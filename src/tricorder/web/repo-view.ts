/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { isDefaultBranchRun } from "../../core/branch.js";
import { coverageNotes, isOff } from "../../core/coverage.js";
import { DEFAULT_RANK_POLICY, type RankPolicy } from "../../core/rank.js";
import {
  DEFAULT_HUNG_AFTER_MS,
  isBrokenVerdict,
  type RunVerdict,
  runVerdict,
} from "../../core/run-verdict.js";
import { safeUrl } from "../../core/safe-url.js";
import { watchKey } from "../../core/slug.js";
import {
  DEFAULT_REVIEW_BUDGET_DAYS,
  defaultCutRank,
  type Tier,
} from "../../core/tier.js";
import type { RepoRef } from "../../core/types.js";
import { actionsVouched } from "../attention/actions-confirmation.js";
import {
  laneAttestation,
  type SectionState,
} from "../attention/attestation.js";
import {
  ageLabel,
  type Freshness,
  type FreshnessPolicy,
  freshness,
} from "../attention/freshness.js";
import {
  readAlert,
  readIssue,
  readPr,
  readReviewRequest,
  readStatus,
  readWorkflowRun,
} from "../attention/payloads.js";
import { repoAttention } from "../attention/tiers.js";
import {
  type CoverageObservation,
  coverageFeatures,
} from "../collect/coverage.js";
import type { RepoObservation } from "../collect/dependabot-alerts.js";
import { LANE as ISSUE_LANE } from "../collect/issues.js";
import {
  REVIEWS_INSTALLATION,
  LANE as REVIEWS_LANE,
} from "../collect/review-requests.js";
import { LANE as UPDATE_PR_LANE } from "../collect/update-prs.js";
import { LANE as ACTIONS_LANE } from "../collect/workflow-runs.js";
import type { CurrentValue, StorePort } from "../store/port.js";

// The per-repository view (CAP-7): every lane's signals for one repository,
// each carrying its own freshness.
//
// The hard part here is not assembly, it is absence. Every section can be
// empty for two entirely different reasons - we looked and there is nothing,
// or we never looked - and a page that renders those the same way is the lie
// this dashboard exists to avoid (AD-28). Each section therefore carries an
// explicit `attested` flag rather than leaving the reader to infer it from a
// count of zero.

export interface RepoAlertRow {
  number: number;
  severity: string;
  advisory: string | null;
  packageName: string | null;
  htmlUrl: string | null;
  freshness: Freshness;
  age: string;
}

export interface RepoPrRow {
  number: number;
  title: string;
  packageName: string | null;
  /**
   * Every alert whose update status names this PR, ascending; empty when no
   * status on record does. The precise join the queue also uses, not the
   * package heuristic: a column that guessed would put a confident `#7`
   * beside a PR GitHub never linked to it.
   */
  linkedAlerts: number[];
  htmlUrl: string | null;
  freshness: Freshness;
  age: string;
}

export interface RepoIssueRow {
  number: number;
  title: string;
  author: string;
  htmlUrl: string | null;
  freshness: Freshness;
  age: string;
}

export interface RepoRunRow {
  /**
   * The row's subject key, the run's GraphQL node id (AD-22). Carried so the
   * sort has a final tiebreak and the renderer a unique React key: two
   * workflows may share a display name, and re-runs of one workflow share a
   * run number, so neither of those is unique on its own.
   */
  key: string;
  workflowName: string;
  runNumber: number;
  status: string;
  conclusion: string | null;
  /**
   * What the run means, from the one function that decides it, so the page
   * and the lane's `failing` counter cannot disagree about the same row. The
   * cell reads this rather than `conclusion`: a `timed_out` or
   * `startup_failure` run is a broken build, and so is one that never
   * finished, and none of the three says `failure`.
   */
  verdict: RunVerdict;
  headBranch: string | null;
  /**
   * The trigger GitHub reported, carried because the ordering asks whether
   * this run built the default branch and a branch name alone cannot say: a
   * pull request from a fork's own `main` reports `main` here too (#141).
   * Not rendered.
   */
  event: string;
  htmlUrl: string | null;
  freshness: Freshness;
  age: string;
}

