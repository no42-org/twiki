/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { Config } from "../core/config.js";
import { type RunDeps, runOnce } from "./run.js";

// Drives runOnce: one tick, or a tick every interval. A failing tick is logged
// and swallowed so the loop survives it; twiki is stateless per tick, so the
// next one re-derives truth and self-heals.

export interface ScheduleOptions {
  once: boolean;
  pollMinutes: number;
  log: (msg: string) => void;
}

export async function schedule(
  config: Config,
  deps: RunDeps,
  opts: ScheduleOptions,
): Promise<void> {
  const tick = async () => {
    try {
      await runOnce(config, deps);
    } catch (err) {
      opts.log(`run failed: ${err instanceof Error ? err.stack : err}`);
    }
  };

  await tick();
  if (opts.once) return;

  setInterval(tick, opts.pollMinutes * 60_000);
}
