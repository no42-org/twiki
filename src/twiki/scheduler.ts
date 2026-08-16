/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { Config } from "../core/config.js";
import { type RunDeps, runOnce } from "./run.js";

// Drives runOnce: one tick, or a tick every interval. A failing tick is logged
// and swallowed so the loop survives it; twiki is stateless per tick, so the
// next one re-derives truth and self-heals.

export const DEFAULT_POLL_MINUTES = 60;

export interface ScheduleOptions {
  once: boolean;
  pollMinutes: number;
  log: (msg: string) => void;
}

/**
 * A poll interval that cannot turn the loop into a hot loop. `Number("")` is 0
 * and `Number("60m")` is NaN; both would reach setInterval and be clamped to a
 * few milliseconds, re-running the tick continuously. In enforce mode that
 * means merge and tag attempts in a tight loop, so anything not finite and
 * positive falls back to the default.
 */
export function normalisePollMinutes(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_POLL_MINUTES;
}

export async function schedule(
  config: Config,
  deps: RunDeps,
  opts: ScheduleOptions,
): Promise<void> {
  const minutes = normalisePollMinutes(opts.pollMinutes);
  if (minutes !== opts.pollMinutes) {
    opts.log(
      `poll interval ${opts.pollMinutes} is not a positive number; using ${minutes} minutes`,
    );
  }

  const tick = async () => {
    try {
      await runOnce(config, deps);
    } catch (err) {
      opts.log(`run failed: ${err instanceof Error ? err.stack : err}`);
    }
  };

  await tick();
  if (opts.once) return;

  // Re-arm only after the tick settles. setInterval would start a second tick
  // on top of a slow one, re-deriving facts mid-flight against the same repos.
  const rearm = () => {
    setTimeout(() => {
      void tick().then(rearm);
    }, minutes * 60_000);
  };
  rearm();
}
