/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { SeverityReading } from "../../core/severity.js";
import { worstSeverity } from "../../core/severity.js";
import { watchKey } from "../../core/slug.js";
import { maxTier, type Tier, tier } from "../../core/tier.js";
import type { RepoRef } from "../../core/types.js";
import type { StorePort } from "../store/port.js";
import { readReviewRequest } from "./payloads.js";
import { buildQueue, type QueueDeps, type QueueItem } from "./queue.js";

// One repository's attention tier (AD-29, AD-34).
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
  /** Open alert items in the queue for this repository. */
  openAlerts: number;
  /** The worst severity among those alerts, `unknown` when one is unreadable. */
  worstSeverity: SeverityReading | null;
  /** This repository's queue items, in chain order. */
  items: QueueItem[];
}

const DAY_MS = 24 * 60 * 60_000;

const KIND_WORD: Readonly<Record<QueueItem["kind"], string>> = {
  alert: "alert",
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

/**
 * The pull request on this repository whose review has waited longest past
 * the budget, with its age in whole days, or null when none is overdue.
 *
 * Measured from the pull request's `createdAt`, the only time the review
 * payload carries (AD-29). A date that does not parse cannot be shown to be
 * overdue, so it raises nothing: this is a claim about waiting time, and a
 * date we cannot read supports no claim either way.
 */
function overdueReview(
  store: StorePort,
  slug: string,
  now: Date,
  budgetDays: number,
): { number: number; days: number } | null {
  let oldest: { number: number; ageMs: number } | null = null;
  for (const row of store.currentByType("review_request")) {
    if (row.state !== "present") continue;
    const request = readReviewRequest(row.payload);
    if (request === null) continue;
    if (request.repo.toLowerCase() !== slug) continue;
    const created = new Date(request.createdAt).getTime();
    if (Number.isNaN(created)) continue;
    const ageMs = now.getTime() - created;
    if (ageMs <= budgetDays * DAY_MS) continue;
    if (oldest === null || ageMs > oldest.ageMs) {
      oldest = { number: request.number, ageMs };
    }
  }
  return oldest === null
    ? null
    : { number: oldest.number, days: Math.floor(oldest.ageMs / DAY_MS) };
}

/**
 * One repository's tier: the maximum over its open queue items, raised to at
 * least `soon` by a review request older than the budget.
 *
 * The queue is built in full and filtered, rather than built per repository:
 * an update PR inherits its terms from the alerts beside it, and a queue
 * built over one repository's rows would be a second, subtly different
 * ranking (AD-29). Reads through the store port only; no GitHub call and no
 * write on this path (AD-3).
 */
export function repoAttention(
  store: StorePort,
  repo: RepoRef,
  now: Date,
  deps: AttentionDeps,
): RepoAttention {
  const slug = watchKey(repo);
  const items = buildQueue(store, now, deps).items.filter(
    (item) => item.repo.toLowerCase() === slug,
  );

  const tiers = items.map((item) => tier(item.ranking, deps.cutRank));
  let repoTier: Tier = "quiet";
  for (const t of tiers) repoTier = maxTier(repoTier, t);

  // The first item in chain order that attains the repository's tier. The
  // queue is already in chain order, so the first match is that item.
  const first = items.find((_, i) => tiers[i] === repoTier);

  const overdue = overdueReview(store, slug, now, deps.reviewBudgetDays);
  let reason: string;
  if (overdue !== null && repoTier === "quiet") {
    // The review is the only thing lifting this repository; say so.
    repoTier = "soon";
    // Whole days, so a wait of 3.5 days against a 3-day budget prints
    // "open 3d": the budget is named beside it so that still reads as over.
    reason = `pull request #${overdue.number} open ${overdue.days}d, past the ${deps.reviewBudgetDays}d review budget`;
  } else if (first !== undefined) {
    reason = nameItem(first);
  } else {
    reason = "no open items";
  }

  const alerts = items.filter((item) => item.kind === "alert");

  return {
    tier: repoTier,
    reason,
    openAlerts: alerts.length,
    // A null display severity is one the lane could not recognise, and
    // worstSeverity already knows what to say about that: `unknown`, never
    // the lowest word we happen to know (AD-20).
    worstSeverity: worstSeverity(
      alerts.map((item) => item.displaySeverity ?? "unknown"),
    ),
    items,
  };
}