export interface RepoReviewRow {
  key: string;
  number: number;
  title: string;
  htmlUrl: string | null;
  requestedReviewers: string[];
  /**
   * How long the request has waited, from the PR's own `createdAt`, or
   * `unknown` when that does not parse: a sweep sentence like `never
   * collected` would be false of a row the sweep plainly collected.
   */
  waiting: string;
  freshness: Freshness;
  age: string;
}

/**
 * The run list's order, as a named total comparator.
 *
 * Named and exported so it can be asserted directly. Its last term is
 * unobservable through `buildRepoView` alone - `currentByType` already
 * returns rows in subject-key order and `Array.sort` is stable, so the rows
 * come out right whether or not the term is there - and a comparator
 * documented as total must not depend on an invariant of the store to be so.
 *
 * Workflow name first, then the default-branch row, because a failure on main
 * is the one a reader came for; then the broken run within its bucket, for
 * the same reason one level down - the run that needs the reader is the one
 * that did not go green, and a rerun that passed is newer than the failure
 * it has not yet replaced; then the run number, newest first; then the
 * subject key, which is what makes it total. Two workflows may share a
 * display name (GitHub allows it) and a re-run shares its run number, so
 * neither is unique on its own.
 *
 * `broken` sits BELOW the default-branch term deliberately: a failed feature
 * branch must not climb above a green main, because it is not a statement
 * about main at all.
 */
export function compareRunRows(
  a: RepoRunRow,
  b: RepoRunRow,
  onDefaultBranch: (row: RepoRunRow) => boolean,
): number {
  return (
    a.workflowName.localeCompare(b.workflowName) ||
    Number(onDefaultBranch(b)) - Number(onDefaultBranch(a)) ||
    Number(isBrokenVerdict(b.verdict)) - Number(isBrokenVerdict(a.verdict)) ||
    b.runNumber - a.runNumber ||
    a.key.localeCompare(b.key)
  );
}

export interface RepoView {
  slug: string;
  /**
   * Everything the coverage row says: why each feature that is off is off,
   * then what GitHub answered for each it did not settle.
   *
   * A list rather than the single string it was: two features can be off for
   * different reasons, and the page must give both rather than name one and
   * invent nothing for the other (#152). Empty when all three are covered.
   */
  coverageReasons: readonly string[];
  /**
   * DEPENDABOT is positively known not to be watching this repository, so its
   * alert count is not a real number and none is rendered (AD-28).
   *
   * Dependabot alone, because the count this withdraws is Dependabot's: a
   * scanner being off says nothing about whether the alert count is real, and
   * withdrawing on it would hide live alerts behind an unrelated feature. What
   * the scanners said still reaches the reader, through `coverageReasons`.
   * False for `unknown`, which means GitHub gave no answer rather than that
   * anything was switched off.
   */
  notCovered: boolean;
  /**
   * The header line: the tier, its rationale, and the counts.
   *
   * Counts come from the queue items when there are any, so the sentence
   * and the tier chip read the same rows (AD-32); with no items they fall
   * back to the alert lane's confirmation, and its attestation says whether
   * they are current.
   */
  summary: SectionState & {
    tier: Tier;
    /** The first item in chain order that attains the tier, and why. */
    tierReason: string;
    openAlerts: number | null;
    worstSeverity: string | null;
  };
  alerts: RepoAlertRow[];
  updatePrs: RepoPrRow[];
  prSection: SectionState;
  /**
   * Plain pull requests. No lane collects them until Epic 3, so the list is
   * empty by construction and the section is never attested: the page says
   * `not confirmed by any completed sweep`, never `0` (AD-28).
   */
  pulls: never[];
  pullsSection: SectionState;
  issues: RepoIssueRow[];
  issueSection: SectionState;
  runs: RepoRunRow[];
  actionsSection: SectionState;
  /**
   * Review requests on THIS repository only, even though the lane collects
   * them estate-wide: this page is about one watched repository, and a row
   * from elsewhere has no business on it. The estate-wide list lives at
   * /reviews.
   */
  reviews: RepoReviewRow[];
  reviewSection: SectionState;
  /**
   * Rows stored for this repository that could not be read. Rendered, never
   * dropped: a page quietly missing items looks complete.
   */
  unreadable: number;
  /**
   * Node-keyed rows (pull requests, issues, workflow runs) anywhere in the
   * store that could not be read at all.
   *
   * Deliberately NOT scoped to this repository, because it cannot be: their
   * repository lives in the payload, and the payload is what failed to read.
   * Such a row might belong here or anywhere else, so the page reports it as
   * exactly that rather than either claiming it or quietly dropping it.
   */
  unattributable: number;
}

