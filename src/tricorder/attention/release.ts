/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import {
  assessRelease,
  type ReleaseVerdict,
} from "../../core/release-worthy.js";
import type { RepoRef } from "../../core/types.js";
import { LANE } from "../collect/release-readiness.js";
import type { CurrentValue, RunRecord, StorePort } from "../store/port.js";
import { confirmationVouches, latestFullRun } from "./attestation.js";
import { type FreshnessPolicy, freshness } from "./freshness.js";
import { readReleaseEvidence } from "./payloads.js";

// One reading of a repository's release evidence (#196), shared by the tier
// lift and the board's Release cell so the two cannot disagree: a repository
// is never lifted by a row its own cell calls unconfirmed or not tracked.

export type ReleaseReading =
  | { state: "not-tracked" }
  | { state: "unconfirmed" }
  | {
      state: "confirmed";
      verdict: ReleaseVerdict;
      /** The row's own confirmation time. */
      verifiedAt: string;
    };

/**
 * Every watched repository's reading, keyed by `slug(repo)`.
 *
 * Confirmed only while the lane's latest full run on the repository's owner
 * is `ok` and fresh, AND the repository's own present row is fresh, AND its
 * payload reads. A failed run leaves an older row behind; reading it would
 * publish a verdict nobody renewed (AD-28).
 *
 * Judged on `policy`, the sweep budget: the lane is scheduled on the alert
 * cadence and has no `lanePolicies` entry (see the schedule in tricorder.ts).
 */
export function releaseReadings(
  store: StorePort,
  watched: ReadonlyMap<string, RepoRef>,
  now: Date,
  policy: FreshnessPolicy,
  tracked: (repo: RepoRef) => boolean,
): Map<string, ReleaseReading> {
  const rows = new Map<string, CurrentValue>();
  for (const row of store.currentByType("release_readiness")) {
    // A tombstoned row is a retracted assertion, not a stale one.
    if (row.state === "present") rows.set(row.subject.key, row);
  }
  const runs = new Map<string, RunRecord | undefined>();
  const laneCurrent = (owner: string): boolean => {
    if (!runs.has(owner)) runs.set(owner, latestFullRun(store, LANE, owner));
    const run = runs.get(owner);
    return (
      run?.outcome === "ok" &&
      freshness(run.verifiedAt, now, policy) === "fresh"
    );
  };

  const readings = new Map<string, ReleaseReading>();
  for (const [slug, repo] of watched) {
    readings.set(slug, read(slug, repo));
  }
  return readings;

  function read(slug: string, repo: RepoRef): ReleaseReading {
    if (!tracked(repo)) return { state: "not-tracked" };
    const row = rows.get(slug);
    if (
      !laneCurrent(repo.owner.toLowerCase()) ||
      !confirmationVouches(row, now, policy)
    ) {
      return { state: "unconfirmed" };
    }
    const evidence = readReleaseEvidence(row.payload);
    if (evidence === null) return { state: "unconfirmed" };
    return {
      state: "confirmed",
      verdict: assessRelease(evidence),
      verifiedAt: row.verifiedAt,
    };
  }
}
