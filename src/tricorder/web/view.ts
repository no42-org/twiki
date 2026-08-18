/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { CoverageState } from "../../core/coverage.js";
import { coverageReason, isCovered } from "../../core/coverage.js";
import type { RepoRef } from "../../core/types.js";
import type { CoverageObservation } from "../collect/coverage.js";
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
  /**
   * Whether GitHub is watching this repository at all (AD-28).
   *
   * A different axis from freshness. When this is anything but `covered` the
   * count is meaningless and is not rendered: the repository has nothing to be
   * fresh or stale about. `null` means the coverage lane has not run yet.
   */
  coverage: CoverageState | null;
  /** Why it is not covered, for the reader. Null when it is. */
  coverageReason: string | null;
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
  /** The coverage lane runs daily, so it is judged on its own cadence (AD-11). */
  coveragePolicy?: FreshnessPolicy,
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

  // Coverage is trusted only while its own attestation is fresh. This is the
  // whole reason coverage is a separate subject: if the coverage lane dies and
  // somebody then switches Dependabot off on a repository, a cached `covered`
  // would keep the page showing a confident, freshly-badged zero, which is the
  // exact defect the lane exists to remove (AD-28).
  const coverage = new Map<string, CoverageState>();
  for (const value of store.currentByType("repository_coverage")) {
    if (value.state !== "present") continue;
    const attested = freshness(value.verifiedAt, now, coveragePolicy ?? policy);
    coverage.set(
      value.subject.key,
      attested === "fresh"
        ? (value.payload as CoverageObservation).state
        : "unknown",
    );
  }

  return watched.map((repo) => {
    const slug = watchKey(repo);
    const confirmed = confirmations.get(slug);
    const summary = confirmed?.payload as RepoObservation | undefined;
    const verifiedAt = confirmed?.verifiedAt ?? null;

    const covered = coverage.get(slug) ?? null;
    // Suppressed rather than rendered alongside a warning. A number next to
    // "not covered" invites the reader to believe the number, and the whole
    // point is that we are not entitled to one (AD-28).
    // Suppressed only on POSITIVE evidence of non-coverage. `unknown` is not
    // such evidence: blanking on it would let one rate-limited probe wipe
    // correct counts off the page, and the alert lane's own confirmation still
    // stands on its own footing.
    const known =
      covered === null || isCovered(covered) || covered === "unknown";

    return {
      slug,
      openAlerts: known && summary ? summary.openAlerts : null,
      worstSeverity: known ? (summary?.worstSeverity ?? null) : null,
      coverage: covered,
      coverageReason: covered === null ? null : coverageReason(covered),
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