export interface RepoViewDeps {
  policy: FreshnessPolicy;
  /** The coverage lane's own daily cadence (AD-11). */
  coveragePolicy?: FreshnessPolicy;
  /**
   * The Actions lane's own hourly cadence (AD-11).
   *
   * Required, as it is on `QueueDeps`, and for the same reason: this view
   * and the overview derive the same CI facts from the same rows, and one
   * of them silently falling back to the fifteen-minute sweep budget would
   * make a repository read `now` on one page and `quiet` on the other.
   */
  actionsPolicy: FreshnessPolicy;
  /** The KEV catalogue's own cadence, for the chain's first term (AD-11). */
  kevPolicy?: FreshnessPolicy;
  /** Thresholds only; the chain order is code (AD-20). */
  rankPolicy?: RankPolicy;
  /** The `now` cut as a term rank (AD-29). */
  cutRank?: number;
  /** Days a review request may wait before the repository is at least soon. */
  reviewBudgetDays?: number;
  /**
   * How long a run may sit unfinished before this page calls it hung.
   *
   * Explicit rather than derived from a freshness policy, because the only
   * policy this page reliably has is the ALERT lane's fifteen minutes, and a
   * page that called a forty-minute run hung while the lane did not would be
   * the disagreement the verdict exists to prevent. The wiring passes twice
   * the Actions cadence, the same expression the lane's wiring uses.
   */
  hungAfterMs?: number;
  /**
   * What this repository calls its default branch, in production
   * `resolveDefaultBranch` bound to the loaded config (AD-33), or null when
   * the caller could not say.
   *
   * Required, with no default. It no longer only orders the run list: the
   * header's tier now comes from a queue that derives a CI item from this
   * branch, so a silent `main` here would make a `master` repository read
   * `quiet` on its own page while the overview read `now` from the very
   * same rows. Null derives no item and treats no run as a build of main.
   */
  defaultBranch: string | null;
}

/** Rows of one node-keyed type belonging to this repository. */
function forRepo<T extends { repo: string }>(
  values: readonly CurrentValue[],
  slug: string,
  read: (payload: unknown) => T | null,
): { rows: { value: CurrentValue; payload: T }[]; unattributable: number } {
  const rows: { value: CurrentValue; payload: T }[] = [];
  let unattributable = 0;
  for (const value of values) {
    if (value.state !== "present") continue;
    const payload = read(value.payload);
    if (payload === null) {
      // A row we cannot read has no readable repository either, so it cannot
      // be attributed to this page or ruled out of it. Counted and shown as
      // exactly that, because silently skipping it would let a malformed row
      // belonging to THIS repository leave the page looking complete.
      unattributable++;
      continue;
    }
    if (payload.repo.toLowerCase() !== slug) continue;
    rows.push({ value, payload });
  }
  return { rows, unattributable };
}

/**
 * Assemble one repository's view.
 *
 * Reads through named StorePort queries only; no SQL and no predicate
 * composed at a route (AD-27). Node-keyed subjects carry their repository in
 * the payload, not the key, which is why the filtering happens here rather
 * than in a store query.
 */
