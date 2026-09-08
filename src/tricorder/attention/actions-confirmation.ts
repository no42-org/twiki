/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { ActionsRepoObservation } from "../collect/workflow-runs.js";
import type { CurrentValue, StorePort } from "../store/port.js";
import { type FreshnessPolicy, freshness } from "./freshness.js";

// Whether a repository's own Actions sweep may be counted from (AD-28).
//
// Three surfaces ask it - the queue, which will not derive a `ci_failure`
// item without it, the board's CI chip, and the repository page's CI section
// - and a rule that drifted between them would let a repository show a
// failing build on one page and `unconfirmed` on the next, off the same row.
// One implementation, so they cannot.

/**
 * The present `repository_actions` rows, by folded slug (AD-22).
 *
 * The ONE place a tombstone is dropped, and it has to be dropped somewhere:
 * a tombstone carries its payload forward, so a row read without this check
 * still says `workflows: 1` and still vouches for a repository the sweep has
 * just said it can no longer speak for. `actionsVouched` below deliberately
 * does not repeat the check - two guards for one rule leave neither of them
 * pinned by a test, because removing either alone changes no answer.
 */
export function actionsConfirmations(
  store: StorePort,
): Map<string, CurrentValue> {
  const bySlug = new Map<string, CurrentValue>();
  for (const value of store.currentByType("repository_actions")) {
    // A tombstoned confirmation is a retracted assertion, not a stale one.
    if (value.state === "present") bySlug.set(value.subject.key, value);
  }
  return bySlug;
}

/**
 * Whether this repository's own Actions confirmation vouches for a count.
 *
 * Three things have to hold, and each was a real failure without it: the
 * sweep reached this repository, it could actually read what it found (a
 * null `workflows` means it reached and could not), and the confirmation is
 * still current on the Actions lane's own cadence. A lane that died days ago
 * must not keep badging its last word as though it were this hour's.
 *
 * The payload is read structurally rather than through `readWorkflowRun`'s
 * sibling guard, because only one field decides this and a confirmation
 * whose `workflows` is missing entirely must answer the same as one whose
 * `workflows` is null: we cannot count from it.
 *
 * A type predicate, so a caller that goes on to read the vouching row's
 * `verifiedAt` narrows here rather than asserting the row back into
 * existence beside the call that just checked it.
 *
 * Takes a CURRENT, present row: `actionsConfirmations` above drops the
 * tombstones, and the repository page filters its own lookup the same way
 * because it also has to tell "retracted" from "never written" for the
 * section's lane fall-back. Checking the state again here would be a second
 * guard for one rule, which is how both end up unpinned.
 */
export function actionsVouched(
  value: CurrentValue | undefined,
  now: Date,
  policy: FreshnessPolicy,
): value is CurrentValue {
  if (value === undefined) return false;
  const payload = value.payload as Partial<ActionsRepoObservation> | undefined;
  if (typeof payload?.workflows !== "number") return false;
  return freshness(value.verifiedAt, now, policy) === "fresh";
}
