/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { SEVERITY_SCALE, type Severity } from "./severity.js";
import type { BumpLevel } from "./types.js";

// The urgency chain (AD-20).
//
// KEV status, then EPSS, then severity, then bump type. That order is CODE.
// Only the EPSS thresholds are configuration, and no configuration path can
// reorder the terms.
//
// Nothing here multiplies one signal by another. Comparison is lexicographic
// over the terms, most significant first, so a lower term can only ever break
// a tie in a higher one. That is deliberate and load-bearing: FIRST prohibits
// composing EPSS with CVSS, naming it "Score Laundering", and a lexicographic
// chain cannot express such a composition even by accident. There is no total
// score anywhere in this file, because a score is exactly the thing that
// would invite one.
//
// Whatever renders this must call the result a LOCAL POLICY. It is not SSVC,
// not CVSS, and not any published standard.

/** Bump ordering for the chain, least urgent first. */
const BUMP_SCALE: readonly BumpLevel[] = ["patch", "minor", "major"];

/**
 * Where an unknown signal sits: directly above the least urgent known value,
 * and below every other known value.
 *
 * This is AD-20's "absent ranks as unknown, never as zero risk" made concrete,
 * and both directions matter. Ranking unknown at the safe end would let a
 * signal we simply failed to collect sink to the bottom of the queue, which is
 * the confident-zero defect wearing a different hat. Ranking it at the urgent
 * end would bury the queue under things we merely failed to look up.
 */
const LEAST_KNOWN = 0;
const UNKNOWN = 1;
const KNOWN_BASE = 2;

/**
 * One item's inputs.
 *
 * Every field is required and every unknown is an explicit `null`, never an
 * absent key (AD-20). A missing key is indistinguishable from a key someone
 * forgot to populate, which is how a lane silently coerces "we did not look"
 * into "there is nothing there".
 */
export interface RankInput {
  /**
   * Is the CVE in the CISA KEV catalogue? `null` when the catalogue could not
   * be fetched, or the item has no CVE to look up.
   */
  readonly kev: boolean | null;
  /**
   * EPSS probability of exploitation in the next 30 days, 0 to 1.
   *
   * This is the PERCENTAGE, not the percentile. They are different numbers and
   * confusing them is the classic EPSS error: a percentile of 0.9 means "more
   * likely to be exploited than 90% of all CVEs", which for most of the corpus
   * is still a very small probability. Snapshotted at ingest and never re-read
   * (AD-18).
   */
  readonly epss: number | null;
  /** Advisory severity, or `null` when absent or unrecognised. */
  readonly severity: Severity | null;
  /** Semver bump the update would apply, or `null` when it is not an update. */
  readonly bump: BumpLevel | null;
  /**
   * Did GitHub fail to prepare this update (`dependabotUpdate.error`)?
   *
   * A stuck update needs the maintainer MORE, not less: nothing is going to
   * fix it automatically. It breaks ties rather than promoting across the
   * chain, so it can never reorder the terms above it, but it can never make
   * an item rank lower either.
   */
  readonly stuck: boolean | null;
}

/**
 * The tunable part. Thresholds only, never order (AD-20).
 *
 * ASSUMED, not chosen: nobody has yet said what exploitation probability
 * should change their morning. 0.5, 0.1 and 0.01 are the bands EPSS guidance
 * commonly discusses, and they want revisiting against a real queue.
 */
export interface RankPolicy {
  /** EPSS probability thresholds, strictly descending, each in 0..1. */
  readonly epssBands: readonly number[];
}

export const DEFAULT_RANK_POLICY: RankPolicy = { epssBands: [0.5, 0.1, 0.01] };

/** One term's contribution, kept so the UI can say why an item ranks here. */
export interface RankTerm {
  readonly name: "kev" | "epss" | "severity" | "bump" | "stuck";
  readonly rank: number;
  readonly reason: string;
}

export interface Ranking {
  /** Lexicographic sort key, most significant term first. */
  readonly key: readonly number[];
  readonly terms: readonly RankTerm[];
  /** CAP-6's "why does it rank there", most significant term first. */
  readonly explanation: string;
}

/**
 * Reject a policy that cannot band correctly.
 *
 * Bands out of order would silently mis-classify every item rather than fail,
 * and a mis-banded queue looks exactly like a working one.
 */