export function buildRepoView(
  store: StorePort,
  repo: RepoRef,
  now: Date,
  deps: RepoViewDeps,
): RepoView {
  const slug = watchKey(repo);
  const installation = repo.owner.toLowerCase();
  let unreadable = 0;
  let unattributable = 0;

  const confirmation = store
    .currentByType("repository")
    .find((v) => v.state === "present" && v.subject.key === slug);
  const summaryPayload = confirmation?.payload as RepoObservation | undefined;

  const coverageValue = store
    .currentByType("repository_coverage")
    .find((v) => v.state === "present" && v.subject.key === slug);
  // Coverage is trusted only while its own attestation is fresh, exactly as
  // on the overview: a dead coverage lane must not keep a cached
  // `covered` badging a confident zero (AD-28).
  const coverageFresh =
    coverageValue !== undefined &&
    freshness(
      coverageValue.verifiedAt,
      now,
      deps.coveragePolicy ?? deps.policy,
    ) === "fresh";
  const features =
    coverageValue && coverageFresh
      ? coverageFeatures(coverageValue.payload as CoverageObservation)
      : null;
  // Positive evidence that DEPENDABOT is not covered, and nothing else - the
  // same one fact the overview keys on, so the two surfaces agree by
  // construction rather than by two people remembering the same rule (#152).
  // `unknown` is not such evidence: it is what a stale coverage attestation
  // degrades to and what a feature nobody has asked GitHub about reads as, and
  // blanking on it would let one dead coverage lane wipe correct counts off
  // every page in the estate (AD-28). Decided here, once, so the renderer
  // cannot reach a different conclusion from the same data.
  const notCovered = features !== null && isOff(features.dependabot.state);
  const coverageReasons = features === null ? [] : coverageNotes(features);
  const known = !notCovered;

  // The one tier computation (AD-34). Nothing on this page derives a tier
  // from the rows it lists; it reads this result. Coverage is decided first
  // and handed in, so a repository this page refuses to count alerts for is
  // not at the same time judged `now` by one of them.
  const rankPolicy = deps.rankPolicy ?? DEFAULT_RANK_POLICY;
  const { actionsPolicy, defaultBranch } = deps;
  const hungAfterMs = deps.hungAfterMs ?? DEFAULT_HUNG_AFTER_MS;
  const attention = repoAttention(
    store,
    repo,
    now,
    {
      policy: deps.policy,
      kevPolicy: deps.kevPolicy ?? deps.policy,
      actionsPolicy,
      rankPolicy,
      cutRank: deps.cutRank ?? defaultCutRank(rankPolicy),
      reviewBudgetDays: deps.reviewBudgetDays ?? DEFAULT_REVIEW_BUDGET_DAYS,
      hungAfterMs,
      // One repository's page, so one branch: `repoAttention` keeps only this
      // repository's items and discards the rest, so a run in some other
      // repository judged against this branch reaches nothing. Constant
      // rather than a resolver because this view is handed the resolved
      // value, not the resolver (AD-33).
      defaultBranchOf: () => defaultBranch,
    },
    notCovered ? new Set([slug]) : undefined,
  );
  // Counted from the same items the tier was judged on, so the sentence
  // beside the chip cannot disagree with it (AD-32). With no alert items
  // there is nothing to count, and the lane's confirmation, or its absence,
  // is the honest answer.
  const counted = attention.openAlerts > 0;

  const alertValues = store.currentByTypeForOwner(
    "dependabot_alert",
    installation,
  );
  const alerts: RepoAlertRow[] = [];
  for (const value of alertValues) {
    if (value.state !== "present") continue;
    // Attributed by SUBJECT KEY, not payload: alert keys are
    // `owner/name#number` (AD-22), so a row too malformed to read still says
    // which repository it belongs to. Counting unreadable rows before this
    // check made one corrupt row in a sibling repository mark every page in
    // the organisation incomplete.
    const keyRepo = value.subject.key.split("#")[0]?.toLowerCase() ?? "";
    if (keyRepo !== slug) continue;
    const alert = readAlert(value.payload);
    if (alert === null) {
      unreadable++;
      continue;
    }
    if (alert.repo.toLowerCase() !== slug) {
      // The key says this repository and the payload says another. Both are
      // written from the same RepoRef at ingest (AD-22), so they cannot
      // disagree on anything this system wrote: the row is corrupt. Counted
      // rather than skipped, because a row we refuse to believe is exactly
      // the kind of thing a page must not hide.
      unreadable++;
      continue;
    }
    alerts.push({
      number: alert.number,
      severity: alert.severity,
      advisory: alert.cveId ?? alert.ghsaId ?? null,
      packageName: alert.packageName ?? null,
      htmlUrl: safeUrl(alert.htmlUrl),
      freshness: freshness(value.verifiedAt, now, deps.policy),
      age: ageLabel(value.verifiedAt, now),
    });
  }
  alerts.sort((a, b) => a.number - b.number);

  // What dependabotUpdate said per alert, read for the one thing this page
  // wants from it: which alerts a PR was opened for. Status keys are
  // `owner/name#alert` (AD-22), so the repository check is on the key, like
  // the alerts above, and the same key-versus-payload rule applies: a row
  // whose payload names another repository or another alert number than
  // its key is corrupt, and is counted rather than believed or hidden. A
  // row that merely fails the shape check is skipped, not counted: a
  // status is never itself an item, and its absence reads as `none on
  // record`.
  const alertsByPr = new Map<number, Set<number>>();
  for (const value of store.currentByTypeForOwner(
    "dependabot_update_status",
    installation,
  )) {
    if (value.state !== "present") continue;
    const [keyRepo, keyNumber] = value.subject.key.split("#");
    if ((keyRepo?.toLowerCase() ?? "") !== slug) continue;
    const status = readStatus(value.payload);
    if (status === null) continue;
    if (
      status.repo.toLowerCase() !== slug ||
      String(status.alertNumber) !== keyNumber
    ) {
      unreadable++;
      continue;
    }
    const pr = status.update?.pullRequestNumber;
    if (pr === null || pr === undefined) continue;
    const linked = alertsByPr.get(pr) ?? new Set<number>();
    linked.add(status.alertNumber);
    alertsByPr.set(pr, linked);
  }

  const prResult = forRepo(
    store.currentByType("dependency_update_pr"),
    slug,
    readPr,
  );
  unattributable += prResult.unattributable;
  const updatePrs = prResult.rows
    .map(({ value, payload }) => ({
      number: payload.number,
      title: payload.title,
      packageName: payload.packageName,
      linkedAlerts: [...(alertsByPr.get(payload.number) ?? [])].sort(
        (a, b) => a - b,
      ),
      htmlUrl: safeUrl(payload.htmlUrl),
      freshness: freshness(value.verifiedAt, now, deps.policy),
      age: ageLabel(value.verifiedAt, now),
    }))
    .sort((a, b) => a.number - b.number);

  const issueResult = forRepo(store.currentByType("issue"), slug, readIssue);
  unattributable += issueResult.unattributable;
  const issues = issueResult.rows
    .map(({ value, payload }) => ({
      number: payload.number,
      title: payload.title,
      author: payload.author,
      htmlUrl: safeUrl(payload.htmlUrl),
      freshness: freshness(value.verifiedAt, now, deps.policy),
      age: ageLabel(value.verifiedAt, now),
    }))
    .sort((a, b) => a.number - b.number);

  const reviewResult = forRepo(
    store.currentByType("review_request"),
    slug,
    readReviewRequest,
  );
  // Its unreadable rows are deliberately NOT counted here. Every other lane
  // feeding forRepo is allowlist-scoped, so an unreadable row of theirs
  // plausibly belongs to this estate; this lane is estate-wide by design and
  // 38 of 40 measured rows were in repositories nobody watches, so one
  // corrupt third-party row would mark EVERY watched repository's page
  // incomplete - the same failure the alert loop above already fixed once.
  // The /reviews page counts them, where the reader is looking at the
  // estate-wide list those rows actually belong to.
  const reviews: RepoReviewRow[] = reviewResult.rows
    // Oldest first, as /reviews sorts: the Waiting column only reads
    // sensibly in that order. Ties break on the key so the list does not
    // reshuffle between refreshes.
    .sort(
      (a, b) =>
        a.payload.createdAt.localeCompare(b.payload.createdAt) ||
        a.value.subject.key.localeCompare(b.value.subject.key),
    )
    .map(({ value, payload }) => ({
      key: value.subject.key,
      number: payload.number,
      title: payload.title,
      htmlUrl: safeUrl(payload.htmlUrl),
      requestedReviewers: payload.requestedReviewers,
      waiting: Number.isNaN(new Date(payload.createdAt).getTime())
        ? "unknown"
        : ageLabel(payload.createdAt, now),
      freshness: freshness(value.verifiedAt, now, deps.policy),
      age: ageLabel(value.verifiedAt, now),
    }));

  const actionsConfirmation = store
    .currentByType("repository_actions")
    .find((v) => v.state === "present" && v.subject.key === slug);
  // The three conditions, and the reason they are one shared function, are
  // written where that function lives: the queue derives a `ci_failure` item
  // from exactly this judgement and the board's CI chip counts them, so a
  // copy here could let one page show a failing build while the next reads
  // `unconfirmed` off the same row. Failing it, the section falls back to
  // the lane's own standing, which says "collected earlier, not confirmed
  // since" rather than asserting a count.
  const vouched = actionsVouched(actionsConfirmation, now, actionsPolicy);

  const runResult = forRepo(
    store.currentByType("workflow_run"),
    slug,
    readWorkflowRun,
  );
  // No declared branch means no run can be shown to be a build of main, and
  // saying otherwise would be a guess: the list falls back to run order.
  const onDefaultBranch = (row: RepoRunRow): boolean =>
    defaultBranch !== null && isDefaultBranchRun(row, defaultBranch);
  unattributable += runResult.unattributable;
  const runs = runResult.rows
    .map(({ value, payload }) => ({
      key: value.subject.key,
      workflowName: payload.workflowName,
      runNumber: payload.runNumber,
      status: payload.status,
      conclusion: payload.conclusion,
      verdict: runVerdict(payload, now, hungAfterMs),
      headBranch: payload.headBranch,
      event: payload.event,
      htmlUrl: safeUrl(payload.htmlUrl),
      freshness: freshness(value.verifiedAt, now, deps.policy),
      age: ageLabel(value.verifiedAt, now),
    }))
    // Total by its own terms; see compareRunRows. A sort on the workflow name
    // alone tied between the two rows the lane now retains per workflow, and
    // left their order to whatever the store happened to return.
    .sort((a, b) => compareRunRows(a, b, onDefaultBranch));

  return {
    slug,
    coverageReasons,
    notCovered,
    summary: {
      tier: attention.tier,
      tierReason: attention.reason,
      // Suppressed on positive evidence of non-coverage only: a number beside
      // "not covered" invites the reader to believe it (AD-28).
      openAlerts: !known
        ? null
        : counted
          ? attention.openAlerts
          : (summaryPayload?.openAlerts ?? null),
      worstSeverity: !known
        ? null
        : counted
          ? attention.worstSeverity
          : (summaryPayload?.worstSeverity ?? null),
      attested: confirmation !== undefined,
      freshness: freshness(confirmation?.verifiedAt ?? null, now, deps.policy),
      age: ageLabel(confirmation?.verifiedAt ?? null, now),
    },
    alerts,
    updatePrs,
    prSection: laneAttestation(
      store,
      UPDATE_PR_LANE,
      installation,
      now,
      deps.policy,
    ),
    pulls: [],
    // No lane, no run rows, nothing to attest. Spelled out rather than read
    // from a lane that does not exist, so the section cannot be mistaken
    // for one whose lane merely has not run yet.
    pullsSection: {
      attested: false,
      freshness: "unknown",
      age: ageLabel(null, now),
    },
    issues,
    issueSection: laneAttestation(
      store,
      ISSUE_LANE,
      installation,
      now,
      deps.policy,
    ),
    runs,
    // This repository's OWN attestation, not the lane's. A bounded sweep
    // reaches some repositories and yields before others (AD-24), so a
    // lane-wide verdict would mark every repository unconfirmed because one
    // was missed - or worse, confirm one the sweep never reached. Falls
    // back to the lane while no per-repository confirmation exists yet.
    // A confirmation for this repository, once one exists, is the whole
    // answer: falling back to the lane's verdict when the confirmation is
    // unreadable or stale would re-assert precisely what the per-repository
    // check just refused. The lane is consulted only while no confirmation
    // exists at all, which is the state before this repository's first
    // sweep.
    actionsSection: actionsConfirmation
      ? {
          attested: vouched,
          freshness: freshness(
            actionsConfirmation.verifiedAt,
            now,
            actionsPolicy,
          ),
          age: ageLabel(actionsConfirmation.verifiedAt, now),
        }
      : laneAttestation(store, ACTIONS_LANE, installation, now, actionsPolicy),
    reviews,
    reviewSection: laneAttestation(
      store,
      REVIEWS_LANE,
      // The review lane runs on its own pseudo-installation, not this
      // repository's owner: its search is global.
      REVIEWS_INSTALLATION,
      now,
      deps.policy,
    ),
    unreadable,
    unattributable,
  };
}
