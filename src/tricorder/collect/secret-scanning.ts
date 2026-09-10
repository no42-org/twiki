/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { safeLog } from "../../core/log.js";
import { watchKey } from "../../core/slug.js";
import { alertSubject, secretScanningSubject } from "../../core/subject.js";
import type { RepoRef } from "../../core/types.js";
import {
  type GitHubReadPort,
  orgSecretScanningUrl,
  type RawSecretScanningAlert,
} from "../../github/port.js";
import type { ObservationInput, RunScope } from "../store/port.js";
import { type LaneRunDeps, withLaneRun } from "./lifecycle.js";
import { named } from "./unlisted.js";

// The REST org-level lane, for secret scanning alerts (#158).
//
// The code scanning lane's sibling, rule for rule: one call covers the whole
// organisation, a user account fans out over its watched repositories, and a
// repository GitHub answers WITHOUT a listing is skipped rather than
// confirmed, so it reads `unconfirmed` and never a confident zero.
//
// What is deliberately different is what a stored row does NOT contain. The
// credential never enters our type at all (see RawSecretScanningAlert), so
// there is nothing here to redact, truncate or forget to redact later. And
// nothing carries a severity: GitHub grades no secret, so a lane inventing a
// grade would be putting a number on the one finding that needs none.
//
// Measured live on 2026-09-09 with the read-only App: the org listing answers
// 200 with an ETag, no `link` header and ZERO alerts in every state in all
// three installed organisations. So the empty page is the shape this lane was
// exercised against for real; every other shape is asserted from the schema.

/**
 * What we store about one secret scanning alert.
 *
 * Flat, and only what a page or the ranking chain reads. THE CREDENTIAL IS
 * NOT HERE and never will be: the adapter's mapper has no field for it, so
 * this payload cannot acquire one by an edit that forgets to redact.
 * `secretType` is `secret_type_display_name`, the only name of the finding
 * that may reach a reader.
 */
export interface SecretScanningAlertObservation {
  number: number;
  repo: string;
  /**
   * What GitHub said the alert's state is, or null where it said nothing.
   * Informational: the projection's own state carries the tombstone, and the
   * lane asks only for open alerts.
   */
  state: string | null;
  /** `secret_type_display_name`, or null where GitHub sent none. */
  secretType: string | null;
  /** `active`, `inactive`, or `unknown` for both absence and that literal. */
  validity: string;
  /** GitHub REPORTED a public leak. Null, false and absent are all false. */
  publiclyLeaked: boolean;
  htmlUrl: string | null;
  createdAt: string | null;
}

/**
 * Per-repository confirmation, written for every watched repository the sweep
 * covered, whether or not it had an alert.
 *
 * No worst severity, unlike its code scanning counterpart, and its absence is
 * the point: GitHub grades no secret, so there is no worst one to report. The
 * chips render `critical` for an open secret from the queue's display
 * severity, which is a word about the finding rather than a grade fed by
 * anything GitHub sent.
 */
export interface RepoSecretScanningObservation {
  repo: string;
  openAlerts: number;
}

export function normalise(alert: RawSecretScanningAlert): ObservationInput {
  const payload: SecretScanningAlertObservation = {
    number: alert.number,
    repo: `${alert.repo.owner}/${alert.repo.name}`,
    state: alert.state,
    secretType: alert.secretType,
    validity: alert.validity,
    publiclyLeaked: alert.publiclyLeaked,
    htmlUrl: alert.htmlUrl,
    createdAt: alert.createdAt,
  };
  return {
    subject: alertSubject("secret_scanning_alert", alert.repo, alert.number),
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
  alerts: readonly RawSecretScanningAlert[],
): ObservationInput {
  const slug = watchKey(repo);
  const mine = alerts.filter((a) => watchKey(a.repo) === slug);
  const payload: RepoSecretScanningObservation = {
    repo: slug,
    openAlerts: mine.length,
  };
  return { subject: secretScanningSubject(repo), payload };
}

export interface LaneDeps extends LaneRunDeps {
  github: GitHubReadPort;
  /** Watched repositories belonging to this installation. */
  watchedIn: (installation: string) => readonly RepoRef[];
  /**
   * The watched set, as case-folded `owner/name`. AD-10's rule, and it lives
   * here rather than in the adapter for the reason the Dependabot lane
   * states: twiki's allowlist guard is case-sensitive on purpose, and GitHub
   * supplies the casing on this read.
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

export const LANE = "rest-org-secret-scanning";

/**
 * Collect one organisation's open secret scanning alerts.
 *
 * Nothing throws past this boundary, including a store failure: one
 * unreachable organisation must not abort the cycle for the others (AD-16).
 */
export async function collectOrgSecretScanning(
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
      const url = orgSecretScanningUrl(installation);
      // Conditional only while every watched repository already has a secret
      // scanning confirmation (AD-25 meets AD-10), exactly as on the two
      // listings beside it: a repository newly added to repos.yaml had its
      // alerts filtered out of the very listing the cached ETag describes, so
      // a 304 would keep it invisible for as long as the rest of the
      // organisation stayed quiet.
      const confirmedRepos = new Set(
        deps.store
          .currentByTypeForOwner("repository_secret_scanning", installation)
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
      const page = await deps.github.listSecretScanningAlerts(
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
            "secret_scanning_alert",
            installation,
          ),
          ...deps.store.currentByTypeForOwner(
            "repository_secret_scanning",
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
          (s) => s.type === "secret_scanning_alert",
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
      // `named` quotes what GitHub said, per repository. The one measured
      // refusal here names itself - `Secret scanning is disabled on this
      // repository.` - but a second one would read differently, and a detail
      // that named one of them for all of them would send the operator to
      // the wrong setting.
      const notes = [
        page.truncated
          ? "secret scanning listing truncated at the pagination cap; nothing tombstoned"
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
      // unlisted, and tombstoning them would report a live credential as
      // revoked.
      if (scope === "full" && outcome === "ok") {
        const seen = new Set(observations.map((o) => o.subject.key));
        const gone = deps.store
          .currentByTypeForOwner("secret_scanning_alert", installation)
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

      // Counts and slugs only. Nothing about a secret's type, its validity or
      // its value reaches the log: the credential is not in our type at all,
      // and the rest is one edit away from a line that quotes a payload.
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
export async function collectAllOrgSecretScanning(
  deps: LaneDeps,
  installations: readonly string[],
  scope: RunScope,
): Promise<LaneResult[]> {
  const results: LaneResult[] = [];
  for (const installation of installations) {
    results.push(await collectOrgSecretScanning(deps, installation, scope));
  }
  return results;
}
