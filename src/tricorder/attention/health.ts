/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { RunOutcome, StorePort } from "../store/port.js";
import {
  ageLabel,
  type Freshness,
  type FreshnessPolicy,
  freshness,
} from "./freshness.js";

// The collection-health view model. Kept separate from rendering so the
// interesting decisions, which are all about what we do and do not know, can
// be tested without a server or a DOM. It lives in attention rather than
// web because the board reads it too (AD-34): the tile warnings and the
// health table at the foot of the page come from one build, so they cannot
// disagree about which lane failed.

/**
 * A run's displayed outcome.
 *
 * Wider than `RunOutcome` because the view distinguishes two states the store
 * does not model. Spelled as a union rather than `string` so that adding a
 * third cannot pass unnoticed.
 */
export type HealthOutcome = RunOutcome | "running" | "stalled";

export interface CollectionHealth {
  lane: string;
  installation: string;
  scope: string;
  outcome: HealthOutcome;
  detail: string | null;
  age: string;
  freshness: Freshness;
}

/**
 * The most recent run per (lane, installation, scope).
 *
 * Ordered by lane, installation, scope, so the table does not reshuffle
 * between refreshes.
 */
export function buildCollectionHealth(
  store: StorePort,
  now: Date,
  policy: FreshnessPolicy,
  /**
   * Per-lane cadences. A lane absent here is judged on `policy`.
   *
   * AD-11 calls one global cadence applied to every lane a defect, and this
   * table had exactly that: a daily lane was reported stale thirty minutes
   * after succeeding, forever.
   */
  lanePolicies: Readonly<Record<string, FreshnessPolicy>> = {},
): CollectionHealth[] {
  return store.latestRunPerKey().map((run) => {
    // beginRun writes `partial` as its placeholder and leaves detail null, so a
    // run still in flight is only distinguishable from one that finished
    // incomplete by those two together. This is a heuristic on a heuristic; the
    // real fix is a finished_at column, which is a schema change.
    const inFlight =
      run.outcome === "partial" &&
      run.verifiedAt === run.startedAt &&
      run.detail === null;

    // Judged against the clock, always. A collector killed mid-sweep (OOM,
    // SIGKILL, eviction) leaves an in-flight row that nothing will ever
    // finish; forcing it green would hide the dead lane this table exists to
    // show. "running" is only a truthful reading while the run is still
    // inside its freshness budget.
    const seen = freshness(
      run.verifiedAt,
      now,
      lanePolicies[run.lane] ?? policy,
    );
    const stalled = inFlight && seen !== "fresh";

    return {
      lane: run.lane,
      installation: run.installation,
      scope: run.scope,
      outcome: stalled ? "stalled" : inFlight ? "running" : run.outcome,
      detail: run.detail,
      age: ageLabel(run.verifiedAt, now),
      freshness: seen,
    };
  });
}
