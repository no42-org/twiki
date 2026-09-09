/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { NOT_APPLICABLE } from "../../core/rank.js";
import type { SeverityReading } from "../../core/severity.js";
import { UNKNOWN_SEVERITY, worstSeverity } from "../../core/severity.js";
import { foldSlug, watchKey } from "../../core/slug.js";
import { maxTier, type Tier, tier } from "../../core/tier.js";
import { topicOf } from "../../core/topics.js";
import type { RepoRef } from "../../core/types.js";
import type { StorePort } from "../store/port.js";
import { readReviewRequest } from "./payloads.js";
import {
  buildQueue,
  type Queue,
  type QueueDeps,
  type QueueItem,
} from "./queue.js";

// One attention tier per repository (AD-29, AD-34).
//
// Computed here and nowhere else: the repo page header, the overview row and
// the notifier all read this one result, so they cannot disagree about which
// repository needs the maintainer. Nothing here is persisted; a tier is a
// reading of the store at one clock, not a fact about the repository.

export interface AttentionDeps extends QueueDeps {
  /** `epssRank(cut, bands)`, computed once at startup (AD-29). */
  cutRank: number;
  /** Days a review request may wait before the repository is at least soon. */
  reviewBudgetDays: number;
}

export interface RepoAttention {
  tier: Tier;
  /** The first item in chain order that attains the tier, and why. */
  reason: string;
  /**
   * The item the reason names, or null when no item gave the tier: either
   * the repository has no items, or an overdue review alone lifted it.
   */
  first: QueueItem | null;
  /**
   * The pull request on this repository whose review has waited longest
   * past the budget, or null when none is overdue.
   */
  overdueReview: { number: number; days: number } | null;
  /** Readable review requests open on this repository. */
  openReviews: number;
  /**
   * Open SECURITY items in the queue for this repository: Dependabot alerts
   * and code scanning findings alike (#156).
   *
   * Derived from the topic rather than from a list of kinds, so the kind
   * Story 3.4 adds joins this count by being filed under Security and not by
   * anyone remembering to edit this line. The name is unchanged because it is
   * what every surface calls it, and both kinds are alerts.
   */
  openAlerts: number;
  /** The worst severity among those items, `unknown` when one is unreadable. */
  worstSeverity: SeverityReading | null;
  /** This repository's queue items, in chain order. */
  items: QueueItem[];
}

const DAY_MS = 24 * 60 * 60_000;

const KIND_WORD: Readonly<Record<QueueItem["kind"], string>> = {
  alert: "alert",
  // Named apart from a Dependabot alert deliberately, even though both count
  // under Security: the two numbers live in the same repository's `#21` space
  // and a rationale saying only "alert #21" would send a reader to the wrong
  // tab.
  code_scanning: "code scanning alert",
  // The run, not the workflow: the number beside it is the run's, and the
  // workflow's own name is in the explanation the sentence ends with. A kind
  // missing from this table prints `undefined` into the rationale rather
  // than failing, which is why the record is keyed by the whole union.
  ci_failure: "workflow run",
  update_pr: "update PR",
  issue: "issue",
};

/** How the rationale names one item. */
function nameItem(item: QueueItem): string {
  const subject = item.packageName
    ? `${KIND_WORD[item.kind]} #${item.number} ${item.packageName}`
    : `${KIND_WORD[item.kind]} #${item.number}`;
  return `${subject}: ${item.explanation}`;
}

interface OpenReview {
  number: number;
  ageMs: number;
}

/**
 * Readable, present review requests grouped by folded repository slug, for
 * the watched slugs only.
 *
 * Measured from the pull request's `createdAt`, the only time the review
 * payload carries (AD-29). A date that does not parse cannot be shown to be
 * overdue, so the row is dropped here: this is a claim about waiting time,
 * and a date we cannot read supports no claim either way.
 */
function reviewsBySlug(
  store: StorePort,
  watched: ReadonlySet<string>,
  now: Date,
): Map<string, OpenReview[]> {
  const bySlug = new Map<string, OpenReview[]>();
  for (const row of store.currentByType("review_request")) {
    if (row.state !== "present") continue;
    const request = readReviewRequest(row.payload);
    if (request === null) continue;
    const slug = foldSlug(request.repo);
    if (!watched.has(slug)) continue;
    const created = new Date(request.createdAt).getTime();
    if (Number.isNaN(created)) continue;
    const list = bySlug.get(slug) ?? [];
    list.push({ number: request.number, ageMs: now.getTime() - created });
    bySlug.set(slug, list);
  }
  return bySlug;
}

/** The review that has waited longest past the budget, in whole days. */
function overdueAmong(
  reviews: readonly OpenReview[],
  budgetDays: number,
): { number: number; days: number } | null {
  let oldest: OpenReview | null = null;
  for (const review of reviews) {
    if (review.ageMs <= budgetDays * DAY_MS) continue;
    if (oldest === null || review.ageMs > oldest.ageMs) oldest = review;
  }
  return oldest === null
    ? null
    : { number: oldest.number, days: Math.floor(oldest.ageMs / DAY_MS) };
}

