/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { RunRecord, StorePort } from "../store/port.js";
import {
  ageLabel,
  type Freshness,
  type FreshnessPolicy,
  freshness,
} from "./freshness.js";

// Whether a lane has vouched for a set at all (AD-28).
//
// Lives in attention rather than web because the board and the repo page
// both ask the question, and attention may not import the pages it feeds.

/** One section's standing: did anything actually establish this is complete? */
export interface SectionState {
  /**
   * True when a lane confirmed this repository's set, so an empty list means
   * "none". False means "we have not looked", and the page says so.
   */
  attested: boolean;
  freshness: Freshness;
  age: string;
}

/** The newest full-scope run of a lane on an installation, if any. */
export function latestFullRun(
  store: StorePort,
  lane: string,
  installation: string,
): RunRecord | undefined {
  return store
    .latestRunPerKey()
    .filter((r) => r.lane === lane)
    .filter((r) => r.installation.toLowerCase() === installation)
    .filter((r) => r.scope === "full")
    .sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))[0];
}

/**
 * Whether a lane vouched for this installation's set, and how current that
 * claim is.
 *
 * Read from the lane's own run rows rather than from the presence of data,
 * because presence cannot distinguish the two empties. Only an `ok` run
 * counts: a partial one skipped something, and it may have been exactly this
 * repository.
 */
export function laneAttestation(
  store: StorePort,
  lane: string,
  installation: string,
  now: Date,
  policy: FreshnessPolicy,
): SectionState {
  const run = latestFullRun(store, lane, installation);
  if (!run || run.outcome !== "ok") {
    return {
      attested: false,
      freshness: freshness(run?.verifiedAt ?? null, now, policy),
      age: ageLabel(run?.verifiedAt ?? null, now),
    };
  }
  return {
    attested: true,
    freshness: freshness(run.verifiedAt, now, policy),
    age: ageLabel(run.verifiedAt, now),
  };
}
