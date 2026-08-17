/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { alertSubject, repositorySubject } from "../../core/subject.js";
import type { RepoRef } from "../../core/types.js";
import type { GitHubReadPort, RawDependabotAlert } from "../../github/port.js";
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
    worstSeverity: worstOf(mine.map((a) => a.severity)),
  };
  return { subject: repositorySubject(repo), payload };
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

function worstOf(severities: readonly string[]): string | null {
  for (const level of SEVERITY_ORDER) {
    if (severities.includes(level)) return level;
  }
  return severities[0] ?? null;
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

  try {
    // Inside the try: beginRun touches the database, and a busy store here
    // would otherwise escape and abort the whole sweep.
    run = deps.store.beginRun({
      lane: LANE,
      installation,
      scope,
      startedAt: deps.now(),
    });

    const page = await deps.github.listOrgDependabotAlerts(installation);
    const watched = page.alerts.filter((a) => deps.isWatched(a.repo));
    const observations = watched.map(normalise);

    // One confirmation per watched repository in this installation, including
    // the ones with nothing to report. This is what makes a real zero
    // expressible and stops a newly-clean repository going stale.
    const repoObservations = deps
      .watchedIn(installation)
      .map((repo) => summariseRepo(repo, watched));

    // One transaction: every observation and its projection advance land
    // together, or none do (AD-3).
    deps.store.recordObservations(run, deps.now(), [
      ...observations,
      ...repoObservations,
    ]);

    // Unreadable payloads mean the result is incomplete. Finishing `ok` here
    // would report a confident zero if the endpoint's shape ever shifts.
    const outcome = page.unreadable > 0 ? "partial" : "ok";
    const detail =
      page.unreadable > 0
        ? `${page.unreadable} alert payloads could not be read`
        : undefined;
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
        deps.log(`${LANE} ${installation}: ${gone.length} alerts resolved`);
      }
    }

    deps.store.finishRun(run, outcome, deps.now(), detail);

    deps.log(
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
    const detail = err instanceof Error ? err.message : String(err);
    if (run) {
      try {
        deps.store.finishRun(run, "failed", deps.now(), detail);
      } catch {
        // The store is the thing that failed. Nothing further to record.
      }
    }
    deps.log(`${LANE} ${installation}: failed, ${detail}`);
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
