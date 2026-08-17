/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { RepoRef } from "../../core/types.js";
import type { RepoObservation } from "../collect/dependabot-alerts.js";
import { watchKey } from "../collect/dependabot-alerts.js";
import type { CurrentValue, RunOutcome, StorePort } from "../store/port.js";
import {
  ageLabel,
  type Freshness,
  type FreshnessPolicy,
  freshness,
} from "./freshness.js";

// The view model. Kept separate from rendering so the interesting decisions,
// which are all about what we do and do not know, can be tested without a
// server or a DOM.

export interface RepoRow {
  slug: string;
  /**
   * Open alerts, or null when we have never collected this repository. Null is
   * not zero: zero means "we looked and there are none", null means "we have
   * not looked". Rendering them the same way is the lie this dashboard exists
   * to avoid.
   */
  openAlerts: number | null;
  /** Highest severity among the open alerts, if any. */
  worstSeverity: string | null;
  freshness: Freshness;
  age: string;
  verifiedAt: string | null;
}

/**
 * Build one row per watched repository.
 *
 * Every watched repository appears, including ones with no alerts and ones
 * never collected: a repository missing from the page is indistinguishable
 * from a healthy one, and the reader cannot tell which they are looking at.
 */
export function buildRepoRows(
  store: StorePort,
  watched: readonly RepoRef[],
  now: Date,
  policy: FreshnessPolicy,
): RepoRow[] {
  // The repository confirmation is the source of truth for "did we look".
  // Deriving it from alert rows cannot work: a healthy repository has none,
  // and a newly-clean one stops having its rows updated the moment they are
  // tombstoned, so both would read as never collected.
  // Only `present` rows. A tombstoned confirmation is a retracted assertion,
  // and rendering its payload would show a stale count as live data.
  const confirmations = new Map<string, CurrentValue>();
  for (const value of store.currentByType("repository")) {
    if (value.state === "present") confirmations.set(value.subject.key, value);
  }

  return watched.map((repo) => {
    const slug = watchKey(repo);
    const confirmed = confirmations.get(slug);
    const summary = confirmed?.payload as RepoObservation | undefined;
    const verifiedAt = confirmed?.verifiedAt ?? null;

    return {
      slug,
      openAlerts: summary ? summary.openAlerts : null,
      worstSeverity: summary?.worstSeverity ?? null,
      freshness: freshness(verifiedAt, now, policy),
      age: ageLabel(verifiedAt, now),
      verifiedAt,
    };
  });
}

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
    const seen = freshness(run.verifiedAt, now, policy);
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
