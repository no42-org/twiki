/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { safeLog } from "../../core/log.js";
import { redact } from "../../core/redact.js";
import type { RunRef, RunStart, StorePort } from "../store/port.js";

// The one failure path every collection lane shares (#71).
//
// This owns exactly two things, the begin call and the catch, because those
// are what all eight lanes spelled identically. It deliberately owns nothing
// between them: the outcome, the detail string, the success `finishRun`, the
// tombstone pass and the early returns differ across five distinct shapes,
// and a helper that parameterised them would flatten distinctions a reader
// needs to see - the per-repository containment boundary two lanes have and
// three do not, the terminal branches that finish a run mid-body, the actions
// lane's tombstone gate, and the KEV lane's rule that a partial run writes
// nothing.

/**
 * The store, the clock and the logger, which every lane's deps carries.
 *
 * Every lane's deps interface extends this, so "a lane's deps is a superset"
 * is checked by the compiler rather than asserted in a comment.
 */
export interface LaneRunDeps {
  store: StorePort;
  now: () => string;
  log: (msg: string) => void;
}

/**
 * Whether a lane collects per installation or once globally.
 *
 * It decides one thing: whether the failure line names the installation. KEV
 * and reviews are global, and their `installation` is a placeholder
 * (`cisa-kev`, the reviews constant) rather than an org anyone owns, so a
 * line naming it would report the failure against an installation that does
 * not exist.
 *
 * A closed pair rather than a free-form label, because both ways of getting
 * that wrong are silent: a global lane that names its placeholder reads like
 * a real org failing, and an installation-scoped lane that drops its
 * installation cannot answer the only question the line is asked (AD-16).
 * The label is derived from the same `lane` and `installation` the run row is
 * written from, so the line cannot drift from the row.
 */
export type LaneReach = "per-installation" | "global";

/**
 * What the wrapper needs to begin a run: `RunStart` minus the clock, which it
 * reads itself, plus the reach. Derived from `RunStart` so a field added
 * there reaches every lane rather than stopping here.
 */
export type LaneRunStart = Omit<RunStart, "startedAt"> & { reach: LaneReach };

/**
 * Begin a collection run, run the lane's body, and contain its failures.
 *
 * Contained: anything the body throws, and a throw from `beginRun` itself,
 * where there is no run to finish. Either way the run is finished `failed`
 * with the redacted message, one redacted line is logged, and a copy of
 * `onFailure` is returned.
 *
 * Guarded within the failure path itself: the `finishRun` that records the
 * failure, because a failing store is one of the things that gets us here,
 * and the log call, through `safeLog`. NOT guarded: computing the detail. A
 * throwing `err.message` getter or a throwing `redact` would escape, and
 * nothing has shown either to be reachable; a second nested try would only
 * hide it.
 *
 * `onFailure` is the caller's own zeroed result, passed in rather than built
 * here because every lane's result shape differs; owning it would be the
 * first step towards owning the outcome too. It is copied on the way out, so
 * a lane that hoists its zero into a module constant cannot have one failed
 * run's mutation reach the next.
 *
 * The body receives the run handle and the `startedAt` this read from the
 * clock, so a lane that judges its own work against the sweep's clock reads
 * it once rather than twice.
 */
export async function withLaneRun<T extends object>(
  deps: LaneRunDeps,
  start: LaneRunStart,
  onFailure: T,
  body: (run: RunRef, startedAt: string) => Promise<T>,
): Promise<T> {
  // Wraps deps.log for this line only. Each lane wraps its own logger too,
  // and the two are not redundant: see safeLog.
  const log = safeLog(deps.log);
  const label =
    start.reach === "global"
      ? start.lane
      : `${start.lane} ${start.installation}`;
  let run: RunRef | null = null;

  try {
    // Inside the try: beginRun touches the database, and a busy store here
    // would otherwise escape and abort the whole sweep.
    const startedAt = deps.now();
    run = deps.store.beginRun({
      lane: start.lane,
      installation: start.installation,
      scope: start.scope,
      startedAt,
    });
    // Awaited, not returned: a returned promise rejects outside this try.
    return await body(run, startedAt);
  } catch (err) {
    // Redacted before it reaches either the log or collection_run.detail: a
    // GitHub auth failure can quote the credential it rejected (AD-16).
    const detail = redact(err instanceof Error ? err.message : String(err));
    if (run) {
      try {
        deps.store.finishRun(run, "failed", deps.now(), detail);
      } catch {
        // The store is what failed. Nothing further to record.
      }
    }
    log(`${label}: failed, ${detail}`);
    return { ...onFailure };
  }
}
