/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { CoverageState } from "../../core/coverage.js";
import { coverageReason, isCovered } from "../../core/coverage.js";
import type { RepoRef } from "../../core/types.js";
import type { CoverageObservation } from "../collect/coverage.js";
import type { RepoObservation } from "../collect/dependabot-alerts.js";
import { watchKey } from "../collect/dependabot-alerts.js";
import { LANE as ISSUE_LANE } from "../collect/issues.js";
import { LANE as UPDATE_PR_LANE } from "../collect/update-prs.js";
import { LANE as ACTIONS_LANE } from "../collect/workflow-runs.js";
import type { CurrentValue, StorePort } from "../store/port.js";
import {
  ageLabel,
  type Freshness,
  type FreshnessPolicy,
  freshness,
} from "./freshness.js";
import { readAlert, readIssue, readPr, readWorkflowRun } from "./payloads.js";

// The per-repository view (CAP-7): every lane's signals for one repository,
// each carrying its own freshness.
//
// The hard part here is not assembly, it is absence. Every section can be
// empty for two entirely different reasons - we looked and there is nothing,
// or we never looked - and a page that renders those the same way is the lie
// this dashboard exists to avoid (AD-28). Each section therefore carries an
// explicit `attested` flag rather than leaving the reader to infer it from a
// count of zero.

/** One section's standing: did anything actually establish this is complete? */
export interface SectionState {
  /**
   * True when a lane confirmed this repository's set, so an empty list means
   * "none". False means "we have not looked", and the page says so.
   */
  attested: boolean;
  freshness: Freshness;
  age: string;
}

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
  author: string;
  packageName: string | null;
  bump: string | null;
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
  /** The alert-lane confirmation: counts, and whether they are current. */
  summary: SectionState & {
    openAlerts: number | null;
    worstSeverity: string | null;
  };
  alerts: RepoAlertRow[];
  updatePrs: RepoPrRow[];
  prSection: SectionState;
  issues: RepoIssueRow[];
  issueSection: SectionState;
  runs: RepoRunRow[];
  actionsSection: SectionState;
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
}

/** Every https URL survives; anything else is dropped, never rendered. */
function safeUrl(url: string | null | undefined): string | null {
  return url?.startsWith("https://") ? url : null;
}

/**
 * Whether a lane vouched for this installation's set, and how current that
 * claim is.
 *
 * Read from the lane's own run rows rather than from the presence of data,
 * because presence cannot distinguish the two empties. Only an `ok` run
 * counts: a partial one skipped something, and it may have been exactly this
 * repository.
 */
function laneAttestation(
  store: StorePort,
  lane: string,
  installation: string,
  now: Date,
  policy: FreshnessPolicy,
): SectionState {
  const run = store
    .latestRunPerKey()
    .filter((r) => r.lane === lane)
    .filter((r) => r.installation.toLowerCase() === installation)
    .filter((r) => r.scope === "full")
    .sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))[0];
  if (!run || run.outcome !== "ok") {
    return {
      attested: false,
      freshness: freshness(run?.verifiedAt ?? null, now, policy),
      age: ageLabel(run?.verifiedAt ?? null, now),
    };
  }
  return {
    attested: true,
    freshness: freshness(run.verifiedAt, now, policy),
    age: ageLabel(run.verifiedAt, now),
  };
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
  // on the repository list: a dead coverage lane must not keep a cached
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
      author: payload.author,
      packageName: payload.packageName,
      bump: payload.bump,
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
      // Suppressed on positive evidence of non-coverage only: a number beside
      // "not covered" invites the reader to believe it (AD-28).
      openAlerts: known && summaryPayload ? summaryPayload.openAlerts : null,
      worstSeverity: known ? (summaryPayload?.worstSeverity ?? null) : null,
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
    issues,
    issueSection: laneAttestation(
      store,
      ISSUE_LANE,
      installation,
      now,
      deps.policy,
    ),
    runs,
    actionsSection: laneAttestation(
      store,
      ACTIONS_LANE,
      installation,
      now,
      deps.actionsPolicy ?? deps.policy,
    ),
    unreadable,
    unattributable,
  };
}
