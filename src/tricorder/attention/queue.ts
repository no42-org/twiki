/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { isDefaultBranchRun } from "../../core/branch.js";
import {
  compareRankings,
  NOT_APPLICABLE,
  type Ranking,
  type RankPolicy,
  rank,
} from "../../core/rank.js";
import { isBrokenVerdict, runVerdict } from "../../core/run-verdict.js";
import { safeUrl } from "../../core/safe-url.js";
import { normaliseSeverity, type Severity } from "../../core/severity.js";
import { foldSlug } from "../../core/slug.js";
import {
  KIND_REASONS,
  kevListedFor,
  type QueueKind,
} from "../../core/topics.js";
import type { RepoRef } from "../../core/types.js";
import type { UpdateStatusObservation } from "../collect/update-status.js";
import type { WorkflowRunObservation } from "../collect/workflow-runs.js";
import type { CurrentValue, StorePort } from "../store/port.js";
import {
  actionsConfirmations,
  actionsVouched,
} from "./actions-confirmation.js";
import {
  ageLabel,
  type Freshness,
  type FreshnessPolicy,
  freshness,
} from "./freshness.js";
import { kevSignal, loadKevIndex } from "./kev-lookup.js";
import {
  readAlert,
  readIssue,
  readPr,
  readStatus,
  readWorkflowRun,
} from "./payloads.js";

// The ranked queue (CAP-6): one cross-repository list answering "what should I
// deal with next, and why does it rank there".
//
// This is the first production caller of the ranking chain. Until it existed,
// rank() and the KEV lookup were deletable with a green suite, a gap three
// review rounds flagged in a row.

export interface QueueItem {
  kind: QueueKind;
  /**
   * The subject key: `owner/name#number` for alerts, the node id for PRs and
   * issues, and `owner/name#workflow:<id>` for a CI failure.
   *
   * A `ci_failure` is the one kind whose key is not a stored row's key,
   * because the item is not a stored row: it is one workflow's standing, and
   * a rerun that breaks the same workflow again is the same thing needing
   * the same attention. Keyed by the workflow rather than by the run, so a
   * rerun replaces the item instead of adding a second one.
   */
  key: string;
  repo: string;
  number: number;
  packageName: string | null;
  /**
   * The issue title, or the workflow's name on a CI failure. Null for alerts
   * and PRs, whose package says enough.
   */
  title: string | null;
  /** The advisory id shown to the reader: CVE when present, else GHSA. */
  advisory: string | null;
  htmlUrl: string | null;
  /** CAP-6's "why does it rank there", most significant term first. */
  explanation: string;
  /**
   * Confirmed listed in CISA KEV. The one state the page shouts about, and
   * only a kind whose KEV term is a catalogue lookup can be in it (AD-31).
   */
  kevListed: boolean;
  /**
   * The severity word a chip may show for this item, or null when the kind
   * carries none it could vouch for. The chain's severity term is the rank;
   * this is the display, and the two are set from one value so they agree.
   */
  displaySeverity: Severity | null;
  ranking: Ranking;
  freshness: Freshness;
  age: string;
}

export interface Queue {
  items: QueueItem[];
  /**
   * Rows whose payload could not be read as an alert. Rendered, never silently
   * dropped: a queue quietly missing items looks complete, which is the
   * confident-zero defect wearing a queue costume.
   */
  unreadable: number;
  /** The KEV catalogue's own standing, because every KEV verdict derives from it. */
  kev: { usable: boolean; version: string | null; age: string };
}

