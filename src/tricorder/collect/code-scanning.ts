/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { safeLog } from "../../core/log.js";
import { NOT_APPLICABLE } from "../../core/rank.js";
import { worstSeverity } from "../../core/severity.js";
import { watchKey } from "../../core/slug.js";
import { alertSubject, codeScanningSubject } from "../../core/subject.js";
import type { RepoRef } from "../../core/types.js";
import {
  type GitHubReadPort,
  orgCodeScanningUrl,
  type RawCodeScanningAlert,
} from "../../github/port.js";
import type { ObservationInput, RunScope } from "../store/port.js";
import { type LaneRunDeps, withLaneRun } from "./lifecycle.js";
import { named } from "./unlisted.js";

// The REST org-level lane, for code scanning alerts (#156).
//
// One call covers every repository in the organisation, exactly as the
// Dependabot lane's does, and for the same reason: a per-repository sweep
// would cost one call per repository per alert cadence. A user account has no
// org-level endpoint, so it fans out; the port owns that routing.
//
// Two rules distinguish this lane from its Dependabot sibling, and both are
// deliberate:
//
//   Every open alert is stored REGARDLESS OF REF. The default-branch
//   condition belongs to the queue builder, so the repository page can list
//   what the queue declines to rank rather than the row simply vanishing.
//
//   Some repositories are SKIPPED rather than confirmed. GitHub answers the
//   per-repository listing with several stable refusals, none of which says a
//   feature is switched off; a repository that answered one gets no rows and
//   no confirmation, so it reads `unconfirmed` and never a confident zero.

/**
 * What we store about one code scanning alert.
 *
 * Flat, and only what a page or the ranking chain reads. `rule.severity` is
 * deliberately absent: it carries the linting scale, on which a Scorecard
 * `error` outranks this estate's one Trivy `critical`, and a field nothing
 * stores cannot be ranked on by accident.
 */
export interface CodeScanningAlertObservation {
  number: number;
  repo: string;
  /**
   * What GitHub said the alert's state is, or null where it said nothing.
   * Informational: the projection's own state carries the tombstone, and the
   * lane asks only for open alerts.
   */
  state: string | null;
  /** `rule.security_severity_level`, or `n/a` when GitHub graded nothing. */
  severity: string;
  /** The scanner that found it, for the queue's rationale. */
  tool: string | null;
  /** `rule.id`, which is a CVE for Trivy and an audit name for zizmor. */
  ruleId: string | null;
  /** `most_recent_instance.ref`. The queue's default-branch condition reads it. */
  ref: string | null;
  htmlUrl: string | null;
  createdAt: string | null;
}

/**
 * Per-repository confirmation, written for every watched repository the sweep
 * covered, whether or not it had an alert.
 *
 * Its own subject type rather than a second writer on `repository`: the two
 * lanes have their own freshness, and one vouching for the other is how a
 * fresh Dependabot sweep would badge a code scanning section nothing swept.
 */
export interface RepoCodeScanningObservation {
  repo: string;
  openAlerts: number;
  /**
   * The worst GRADED severity among them, or null when none is graded.
   *
   * `n/a` values are filtered out rather than passed through: `worstSeverity`
   * would read the sentinel as a severity it does not recognise and answer
   * `unknown`, which claims a value we failed to read where the truth is that
   * the tool grades nothing.
   */
  worstSeverity: string | null;
}

export function normalise(alert: RawCodeScanningAlert): ObservationInput {
  const payload: CodeScanningAlertObservation = {
    number: alert.number,
    repo: `${alert.repo.owner}/${alert.repo.name}`,
    state: alert.state,
    severity: alert.securitySeverity,
    tool: alert.tool,
    ruleId: alert.ruleId,
    ref: alert.ref,
    htmlUrl: alert.htmlUrl,
    createdAt: alert.createdAt,
  };
  return {
    subject: alertSubject("code_scanning_alert", alert.repo, alert.number),
    payload,
  };
}

/** The repository a subject key belongs to. Keys are `owner/name#number`. */
function repoOfKey(key: string): RepoRef {
  const slug = key.split("#")[0] ?? "";
  const [owner = "", name = ""] = slug.split("/");
  return { owner, name };
}

/** Summarise one repository's alerts into its confirmation row. */
export function summariseRepo(
  repo: RepoRef,
  alerts: readonly RawCodeScanningAlert[],
): ObservationInput {
  const slug = watchKey(repo);
  const mine = alerts.filter((a) => watchKey(a.repo) === slug);
  const payload: RepoCodeScanningObservation = {
    repo: slug,
    openAlerts: mine.length,
    worstSeverity: worstSeverity(
      mine
        .map((a) => a.securitySeverity)
        .filter((severity) => severity !== NOT_APPLICABLE),
    ),
  };
  return { subject: codeScanningSubject(repo), payload };
}

