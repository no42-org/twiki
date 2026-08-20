/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { safeLog } from "../../core/log.js";
import { redact } from "../../core/redact.js";
import { worstSeverity } from "../../core/severity.js";
import { alertSubject, repositorySubject } from "../../core/subject.js";
import type { RepoRef } from "../../core/types.js";
import {
  type GitHubReadPort,
  orgAlertsUrl,
  type RawDependabotAlert,
} from "../../github/port.js";
import type { ObservationInput, RunScope, StorePort } from "../store/port.js";

// The REST org-level lane, for Dependabot alerts.
//
// REST rather than GraphQL, because EPSS ships on this payload and GraphQL's
// vulnerabilityAlerts does not carry it (AD-15). One call covers every
// repository in the organisation, which is what makes twelve installations
// cost about 36 calls a cycle rather than one per repository.
//
// The pipeline is fetch, normalise, load. Ranking is a later story; this lane
// captures EPSS at ingest so the ranking has something honest to read (AD-18).

/** What we store about an alert. Keep it flat: the ranking chain reads it. */
/**
 * Per-repository confirmation. Written for every watched repository on every
 * successful sweep, whether or not it had an alert.
 *
 * Without it, "we looked and there are none" is inexpressible: a healthy
 * repository has no alert rows, and absence of rows is indistinguishable from
 * absence of collection. It also keeps a repository that just became clean
 * from going permanently stale, because its alert rows stop being updated the
 * moment they are tombstoned.
 */
export interface RepoObservation {
  repo: string;
  openAlerts: number;
  worstSeverity: string | null;
}

export interface AlertObservation {
  number: number;
  repo: string;
  /**
   * open, fixed, dismissed or auto_dismissed, as GitHub reported it. The
   * projection's own `state` column carries the tombstone; this is what the
   * API said, kept so the two can be compared.
   */
  state: string;
  severity: string;
  ghsaId: string | null;
  cveId: string | null;
  packageName: string | null;
  ecosystem: string | null;
  /** Captured now, never re-read for this alert (AD-18). */
  epssPercentage: number | null;
  epssPercentile: number | null;
  relationship: string | null;
  scope: string | null;
  htmlUrl: string | null;
  createdAt: string | null;
}

export function normalise(alert: RawDependabotAlert): ObservationInput {
  const payload: AlertObservation = {
    number: alert.number,
    repo: `${alert.repo.owner}/${alert.repo.name}`,
    state: alert.state,
    severity: alert.severity,
    ghsaId: alert.ghsaId,
    cveId: alert.cveId,
    packageName: alert.packageName,
    ecosystem: alert.ecosystem,
    epssPercentage: alert.epssPercentage,
    epssPercentile: alert.epssPercentile,
    relationship: alert.relationship,
    scope: alert.scope,
    htmlUrl: alert.htmlUrl,
    createdAt: alert.createdAt,
  };
  return {
    subject: alertSubject("dependabot_alert", alert.repo, alert.number),
    payload,
  };
}

/** The repository a subject key belongs to. Keys are `owner/name#number`. */
function repoOfKey(key: string): RepoRef {
  const slug = key.split("#")[0] ?? "";
  const [owner = "", name = ""] = slug.split("/");
  return { owner, name };
}

