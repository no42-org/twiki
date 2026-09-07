/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { CoverageState } from "../../core/coverage.js";
import { coverageReason, isCovered } from "../../core/coverage.js";
import { DEFAULT_RANK_POLICY, type RankPolicy } from "../../core/rank.js";
import { safeUrl } from "../../core/safe-url.js";
import { watchKey } from "../../core/slug.js";
import {
  DEFAULT_REVIEW_BUDGET_DAYS,
  defaultCutRank,
  type Tier,
} from "../../core/tier.js";
import type { RepoRef } from "../../core/types.js";
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
import type { CoverageObservation } from "../collect/coverage.js";
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
  workflowName: string;
  runNumber: number;
  status: string;
  conclusion: string | null;
  headBranch: string | null;
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

export interface RepoView {
  slug: string;
  coverage: CoverageState | null;
  coverageReason: string | null;
  /**
   * GitHub is positively known not to be watching this repository, so it has
   * no count to be fresh or stale about and none is rendered (AD-28). False
   * for `unknown`, which means the coverage attestation went stale rather
   * than that coverage was withdrawn.
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
  /** The Actions lane's cadence, for judging its attestation. */
  actionsPolicy?: FreshnessPolicy;
  /** The KEV catalogue's own cadence, for the chain's first term (AD-11). */
  kevPolicy?: FreshnessPolicy;
  /** Thresholds only; the chain order is code (AD-20). */
  rankPolicy?: RankPolicy;
  /** The `now` cut as a term rank (AD-29). */
  cutRank?: number;
  /** Days a review request may wait before the repository is at least soon. */
  reviewBudgetDays?: number;
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
  const coverage = coverageValue
    ? freshness(
        coverageValue.verifiedAt,
        now,
        deps.coveragePolicy ?? deps.policy,
      ) === "fresh"
      ? (coverageValue.payload as CoverageObservation).state
      : "unknown"
    : null;
  // Positive evidence of non-coverage, and nothing else. `unknown` is not
  // such evidence: it is what a stale coverage attestation degrades to, and
  // blanking on it would let one dead coverage lane wipe correct counts off
  // every page in the estate (AD-28). Decided here, once, so the renderer
  // cannot reach a different conclusion from the same data.
  const notCovered =
    coverage !== null && !isCovered(coverage) && coverage !== "unknown";
  const known = !notCovered;

  // The one tier computation (AD-34). Nothing on this page derives a tier
  // from the rows it lists; it reads this result. Coverage is decided first
  // and handed in, so a repository this page refuses to count alerts for is
  // not at the same time judged `now` by one of them.
  const rankPolicy = deps.rankPolicy ?? DEFAULT_RANK_POLICY;
  const attention = repoAttention(
    store,
    repo,
    now,
    {
      policy: deps.policy,
      kevPolicy: deps.kevPolicy ?? deps.policy,
      rankPolicy,
      cutRank: deps.cutRank ?? defaultCutRank(rankPolicy),
      reviewBudgetDays: deps.reviewBudgetDays ?? DEFAULT_REVIEW_BUDGET_DAYS,
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
  // Three things have to hold before this section counts as vouched for,
  // and each was a real failure without it: the sweep reached this
  // repository, it could actually read what it found (null workflows means
  // it reached and could not), and the confirmation is still current. The
  // last is the same rule the coverage lookup above applies, for the same
  // reason: a lane that died days ago must not keep badging its last word
  // as though it were this hour's (AD-28). Failing any of them, the
  // section falls back to the lane's own standing, which says "collected
  // earlier, not confirmed since" rather than asserting a count.
  const actionsPayload = actionsConfirmation?.payload as
    | { workflows: number | null }
    | undefined;
  const actionsVouched =
    actionsConfirmation !== undefined &&
    actionsPayload?.workflows !== null &&
    actionsPayload?.workflows !== undefined &&
    freshness(
      actionsConfirmation.verifiedAt,
      now,
      deps.actionsPolicy ?? deps.policy,
    ) === "fresh";

  const runResult = forRepo(
    store.currentByType("workflow_run"),
    slug,
    readWorkflowRun,
  );
  unattributable += runResult.unattributable;
  const runs = runResult.rows
    .map(({ value, payload }) => ({
      workflowName: payload.workflowName,
      runNumber: payload.runNumber,
      status: payload.status,
      conclusion: payload.conclusion,
      headBranch: payload.headBranch,
      htmlUrl: safeUrl(payload.htmlUrl),
      freshness: freshness(value.verifiedAt, now, deps.policy),
      age: ageLabel(value.verifiedAt, now),
    }))
    .sort((a, b) => a.workflowName.localeCompare(b.workflowName));

  return {
    slug,
    coverage,
    coverageReason: coverage === null ? null : coverageReason(coverage),
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
          attested: actionsVouched,
          freshness: freshness(
            actionsConfirmation.verifiedAt,
            now,
            deps.actionsPolicy ?? deps.policy,
          ),
          age: ageLabel(actionsConfirmation.verifiedAt, now),
        }
      : laneAttestation(
          store,
          ACTIONS_LANE,
          installation,
          now,
          deps.actionsPolicy ?? deps.policy,
        ),
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
