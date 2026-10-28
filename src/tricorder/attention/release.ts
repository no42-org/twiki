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
import { readReleaseEvidence, readReleaseFailure } from "./payloads.js";

// One reading of a repository's release evidence (#196), shared by the tier
// lift and the board's Release cell so the two cannot disagree: a repository
// is never lifted by a row its own cell calls unconfirmed or not tracked.

/** No `ok` or `partial`, fresh run of the lane on the owner, or no fresh row of its own. */
export const RELEASE_NOT_CONFIRMED =
  "not confirmed by a current, complete release-readiness run";
/** The row is present and fresh, but its payload does not parse. */
export const RELEASE_UNREADABLE =
  "the stored release reading could not be read";
/**
 * The read stopped short and nothing it read counts. The commits past it may
 * hold a feature, so `none` would claim a history nobody read.
 */
export const RELEASE_TRUNCATED =
  "more commits exist than were read, and none of those read count toward a release";

export type ReleaseReading =
  | { state: "not-tracked" }
  | { state: "unconfirmed"; reason: string }
  | {
      state: "confirmed";
      verdict: ReleaseVerdict;
      /** Committer date of the latest tag, ISO, or null. */
      tagDate: string | null;
      /** The row's own confirmation time. */
      verifiedAt: string;
    };

/**
 * Every watched repository's reading, keyed by `slug(repo)`.
 *
 * Confirmed only while the lane's latest full run on the repository's owner
 * is `ok` or `partial` and fresh, AND the repository's own present row is
 * fresh, AND its payload reads. A failed run leaves an older row behind;
 * reading it would publish a verdict nobody renewed (AD-28).
 *
 * A partial run counts because the lane writes a row for every repository
 * it tried: evidence, or the reason its read failed. A failed repository
 * reads unconfirmed with that reason; its siblings keep their readings.
 *
 * A truncated read that is not ready is unconfirmed too, decided here so the
 * board cell and the repository page cannot differ on it. A truncated read
 * that is ready stays confirmed: what was read already counts. The tier lift
 * reads only security fixes, and a reading that is not ready has none.
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
      (run?.outcome === "ok" || run?.outcome === "partial") &&
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
      return { state: "unconfirmed", reason: RELEASE_NOT_CONFIRMED };
    }
    const failure = readReleaseFailure(row.payload);
    if (failure !== null) return { state: "unconfirmed", reason: failure };
    const evidence = readReleaseEvidence(row.payload);
    if (evidence === null) {
      return { state: "unconfirmed", reason: RELEASE_UNREADABLE };
    }
    const verdict = assessRelease(evidence);
    if (verdict.truncated && !verdict.ready) {
      return { state: "unconfirmed", reason: RELEASE_TRUNCATED };
    }
    return {
      state: "confirmed",
      verdict,
      tagDate: evidence.tagDate,
      verifiedAt: row.verifiedAt,
    };
  }
}