export interface LaneDeps extends LaneRunDeps {
  github: GitHubReadPort;
  /** Watched repositories belonging to this installation. */
  watchedIn: (installation: string) => readonly RepoRef[];
  /**
   * The watched set, as case-folded `owner/name`. AD-10's rule, and it lives
   * here rather than in the adapter for the reason the Dependabot lane states:
   * twiki's allowlist guard is case-sensitive on purpose, and GitHub supplies
   * the casing on this read.
   */
  isWatched: (repo: RepoRef) => boolean;
}

export interface LaneResult {
  installation: string;
  outcome: "ok" | "partial" | "failed";
  alerts: number;
  /** Payloads the adapter could not read. Non-zero forces a partial run. */
  unreadable: number;
  /** Repositories GitHub answered, but with no listing to give. */
  skipped: number;
}

export const LANE = "rest-org-code-scanning";

/**
 * Collect one organisation's open code scanning alerts.
 *
 * Nothing throws past this boundary, including a store failure: one
 * unreachable organisation must not abort the cycle for the others (AD-16).
 */
export async function collectOrgCodeScanning(
  deps: LaneDeps,
  installation: string,
  scope: RunScope,
): Promise<LaneResult> {
  const log = safeLog(deps.log);

  return withLaneRun<LaneResult>(
    deps,
    { lane: LANE, installation, scope, reach: "per-installation" },
    { installation, outcome: "failed", alerts: 0, unreadable: 0, skipped: 0 },
    async (run) => {
      const url = orgCodeScanningUrl(installation);
      // Conditional only while every watched repository already has a code
      // scanning confirmation (AD-25 meets AD-10), exactly as on the
      // Dependabot listing: a repository newly added to repos.yaml had its
      // alerts filtered out of the very listing the cached ETag describes, so
      // a 304 would keep it invisible for as long as the rest of the
      // organisation stayed quiet.
      const confirmedRepos = new Set(
        deps.store
          .currentByTypeForOwner("repository_code_scanning", installation)
          .filter((c) => c.state === "present")
          .map((c) => c.subject.key),
      );
      const unconfirmed = deps
        .watchedIn(installation)
        .map(watchKey)
        .filter((slug) => !confirmedRepos.has(slug));
      if (unconfirmed.length > 0) {
        log(
          `${LANE} ${installation}: conditional sweep off, unconfirmed: ${unconfirmed.join(", ")}`,
        );
      }
      const page = await deps.github.listCodeScanningAlerts(
        installation,
        // Used only when the account has no org-level endpoint to collapse
        // into. An organisation ignores this and still costs one call.
        deps.watchedIn(installation),
        unconfirmed.length === 0
          ? deps.store.loadValidator(installation, url)
          : null,
      );

      if (page.notModified) {
        // GitHub's own statement that the listing is unchanged since the
        // sweep that stored these rows. Confirm them rather than rewrite
        // them: no observation rows land, verified_at advances so a quiet
        // scanned repository renders fresh, and nothing is tombstoned
        // because nothing was observed absent.
        const confirmed = [
          ...deps.store.currentByTypeForOwner(
            "code_scanning_alert",
            installation,
          ),
          ...deps.store.currentByTypeForOwner(
            "repository_code_scanning",
            installation,
          ),
        ]
          .filter((c) => c.state === "present")
          .filter((c) => deps.isWatched(repoOfKey(c.subject.key)))
          .map((c) => c.subject);
        deps.store.touchVerified(confirmed, deps.now());
        // The same gate as the 200 path's save, for the same reason: an
        // adapter change returning a fresh validator on 304 must not slip
        // past the guard the 200 path enforces.
        if (scope === "full" && page.validator) {
          deps.store.saveValidator(
            installation,
            url,
            page.validator,
            deps.now(),
          );
        }
        deps.store.finishRun(run, "ok", deps.now(), "not modified (304)");
        const alerts = confirmed.filter(
          (s) => s.type === "code_scanning_alert",
        ).length;
        log(
          `${LANE} ${installation}: not modified, ${alerts} alerts confirmed`,
        );
        return {
          installation,
          outcome: "ok",
          alerts,
          unreadable: 0,
          skipped: 0,
        };
      }

      // Every open alert this installation watches, whatever ref it is on.
      // The default-branch condition is the queue builder's alone.
      const watched = page.alerts.filter((a) => deps.isWatched(a.repo));
      const observations = watched.map(normalise);

      // Three distinct ways the answer can be incomplete, reported as three
      // distinct things, and every guard below keys off `ok`. A skipped
      // repository is NOT one of them: GitHub answered, the answer was that
      // there is no listing to give, and degrading on it would hold this
      // lane partial for as long as that repository exists.
      const outcome =
        page.unreadable > 0 || page.unreachable.length > 0 || page.truncated
          ? "partial"
          : "ok";
      const skippedSlugs = page.skipped.map((s) => watchKey(s.repo));
      // `named` quotes what GitHub said, per repository: the refusals here
      // differ (`no analysis found`, `Resource not accessible by
      // integration`, an Advanced Security message) and a detail that named
      // one of them for all of them would send the operator to the wrong
      // setting.
      const notes = [
        page.truncated
          ? "code scanning listing truncated at the pagination cap; nothing tombstoned"
          : null,
        page.unreachable.length > 0
          ? `${page.unreachable.length} repositories could not be read: ${named(page.unreachable)}`
          : null,
        page.unreadable > 0
          ? `${page.unreadable} alert payloads could not be read`
          : null,
        page.skipped.length > 0
          ? `skipped, no listing to read: ${named(page.skipped)}`
          : null,
      ].filter((n): n is string => n !== null);
      const detail = notes.length > 0 ? notes.join("; ") : undefined;

      // One confirmation per watched repository the sweep actually covered.
      // Under the same two guards as the tombstone pass below - a hot run
      // queried a subset, a partial run could not read some payloads - plus
      // a third of this lane's own: a skipped repository was answered but
      // not listed, so confirming it would publish a zero for exactly the
      // repository we have no listing for.
      const skipped = new Set(skippedSlugs);
      const repoObservations =
        scope === "full" && outcome === "ok"
          ? deps
              .watchedIn(installation)
              .filter((repo) => !skipped.has(watchKey(repo)))
              .map((repo) => summariseRepo(repo, watched))
          : [];

      // One transaction: every observation and its projection advance land
      // together, or none do (AD-3).
      deps.store.recordObservations(run, deps.now(), [
        ...observations,
        ...repoObservations,
      ]);

      // Reconcile disappearance into explicit tombstones (AD-23), under the
      // same three guards the Dependabot lane states, plus this lane's
      // fourth: a skipped repository's rows are not absent, they are
      // unlisted, and tombstoning them would report a finding as fixed.
      if (scope === "full" && outcome === "ok") {
        const seen = new Set(observations.map((o) => o.subject.key));
        const gone = deps.store
          .currentByTypeForOwner("code_scanning_alert", installation)
          .filter((c) => c.state === "present")
          .filter((c) => !seen.has(c.subject.key))
          .filter((c) => deps.isWatched(repoOfKey(c.subject.key)))
          .filter((c) => !skipped.has(watchKey(repoOfKey(c.subject.key))))
          .map((c) => c.subject);

        if (gone.length > 0) {
          deps.store.recordTombstones(run, deps.now(), gone);
          log(`${LANE} ${installation}: ${gone.length} alerts resolved`);
        }
      }

      // The validator is saved under the same guards as the confirmations
      // and tombstones, because a 304 against it asserts exactly what they
      // assert: "the stored rows are the complete answer". When a 200 stored
      // rows without earning a fresh validator, the stored one must go: it
      // describes the pre-rewrite listing, and a later byte-identical
      // listing would confirm rows the listing no longer contains.
      if (scope === "full" && outcome === "ok" && page.validator) {
        deps.store.saveValidator(installation, url, page.validator, deps.now());
      } else {
        deps.store.deleteValidator(installation, url);
      }

      deps.store.finishRun(run, outcome, deps.now(), detail);

      log(
        `${LANE} ${installation}: ${observations.length} watched alerts` +
          `, ${page.alerts.length - watched.length} outside the allowlist` +
          (page.unreadable > 0 ? `, ${page.unreadable} unreadable` : "") +
          (skippedSlugs.length > 0 ? `, ${skippedSlugs.length} skipped` : ""),
      );
      return {
        installation,
        outcome,
        alerts: observations.length,
        unreadable: page.unreadable,
        skipped: skippedSlugs.length,
      };
    },
  );
}

/**
 * Sweep several installations. Serial by design: GitHub advises serial
 * requests per installation, and fanning out is how a collector trips the
 * secondary limits it cannot see coming (AD-24).
 */
export async function collectAllOrgCodeScanning(
  deps: LaneDeps,
  installations: readonly string[],
  scope: RunScope,
): Promise<LaneResult[]> {
  const results: LaneResult[] = [];
  for (const installation of installations) {
    results.push(await collectOrgCodeScanning(deps, installation, scope));
  }
  return results;
}