/** One repository's verdict over its own items and reviews. */
function judge(
  items: QueueItem[],
  reviews: readonly OpenReview[],
  deps: AttentionDeps,
): RepoAttention {
  const tiers = items.map((item) => tier(item.ranking, deps.cutRank));
  let repoTier: Tier = "quiet";
  for (const t of tiers) repoTier = maxTier(repoTier, t);

  // The first item in chain order that attains the repository's tier. The
  // queue is already in chain order, so the first match is that item.
  let first = items.find((_, i) => tiers[i] === repoTier) ?? null;

  const overdue = overdueAmong(reviews, deps.reviewBudgetDays);
  let reason: string;
  if (overdue !== null && repoTier === "quiet") {
    // The review is the only thing lifting this repository; say so, and
    // name no item: none of them gave the tier.
    repoTier = "soon";
    first = null;
    // Whole days, so a wait of 3.5 days against a 3-day budget prints
    // "open 3d": the budget is named beside it so that still reads as over.
    reason = `pull request #${overdue.number} open ${overdue.days}d, past the ${deps.reviewBudgetDays}d review budget`;
  } else if (first !== null) {
    reason = nameItem(first);
  } else {
    reason = "no open items";
  }

  const alerts = items.filter((item) => topicOf(item.kind) === "security");

  return {
    tier: repoTier,
    reason,
    first,
    overdueReview: overdue,
    openReviews: reviews.length,
    openAlerts: alerts.length,
    // `n/a` first, because it is not a severity at all: worstSeverity reads
    // any word it does not recognise as `unknown`, so one ungraded code
    // scanning finding would report a repository holding a real `high` as
    // `unknown`. The lane's own summariseRepo filters the sentinel out
    // before this same call, for this same reason.
    //
    // A null display survives that filter and still becomes `unknown`: there
    // IS a severity on that item and we could not read it, which is a gap
    // and must not read as the lowest word we happen to know (AD-20).
    worstSeverity: worstSeverity(
      alerts
        .filter((item) => item.displaySeverity !== NOT_APPLICABLE)
        .map((item) => item.displaySeverity ?? UNKNOWN_SEVERITY),
    ),
    items,
  };
}

/**
 * Every watched repository's tier from one queue build.
 *
 * The queue is built once and grouped, rather than built per repository: an
 * update PR inherits its terms from the alerts beside it, and a queue built
 * over one repository's rows would be a second, subtly different ranking
 * (AD-29). Items whose repository is not watched land in no group, so they
 * count in no tier, no tile and no summary (AD-32). Reads through the store
 * port only; no GitHub call and no write on this path (AD-3).
 *
 * `suppressAlertsFor` names the folded slugs whose DEPENDABOT alert rows the
 * caller has positive evidence GitHub is no longer watching (AD-28): their
 * alert items are dropped before tiering, so a repository that reads `not
 * covered` cannot at the same time be `now` because of an alert nobody may
 * count. The update PRs beside them keep the terms they inherited in the
 * queue build; only the alert items go.
 *
 * `suppressCodeScanningFor` is the same rule for the same reason, one
 * feature over (#156). Two sets rather than one, because the two features
 * are switched off independently: a repository with Dependabot off and code
 * scanning on still has real findings to count, and a single set would
 * withdraw both on evidence about either.
 */
export function attentionByRepo(
  store: StorePort,
  watched: readonly RepoRef[],
  now: Date,
  deps: AttentionDeps,
  suppressAlertsFor: ReadonlySet<string> = new Set(),
  suppressCodeScanningFor: ReadonlySet<string> = new Set(),
): { byRepo: Map<string, RepoAttention>; queue: Queue } {
  const queue = buildQueue(store, now, deps);

  const itemsBySlug = new Map<string, QueueItem[]>();
  for (const repo of watched) itemsBySlug.set(watchKey(repo), []);
  for (const item of queue.items) {
    const slug = foldSlug(item.repo);
    if (item.kind === "alert" && suppressAlertsFor.has(slug)) continue;
    if (item.kind === "code_scanning" && suppressCodeScanningFor.has(slug)) {
      continue;
    }
    itemsBySlug.get(slug)?.push(item);
  }

  const reviews = reviewsBySlug(store, new Set(itemsBySlug.keys()), now);

  const byRepo = new Map<string, RepoAttention>();
  for (const [slug, items] of itemsBySlug) {
    byRepo.set(slug, judge(items, reviews.get(slug) ?? [], deps));
  }
  return { byRepo, queue };
}

/**
 * One repository's tier: the maximum over its open queue items, raised to at
 * least `soon` by a review request older than the budget.
 *
 * A wrapper over the batch form, so a page about one repository and a page
 * about all of them read the same computation.
 */
export function repoAttention(
  store: StorePort,
  repo: RepoRef,
  now: Date,
  deps: AttentionDeps,
  suppressAlertsFor: ReadonlySet<string> = new Set(),
  suppressCodeScanningFor: ReadonlySet<string> = new Set(),
): RepoAttention {
  const { byRepo } = attentionByRepo(
    store,
    [repo],
    now,
    deps,
    suppressAlertsFor,
    suppressCodeScanningFor,
  );
  const attention = byRepo.get(watchKey(repo));
  if (attention === undefined) {
    // Unreachable: the batch form seeds a group for every repository it was
    // given. Named rather than asserted away, because a page would otherwise
    // read a missing verdict as quiet.
    throw new Error(`no attention computed for ${watchKey(repo)}`);
  }
  return attention;
}