export interface QueueDeps {
  /** Freshness budget for alert rows: the sweep cadence that confirms them. */
  policy: FreshnessPolicy;
  /** Freshness budget for the KEV catalogue: its own daily cadence (AD-11). */
  kevPolicy: FreshnessPolicy;
  /**
   * Freshness budget for the Actions lane: its own hourly cadence (AD-11).
   *
   * It decides two things at once, which is why it is one value: whether a
   * repository's confirmation is current enough to derive a `ci_failure`
   * from, and how fresh the resulting item's own badge reads.
   */
  actionsPolicy: FreshnessPolicy;
  /** Thresholds only. The chain order is code and nothing here reorders it (AD-20). */
  rankPolicy: RankPolicy;
  /**
   * How long a workflow run may sit unfinished before it counts as hung.
   * Callers pass twice the Actions cadence, the same expression the lane's
   * wiring uses, so a run this builder calls broken is one the lane counted
   * as failing.
   */
  hungAfterMs: number;
  /**
   * What a repository calls its default branch, in production
   * `resolveDefaultBranch` bound to the loaded config (AD-33), or null when
   * the caller could not say.
   *
   * Required, with no default: a fallback of `main` here would let the
   * binding be dropped with the suite green, and then every repository on
   * `master` would silently stop reporting a red main - the exact failure
   * this whole line of work exists to prevent.
   *
   * Null rather than a fallback for the same reason. `createApp` guards the
   * resolver so one throwing config cannot 500 the dashboard, and a guard
   * that answered `main` would turn that error into a measured zero on the
   * CI chip of every repository that is not on `main`. Null derives no item,
   * and the chip beside it reads `unconfirmed`.
   */
  defaultBranchOf: (repo: RepoRef) => string | null;
}

/**
 * The `owner/name` a stored row carries, as a ref the resolver can take.
 *
 * Null for anything that is not exactly two segments: a slug we cannot split
 * is one we cannot ask about, and inventing an owner from it would ask the
 * resolver a question about a repository that does not exist.
 */
function refOf(slug: string): RepoRef | null {
  const parts = slug.split("/");
  if (parts.length !== 2) return null;
  const [owner, name] = parts;
  if (!owner || !name) return null;
  return { owner, name };
}

/** A retained default-branch run, with the row it was read from. */
export interface DefaultBranchRun {
  row: CurrentValue;
  run: WorkflowRunObservation;
}

/**
 * Which of two runs of one workflow is the one to judge.
 *
 * The higher run number, then the lower subject key. The second term is what
 * makes it TOTAL, and it is not decoration: GitHub counts run numbers per
 * workflow and a re-run shares its number, so two rows can tie on it, and a
 * tie resolved by whatever order the store returned would let the item name
 * one run's link and the other's verdict between two refreshes. The run list
 * on the repository page breaks the same tie the same way.
 *
 * Exported so it can be asserted directly, for the same reason
 * `compareRunRows` is: that second term is invisible through `buildQueue`,
 * because `currentByType` already returns rows in subject-key order and the
 * first row of a tie is the one held, so the rows come out right whether or
 * not the term is there - until the store's ORDER BY changes.
 */
export function newerRun(a: DefaultBranchRun, b: DefaultBranchRun): boolean {
  if (a.run.runNumber !== b.run.runNumber) {
    return a.run.runNumber > b.run.runNumber;
  }
  return a.row.subject.key.localeCompare(b.row.subject.key) < 0;
}

