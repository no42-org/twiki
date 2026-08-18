/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { Subject, SubjectType } from "../../core/subject.js";

// StorePort exposes named domain queries, never SQL. No SQL string, table name
// or column name may appear outside this directory (AD-27): a passthrough
// would push projection and freshness logic into every route that used it.
//
// Every read returns verified_at alongside its value, so AD-11 is structurally
// satisfiable rather than a thing each caller must remember.

export type RunScope = "hot" | "full";
export type RunOutcome = "ok" | "partial" | "failed";
export type SubjectState = "present" | "resolved";

export interface RunRef {
  id: number;
  lane: string;
  installation: string;
  scope: RunScope;
}

export interface RunStart {
  lane: string;
  installation: string;
  scope: RunScope;
  startedAt: string;
}

/** What a lane observed about one subject. */
export interface ObservationInput {
  subject: Subject;
  /** Serialisable, shape discriminated on subject.type. */
  payload: unknown;
  state?: SubjectState;
  /**
   * When the value last changed. Omitted means "unchanged": the store carries
   * the previous observed_at forward, which is what keeps a 304 from making a
   * quiet repository look stale (AD-11).
   */
  observedAt?: string;
}

/** A subject's current value, as the projection holds it. */
export interface CurrentValue<T = unknown> {
  subject: Subject;
  payload: T;
  state: SubjectState;
  /** When the value last changed. */
  observedAt: string;
  /** When it was last confirmed. Freshness renders from this. */
  verifiedAt: string;
}

export interface RunRecord {
  id: number;
  lane: string;
  installation: string;
  scope: RunScope;
  outcome: RunOutcome;
  detail: string | null;
  startedAt: string;
  verifiedAt: string;
}

export interface Validator {
  etag: string | null;
  lastModified: string | null;
  tokenGen: string;
}

export interface StorePort {
  /** Schema version the store is at. The web process refuses a mismatch. */
  schemaVersion(): number;

  // --- write side: collector only ---

  beginRun(start: RunStart): RunRef;
  finishRun(
    run: RunRef,
    outcome: RunOutcome,
    verifiedAt: string,
    detail?: string,
  ): void;

  /**
   * Append observations and advance the projection in ONE transaction (AD-3).
   * Either both land or neither does.
   */
  recordObservations(
    run: RunRef,
    verifiedAt: string,
    observations: readonly ObservationInput[],
  ): void;

  /** Mark a subject gone. Explicit, never inferred from absence (AD-23). */
  recordTombstones(
    run: RunRef,
    verifiedAt: string,
    subjects: readonly Subject[],
  ): void;

  /** Advance verified_at without writing an observation. This is what a 304 does. */
  touchVerified(subjects: readonly Subject[], verifiedAt: string): void;

  saveValidator(
    installation: string,
    requestUrl: string,
    validator: Validator,
    verifiedAt: string,
  ): void;

  /**
   * Drop a stored validator.
   *
   * Called whenever a 200 sweep stores rows without producing a cacheable
   * validator: the stored one still describes the pre-rewrite listing, and a
   * later byte-identical revert of the listing would let a 304 against it
   * confirm rows the listing no longer contains, skipping the tombstone pass
   * a 200 would have run (AD-23, AD-25).
   */
  deleteValidator(installation: string, requestUrl: string): void;

  /** Trim observations older than the cutoff. Never touches the projection (AD-4). */
  trimObservations(olderThan: string): number;

  /**
   * Delete collection runs older than `olderThan`, returning the count.
   *
   * Two subjects are never deleted, whatever their age:
   *
   *   the latest run per (lane, installation, scope)  losing it removes the
   *     lane from the collection-health view entirely, and a lane missing from
   *     that table is indistinguishable from a lane that is fine
   *   any run an observation still references  the log points at the run that
   *     produced it, and severing that is a worse loss than the disk it saves
   *
   * Unlike observations, run rows accumulate with time rather than with change:
   * roughly 1.9M a year at the planned cadences, whether or not anything
   * happens. That asymmetry is why the trim exists.
   */
  trimRuns(olderThan: string): number;

  // --- read side: both processes ---

  currentByType(type: SubjectType): CurrentValue[];
  /**
   * Subjects of a type whose key begins with `owner/`. Reconciliation must be
   * bounded to what a run actually queried, so a lane sweeping one
   * organisation can only ever tombstone that organisation's subjects (AD-16).
   */
  currentByTypeForOwner(type: SubjectType, owner: string): CurrentValue[];
  current(subject: Subject): CurrentValue | null;
  latestRuns(limit: number): RunRecord[];
  /**
   * The newest run for each (lane, installation, scope).
   *
   * Not a slice of recent history: a lane that stopped running is exactly the
   * one that a fixed window pushes out, so it would vanish from the health
   * view rather than showing stale, which is backwards (AD-16).
   */
  latestRunPerKey(): RunRecord[];
  loadValidator(installation: string, requestUrl: string): Validator | null;

  close(): void;
}