export function assertRankPolicy(policy: RankPolicy): void {
  const { epssBands } = policy;
  if (epssBands.length === 0) {
    throw new Error("rank policy: epssBands must not be empty");
  }
  for (const [i, band] of epssBands.entries()) {
    if (!Number.isFinite(band) || band < 0 || band > 1) {
      throw new Error(
        `rank policy: epssBands[${i}] is not a probability: ${band}`,
      );
    }
    const previous = epssBands[i - 1];
    if (previous !== undefined && band >= previous) {
      throw new Error(
        `rank policy: epssBands must be strictly descending, got ${previous} then ${band}`,
      );
    }
  }
}

/** Rank a value against an ordered scale, with unknown in its stated slot. */
function scaleRank<T>(value: T | null, scale: readonly T[]): number {
  if (value === null) return UNKNOWN;
  const index = scale.indexOf(value);
  // A value outside the scale is a value we do not understand, which is an
  // unknown, not a known-safe one.
  if (index < 0) return UNKNOWN;
  return index === 0 ? LEAST_KNOWN : KNOWN_BASE + index - 1;
}

function epssRank(epss: number | null, bands: readonly number[]): number {
  if (epss === null || !Number.isFinite(epss)) return UNKNOWN;
  for (const [i, band] of bands.entries()) {
    if (epss >= band) return KNOWN_BASE + (bands.length - 1 - i);
  }
  return LEAST_KNOWN;
}

const percent = (epss: number) => `${(epss * 100).toFixed(1)}%`;

function kevTerm(kev: boolean | null): RankTerm {
  return {
    name: "kev",
    rank: scaleRank(kev, [false, true]),
    reason:
      kev === null
        ? "KEV status unknown"
        : kev
          ? "listed in CISA KEV"
          : "not in CISA KEV",
  };
}

function epssTerm(epss: number | null, bands: readonly number[]): RankTerm {
  const rank = epssRank(epss, bands);
  return {
    name: "epss",
    rank,
    reason:
      epss === null || !Number.isFinite(epss)
        ? "EPSS unknown"
        : rank === LEAST_KNOWN
          ? `EPSS ${percent(epss)}, below ${percent(bands[bands.length - 1] as number)}`
          : `EPSS ${percent(epss)}`,
  };
}

function severityTerm(severity: Severity | null): RankTerm {
  return {
    name: "severity",
    rank: scaleRank(severity, SEVERITY_SCALE),
    reason: severity === null ? "severity unknown" : `severity ${severity}`,
  };
}

function bumpTerm(bump: BumpLevel | null): RankTerm {
  return {
    name: "bump",
    rank: scaleRank(bump, BUMP_SCALE),
    reason: bump === null ? "bump unknown" : `${bump} bump`,
  };
}

function stuckTerm(stuck: boolean | null): RankTerm {
  return {
    name: "stuck",
    rank: scaleRank(stuck, [false, true]),
    reason:
      stuck === null
        ? "stuck state unknown"
        : stuck
          ? "GitHub could not prepare this update"
          : "update prepared normally",
  };
}

/**
 * Rank one item on the fixed chain.
 *
 * Pure: same input, same policy, same output, every time. It reads no clock,
 * no store and no port, which is what lets the whole ordering be tested
 * without any of them.
 */
export function rank(input: RankInput, policy: RankPolicy): Ranking {
  assertRankPolicy(policy);

  // This array IS the chain order, and it is the only place that order is
  // expressed. Nothing reads it from configuration.
  const terms: RankTerm[] = [
    kevTerm(input.kev),
    epssTerm(input.epss, policy.epssBands),
    severityTerm(input.severity),
    bumpTerm(input.bump),
    stuckTerm(input.stuck),
  ];

  return {
    key: terms.map((t) => t.rank),
    terms,
    explanation: terms.map((t) => t.reason).join(", "),
  };
}

/**
 * Order two rankings, most urgent first.
 *
 * Lexicographic: the first term that differs decides, and no later term can
 * overturn it. Suitable for `Array.prototype.sort`.
 */
export function compareRankings(a: Ranking, b: Ranking): number {
  const length = Math.max(a.key.length, b.key.length);
  for (let i = 0; i < length; i++) {
    const difference = (b.key[i] ?? 0) - (a.key[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}
