/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { isDefaultBranchRef, isDefaultBranchRun } from "../../core/branch.js";
import {
  compareRankings,
  NOT_APPLICABLE,
  type Ranking,
  type RankPolicy,
  type ReasonTable,
  rank,
  type Signal,
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
import { VALIDITY_INACTIVE } from "../../core/validity.js";
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
  readCodeScanningAlert,
  readIssue,
  readPr,
  readPullRequest,
  readSecretScanningAlert,
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
   * The subject key: `owner/name#number` for Dependabot alerts, the node id
   * for PRs and issues, `owner/name#workflow:<id>` for a CI failure,
   * `owner/name#code-scanning:<n>` for a code scanning finding and
   * `owner/name#secret-scanning:<n>` for a leaked credential.
   *
   * Three kinds carry a key that is not a stored row's, for two reasons.
   *
   * A `ci_failure` is not a stored row at all: it is one workflow's
   * standing, and a rerun that breaks the same workflow again is the same
   * thing needing the same attention. Keyed by the workflow rather than by
   * the run, so a rerun replaces the item instead of adding a second one.
   *
   * A `code_scanning` finding and a `secret_scanning` alert ARE stored rows,
   * but `alertSubject` puts the discriminating type OUTSIDE the key, so all
   * three alert families store number 21 in one repository under one key
   * under three types. They are distinct subjects there and would be one key
   * here, which collides as a render key, ties the queue's final tiebreak
   * and, in Epic 4 where item keys become notification keys, would have one
   * finding suppress the other.
   */
  key: string;
  repo: string;
  number: number;
  packageName: string | null;
  /**
   * The issue title, the workflow's name on a CI failure, the rule id on a
   * code scanning finding, or the secret's display name on a leaked
   * credential - never the credential itself, which nothing in this system
   * ever mapped. Null for alerts and PRs, whose package says enough.
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
   * The severity a chip may show for this item, as the chain's own signal so
   * the display and the rank are one value (AD-20):
   *
   *   a word    the graded severity, or `critical` on a leaked credential,
   *             whose word is a statement about the kind rather than a grade
   *             GitHub sent: its severity TERM stays `n/a` and ranks nothing
   *   `n/a`     the item carries no severity to grade, which is a FACT and
   *             not a gap: a code scanning tool that grades nothing produces
   *             this, and three of the estate's 73 findings are in it
   *   null      there is a severity and we could not read it
   *
   * The last two were one value until a repository with one ungraded finding
   * beside a real `high` reported its worst severity as `unknown`: absence of
   * a grade is not a failure to read one.
   */
  displaySeverity: Signal<Severity>;
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

/**
 * What one pass produced.
 *
 * Every pass answers the same two things - the items it derived, and the
 * stored rows it holds and could not read - so `buildQueue` sums them
 * without knowing what any of them does. The count is stated rather than
 * dropped, because a queue quietly missing rows looks complete, which is the
 * confident-zero defect wearing a queue costume.
 */
interface Pass {
  items: QueueItem[];
  unreadable: number;
}

/**
 * The terms one Dependabot alert contributes, derived once.
 *
 * Filled by the alert pass, read by the update-PR pass. One derivation per
 * alert: two copy-parallel loops let the two drift, and a PR could "inherit"
 * a risk disagreeing with the alert row beside it.
 */
interface AlertTerms {
  kev: ReturnType<typeof kevSignal>;
  epss: number | null;
  severity: ReturnType<typeof normaliseSeverity>;
  advisory: string | null;
}

/** What the alert pass leaves behind for the update-PR pass to join on. */
interface AlertPass extends Pass {
  /** Terms by package, folded, for the title-parsed heuristic. */
  alertsByPackage: Map<string, AlertTerms[]>;
  /** The same terms by subject key, for the precise status-driven join. */
  alertsByKey: Map<string, AlertTerms>;
}

/** What the update-status prepass leaves behind, for the two passes that read it. */
interface StatusIndex {
  statusByAlertKey: Map<string, UpdateStatusObservation>;
  linksByPr: Map<string, { alertKey: string; error: string | null }[]>;
}

/**
 * What dependabotUpdate said, read before the alert pass because both later
 * passes consume it: the alert's stuck flag comes from the status keyed like
 * the alert itself, and a status naming a PR number is the precise
 * alert-to-PR link the package heuristic only approximates.
 *
 * The ONE piece of cross-pass state besides the alert terms, and it is read
 * here rather than inside either consumer so the two cannot disagree about
 * which statuses exist.
 */
function updateStatusIndex(store: StorePort): StatusIndex {
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
  return { statusByAlertKey, linksByPr };
}

/**
 * A memo over `deps.defaultBranchOf`, keyed by folded slug.
 *
 * One resolver call per repository rather than one per row: a repository
 * with thirty workflows asks the same question thirty times otherwise. One
 * memo shared by the two passes that ask, so the code scanning filter and
 * the CI filter cannot answer differently for one repository within one
 * build.
 */
function branchResolver(deps: QueueDeps): (slug: string) => string | null {
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
  return defaultBranchOf;
}

/**
 * The Dependabot alerts, and the terms the update-PR pass joins on.
 *
 * First because it is the only pass that produces state anything else reads.
 */
function alertPass(
  store: StorePort,
  now: Date,
  deps: QueueDeps,
  index: ReturnType<typeof loadKevIndex>,
  { statusByAlertKey }: StatusIndex,
): AlertPass {
  const items: QueueItem[] = [];
  let unreadable = 0;
  const alertsByPackage = new Map<string, AlertTerms[]>();
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

  return { items, unreadable, alertsByPackage, alertsByKey };
}

function codeScanningPass(
  store: StorePort,
  now: Date,
  deps: QueueDeps,
  defaultBranchOf: (slug: string) => string | null,
): Pass {
  const items: QueueItem[] = [];
  let unreadable = 0;

  // The code scanning findings (#156). Stored regardless of ref by a lane
  // that deliberately does not filter, so THIS is where the default-branch
  // condition is applied and the only place it is: the repository page lists
  // every stored alert with its ref, and a finding on a pull-request merge
  // ref is real work that is not yet a claim about the shipped branch.
  //
  // Every term but severity is a fact of absence. There is no CVE to look up,
  // no EPSS to score, no update to bump and no fix being prepared, so a
  // critical finding reaches `soon` and never `now`: `now` needs a broken
  // branch, a KEV listing or an EPSS band, and this kind carries none of the
  // three by construction.
  for (const row of store.currentByType("code_scanning_alert")) {
    if (row.state !== "present") continue;
    const alert = readCodeScanningAlert(row.payload);
    if (alert === null) {
      unreadable++;
      continue;
    }

    const slug = foldSlug(alert.repo);
    const branch = defaultBranchOf(slug);
    // Two ways to get here, neither an unreadable row: the resolver declined
    // (a configuration fact, which the Security chip renders through the
    // coverage and confirmation rules rather than as a zero), or the payload
    // slug does not split into an owner and a name. Neither is evidence
    // about the finding, so neither is counted as a row we failed to read.
    if (branch === null) continue;
    // Through the shared predicate, never a bare string comparison, so the
    // page's run list, the Actions lane and this builder all decide "is this
    // the default branch" the same way (AD-33). `refs/pull/7/merge` is false
    // rather than parsed, which is exactly the case this filter is for.
    if (!isDefaultBranchRef(alert.ref, branch)) continue;

    // The sentinel first: `n/a` is a fact (this tool grades nothing) and
    // ranks least, where an unrecognised word is a value we could not read
    // and ranks as unknown. Collapsing the two would let a level GitHub
    // invents tomorrow sink silently to the bottom of the queue.
    const severity =
      alert.severity === NOT_APPLICABLE
        ? NOT_APPLICABLE
        : normaliseSeverity(alert.severity);
    const ranking = rank(
      {
        // Not a statement about a build, and not an advisory: five facts of
        // absence, of which the kind's table silences three and words two.
        broken: NOT_APPLICABLE,
        kev: NOT_APPLICABLE,
        epss: NOT_APPLICABLE,
        severity,
        bump: NOT_APPLICABLE,
        stuck: NOT_APPLICABLE,
      },
      deps.rankPolicy,
      {
        ...KIND_REASONS.code_scanning,
        // Per item, because the sentence names the tool that found it, and
        // which tool it was is what a maintainer acts on differently: a
        // Trivy finding is a dependency to bump, a zizmor one is a workflow
        // to edit. The `broken` slot leads the chain, so the tool name leads
        // the sentence.
        broken: { na: alert.tool ?? "code scanning" },
      },
    );

    items.push({
      kind: "code_scanning",
      // NOT the stored row's key, which is the second kind whose key is not.
      // `alertSubject` puts the type outside the key, so this row and a
      // Dependabot alert of the same number in the same repository share it
      // exactly; two items under one key collide as a render key, tie the
      // sort's final tiebreak, and in Epic 4 would have one finding suppress
      // the other's notification. Shaped like the `ci_failure` key for the
      // same reason it is shaped that way: the discriminator is in the key.
      key: `${slug}#code-scanning:${alert.number}`,
      repo: alert.repo,
      number: alert.number,
      packageName: null,
      // The rule id, which is the identifying half of the finding: a CVE for
      // Trivy, an audit name for zizmor. The full description is not stored,
      // because nothing renders it and a field nothing renders is a field
      // that can silently rot.
      title: alert.ruleId,
      // Deliberately null even when the rule id IS a CVE. This column means
      // "the advisory this item is about", and a code scanning rule id is
      // the rule, not an advisory record: Trivy names one, Scorecard and
      // zizmor never do, and a column that is a CVE for one tool and an
      // audit slug for another teaches the reader nothing.
      advisory: null,
      htmlUrl: safeUrl(alert.htmlUrl),
      explanation: ranking.explanation,
      // Its KEV term is n/a by construction, and kevListedFor says so: the
      // page never gets a chance to shout about it.
      kevListed: kevListedFor("code_scanning"),
      // The signal as it stands: `n/a` where the tool grades nothing, null
      // where it sent a level we do not recognise. Collapsing the two let one
      // ungraded finding report a repository's worst severity as `unknown`.
      displaySeverity: severity,
      ranking,
      // The lane runs on the alert cadence, so its rows are judged on the
      // same budget as the Dependabot alerts beside them.
      freshness: freshness(row.verifiedAt, now, deps.policy),
      age: ageLabel(row.verifiedAt, now),
    });
  }

  return { items, unreadable };
}

function secretScanningPass(
  store: StorePort,
  now: Date,
  deps: QueueDeps,
): Pass {
  const items: QueueItem[] = [];
  let unreadable = 0;

  // The leaked credentials (#158). No branch guard has an analogue here: a
  // secret scanning alert carries no ref at all, so there is nothing to
  // filter on and every stored row that reads is an item.
  //
  // Every term is a fact of absence EXCEPT `kev`, and that one term is the
  // whole ranking of this kind: `tier()` promotes on a broken branch, a
  // listed KEV term or an EPSS band, the KEV scale is `[false, true]`, so
  // `true` is the only rank above unknown and is exactly what reaches `now`.
  // What the term must NOT do is make a page cite CISA: `kevListed` stays
  // false and the kind's reason table replaces the chain's default sentence.
  for (const row of store.currentByType("secret_scanning_alert")) {
    if (row.state !== "present") continue;
    const alert = readSecretScanningAlert(row.payload);
    if (alert === null) {
      unreadable++;
      continue;
    }

    // The PROJECTION's state is the authority, and it is the `present` check
    // at the top of the loop. The payload's own `state` is informational and
    // is deliberately not read here: the lane asks GitHub only for open alerts, so a row we
    // last saw is one GitHub last listed as open, and a row it stopped
    // listing is tombstoned by the lane's own reconciliation. Gating on the
    // payload instead would hide a live finding on the strength of a word
    // captured at the last sweep, which is the reverse of what this
    // dashboard is for - and the two sibling alert kinds ignore it for the
    // same reason.
    const slug = foldSlug(alert.repo);
    const ranking = rank(
      {
        broken: NOT_APPLICABLE,
        // The promotion, and the only term that says anything - but only
        // while the credential might still work.
        //
        // GitHub keeps an alert `state: "open"` after its OWN validity check
        // reports the credential dead, and it stays open until a human
        // closes it by hand, so an unconditional `true` here held a rotated
        // secret above every live KEV-listed CVE in the estate for as long
        // as nobody tidied up on github.com. `inactive` therefore drops to
        // `n/a`: the finding is still collected, still listed and still
        // ranked, but it lands in `soon` rather than `now`.
        //
        // `unknown` counts as active, and that direction is deliberate: a
        // credential GitHub could not verify is one we must assume still
        // works. Absence maps to `unknown` at the boundary, so an old row or
        // a payload with no validity field is treated as live too.
        kev: alert.validity === VALIDITY_INACTIVE ? NOT_APPLICABLE : true,
        epss: NOT_APPLICABLE,
        // `n/a`, not a grade: GitHub grades no secret, and the `critical` the
        // chip shows below is a word about the kind rather than a rank
        // anything fed. A severity term here would put this finding on the
        // advisory scale it is not on.
        severity: NOT_APPLICABLE,
        bump: NOT_APPLICABLE,
        stuck: NOT_APPLICABLE,
      },
      deps.rankPolicy,
      {
        ...KIND_REASONS.secret_scanning,
        // Per item, in the chain's leading slot, so the sentence opens with
        // what leaked. `secret_type_display_name` is the ONLY name of the
        // finding that may reach a reader; the credential itself was never
        // mapped, so there is nothing here to leak by accident.
        broken: { na: alert.secretType ?? "secret scanning alert" },
        // The slot after severity, as the code scanning kind uses it for its
        // branch phrase: GitHub's own validity check, which is what a
        // maintainer acts on differently AND what decides the KEV term
        // above, so the sentence names the value that did the deciding.
        // `unknown` covers both the literal and an absent field, which mean
        // the same thing to a reader.
        bump: { na: `validity ${alert.validity}` },
      },
    );

    items.push({
      kind: "secret_scanning",
      // The kind is IN the key, for the collision `alertSubject` leaves open:
      // it puts the type outside the stored key, so secret scanning alert 21
      // and Dependabot alert 21 in one repository would share a render key,
      // tie the queue's final tiebreak, and in Epic 4 have one suppress the
      // other's notification.
      key: `${slug}#secret-scanning:${alert.number}`,
      repo: alert.repo,
      number: alert.number,
      packageName: null,
      // The display name, never the secret and never `secret_type`.
      title: alert.secretType,
      advisory: null,
      htmlUrl: safeUrl(alert.htmlUrl),
      explanation: ranking.explanation,
      // False, and this is the line the whole kind turns on. Its KEV TERM is
      // true, because that is what reaches `now`; the DISPLAY FLAG is what
      // makes a page print "in CISA KEV", and an open secret is not in
      // CISA's catalogue of exploited vulnerabilities.
      kevListed: kevListedFor("secret_scanning"),
      // A word, not a grade. The chip reads `1 critical` because a live
      // credential is the finding that stops everything; the severity TERM
      // above stays `n/a` and contributes no rank, so the two never pretend
      // to be one number.
      displaySeverity: "critical",
      ranking,
      // The lane runs on the alert cadence, so its rows are judged on the
      // same budget as the alerts beside them.
      freshness: freshness(row.verifiedAt, now, deps.policy),
      age: ageLabel(row.verifiedAt, now),
    });
  }

  return { items, unreadable };
}

/**
 * The update PRs (CAP-3), ranked by the risk of what they fix.
 *
 * The join is local: `alertsByPackage` was filled by `alertPass`, which is
 * the only reason that pass runs first, so a PR bumping a package with an
 * open alert inherits the worst-ranking alert's top three terms. A PR whose
 * package has no open alert is a plain update, and its security terms are
 * facts of absence (n/a), not gaps (unknown): calling them unknown would
 * float every routine bump above every alert we checked and found absent.
 */
function updatePrPass(
  store: StorePort,
  now: Date,
  deps: QueueDeps,
  { alertsByPackage, alertsByKey }: AlertPass,
  { linksByPr }: StatusIndex,
): Pass {
  const items: QueueItem[] = [];
  let unreadable = 0;

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

  return { items, unreadable };
}

/**
 * The retained pull-request checks, indexed by the ref they ran on.
 *
 * Keyed `<folded repo slug>|<head ref>`, because that is what a pull request
 * can be looked up by: the rows themselves are keyed by run node id, and the
 * lane's retention keys them per workflow per head ref (#161). A repository
 * with two workflows on one ref therefore contributes two rows to one entry,
 * and the pass below judges them together.
 *
 * The key limits are the lane's and are not fixed here: the ref is a BARE
 * branch name, so two forks opening `patch-1` share one entry, and a ref
 * deleted and recreated inherits the old rows. Both are written down where
 * the retention key is defined.
 */
function checksByHeadRef(
  store: StorePort,
): Map<string, WorkflowRunObservation[]> {
  const byRef = new Map<string, WorkflowRunObservation[]>();
  for (const row of store.currentByType("pull_request_workflow_run")) {
    if (row.state !== "present") continue;
    const run = readWorkflowRun(row.payload);
    // Skipped rather than counted as unreadable, and this is the one place
    // in this file where that is right: a check row is never itself a queue
    // item, and its absence already degrades honestly to `checks not
    // observed` on the pull request it belonged to (AD-20). Counting it
    // would make the "items not shown" banner claim items that were never
    // items.
    if (run === null || run.headBranch === null) continue;
    const key = `${foldSlug(run.repo)}|${run.headBranch}`;
    const list = byRef.get(key) ?? [];
    list.push(run);
    byRef.set(key, list);
  }
  return byRef;
}

/**
 * Whether a run has not finished yet.
 *
 * `runVerdict` answers `other` for two quite different things, and this is
 * what tells them apart: a run GitHub has not concluded, and one it
 * concluded as something that is neither a pass nor a failure - cancelled,
 * skipped, neutral, action_required, stale, and whatever it adds next. A
 * `completed` run with no conclusion at all is over too, whatever it left
 * behind, so the status decides rather than the null.
 *
 * Its own predicate rather than a re-reading of the verdict, because the
 * verdict deliberately does not carry this: `other` is the answer that
 * cannot invent a failure, and telling a wait from a settled non-result is a
 * question about wording, not about rank. Both rank `n/a`.
 */
function stillRunning(run: WorkflowRunObservation): boolean {
  return run.conclusion === null && run.status !== "completed";
}

/**
 * What the retained checks on one head ref say, as the `stuck` term and the
 * words that go with it.
 *
 * Precedence, worst first: a broken run decides, then one still going, then
 * one that settled on no result, then a clean one. A pull request with one
 * failing workflow and one still running is stuck whatever the second one
 * eventually says, and one with a pass beside a run in flight has not
 * finished being checked.
 *
 * The `n/a` readings are deliberately NOT collapsed. "Not observed", "still
 * running" and "settled on no result" rank identically - all three are facts
 * of absence, all three land the repository in `quiet` - and they are
 * different things to a reader: a gap in what we collected, a wait, and a
 * run somebody cancelled. Three sentences over one is the whole reason the
 * queue supplies this entry per item.
 *
 * The tier arithmetic was verified against the chain and is not re-derived
 * here: `true` ranks 2 and gives `soon`; `false` and every `n/a` value rank
 * 0 and give `quiet`.
 */
function checkTerm(
  runs: readonly WorkflowRunObservation[] | undefined,
  now: Date,
  hungAfterMs: number,
): { stuck: Signal<boolean>; words: NonNullable<ReasonTable["stuck"]> } {
  if (runs === undefined || runs.length === 0) {
    // NOT "the checks passed" and not silence. Nothing was observed on this
    // ref, which is a gap in our collection and says nothing about the pull
    // request - and a check row's freshness is never evidence that a pull
    // request is open, because the Actions lane's 304 path re-confirms
    // retained rows indefinitely (#161). This pass reads such a row only for
    // a pull request it has independently collected as open.
    return { stuck: NOT_APPLICABLE, words: { na: "checks not observed" } };
  }
  const judged = runs.map((run) => ({
    run,
    verdict: runVerdict(run, now, hungAfterMs),
  }));
  const broken = judged.find((j) => isBrokenVerdict(j.verdict));
  if (broken !== undefined) {
    // The word itself, per item: "failed" and "hung" are different things to
    // a maintainer - one is a red build to read, the other a run that never
    // came back - exactly as the CI kind's sentence carries its own verdict.
    return { stuck: true, words: { stuck: `checks ${broken.verdict}` } };
  }
  if (judged.some((j) => stillRunning(j.run))) {
    return { stuck: NOT_APPLICABLE, words: { na: "checks running" } };
  }
  // Settled, and on nothing this system reads as a result. GitHub's own word
  // for it, because that is what the maintainer acts on differently: a
  // cancelled run is one to re-run, a skipped one is a path that did not
  // apply. A `completed` run with no conclusion at all has no word to quote.
  const settled = judged.find((j) => j.verdict === "other");
  if (settled !== undefined) {
    return {
      stuck: NOT_APPLICABLE,
      words: {
        na: `checks ${settled.run.conclusion ?? "completed with no result"}`,
      },
    };
  }
  return { stuck: false, words: { fine: "checks passed" } };
}

/**
 * The plain pull requests (#167): open, and opened by nobody the config
 * names as a dependency-update bot.
 *
 * Five of the six terms are facts of absence - a pull request carries no
 * CVE, no EPSS, no advisory grade and no bump, and it is not a statement
 * about main - so the one term that speaks is whether its checks are stuck.
 * That term reads the run rows the Actions lane already retains for this
 * head ref; the checks API is never called, and no call is added by this
 * kind at all.
 */
function pullRequestPass(store: StorePort, now: Date, deps: QueueDeps): Pass {
  const items: QueueItem[] = [];
  const checks = checksByHeadRef(store);

  // Read once, because two things below need the whole set: the item loop,
  // and the count of open pull requests per head ref that decides whether a
  // check row may be attributed at all.
  const readable = [...store.currentByType("pull_request")]
    .filter((row) => row.state === "present")
    .map((row) => ({ row, pr: readPullRequest(row.payload) }));
  const unreadable = readable.filter((r) => r.pr === null).length;

  // How many OPEN pull requests each ref key stands for.
  //
  // A check row is keyed by the base repository slug and a BARE head ref
  // (#161), and nothing in the run payload names the head repository, so two
  // forks opening `patch-1` against this repository are one key here. That
  // was a display limit at the retention key; here it would attribute one
  // contributor's red build to another's pull request and rank it `soon`
  // under their name.
  //
  // Refused rather than guessed: where a ref stands for more than one open
  // pull request, neither gets the verdict and both read `checks not
  // observed`, which is exactly what is true - we cannot say which run
  // belongs to which. Closing it properly needs a head-repository field on
  // the run mapper, which is a port change.
  const prsPerRef = new Map<string, number>();
  for (const { pr } of readable) {
    if (pr === null || pr.headRef === null) continue;
    const key = `${foldSlug(pr.repo)}|${pr.headRef}`;
    prsPerRef.set(key, (prsPerRef.get(key) ?? 0) + 1);
  }

  for (const { row, pr } of readable) {
    if (pr === null) continue;

    const slug = foldSlug(pr.repo);
    const refKey = pr.headRef === null ? null : `${slug}|${pr.headRef}`;
    // A pull request with no head ref matches no entry, which is what makes
    // `checks not observed` the answer rather than a lookup on `undefined`;
    // so does one whose ref another open pull request also claims.
    const { stuck, words } = checkTerm(
      refKey === null || (prsPerRef.get(refKey) ?? 0) > 1
        ? undefined
        : checks.get(refKey),
      now,
      deps.hungAfterMs,
    );
    const ranking = rank(
      {
        broken: NOT_APPLICABLE,
        kev: NOT_APPLICABLE,
        epss: NOT_APPLICABLE,
        severity: NOT_APPLICABLE,
        bump: NOT_APPLICABLE,
        stuck,
      },
      deps.rankPolicy,
      {
        ...KIND_REASONS.pull_request,
        // The whole entry per item, because all four of its states say
        // something the table cannot know. See the note beside the table.
        stuck: words,
      },
    );

    items.push({
      kind: "pull_request",
      // The stored row's key, which is the node id - the same key the
      // `dependency_update_pr` row for this pull request would carry. That
      // is deliberate and is what `onePerPullRequest` compares on: the two
      // kinds are exclusive, so a collision is a contradiction to resolve
      // rather than two items to render.
      key: row.subject.key,
      repo: pr.repo,
      number: pr.number,
      packageName: null,
      title: pr.title,
      advisory: null,
      htmlUrl: safeUrl(pr.htmlUrl),
      explanation: ranking.explanation,
      // Its KEV term is n/a by construction, and kevListedFor says so: the
      // page never gets a chance to shout about it.
      kevListed: kevListedFor("pull_request"),
      displaySeverity: null,
      ranking,
      freshness: freshness(row.verifiedAt, now, deps.policy),
      age: ageLabel(row.verifiedAt, now),
    });
  }

  return { items, unreadable };
}

/**
 * At most one item per pull request node id, preferring the dependency one.
 *
 * The SECOND enforcement of "never twice", and not redundancy for its own
 * sake. `classifyPullRequest` decides the type at collection, but the rows
 * outlive the decision: `update-prs.ts` is the only thing that tombstones a
 * `dependency_update_pr` row, and the entrypoint disables that lane outright
 * when `bots` is empty. So one edit to repos.yaml freezes every existing
 * `dependency_update_pr` row exactly while this lane correctly starts
 * claiming the same pull requests as human ones - two rows, one pull
 * request, and nothing in the collection layer able to see both. This is
 * where they meet.
 *
 * The dependency one wins because it says more: a reader wants the package
 * and the linked alert, not a bare title, and the Dependencies section is
 * where a dependency update is documented to appear.
 *
 * SCOPED TO THIS PAIR, and that scope is the point. Cross-type coexistence
 * on one node id stays legal in general: `review_request` and
 * `dependency_update_pr` share node ids deliberately, because review
 * requests are collected WITHOUT the allowlist filter and belong to a
 * surface of their own. A rule phrased as "one node id, one item" would be
 * wrong and would break the reviews topic.
 */
function onePerPullRequest(items: readonly QueueItem[]): QueueItem[] {
  const claimed = new Set(
    items.filter((item) => item.kind === "update_pr").map((item) => item.key),
  );
  return items.filter(
    (item) => item.kind !== "pull_request" || !claimed.has(item.key),
  );
}

function issuePass(store: StorePort, now: Date, deps: QueueDeps): Pass {
  const items: QueueItem[] = [];
  let unreadable = 0;

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

  return { items, unreadable };
}

function ciFailurePass(
  store: StorePort,
  now: Date,
  deps: QueueDeps,
  defaultBranchOf: (slug: string) => string | null,
): Pass {
  const items: QueueItem[] = [];
  let unreadable = 0;

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
      // quietly missing rows looks complete. Unlike the other passes, this
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

  return { items, unreadable };
}

/**
 * Build the ranked queue.
 *
 * One pass per kind, each independent of the others except for the two
 * pieces of state written down beside them: the update statuses, read once
 * before anything, and the alert terms the update-PR pass joins on. This was
 * one 673-line function through five kinds; the sixth is where it stopped
 * being readable (#167).
 */
export function buildQueue(
  store: StorePort,
  now: Date,
  deps: QueueDeps,
): Queue {
  const index = loadKevIndex(store, now, deps.kevPolicy);
  const statuses = updateStatusIndex(store);
  const defaultBranchOf = branchResolver(deps);

  const alerts = alertPass(store, now, deps, index, statuses);
  const passes: Pass[] = [
    alerts,
    codeScanningPass(store, now, deps, defaultBranchOf),
    secretScanningPass(store, now, deps),
    updatePrPass(store, now, deps, alerts, statuses),
    pullRequestPass(store, now, deps),
    issuePass(store, now, deps),
    ciFailurePass(store, now, deps, defaultBranchOf),
  ];

  const items = onePerPullRequest(passes.flatMap((pass) => pass.items));
  const unreadable = passes.reduce((sum, pass) => sum + pass.unreadable, 0);

  // The key tiebreak cannot be observed through the store today, because
  // currentByType already returns rows ORDER BY subject_key and this sort is
  // stable. It stays as defence: that SQL clause is one edit away from
  // disappearing, and a queue that reshuffles between refreshes on rank ties
  // would look broken in a way no test of ordering-by-rank catches.
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
