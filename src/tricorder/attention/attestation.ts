/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { CurrentValue, RunRecord, StorePort } from "../store/port.js";
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

/**
 * Whether one repository's own confirmation row still vouches for a count.
 *
 * Presence is not enough, and that is the whole of this function: a lane
 * that died days ago leaves its last confirmation behind, and reading it as
 * an attestation makes a page say `none` where the overview - which judges
 * the same row on the same cadence - says `unconfirmed`. `actionsVouched`
 * states the same rule for the Actions lane, with a payload check this one
 * has no analogue for: this confirmation carries only a count, and a
 * confirmation that reached the repository and found nothing is exactly the
 * `0` we want to publish.
 *
 * Takes a CURRENT, present row: the callers drop tombstones on the way in,
 * because a tombstoned confirmation is a retracted assertion rather than a
 * stale one, and they also have to tell "retracted" from "never written".
 * Checking the state again here would be a second guard for one rule, which
 * is how both end up unpinned by any test.
 *
 * A type predicate, so a caller that goes on to read the vouching row's
 * `verifiedAt` narrows here rather than asserting the row back into
 * existence beside the call that just checked it.
 */
export function confirmationVouches(
  value: CurrentValue | undefined,
  now: Date,
  policy: FreshnessPolicy,
): value is CurrentValue {
  if (value === undefined) return false;
  return freshness(value.verifiedAt, now, policy) === "fresh";
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
