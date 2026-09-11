/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { safeLog } from "../../core/log.js";
import { watchKey } from "../../core/slug.js";
import type { SubjectType } from "../../core/subject.js";
import type { RepoRef } from "../../core/types.js";
import type {
  GitHubReadPort,
  RequestValidator,
  UnlistedRepo,
} from "../../github/port.js";
import type { ObservationInput, RunScope } from "../store/port.js";
import { type LaneRunDeps, withLaneRun } from "./lifecycle.js";
import { named } from "./unlisted.js";

// The shared body of the three REST org-listing lanes: Dependabot alerts,
// code scanning alerts and secret scanning alerts (#163).
//
// One call covers every repository in an organisation. A user account has no
// org-level endpoint, so the port fans out per repository; only that path can
// report a repository it could not list.
//
// WHY THIS PARAMETERISES WHEN `lifecycle.ts` DELIBERATELY DOES NOT.
// The comment on `withLaneRun` warns that a helper parameterising its two
// responsibilities "would flatten distinctions a reader needs to see". That is
// true there and it is not a warning against this module. The run lifecycle
// serves five lanes that genuinely differ: the per-repository containment
// boundary two of them have and three do not, the terminal branches that
// finish a run mid-body, the actions lane's tombstone gate, and the KEV lane's
// rule that a partial run writes nothing. Those are real distinctions, and
// parameterising them would hide them.
//
// These three lane bodies had no distinctions left. Normalise the domain noun
// away and the two scanner bodies were identical line for line, and the
// Dependabot body differed only in its truncation phrase. What that cost is on
// the record: the null-entry mapper guard added in #158 reached two mappers
// and missed the third, and three review layers across two passes asked for an
// `isWatched` filter that could not be added to one lane without diverging
// from the other two.
//
// The rule this module keeps: a divergence that cannot be expressed as one of
// the fields of `LaneSpec` is rejected, not special-cased. A fourth kind that
// needs a fifth rule does not belong here.

/** The repository a subject key belongs to. Keys are `owner/name#number`. */
function repoOfKey(key: string): RepoRef {
  const slug = key.split("#")[0] ?? "";
  const [owner = "", name = ""] = slug.split("/");
  return { owner, name };
}

export interface LaneDeps extends LaneRunDeps {
  github: GitHubReadPort;
  /** Watched repositories belonging to this installation. */
  watchedIn: (installation: string) => readonly RepoRef[];
  /**
   * The watched set, as case-folded `owner/name`. AD-10's rule, and it lives
   * here rather than in the adapter because twiki's allowlist guard is
   * case-sensitive on purpose and GitHub supplies the casing on this read.
   */
  isWatched: (repo: RepoRef) => boolean;
}

export interface LaneResult {
  installation: string;
  outcome: "ok" | "partial" | "failed";
  alerts: number;
  /** Payloads the adapter could not read. Non-zero forces a partial run. */
  unreadable: number;
  /** Repositories GitHub answered, but with no listing to give (#171). */
  skipped: number;
}

/**
 * What every org listing returns, whatever kind of alert it carries.
 *
 * `OrgAlertPage`, `CodeScanningAlertPage` and `SecretScanningAlertPage` are
 * structurally identical apart from their element type, and all three satisfy
 * this. Declared here rather than in the port because collapsing the three
 * port types is a change to `src/github/`, which this one deliberately is not.
 */
export interface ListingPage<TAlert> {
  alerts: readonly TAlert[];
  /** Payloads the adapter could not map. */
  unreadable: number;
  /** Repositories that reached no answer at all. These degrade the run. */
  unreachable: readonly UnlistedRepo[];
  /** Repositories GitHub answered with a refusal instead of a listing. */
  skipped: readonly UnlistedRepo[];
  notModified: boolean;
  truncated: boolean;
  validator: RequestValidator | null;
}

/**
 * Everything one kind varies, and nothing else.
 *
 * Eight fields. If a kind needs a ninth, the question to answer first is
 * whether it is an org-listing lane at all.
 */
