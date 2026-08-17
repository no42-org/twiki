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
 * A signal that is absent because there is nothing to know.
 *
 * Distinct from `null`, which means we do not know. Collapsing the two is a
 * real ordering bug and not a pedantic one: KEV is the chain's top term, so a
 * dependency bump with no CVE at all (nothing to look up) would outrank a
 * critical advisory whose CVE we checked and confirmed absent from the
 * catalogue. Most update pull requests have no CVE, so that single conflation
 * floats the dullest items in the queue to the top and nothing below KEV can
 * overturn it.
 *
 * `n/a` ranks at the least-urgent end, because it IS a fact: there is no
 * exploitation signal to be had, and that is not the same as failing to fetch
 * one.
 */
export const NOT_APPLICABLE = "n/a";

/**
 * A chain input: a known value, `n/a` when the signal cannot apply, or `null`
 * when we do not know. Never an absent key (AD-20).
 */
export type Signal<T> = T | typeof NOT_APPLICABLE | null;

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
   * Is the CVE in the CISA KEV catalogue? `n/a` when the item has no CVE to
   * look up, `null` when the catalogue could not be fetched.
   */
  readonly kev: Signal<boolean>;
  /**
   * EPSS probability of exploitation in the next 30 days, 0 to 1.
   *
   * This is the PERCENTAGE, not the percentile. They are different numbers and
   * confusing them is the classic EPSS error: a percentile of 0.9 means "more
   * likely to be exploited than 90% of all CVEs", which for most of the corpus
   * is still a very small probability. Snapshotted at ingest and never re-read
   * (AD-18).
   */
  readonly epss: Signal<number>;
  /** Advisory severity. `n/a` when the item carries no advisory at all. */
  readonly severity: Signal<Severity>;
  /** Semver bump the update applies. `n/a` when the item is not an update. */
  readonly bump: Signal<BumpLevel>;
  /**
   * Did GitHub fail to prepare this update (`dependabotUpdate.error`)?
   *
   * A stuck update needs the maintainer MORE, not less: nothing is going to
   * fix it automatically. It breaks ties rather than promoting across the
   * chain, so it can never reorder the terms above it, but it can never make
   * an item rank lower either. `n/a` when the item is not an update.
   */
  readonly stuck: Signal<boolean>;
}

/**
 * The tunable part. Thresholds only, never order (AD-20).
 *
 * CHOSEN 2026-08-17 against a real queue, not inherited from a default. The
 * measured distribution over 60 scored alerts was: 1 at or above 0.5, 6 at or
 * above 0.1, 46 at or above 0.01.
 *
 * 0.1 is the line that matters, because it decides what outranks severity, and
 * it falls in a genuine gap: the values step 0.1501, 0.1466, 0.1466 and then
 * drop to 0.0521. 0.5 isolates the single standout. The 0.01 floor leaves most
 * alerts tied, which is deliberate: below a 1 percent chance of exploitation in
 * 30 days the signal is weak, and letting severity decide there is more honest
 * than manufacturing an order EPSS cannot support.
 *
 * The sample was one estate at one moment, so this is a decision with evidence
 * rather than a settled constant. It is configuration precisely so a wider
 * allowlist can revise it.
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
    // Zero is excluded, not merely out of range: every finite probability is
    // >= 0, so a band of 0 makes the below-lowest rank unreachable, every item
    // ties on EPSS, and the term silently stops contributing at all.
    if (!Number.isFinite(band) || band <= 0 || band > 1) {
      throw new Error(
        `rank policy: epssBands[${i}] is not a probability above zero: ${band}`,
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

/** Rank a value against an ordered scale, with each absence in its own slot. */
function scaleRank<T>(value: Signal<T>, scale: readonly T[]): number {
  // No scale in this module contains the string "n/a", so this cannot shadow a
  // real value.
  if (value === NOT_APPLICABLE) return LEAST_KNOWN;
  if (value === null) return UNKNOWN;
  const index = scale.indexOf(value as T);
  // A value outside the scale is a value we do not understand, which is an
  // unknown, not a known-safe one.
  if (index < 0) return UNKNOWN;
  return index === 0 ? LEAST_KNOWN : KNOWN_BASE + index - 1;
}

function epssRank(epss: Signal<number>, bands: readonly number[]): number {
  if (epss === NOT_APPLICABLE) return LEAST_KNOWN;
  // Outside 0..1 it is not a probability, whatever the payload said. Letting it
  // fall through the bands would rank a negative sentinel as measured-harmless
  // and print "EPSS -100.0%, below 1.0%" as the reason.
  if (epss === null || !Number.isFinite(epss) || epss < 0 || epss > 1) {
    return UNKNOWN;
  }
  for (const [i, band] of bands.entries()) {
    if (epss >= band) return KNOWN_BASE + (bands.length - 1 - i);
  }
  return LEAST_KNOWN;
}

const percent = (epss: number) => `${(epss * 100).toFixed(1)}%`;

function kevTerm(kev: Signal<boolean>): RankTerm {
  return {
    name: "kev",
    rank: scaleRank(kev, [false, true]),
    reason:
      kev === NOT_APPLICABLE
        ? "no CVE to check against KEV"
        : kev === null
          ? "KEV status unknown"
          : kev
            ? "listed in CISA KEV"
            : "not in CISA KEV",
  };
}

function epssTerm(epss: Signal<number>, bands: readonly number[]): RankTerm {
  const rank = epssRank(epss, bands);
  const measured = typeof epss === "number" && rank !== UNKNOWN;
  return {
    name: "epss",
    rank,
    reason:
      epss === NOT_APPLICABLE
        ? "no CVE to score"
        : !measured
          ? "EPSS unknown"
          : rank === LEAST_KNOWN
            ? `EPSS ${percent(epss as number)}, below ${percent(bands[bands.length - 1] as number)}`
            : `EPSS ${percent(epss as number)}`,
  };
}

function severityTerm(severity: Signal<Severity>): RankTerm {
  return {
    name: "severity",
    rank: scaleRank(severity, SEVERITY_SCALE),
    reason:
      severity === NOT_APPLICABLE
        ? "no advisory"
        : severity === null
          ? "severity unknown"
          : `severity ${severity}`,
  };
}

function bumpTerm(bump: Signal<BumpLevel>): RankTerm {
  return {
    name: "bump",
    rank: scaleRank(bump, BUMP_SCALE),
    reason:
      bump === NOT_APPLICABLE
        ? "not an update"
        : bump === null
          ? "bump unknown"
          : `${bump} bump`,
  };
}

function stuckTerm(stuck: Signal<boolean>): RankTerm {
  return {
    name: "stuck",
    rank: scaleRank(stuck, [false, true]),
    reason:
      stuck === NOT_APPLICABLE
        ? "not an update"
        : stuck === null
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
    // Missing terms count as UNKNOWN, never as least-urgent. Unreachable while
    // every key is the same shape, but the day a term is added to the chain, a
    // key built by the older shape must not sort as though the new signal had
    // been measured and found harmless. That is this module's whole thesis.
    const difference = (b.key[i] ?? UNKNOWN) - (a.key[i] ?? UNKNOWN);
    if (difference !== 0) return difference;
  }
  return 0;
}
