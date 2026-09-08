/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import {
  epssRank,
  LEAST_KNOWN,
  type Ranking,
  type RankPolicy,
  UNKNOWN,
} from "./rank.js";

// Attention tiers (AD-29): three buckets over the chain, not a second ranking.
//
// A tier is a bucket over one item's own term ranks, and a repository takes
// the maximum over its items. That is deliberately weaker than queue order:
// the queue is lexicographic, so an item whose KEV status is unknown sorts
// above one checked and found absent even when only the second reaches
// `now`. Tier and order agree on what they are built from, the chain's
// ranks, and on nothing else. There is no severity floor and no composite
// here, for the same reason rank.ts has no score.

export type Tier = "now" | "soon" | "quiet";

/** Tier order, most urgent first, for taking a maximum over items. */
export const TIER_ORDER: readonly Tier[] = ["now", "soon", "quiet"];

/**
 * The EPSS probability at or above which an item is `now`, unless configured.
 *
 * Decided on live EPSS data (AD-29): 0.1 is the band that decides what
 * outranks severity, so it is also the band that decides what cannot wait.
 */
export const DEFAULT_NOW_EPSS = 0.1;

/** Days a review request may wait before its repository is at least `soon`. */
export const DEFAULT_REVIEW_BUDGET_DAYS = 3;

/** The more urgent of two tiers. */
export function maxTier(a: Tier, b: Tier): Tier {
  return TIER_ORDER.indexOf(a) <= TIER_ORDER.indexOf(b) ? a : b;
}

/**
 * The `now` cut as a term rank, resolved once at startup (AD-29).
 *
 * The cut must equal one of the configured bands. A probability between
 * bands would put the `now` line somewhere the chain cannot see, and a cut
 * below every band would resolve to LEAST_KNOWN and make every item `now`,
 * untriaged issues included. The one resolver for the configured cut and
 * for the default, so neither path can skip the check.
 */
export function cutRankFor(cut: number, policy: RankPolicy): number {
  if (!policy.epssBands.includes(cut)) {
    throw new Error(
      `TRICORDER_NOW_EPSS ${cut} is not one of the configured EPSS bands ${policy.epssBands.join(",")}`,
    );
  }
  return epssRank(cut, policy.epssBands);
}

/** `cutRankFor` at the default cut: throws when the bands no longer carry it. */
export function defaultCutRank(policy: RankPolicy): number {
  return cutRankFor(DEFAULT_NOW_EPSS, policy);
}

/**
 * Bucket one ranked item.
 *
 * `now` when the default branch is broken, the KEV term is listed or the
 * EPSS term ranks at or above the
 * cut band; `soon` when any term ranks above least-known, which includes
 * unknown, because a signal we failed to collect must not read as quiet
 * (AD-20); `quiet` when every term sits at least-known.
 *
 * `cutRank` is a measured EPSS rank from `cutRankFor`, so this function
 * compares ranks with ranks and never re-reads a probability. A cut at or
 * below UNKNOWN is refused: an unknown EPSS would satisfy it, and so would a
 * least-known one, which makes every item `now`. A term the ranking does not
 * carry reads as unknown, which can lift an item to soon and never to now.
 */
export function tier(ranking: Ranking, cutRank: number): Tier {
  if (cutRank <= UNKNOWN) {
    throw new Error(`cutRank ${cutRank} is not a measured EPSS rank`);
  }
  const rankOf = (name: string): number =>
    ranking.terms.find((t) => t.name === name)?.rank ?? UNKNOWN;

  // A red default branch, on the same reasoning as KEV below: its scale is
  // [false, true] too, so `true` is the only rank above UNKNOWN and nothing
  // else can satisfy this.
  //
  // A line of its own, and the easy thing to miss when a term is added to
  // the head of the chain. Leading the chain decides ORDER, not tier: the
  // term would satisfy `anyAboveLeast` below and stop at `soon`, so a
  // repository whose main is broken would sort first inside the wrong
  // bucket.
  if (rankOf("broken") > UNKNOWN) return "now";
  // A listed KEV entry is the only KEV rank above UNKNOWN: the scale is
  // [false, true], so false is LEAST_KNOWN and true is the first known rank.
  if (rankOf("kev") > UNKNOWN) return "now";
  if (rankOf("epss") >= cutRank) return "now";

  const anyAboveLeast = ranking.terms.some((t) => t.rank > LEAST_KNOWN);
  // A ranking that carries no terms at all has told us nothing, and nothing
  // is not quiet.
  return anyAboveLeast || ranking.terms.length === 0 ? "soon" : "quiet";
}