export interface LaneSpec<TAlert extends { repo: RepoRef }> {
  /** The `collection_run.lane` value, and the prefix on every log line. */
  lane: string;
  /** The alert subject type this kind stores. */
  alertSubject: SubjectType;
  /** The per-repository confirmation subject type this kind writes. */
  confirmationSubject: SubjectType;
  /** The validator key for this kind's org listing. */
  url: (installation: string) => string;
  /**
   * The port read. Fans out per repository on a user account.
   *
   * Takes the port rather than closing over one, so a `LaneSpec` stays a
   * plain value: the lane is constructed once at module scope and the port
   * arrives per call, as it does everywhere else in this layer.
   */
  list: (
    github: GitHubReadPort,
    installation: string,
    repos: readonly RepoRef[],
    cached: RequestValidator | null,
  ) => Promise<ListingPage<TAlert>>;
  /** One alert to one observation row. */
  normalise: (alert: TAlert) => ObservationInput;
  /** One repository's alerts to its confirmation row. */
  summariseRepo: (repo: RepoRef, alerts: readonly TAlert[]) => ObservationInput;
  /** How this kind names its listing when the pagination cap truncates it. */
  truncationNote: string;
}

/**
 * Collect one installation's open alerts of one kind.
 *
 * Nothing throws past this boundary, including a store failure: one
 * unreachable organisation must not abort the cycle for the others (AD-16).
 */