/** Case-folded slug, matching how subject keys are derived (AD-22). */
export function watchKey(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`.toLowerCase();
}

/** Summarise one repository's alerts into its confirmation row. */
export function summariseRepo(
  repo: RepoRef,
  alerts: readonly RawDependabotAlert[],
): ObservationInput {
  const slug = watchKey(repo);
  const mine = alerts.filter((a) => watchKey(a.repo) === slug);
  const payload: RepoObservation = {
    repo: slug,
    openAlerts: mine.length,
    worstSeverity: worstSeverity(mine.map((a) => a.severity)),
  };
  return { subject: repositorySubject(repo), payload };
}

export interface LaneDeps {
  github: GitHubReadPort;
  store: StorePort;
  /** Watched repositories belonging to this installation. */
  watchedIn: (installation: string) => readonly RepoRef[];
  /**
   * The watched set, as case-folded `owner/name`. This is AD-10's rule and it
   * lives here rather than in the adapter: twiki's allowlist guard is
   * deliberately case-sensitive, and GitHub supplies the casing on this read,
   * so reusing it would drop alerts and report a confident zero.
   */
  isWatched: (repo: RepoRef) => boolean;
  now: () => string;
  log: (msg: string) => void;
}

export interface LaneResult {
  installation: string;
  outcome: "ok" | "partial" | "failed";
  alerts: number;
  /** Payloads the adapter could not read. Non-zero forces a partial run. */
  unreadable: number;
}

export const LANE = "rest-org-dependabot";

/**
 * Collect one organisation's open Dependabot alerts.
 *
 * Nothing throws past this boundary, including a store failure: one
 * unreachable organisation, or one busy database, must not abort the cycle for
 * the other twelve (AD-16).
 */
export async function collectOrgAlerts(
  deps: LaneDeps,
  installation: string,
  scope: RunScope,
): Promise<LaneResult> {
  let run: ReturnType<StorePort["beginRun"]> | null = null;
  // A logger that throws after finishRun committed would land in the catch and
  // rewrite a successful run as failed (AD-16). Same fix as the KEV lane.
  const log = safeLog(deps.log);

  try {
    // Inside the try: beginRun touches the database, and a busy store here
    // would otherwise escape and abort the whole sweep.
    run = deps.store.beginRun({
      lane: LANE,
      installation,
      scope,
      startedAt: deps.now(),
    });

    const url = orgAlertsUrl(installation);
    // Conditional only while every watched repository has a confirmation row
    // (AD-25 meets AD-10). A repository newly added to repos.yaml has none,
    // and its alerts sat in the very listing the cached ETag describes,
    // filtered out by the old allowlist - so a 304 would keep it invisible
    // for as long as the rest of the org stayed quiet. One unconditional
    // sweep writes its rows, then the cache resumes.
    const confirmedRepos = new Set(
      deps.store
        .currentByTypeForOwner("repository", installation)
        .filter((c) => c.state === "present")
        .map((c) => c.subject.key),
    );
    const unconfirmed = deps
      .watchedIn(installation)
      .map(watchKey)
      .filter((slug) => !confirmedRepos.has(slug));
    if (unconfirmed.length > 0) {
      // Normally one sweep long: the confirmation pass below writes a row
      // for every watched repository on the next full ok sweep. Logged
      // anyway, because if this ever persists (full sweeps failing, scope
      // never full) the cache is silently off for the whole organisation,
      // and the line names exactly which repositories are holding it off.
      log(
        `${LANE} ${installation}: conditional sweep off, unconfirmed: ${unconfirmed.join(", ")}`,
      );
    }
    const page = await deps.github.listDependabotAlerts(
      installation,
      // Used only when the account has no org-level endpoint to collapse
      // into. An organisation ignores this and still costs one call.
      deps.watchedIn(installation),
      unconfirmed.length === 0
        ? deps.store.loadValidator(installation, url)
        : null,
    );

    if (page.notModified) {
      // GitHub's own statement that the listing is unchanged since the sweep
      // that stored these rows. Confirm them rather than rewrite them: no
      // observation rows land (AD-3's log stays change-only), verified_at
      // advances so a quiet healthy repository renders fresh, and nothing is
      // tombstoned because nothing was observed absent. Rows outside the
      // allowlist age out on their own, exactly as on a 200 sweep.
      const confirmed = [
        ...deps.store.currentByTypeForOwner("dependabot_alert", installation),
        ...deps.store.currentByTypeForOwner("repository", installation),
      ]
        .filter((c) => c.state === "present")
        .filter((c) => deps.isWatched(repoOfKey(c.subject.key)))
        .map((c) => c.subject);
      deps.store.touchVerified(confirmed, deps.now());
      // Same gate as the 200 path's save. Unreachable today (the entrypoint
      // only runs full sweeps) and the refreshed validator is value-identical
      // to the stored one, but an adapter change returning a fresh validator
      // on 304 must not slip past the guard the 200 path enforces.
      if (scope === "full" && page.validator) {
        deps.store.saveValidator(installation, url, page.validator, deps.now());
      }
      deps.store.finishRun(run, "ok", deps.now(), "not modified (304)");
      const alerts = confirmed.filter(
        (s) => s.type === "dependabot_alert",
      ).length;
      log(`${LANE} ${installation}: not modified, ${alerts} alerts confirmed`);
      return { installation, outcome: "ok", alerts, unreadable: 0 };
    }

    const watched = page.alerts.filter((a) => deps.isWatched(a.repo));
    const observations = watched.map(normalise);

    // Unreadable payloads mean the result is incomplete. Finishing `ok` here
    // would report a confident zero if the endpoint's shape ever shifts.
    // Truncation degrades exactly as unreadable payloads do: both mean the
    // result set is incomplete, and every guard below keys off `ok`, so a
    // truncated sweep confirms nothing, tombstones nothing and caches no
    // validator.
    // Three distinct ways the answer can be incomplete, reported as three
    // distinct things. Folding unreachable REPOSITORIES into "alert
    // payloads could not be read" points the operator at a mapper bug that
    // does not exist, and the fan-out makes that the common case.
    const outcome =
      page.unreadable > 0 || page.unreachable > 0 || page.truncated
        ? "partial"
        : "ok";
    const notes = [
      page.truncated
        ? "alert listing truncated at the pagination cap; nothing tombstoned"
        : null,
      page.unreachable > 0
        ? `${page.unreachable} repositories could not be read`
        : null,
      page.unreadable > 0
        ? `${page.unreadable} alert payloads could not be read`
        : null,
    ].filter((n): n is string => n !== null);
    const detail = notes.length > 0 ? notes.join("; ") : undefined;

    // One confirmation per watched repository in this installation, including
    // the ones with nothing to report. This is what makes a real zero
    // expressible and stops a newly-clean repository going stale.
    //
    // Written under the same two guards as the tombstone reconciliation below,
    // for the same reason: a confirmation asserts "we looked, and this is the
    // whole answer". A sweep that cannot back that assertion must stay silent
    // and leave the prior value to go stale on its own.
    //
    //   scope must be full   a hot run queried a subset, so its count is an
    //                        undercount, and writing it would overwrite a full
    //                        sweep's real number with a smaller one
    //   outcome must be ok   a partial run could not read some payloads, so its
    //                        count publishes a confident zero for exactly the
    //                        repository whose alerts failed to map
    const repoObservations =
      scope === "full" && outcome === "ok"
        ? deps
            .watchedIn(installation)
            .map((repo) => summariseRepo(repo, watched))
        : [];

    // One transaction: every observation and its projection advance land
    // together, or none do (AD-3).
    deps.store.recordObservations(run, deps.now(), [
      ...observations,
      ...repoObservations,
    ]);

    // Reconcile disappearance into explicit tombstones (AD-23), under three
    // guards, because a wrong tombstone silently wipes real state:
    //
    //   scope must be full        a hot run queried a subset, so absence from
    //                             it means nothing
    //   outcome must be ok        a partial run had unreadable payloads, so
    //                             absence might be a mapping failure
    //   repo must still be watched  a repository dropped from repos.yaml is
    //                             out of scope, not fixed, and tombstoning it
    //                             would assert something untrue
    if (scope === "full" && outcome === "ok") {
      const seen = new Set(observations.map((o) => o.subject.key));
      const gone = deps.store
        .currentByTypeForOwner("dependabot_alert", installation)
        .filter((c) => c.state === "present")
        .filter((c) => !seen.has(c.subject.key))
        .filter((c) => deps.isWatched(repoOfKey(c.subject.key)))
        .map((c) => c.subject);

      if (gone.length > 0) {
        deps.store.recordTombstones(run, deps.now(), gone);
        log(`${LANE} ${installation}: ${gone.length} alerts resolved`);
      }
    }

    // The validator is saved under the same guards as the confirmations and
    // tombstones, because a 304 against it asserts exactly what they assert:
    // "the stored rows are the complete answer". A partial sweep's validator
    // would let the next sweep confirm rows it knows are incomplete, and a
    // hot sweep's would let one confirm rows it never tombstone-reconciled.
    //
    // When a 200 stored rows WITHOUT earning a fresh validator (multi-page
    // listing, partial sweep), the stored validator must go: it describes the
    // pre-rewrite listing, and if the listing later reverts byte-identical to
    // that old body, a 304 against it would confirm every present row -
    // including alerts the listing no longer contains - and skip the tombstone
    // pass a 200 would have run. A fixed alert would render current forever
    // (AD-23).
    if (scope === "full" && outcome === "ok" && page.validator) {
      deps.store.saveValidator(installation, url, page.validator, deps.now());
    } else {
      deps.store.deleteValidator(installation, url);
    }

    deps.store.finishRun(run, outcome, deps.now(), detail);

    log(
      `${LANE} ${installation}: ${observations.length} watched alerts` +
        `, ${page.alerts.length - watched.length} outside the allowlist` +
        (page.unreadable > 0 ? `, ${page.unreadable} unreadable` : ""),
    );
    return {
      installation,
      outcome,
      alerts: observations.length,
      unreadable: page.unreadable,
    };
  } catch (err) {
    // Redacted before it reaches either the log or collection_run.detail: a
    // GitHub auth failure can quote the credential it rejected (AD-16).
    const detail = redact(err instanceof Error ? err.message : String(err));
    if (run) {
      try {
        deps.store.finishRun(run, "failed", deps.now(), detail);
      } catch {
        // The store is the thing that failed. Nothing further to record.
      }
    }
    log(`${LANE} ${installation}: failed, ${detail}`);
    return { installation, outcome: "failed", alerts: 0, unreadable: 0 };
  }
}

/**
 * Sweep several installations. Serial by design: GitHub advises serial requests
 * per installation, and fanning out is how a collector trips the secondary
 * limits it cannot see coming (AD-24).
 */
export async function collectAllOrgs(
  deps: LaneDeps,
  installations: readonly string[],
  scope: RunScope,
): Promise<LaneResult[]> {
  const results: LaneResult[] = [];
  for (const installation of installations) {
    results.push(await collectOrgAlerts(deps, installation, scope));
  }
  return results;
}
