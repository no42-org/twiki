/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// Freshness is computed from verified_at, never observed_at (AD-11).
//
// A quiet, healthy repository changes nothing for weeks. Judging it by when it
// last CHANGED would render the repositories that are fine as the most
// neglected, which inverts the whole point of the dashboard. verified_at says
// when we last confirmed it, and a 304 advances that without writing a value.

export type Freshness = "fresh" | "stale" | "unknown";

/**
 * How many lane cadences may pass before a value counts as stale.
 *
 * Assumed, not chosen: nobody has yet said what tolerance they actually want,
 * and the number wants deciding against real cadences rather than inherited
 * from a default. Two means "we missed one cycle and are into the next".
 */
export const DEFAULT_STALE_AFTER_CADENCES = 2;

export interface FreshnessPolicy {
  /** The lane's cadence, in milliseconds. */
  cadenceMs: number;
  /** Multiples of the cadence tolerated before stale. */
  staleAfterCadences?: number;
}

/**
 * Classify one value.
 *
 * `unknown` is not a synonym for stale: it means never collected at all, which
 * is a different thing for a reader to see than a value that has gone quiet.
 * Both must be distinguishable from a real zero.
 */
export function freshness(
  verifiedAt: string | null | undefined,
  now: Date,
  policy: FreshnessPolicy,
): Freshness {
  if (!verifiedAt) return "unknown";
  const seen = new Date(verifiedAt).getTime();
  if (Number.isNaN(seen)) return "unknown";

  const budget =
    policy.cadenceMs *
    (policy.staleAfterCadences ?? DEFAULT_STALE_AFTER_CADENCES);
  return now.getTime() - seen <= budget ? "fresh" : "stale";
}

/** Human-readable age, for the badge's title attribute. */
export function ageLabel(
  verifiedAt: string | null | undefined,
  now: Date,
): string {
  if (!verifiedAt) return "never collected";
  const seen = new Date(verifiedAt).getTime();
  if (Number.isNaN(seen)) return "never collected";

  const seconds = Math.max(0, Math.round((now.getTime() - seen) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}