export function buildQueue(
  store: StorePort,
  now: Date,
  deps: QueueDeps,
): Queue {
  const index = loadKevIndex(store, now, deps.kevPolicy);

  // What dependabotUpdate said, read before the alert pass because both later
  // passes consume it: the alert's stuck flag comes from the status keyed like
  // the alert itself, and a status naming a PR number is the precise
  // alert-to-PR link the package heuristic only approximates.
  const statusByAlertKey = new Map<string, UpdateStatusObservation>();
  const linksByPr = new Map<
    string,
    { alertKey: string; error: string | null }[]
  >();
  for (const row of store.currentByType("dependabot_update_status")) {
    if (row.state !== "present") continue;
    const status = readStatus(row.payload);
    if (status === null) continue;
    statusByAlertKey.set(row.subject.key, status);
    if (status.update?.pullRequestNumber != null) {
      const prKey = `${status.repo.toLowerCase()}|${status.update.pullRequestNumber}`;
      const list = linksByPr.get(prKey) ?? [];
      // The error rides along: a status can carry BOTH a PR and an error
      // (the PR opened, a later update attempt failed), and the PR row must
      // agree with the alert row about it rather than say "prepared
      // normally" one line away from "could not prepare".
      list.push({ alertKey: row.subject.key, error: status.update.error });
      linksByPr.set(prKey, list);
    }
  }

  const items: QueueItem[] = [];
  let unreadable = 0;

  // Filled during the alert pass, read during the PR pass. One derivation of
  // kev and severity per alert: two copy-parallel loops let the two drift, and
  // a PR could "inherit" a risk disagreeing with the alert row beside it.
  interface AlertTerms {
    kev: ReturnType<typeof kevSignal>;
    epss: number | null;
    severity: ReturnType<typeof normaliseSeverity>;
    advisory: string | null;
  }
  const alertsByPackage = new Map<string, AlertTerms[]>();
  // The same triples keyed by subject key, for the precise status-driven join.
  const alertsByKey = new Map<string, AlertTerms>();

  for (const row of store.currentByType("dependabot_alert")) {
    if (row.state !== "present") continue;
    const alert = readAlert(row.payload);
    if (alert === null) {
      unreadable++;
      continue;
    }

    const kev = kevSignal(index, alert.cveId);
    const severity = normaliseSeverity(alert.severity ?? "");
    const terms: AlertTerms = {
      kev,
      epss: alert.epssPercentage,
      severity,
      advisory: alert.cveId ?? alert.ghsaId ?? null,
    };
    alertsByKey.set(row.subject.key, terms);
    if (alert.packageName !== null) {
      const key = `${alert.repo.toLowerCase()}|${alert.packageName.toLowerCase()}`;
      const list = alertsByPackage.get(key) ?? [];
      list.push(terms);
      alertsByPackage.set(key, list);
    }
    // The stuck flag (CAP-3): a status naming an error means GitHub tried to
    // prepare the fix and could not, so nothing is coming automatically. No
    // status row means we have not looked yet, which is unknown, never "fine"
    // (AD-20); a status whose update is null means GitHub is not attempting a
    // fix at all, which is a fact of absence (n/a), not a gap.
    const status = statusByAlertKey.get(row.subject.key);
    const stuck =
      status === undefined
        ? null
        : status.update === null
          ? NOT_APPLICABLE
          : status.update.error !== null;
    const ranking = rank(
      {
        // An alert is not a statement about a build (AD-20's n/a, not its
        // unknown): there is nothing to know here, so it ranks least and the
        // term stays silent in the explanation.
        broken: NOT_APPLICABLE,
        kev,
        // Explicit null stays null: absent EPSS ranks as unknown, never as
        // zero risk (AD-20), and 9 of the 67 alerts measured on the live
        // estate carried none, so this is a standing path, not a corner.
        epss: alert.epssPercentage,
        // An unrecognised severity becomes null and ranks as unknown, which is
        // what the adapter's own "unknown" value should do.
        severity,
        // An alert is not an update: nothing to bump.
        bump: NOT_APPLICABLE,
        stuck,
      },
      deps.rankPolicy,
      KIND_REASONS.alert,
    );

    items.push({
      kind: "alert",
      key: row.subject.key,
      repo: alert.repo,
      number: alert.number,
      packageName: alert.packageName ?? null,
      title: null,
      advisory: alert.cveId ?? alert.ghsaId ?? null,
      // GitHub only ever hands out https URLs, so anything else in this field
      // is a corrupted or foreign row, and this is the first store-derived
      // href in the codebase: hono/jsx renders `javascript:` schemes verbatim.
      htmlUrl: safeUrl(alert.htmlUrl),
      explanation: ranking.explanation,
      kevListed: kevListedFor("alert") && kev === true,
      displaySeverity: severity,
      ranking,
      freshness: freshness(row.verifiedAt, now, deps.policy),
      age: ageLabel(row.verifiedAt, now),
    });
  }

  // The key tiebreak cannot be observed through the store today, because
  // currentByType already returns rows ORDER BY subject_key and this sort is
  // stable. It stays as defence: that SQL clause is one edit away from
  // disappearing, and a queue that reshuffles between refreshes on rank ties
  // would look broken in a way no test of ordering-by-rank catches.
  // The update PRs (CAP-3), ranked by the risk of what they fix. The join is
  // local: alertsByPackage was filled during the single pass over the alerts
  // above, so a PR bumping a package with an open alert inherits the
  // worst-ranking alert's top three terms. A PR whose package has no open
  // alert is a plain update, and its security terms are facts of absence
  // (n/a), not gaps (unknown): calling them unknown would float every routine
  // bump above every alert we checked and found absent.
  for (const row of store.currentByType("dependency_update_pr")) {
    if (row.state !== "present") continue;
    const pr = readPr(row.payload);
    if (pr === null) {
      unreadable++;
      continue;
    }

    // The precise join first: a status row naming this PR's number is
    // GitHub's own statement of which alert the PR fixes, so when one exists
    // it wins over the title-parsed package heuristic, INCLUDING when the
    // named alert row cannot be read: falling back to the heuristic there
    // would re-inherit a different alert's risk, the exact wrong-alert
    // inheritance the join exists to fix. The stuck term comes from the
    // linked statuses' own error fields, not from the PR's existence.
    const links = linksByPr.get(`${pr.repo.toLowerCase()}|${pr.number}`) ?? [];
    const linked = links
      .map((link) => alertsByKey.get(link.alertKey))
      .filter((terms): terms is AlertTerms => terms !== undefined);

    const candidates =
      links.length > 0
        ? linked
        : pr.packageName === null
          ? []
          : // Folded on both sides: the alert name comes from GitHub's
            // ecosystem-normalised advisory data (pip says django) while the PR
            // title carries manifest casing (Bump Django from ...), and a case
            // miss silently loses the CAP-3 risk inheritance.
            (alertsByPackage.get(
              `${pr.repo.toLowerCase()}|${pr.packageName.toLowerCase()}`,
            ) ?? []);
    const prStuck =
      links.length === 0
        ? NOT_APPLICABLE
        : links.some((link) => link.error !== null);

    // A PR with candidates takes its terms from them, even when a candidate
    // happens to tie the all-n/a baseline: seeding from the baseline and
    // comparing strictly lost the advisory on exactly that tie, and the row
    // said "no advisory" about a PR that fixes a real one.
    let best: Ranking;
    let advisory: string | null;
    let kevListed: boolean;
    let displaySeverity: Severity | null;
    if (candidates.length === 0) {
      // Two different absences (AD-20). A status names an alert we could not
      // read: there IS an advisory, we failed to see it, so the security
      // terms are unknown. No link and no package match: a plain update, and
      // its security terms are facts of absence.
      const linkedButUnreadable = links.length > 0;
      best = rank(
        {
          broken: NOT_APPLICABLE,
          kev: linkedButUnreadable ? null : NOT_APPLICABLE,
          epss: linkedButUnreadable ? null : NOT_APPLICABLE,
          severity: linkedButUnreadable ? null : NOT_APPLICABLE,
          bump: pr.bump,
          stuck: prStuck,
        },
        deps.rankPolicy,
        KIND_REASONS.update_pr,
      );
      advisory = null;
      kevListed = false;
      displaySeverity = null;
    } else {
      const ranked = candidates.map((c) => ({
        c,
        r: rank(
          {
            broken: NOT_APPLICABLE,
            kev: c.kev,
            epss: c.epss,
            severity: c.severity,
            bump: pr.bump,
            stuck: prStuck,
          },
          deps.rankPolicy,
          KIND_REASONS.update_pr,
        ),
      }));
      // The worst-ranking alert wins: a PR fixing two advisories is judged by
      // the more urgent of them.
      ranked.sort((a, b) => compareRankings(a.r, b.r));
      const winner = ranked[0] as (typeof ranked)[number];
      best = winner.r;
      advisory = winner.c.advisory;
      kevListed = kevListedFor("update_pr") && winner.c.kev === true;
      displaySeverity = winner.c.severity;
    }

    items.push({
      kind: "update_pr",
      key: row.subject.key,
      repo: pr.repo,
      number: pr.number,
      packageName: pr.packageName,
      title: null,
      advisory,
      htmlUrl: safeUrl(pr.htmlUrl),
      explanation: best.explanation,
      kevListed,
      displaySeverity,
      ranking: best,
      freshness: freshness(row.verifiedAt, now, deps.policy),
      age: ageLabel(row.verifiedAt, now),
    });
  }

  // Untriaged issues (CAP-2). Every security term is a fact of absence: an
  // issue carries no CVE, no advisory and no update, so all-n/a is the honest
  // ranking and it sinks below every alert we actually measured. The chain's
  // default wording would recite five absences, so the issue table words them
  // as the one thing that is true (AD-31); the explanation is still the
  // chain's own, not an override written beside it.
  for (const row of store.currentByType("issue")) {
    if (row.state !== "present") continue;
    const issue = readIssue(row.payload);
    if (issue === null) {
      unreadable++;
      continue;
    }

    const ranking = rank(
      {
        broken: NOT_APPLICABLE,
        kev: NOT_APPLICABLE,
        epss: NOT_APPLICABLE,
        severity: NOT_APPLICABLE,
        bump: NOT_APPLICABLE,
        stuck: NOT_APPLICABLE,
      },
      deps.rankPolicy,
      KIND_REASONS.issue,
    );

    items.push({
      kind: "issue",
      key: row.subject.key,
      repo: issue.repo,
      number: issue.number,
      packageName: null,
      title: issue.title,
      advisory: null,
      htmlUrl: safeUrl(issue.htmlUrl),
      explanation: ranking.explanation,
      // An issue's KEV term is n/a by construction; kevListedFor says so, and
      // the page never gets a chance to shout about it.
      kevListed: kevListedFor("issue"),
      displaySeverity: null,
      ranking,
      freshness: freshness(row.verifiedAt, now, deps.policy),
      age: ageLabel(row.verifiedAt, now),
    });
  }

  // The CI failures (CAP: build failures). Nothing ships from a repository
  // whose default branch is red, so this is the chain's leading term and the
  // only kind that ever passes `true` for it.
  //
  // Derived, never persisted: nothing here writes a row, and the item exists
  // only while BOTH pieces of evidence are current - this repository's own
  // Actions confirmation, and the retained run row the verdict is read from.
  // Either one going stale removes the item, which is what stops a main
  // fixed outside the retained window, or a workflow nothing supersedes any
  // more, from pinning a repository at `now` for ever.
  //
  // The confirmation is a GATE, not a decoration. Without it a repository the
  // sweep has never reached and one whose main is green are both "no broken
  // rows", which is the confident zero this dashboard exists to refuse
  // (AD-28); the CI chip reads `unconfirmed` there instead, and the absence
  // of an item is then honest rather than reassuring.
  const vouched = new Set<string>();
  for (const [slug, value] of actionsConfirmations(store)) {
    if (actionsVouched(value, now, deps.actionsPolicy)) vouched.add(slug);
  }
  // One resolver call per repository rather than one per row: a repository
  // with thirty workflows asks the same question thirty times otherwise.
  const branches = new Map<string, string | null>();
  const defaultBranchOf = (slug: string): string | null => {
    let branch = branches.get(slug);
    if (branch === undefined) {
      const ref = refOf(slug);
      branch = ref === null ? null : deps.defaultBranchOf(ref);
      branches.set(slug, branch);
    }
    return branch;
  };

  // The NEWEST default-branch run per workflow, selected before anything
  // asks whether it is broken. Testing the verdict first would skip the
  // green re-run entirely and leave the failure it replaced still holding
  // the key, so a fixed main would go on reading red until the failing row
  // was superseded out of the store. The run list on the repository page
  // documents the same case from the other side.
  const latestByKey = new Map<string, DefaultBranchRun>();
  for (const row of store.currentByType("workflow_run")) {
    if (row.state !== "present") continue;
    const run = readWorkflowRun(row.payload);
    if (run === null) {
      // A row we hold and cannot read is stated, never dropped: a queue
      // quietly missing rows looks complete. Unlike the passes above, this
      // one cannot say whether the row WOULD have become an item - the
      // branch and the verdict are in the payload that failed to read - so
      // the count is "run rows we could not read", not "CI items lost". The
      // page's sentence is already worded as the lower bound it is.
      unreadable++;
      continue;
    }
    const slug = foldSlug(run.repo);
    if (!vouched.has(slug)) continue;
    const branch = defaultBranchOf(slug);
    // Two ways to get here, and neither is an unreadable row, so neither is
    // counted as one. The resolver declined, which the CI chip renders as
    // `unconfirmed` rather than as a zero; or the payload's slug does not
    // split into an owner and a name, which cannot actually happen past the
    // `vouched` check above - confirmation keys always carry the slash -
    // and is left as defence rather than as a path.
    if (branch === null) continue;
    // Through the shared predicate, never a bare branch comparison: the lane
    // and this builder must decide "is this a build of main" the same way
    // (AD-33), and only the event tells a fork's pull request apart from a
    // push to our own main (#141).
    if (!isDefaultBranchRun(run, branch)) continue;

    const key = `${slug}#workflow:${run.workflowId}`;
    const held = latestByKey.get(key);
    const candidate: DefaultBranchRun = { row, run };
    if (held === undefined || newerRun(candidate, held)) {
      latestByKey.set(key, candidate);
    }
  }

  for (const [key, { row, run }] of latestByKey) {
    // The deciding row's own freshness, beside the repository's. The
    // confirmation says the sweep reached this repository this hour; it says
    // nothing about THIS row, which the sweep only touches while the run is
    // inside the page it reads. A workflow deleted, renamed or gone quiet
    // keeps its last row for ever, and without this gate its last failure
    // would rank `now` for ever too, badged stale on the page that ranked it.
    if (freshness(row.verifiedAt, now, deps.actionsPolicy) !== "fresh") {
      continue;
    }
    const verdict = runVerdict(run, now, deps.hungAfterMs);
    if (!isBrokenVerdict(verdict)) continue;

    // The run's own age, not the row's: the reader wants to know how long
    // main has been red, and the row's `verifiedAt` moves every sweep. A
    // timestamp that will not parse is not evidence of an age, and a
    // `failure` conclusion is a broken build whether or not we can date it,
    // so the sentence says so rather than borrowing `ageLabel`'s "never
    // collected", which would be false of a run we plainly collected.
    const when = Number.isNaN(Date.parse(run.createdAt))
      ? "at an unknown time"
      : ageLabel(run.createdAt, now);
    const ranking = rank(
      {
        broken: true,
        // Not an advisory and not an update. Every security term is a fact
        // of absence, and the ci_failure table silences all five so the one
        // sentence a reader came for is the whole explanation.
        kev: NOT_APPLICABLE,
        epss: NOT_APPLICABLE,
        severity: NOT_APPLICABLE,
        bump: NOT_APPLICABLE,
        stuck: NOT_APPLICABLE,
      },
      deps.rankPolicy,
      {
        ...KIND_REASONS.ci_failure,
        // Per item, because the sentence carries this run's verdict word and
        // this run's age. A per-kind table could only say "broken", and the
        // difference between a workflow that failed and one that never
        // finished is exactly what the maintainer acts on differently.
        broken: {
          broken: `default branch workflow ${run.workflowName} ${verdict} ${when}`,
        },
      },
    );

    items.push({
      kind: "ci_failure",
      key,
      repo: run.repo,
      // The deciding run's number, so the row links to the run a reader can
      // open and not to the workflow in the abstract.
      number: run.runNumber,
      packageName: null,
      title: run.workflowName,
      advisory: null,
      htmlUrl: safeUrl(run.htmlUrl),
      explanation: ranking.explanation,
      // Its KEV term is n/a by construction, and kevListedFor says so: the
      // page never gets a chance to shout about it.
      kevListed: kevListedFor("ci_failure"),
      displaySeverity: null,
      ranking,
      // The Actions lane's own hourly cadence. Judged on the sweep's fifteen
      // minutes, every CI item would read stale within minutes of a
      // successful sweep (AD-11).
      freshness: freshness(row.verifiedAt, now, deps.actionsPolicy),
      age: ageLabel(row.verifiedAt, now),
    });
  }

  items.sort(
    (a, b) =>
      compareRankings(a.ranking, b.ranking) || a.key.localeCompare(b.key),
  );

  return {
    items,
    unreadable,
    kev: {
      usable: index.usable,
      version: index.version,
      age: ageLabel(index.verifiedAt, now),
    },
  };
}
