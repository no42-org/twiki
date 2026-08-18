/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { redact } from "../../core/redact.js";
import type {
  RunOutcome,
  RunRecord,
  RunScope,
  StorePort,
} from "../store/port.js";

// Drives the lanes on their own cadences (AD-15), one installation at a time
// (AD-24).
//
// Due-ness is read from the store, never from process memory. A collector that
// restarts must not re-sweep everything it already swept, and must not wait a
// full cadence before doing anything either; the last run per lane and
// installation is already recorded, so it is the honest source.

export interface LaneSchedule {
  lane: string;
  scope: RunScope;
  cadenceMs: number;
  /**
   * Which installations this lane applies to. Omitted means all of them.
   *
   * Not every lane is per-installation. KEV is one public document that no
   * organisation has its own copy of, and giving it a pseudo-installation to
   * ride made the GitHub lanes try to collect from it and fail twice a cycle,
   * with the run then reporting failure it had not really had.
   */
  installations?: readonly string[];
  /**
   * How long to wait after a FAILED run, when that should be shorter than the
   * cadence. A daily lane that fails once would otherwise collect nothing for
   * 24 hours, and twice in a row crosses the staleness budget entirely.
   */
  retryAfterMs?: number;
  /** Runs one installation. Must not throw; lanes contain their own failures. */
  run: (installation: string) => Promise<{ outcome: RunOutcome }>;
}

export interface CycleDeps {
  store: StorePort;
  now: () => Date;
  log: (fields: LogFields, msg: string) => void;
}

/**
 * Every collector line carries these (AD-16).
 *
 * Not a convenience: when one installation goes quiet among thirteen, a line
 * that does not say which lane and which installation cannot answer the only
 * question being asked.
 */
export interface LogFields {
  lane: string;
  installation: string;
  scope: string;
  verifiedAt?: string;
}

/**
 * Is this lane due for this installation?
 *
 * A run in the future is treated as due. Clock skew that puts a stored
 * timestamp ahead of now would otherwise park the lane until real time caught
 * up, which for a badly wrong clock means never collecting again. Running one
 * cycle early is cheap; silently stopping is the failure this whole build is
 * organised against.
 */
/**
 * Reject a schedule that cannot work, at the point it is built.
 *
 * Not inside the cycle: throwing there aborts every remaining lane and
 * installation, which is exactly what AD-16 forbids, and turns one
 * misconfigured lane into a total collection outage repeated every tick.
 */
export function assertSchedules(
  schedules: readonly LaneSchedule[],
  installations: readonly string[],
): void {
  for (const s of schedules) {
    if (s.installations && s.installations.length === 0) {
      throw new Error(`lane ${s.lane} declares no installations`);
    }
    const orphan = s.installations?.find((i) => !installations.includes(i));
    if (orphan !== undefined) {
      throw new Error(
        `lane ${s.lane} declares installation ${orphan}, which the cycle never visits`,
      );
    }
  }
}

export function isDue(
  last: RunRecord | undefined,
  cadenceMs: number,
  now: Date,
  retryAfterMs?: number,
): boolean {
  if (!last) return true;
  // Anything that is not a clean success, not just `failed`. beginRun writes
  // `partial` as its in-flight placeholder, so a collector killed mid-run
  // leaves a row that would otherwise wait a full cadence, and a lane that
  // finished `partial` has not delivered what it was scheduled to deliver.
  const wait =
    last.outcome !== "ok" && retryAfterMs !== undefined
      ? Math.min(Math.max(retryAfterMs, 1_000), cadenceMs)
      : cadenceMs;
  const since = now.getTime() - new Date(last.verifiedAt).getTime();
  if (Number.isNaN(since)) return true;
  if (since < 0) return true;
  return since >= wait;
}

export interface CycleReport {
  ran: number;
  skipped: number;
  failed: number;
}

/**
 * Run every lane that is due, for every installation.
 *
 * Serial throughout. GitHub advises serial requests per installation, and
 * fanning out is how a collector trips secondary limits it cannot see coming
 * (AD-24). One installation's failure never reaches another's: lanes contain
 * their own errors, and anything that escapes one is caught here rather than
 * ending the cycle (AD-16).
 */