export async function collectOrgListing<TAlert extends { repo: RepoRef }>(
  spec: LaneSpec<TAlert>,
  deps: LaneDeps,
  installation: string,
  scope: RunScope,
): Promise<LaneResult> {
  const log = safeLog(deps.log);
  const LANE = spec.lane;

  return withLaneRun<LaneResult>(
    deps,
    { lane: LANE, installation, scope, reach: "per-installation" },
    {
      installation,
      outcome: "failed",
      alerts: 0,
      unreadable: 0,
      skipped: 0,
    },
    async (run) => {
      const url = spec.url(installation);
      // Conditional only while every watched repository already has a
      // confirmation of this kind (AD-25 meets AD-10): a repository newly
      // added to repos.yaml had its alerts filtered out of the very listing
      // the cached ETag describes, so a 304 would keep it invisible for as
      // long as the rest of the organisation stayed quiet.
      const confirmedRepos = new Set(
        deps.store
          .currentByTypeForOwner(spec.confirmationSubject, installation)
          .filter((c) => c.state === "present")
          .map((c) => c.subject.key),
      );
      const unconfirmed = deps
        .watchedIn(installation)
        .map(watchKey)
        .filter((slug) => !confirmedRepos.has(slug));
      if (unconfirmed.length > 0) {
        // Normally one sweep long: the confirmation pass below writes a row
        // for every watched repository the next full ok sweep COVERS. Logged
        // anyway, because if this ever persists (full sweeps failing, scope
        // never full) the cache is silently off for the whole organisation,
        // and the line names exactly which repositories are holding it off.
        //
        // One cause is permanent and benign: a repository GitHub answers with
        // a stable refusal instead of a listing is never confirmed, so it is
        // named here every sweep for as long as the refusal lasts (#171). A
        // repository that WAS confirmed reaches the same place, because the
        // retraction below withdraws the row this set is built from - that is
        // the other path in, and it is permanent for the same reason.
        //
        // Not filtered out, because the skip set is only known after the call
        // this gate decides, and nothing is lost by it: a skipped repository
        // exists only on the per-repository fan-out, which caches no
        // validator at all, so this gate is already a no-op there. It is the
        // ORGANISATION path the line exists to protect.
        log(
          `${LANE} ${installation}: conditional sweep off, unconfirmed: ${unconfirmed.join(", ")}`,
        );
      }
      const page = await spec.list(
        deps.github,
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
        // repository renders fresh, and nothing is tombstoned because nothing
        // was observed absent.
        const confirmed = [
          ...deps.store.currentByTypeForOwner(spec.alertSubject, installation),
          ...deps.store.currentByTypeForOwner(
            spec.confirmationSubject,
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
          (s) => s.type === spec.alertSubject,
        ).length;
        log(
          `${LANE} ${installation}: not modified, ${alerts} alerts confirmed`,
        );
        return {
          installation,
          outcome: "ok",
          alerts,
          unreadable: 0,
          // A 304 covered the whole listing: nothing was asked about
          // repository by repository, so nothing was skipped.
          skipped: 0,
        };
      }

      // Every open alert this installation watches, whatever ref it is on.
      // The default-branch condition is the queue builder's alone.
      const watched = page.alerts.filter((a) => deps.isWatched(a.repo));
      const observations = watched.map(spec.normalise);

      // Three distinct ways the answer can be incomplete, reported as three
      // distinct things, and every guard below keys off `ok`. A skipped
      // repository is NOT one of them: GitHub answered, the answer was that
      // there is no listing to give, and degrading on it would hold this lane
      // partial for as long as that repository exists.
      const outcome =
        page.unreadable > 0 || page.unreachable.length > 0 || page.truncated
          ? "partial"
          : "ok";
      const skippedSlugs = page.skipped.map((s) => watchKey(s.repo));
      // `named` quotes what GitHub said, per repository: the refusals differ
      // by kind and by repository, and a detail that named one of them for
      // all of them would send the operator to the wrong setting.
      const notes = [
        page.truncated ? spec.truncationNote : null,
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
      // queried a subset, a partial run could not read some payloads - plus a
      // third: a skipped repository was answered but not listed, so
      // confirming it would publish a zero for exactly the repository we have
      // no listing for.
      const skipped = new Set(skippedSlugs);
      const repoObservations =
        scope === "full" && outcome === "ok"
          ? deps
              .watchedIn(installation)
              .filter((repo) => !skipped.has(watchKey(repo)))
              .map((repo) => spec.summariseRepo(repo, watched))
          : [];

      // One transaction: every observation and its projection advance land
      // together, or none do (AD-3).
      deps.store.recordObservations(run, deps.now(), [
        ...observations,
        ...repoObservations,
      ]);

      // Reconcile disappearance into explicit tombstones (AD-23), under four
      // guards: a hot run queried a subset, a partial run could not read some
      // payloads, a repository dropped from repos.yaml is out of scope rather
      // than fixed, and a skipped repository's rows are not absent but
      // unlisted - tombstoning those would report a live finding as fixed.
      if (scope === "full" && outcome === "ok") {
        const seen = new Set(observations.map((o) => o.subject.key));
        const gone = deps.store
          .currentByTypeForOwner(spec.alertSubject, installation)
          .filter((c) => c.state === "present")
          .filter((c) => !seen.has(c.subject.key))
          .filter((c) => deps.isWatched(repoOfKey(c.subject.key)))
          .filter((c) => !skipped.has(watchKey(repoOfKey(c.subject.key))))
          .map((c) => c.subject);

        if (gone.length > 0) {
          deps.store.recordTombstones(run, deps.now(), gone);
          log(`${LANE} ${installation}: ${gone.length} alerts resolved`);
        }

        // The CONFIRMATION of a skipped repository is retracted, though its
        // alert rows above are not. Withholding a new one is enough only for
        // a repository never confirmed; one confirmed at three open alerts
        // last week would otherwise keep publishing that three, attested and
        // ageing.
        //
        // This respects AD-23 rather than bending it. The skip is a stable
        // refusal, WHATEVER it was - the fan-out classifies on
        // `probe.answered` alone and never on which refusal arrived - so the
        // argument has to hold for all of them. For a feature switched off it
        // is a positive statement of absence; for an endpoint the App may not
        // read it is that we can no longer attest. Different routes, one
        // action: stop publishing a count nobody measured. The alert rows
        // differ under both, because nothing said those alerts are gone -
        // only that they cannot be listed.
        //
        // `present` only, and it is load-bearing: `recordTombstones` TOUCHES
        // an already-resolved subject rather than skipping it, so without
        // this filter a permanently skipped repository would be re-touched
        // and re-logged on every sweep for ever. The freshness that touch
        // exists to provide is deliberately given up here; nothing reads a
        // retracted confirmation's `verifiedAt` today, and a row whose
        // assertion was withdrawn has no freshness to report.
        const withdrawn = deps.store
          .currentByTypeForOwner(spec.confirmationSubject, installation)
          .filter((c) => c.state === "present")
          .filter((c) => skipped.has(c.subject.key))
          .filter((c) => deps.isWatched(repoOfKey(c.subject.key)))
          .map((c) => c.subject);

        if (withdrawn.length > 0) {
          deps.store.recordTombstones(run, deps.now(), withdrawn);
          log(
            `${LANE} ${installation}: ${withdrawn.length} confirmations retracted`,
          );
        }
      }

      // The validator is saved under the same guards as the confirmations and
      // tombstones, because a 304 against it asserts exactly what they
      // assert: "the stored rows are the complete answer". When a 200 stored
      // rows without earning a fresh validator, the stored one must go: it
      // describes the pre-rewrite listing, and a later byte-identical listing
      // would confirm rows the listing no longer contains.
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
export async function collectAllOrgListings<TAlert extends { repo: RepoRef }>(
  spec: LaneSpec<TAlert>,
  deps: LaneDeps,
  installations: readonly string[],
  scope: RunScope,
): Promise<LaneResult[]> {
  const results: LaneResult[] = [];
  for (const installation of installations) {
    results.push(await collectOrgListing(spec, deps, installation, scope));
  }
  return results;
}