export async function runCycle(
  deps: CycleDeps,
  schedules: readonly LaneSchedule[],
  installations: readonly string[],
  cadenceOverride?: number,
): Promise<CycleReport> {
  const now = deps.now();
  const latest = new Map<string, RunRecord>();
  for (const r of deps.store.latestRunPerKey()) {
    latest.set(`${r.lane}|${r.installation}|${r.scope}`, r);
  }

  const report: CycleReport = { ran: 0, skipped: 0, failed: 0 };

  for (const installation of installations) {
    for (const s of schedules) {
      if (s.installations && !s.installations.includes(installation)) continue;
      const key = `${s.lane}|${installation}|${s.scope}`;
      const fields = {
        lane: s.lane,
        installation,
        scope: s.scope,
      };
      const cadence = cadenceOverride ?? s.cadenceMs;

      if (!isDue(latest.get(key), cadence, now, s.retryAfterMs)) {
        report.skipped++;
        continue;
      }

      try {
        const { outcome } = await s.run(installation);
        report.ran++;
        if (outcome === "failed") report.failed++;
        const after = deps.store
          .latestRunPerKey()
          .find((r) => `${r.lane}|${r.installation}|${r.scope}` === key);
        deps.log({ ...fields, verifiedAt: after?.verifiedAt }, outcome);
      } catch (err) {
        // A lane is supposed to contain its own failures. If one escapes, it
        // must still not take the other twelve installations down with it.
        report.ran++;
        report.failed++;
        deps.log(
          fields,
          `escaped its lane: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  return report;
}

/** Format one line so every field AD-16 asks for is present and greppable. */
export function formatLine(fields: LogFields, msg: string): string {
  const parts = [
    `lane=${fields.lane}`,
    `installation=${fields.installation}`,
    `scope=${fields.scope}`,
  ];
  if (fields.verifiedAt) parts.push(`verified_at=${fields.verifiedAt}`);
  return `${parts.join(" ")} ${redact(msg)}`;
}

export interface LoopOptions {
  /** One cycle then stop, for cron and for a smoke test. */
  once: boolean;
  /** How often to wake and look for due lanes. */
  tickMs: number;
  log: (msg: string) => void;
}

export const DEFAULT_TICK_MS = 60_000;

/**
 * A tick interval that cannot become a hot loop.
 *
 * `Number("")` is 0 and `Number("5m")` is NaN, and either would reach the timer
 * and be clamped to a few milliseconds. For this collector that means hammering
 * GitHub in a tight loop, which is the fastest possible way to lose an
 * installation's rate-limit budget.
 */
export function normaliseTickMs(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TICK_MS;
}

/**
 * Returns how many lane runs failed in the LAST cycle, so a caller running
 * once (cron) can exit non-zero rather than reporting success it did not have.
 */
export async function loop(
  deps: CycleDeps,
  schedules: readonly LaneSchedule[],
  installations: readonly string[],
  opts: LoopOptions,
): Promise<number> {
  const tickMs = normaliseTickMs(opts.tickMs);
  if (tickMs !== opts.tickMs) {
    opts.log(`tick interval ${opts.tickMs} is not usable; using ${tickMs}ms`);
  }

  const tick = async (): Promise<number> => {
    try {
      const r = await runCycle(deps, schedules, installations);
      opts.log(`cycle: ${r.ran} ran, ${r.skipped} not due, ${r.failed} failed`);
      return r.failed;
    } catch (err) {
      opts.log(
        `cycle failed: ${redact(String(err instanceof Error ? err.message : err))}`,
      );
      // The cycle itself falling over is worse than a lane failing, not
      // better. Counted as the runs a cycle would actually have attempted,
      // which per-lane `installations` made smaller than lanes x installations.
      const attempts = schedules.reduce(
        (n, s) =>
          n + (s.installations ? s.installations.length : installations.length),
        0,
      );
      return Math.max(1, attempts);
    }
  };

  const failed = await tick();
  if (opts.once) return failed;

  // Re-armed only after the cycle settles. An interval would start a second
  // cycle on top of a slow one, sweeping the same installation twice at once.
  const rearm = () => {
    setTimeout(() => {
      void tick().then(rearm);
    }, tickMs);
  };
  rearm();
  return failed;
}
