/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { pathToFileURL } from "node:url";
import { loadConfig } from "./core/config.js";
import {
  assertRankPolicy,
  DEFAULT_RANK_POLICY,
  type RankPolicy,
} from "./core/rank.js";
import { HttpEnrichment } from "./enrich/kev.js";
import {
  createTricorderAppFromEnv,
  createTricorderReadPort,
} from "./github/octokit-adapter.js";
import {
  LANE as COVERAGE_LANE,
  collectCoverage,
} from "./tricorder/collect/coverage.js";
import {
  LANE as ALERT_LANE,
  collectOrgAlerts,
} from "./tricorder/collect/dependabot-alerts.js";
import {
  collectIssues,
  LANE as ISSUE_LANE,
} from "./tricorder/collect/issues.js";
import {
  collectKev,
  KEV_INSTALLATION,
  LANE as KEV_LANE,
} from "./tricorder/collect/kev.js";
import {
  assertSchedules,
  formatLine,
  type LaneSchedule,
  loop,
} from "./tricorder/collect/scheduler.js";
import {
  collectUpdatePRs,
  LANE as UPDATE_PR_LANE,
} from "./tricorder/collect/update-prs.js";
import {
  collectUpdateStatuses,
  LANE as UPDATE_STATUS_LANE,
} from "./tricorder/collect/update-status.js";
import { diagnose, formatReport } from "./tricorder/doctor.js";
import type { RunOutcome, RunScope } from "./tricorder/store/port.js";
import { SqliteStore } from "./tricorder/store/sqlite-store.js";
import { createApp } from "./tricorder/web/app.js";
import { startServer } from "./tricorder/web/server.js";

// gitricorder's entrypoint. Two roles from one image, chosen by argument
// (AD-13): the collector writes, the web process reads, and neither performs
// the other's job.
//
// This entrypoint may not import src/twiki: it wires the read side only, and
// the boundary lint enforces that.

const DEFAULT_DB = "tricorder.db";

/**
 * Lane cadences, in one place.
 *
 * The scheduler's cadence and the reader's freshness budget must be the same
 * number, and they were three separate literals. AD-11 calls a lane judged on
 * the wrong cadence a defect, and duplication is how that happens.
 */
export const ALERT_CADENCE_MS = 15 * 60_000;
export const COVERAGE_CADENCE_MS = 24 * 60 * 60_000;
export const KEV_CADENCE_MS = 24 * 60 * 60_000;
/** After a failed or partial run, retry sooner than a full day. */
export const KEV_RETRY_MS = 60 * 60_000;

/**
 * `??` does not catch NaN, so an unparseable port would reach listen(), coerce
 * to 0 and bind an arbitrary ephemeral port while the log claimed otherwise.
 *
 * Decimal digits only, and 0 is rejected: `Number()` also accepts `1e4` and
 * `0x1f`, and port 0 is the exact "bind something arbitrary" case this guard
 * exists to prevent. Throws rather than exiting so it can be tested.
 */
export function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`TRICORDER_PORT is not a valid port: ${raw}`);
  }
  const n = Number(trimmed);
  if (n < 1 || n > 65535) {
    throw new Error(`TRICORDER_PORT is not a valid port: ${raw}`);
  }
  return n;
}

/**
 * An env flag that reads the way an operator expects.
 *
 * `!== ""` would make TRICORDER_ONCE=false enable once-mode, so a compose file
 * written to turn the feature OFF would turn it on and the container would run
 * one cycle and exit. No other flag in src/ sets a precedent, so this is it.
 */
export function envFlag(raw: string | undefined): boolean {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "") return false;
  return !["false", "0", "no", "off"].includes(v);
}

/**
 * Seconds between wake-ups, with a floor.
 *
 * The floor is the point. `TRICORDER_TICK_SECONDS=0.001` is finite and above
 * zero, so a "> 0" check passes it through as one millisecond: a cycle against
 * GitHub every millisecond, which is the exact failure the guard exists to
 * prevent. Anything unusable or below the floor falls back, loudly.
 */
export const MIN_TICK_SECONDS = 1;
export const DEFAULT_TICK_SECONDS = 60;

export function parseTickSeconds(
  raw: string | undefined,
  warn: (msg: string) => void = () => {},
): number {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return DEFAULT_TICK_SECONDS;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n < MIN_TICK_SECONDS) {
    warn(
      `TRICORDER_TICK_SECONDS=${raw} is not usable (minimum ${MIN_TICK_SECONDS}s); using ${DEFAULT_TICK_SECONDS}s`,
    );
    return DEFAULT_TICK_SECONDS;
  }
  return n;
}

/**
 * The real schedule table.
 *
 * Extracted so it can be asserted over. Every lane here was deletable with a
 * green suite: removing the KEV block, or the `installations` restriction that
 * keeps the GitHub lanes off the KEV pseudo-installation, passed lint,
 * typecheck and every test.
 */
export function buildSchedules(deps: {
  installations: readonly string[];
  alerts: (installation: string) => Promise<{ outcome: RunOutcome }>;
  coverage: (installation: string) => Promise<{ outcome: RunOutcome }>;
  kev: (scope: RunScope) => Promise<{ outcome: RunOutcome }>;
  /** Null when no bot actors are configured: the lane is absent, loudly. */
  updatePrs:
    | ((installation: string) => Promise<{ outcome: RunOutcome }>)
    | null;
  issues: (installation: string) => Promise<{ outcome: RunOutcome }>;
  updateStatuses: (installation: string) => Promise<{ outcome: RunOutcome }>;
}): LaneSchedule[] {
  const schedules: LaneSchedule[] = [
    {
      lane: KEV_LANE,
      scope: "full",
      cadenceMs: KEV_CADENCE_MS,
      retryAfterMs: KEV_RETRY_MS,
      installations: [KEV_INSTALLATION],
      // Scope passed explicitly rather than relying on a default: if the two
      // disagree the due-ness key never matches the run that was written, and
      // the lane re-fetches on every tick.
      run: () => deps.kev("full"),
    },
    {
      lane: ALERT_LANE,
      scope: "full",
      cadenceMs: ALERT_CADENCE_MS,
      installations: deps.installations,
      run: deps.alerts,
    },
    ...(deps.updatePrs === null
      ? []
      : [
          {
            lane: UPDATE_PR_LANE,
            scope: "full" as const,
            cadenceMs: ALERT_CADENCE_MS,
            installations: deps.installations,
            run: deps.updatePrs,
          },
        ]),
    {
      lane: ISSUE_LANE,
      scope: "full",
      cadenceMs: ALERT_CADENCE_MS,
      installations: deps.installations,
      run: deps.issues,
    },
    // Always on, deliberately not gated on the bots config like updatePrs: a
    // STUCK update is exactly one with no PR to search for, and tying the two
    // together would hide the stuck state from anyone without bots configured.
    {
      lane: UPDATE_STATUS_LANE,
      scope: "full",
      cadenceMs: ALERT_CADENCE_MS,
      installations: deps.installations,
      run: deps.updateStatuses,
    },
    {
      lane: COVERAGE_LANE,
      scope: "full",
      cadenceMs: COVERAGE_CADENCE_MS,
      installations: deps.installations,
      run: deps.coverage,
    },
  ];
  // Validated here, not at the call site: an earlier version exported the
  // check and relied on the entrypoint to call it, the wiring silently never
  // landed, and a lane whose installations the cycle never visits would have
  // been skipped every tick with no run rows and no error.
  assertSchedules(schedules, cycleInstallations(deps.installations));
  return schedules;
}

/**
 * Every installation a cycle visits, KEV's pseudo-installation included.
 *
 * A Set, because an owner literally named `cisa` would otherwise appear twice
 * and every GitHub lane would sweep it twice per cycle.
 */
export function cycleInstallations(installations: readonly string[]): string[] {
  return [...new Set([...installations, KEV_INSTALLATION])];
}

/**
 * EPSS thresholds from the environment, or the measured defaults.
 *
 * CAP-6: changing a configured threshold changes the order, and no
 * configuration path reorders the chain itself. The numbers go through
 * assertRankPolicy, so a typo refuses to start rather than silently
 * mis-banding every item on the queue.
 */
export function parseEpssBands(raw: string | undefined): RankPolicy {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return DEFAULT_RANK_POLICY;
  const bands = trimmed.split(",").map((part) => Number(part.trim()));
  const policy: RankPolicy = { epssBands: bands };
  try {
    assertRankPolicy(policy);
  } catch (err) {
    throw new Error(
      `TRICORDER_EPSS_BANDS is not usable: ${err instanceof Error ? err.message : err}`,
    );
  }
  return policy;
}

/** An https URL, or unset. Anything else refuses to start. */
export function parseKevUrl(raw: string | undefined): string | undefined {
  const trimmed = (raw ?? "").trim();
  if (trimmed === "") return undefined;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`TRICORDER_KEV_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`TRICORDER_KEV_URL must be https: ${raw}`);
  }
  return url.toString();
}

function usage(): never {
  console.error("usage: tricorder <collect|web|doctor>");
  process.exit(2);
}

async function main(): Promise<void> {
  const role = process.argv[2];
  const env = process.env;
  const dbPath = env.TRICORDER_DB ?? DEFAULT_DB;
  const configPath = env.TWIKI_CONFIG ?? "repos.yaml";
  const log = (msg: string) => console.error(`[tricorder] ${msg}`);

  let port: number | undefined;
  try {
    port = parsePort(env.TRICORDER_PORT);
  } catch (err) {
    console.error(`[tricorder] ${err instanceof Error ? err.message : err}`);
    process.exit(2);
  }

  if (role === "web") {
    // Read-only, and refuses a schema this build does not understand rather
    // than serving misread rows (AD-26).
    const store = SqliteStore.openForRead(dbPath);
    // repos.yaml is the entire universe (AD-10), so its entries ARE the
    // watched set. There is no second filter to apply here.
    const config = loadConfig(configPath);
    const watched = config.repos;

    const app = createApp({
      store,
      watched,
      // Matches the full-sweep cadence the architecture plans for.
      policy: { cadenceMs: ALERT_CADENCE_MS },
      // Each lane judged on its own cadence. One global threshold applied to
      // every lane is a defect AD-11 names explicitly, and it made both daily
      // lanes read stale thirty minutes after succeeding.
      lanePolicies: {
        [KEV_LANE]: { cadenceMs: KEV_CADENCE_MS },
        [COVERAGE_LANE]: { cadenceMs: COVERAGE_CADENCE_MS },
      },
      rankPolicy: parseEpssBands(env.TRICORDER_EPSS_BANDS),
      now: () => new Date(),
    });

    const server = startServer(app, {
      host: env.TRICORDER_HOST,
      port,
      log,
    });

    // Without this the container takes the full 10s SIGTERM grace period on
    // every stop and drops the WAL handle rather than closing it.
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        log(`${signal}, shutting down`);
        server.close(() => {
          store.close();
        });
      });
    }
    return;
  }

  if (role === "collect") {
    // Opening for write migrates the schema forward, which is the collector's
    // job and only the collector's (AD-26).
    const store = SqliteStore.openForWrite(dbPath);
    const config = loadConfig(configPath);
    const watched = config.repos;

    // Installations are derived from the allowlist, not discovered. repos.yaml
    // is the entire universe (AD-10), so an account nothing is watched on is
    // an account we have no business calling.
    const installations = [
      ...new Set(watched.map((r) => r.owner.toLowerCase())),
    ].sort();

    const watchedIn = (installation: string) =>
      watched.filter((r) => r.owner.toLowerCase() === installation);
    const isWatched = (repo: { owner: string; name: string }) =>
      watched.some(
        (r) =>
          r.owner.toLowerCase() === repo.owner.toLowerCase() &&
          r.name.toLowerCase() === repo.name.toLowerCase(),
      );

    const app = createTricorderAppFromEnv(env);
    const github = await createTricorderReadPort(app, isWatched, env);

    const laneDeps = {
      github,
      store,
      watchedIn,
      isWatched,
      now: () => new Date().toISOString(),
      log,
    };

    // Configurable so a mirror or an egress proxy can be used. Validated like
    // every neighbouring setting: a typo that silently reverts to CISA's feed
    // would look like a working mirror until someone read the logs.
    const enrichment = new HttpEnrichment(parseKevUrl(env.TRICORDER_KEV_URL));

    const schedules = buildSchedules({
      installations,
      alerts: (installation) =>
        collectOrgAlerts(laneDeps, installation, "full"),
      coverage: (installation) =>
        collectCoverage(laneDeps, installation, "full"),
      kev: (scope) =>
        collectKev({ enrichment, store, now: laneDeps.now, log }, scope),
      updatePrs:
        config.bots.length > 0
          ? (installation) =>
              collectUpdatePRs(
                { ...laneDeps, bots: config.bots },
                installation,
                "full",
              )
          : null,
      issues: (installation) => collectIssues(laneDeps, installation, "full"),
      updateStatuses: (installation) =>
        collectUpdateStatuses(laneDeps, installation, "full"),
    });

    if (config.bots.length === 0) {
      // Absent, loudly. A lane that silently does not exist is how "no update
      // PRs" and "we never looked" become the same picture (AD-19, AD-28).
      log(
        "no bot actors configured; the update-PR lane is disabled. Set bots: in repos.yaml.",
      );
    }

    log(
      `collecting ${watched.length} repositories across ${installations.length} installations: ${installations.join(", ")}`,
    );

    const once = envFlag(env.TRICORDER_ONCE);

    // Registered BEFORE the first cycle. A full cycle is one call per watched
    // repository for the coverage lane, so it can run for minutes; a container
    // stopped in that window would otherwise get default signal handling and
    // die without closing the WAL handle.
    let stopping = false;
    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        stopping = true;
        log(`${signal}, shutting down`);
        store.close();
        process.exit(0);
      });
    }

    const failures = await loop(
      {
        store,
        now: () => new Date(),
        log: (fields, msg) => log(formatLine(fields, msg)),
      },
      schedules,
      cycleInstallations(installations),
      {
        once,
        tickMs: parseTickSeconds(env.TRICORDER_TICK_SECONDS, log) * 1000,
        log,
      },
    );

    if (once) {
      if (!stopping) store.close();
      // A cron entry whose collection failed everywhere must not report
      // success. That is the same lie the old stub was changed to stop telling.
      if (failures > 0) {
        log(`${failures} lane runs failed`);
        process.exitCode = 1;
      }
      return;
    }
    return;
  }

  if (role === "doctor") {
    // Setup diagnostics. Reads GitHub, writes nothing, touches no store, so it
    // is safe to run against a live installation before anything is wired up.
    const config = loadConfig(configPath);
    const report = await diagnose(createTricorderAppFromEnv(env), config.repos);
    console.log(formatReport(report));
    // Non-zero on a bad setup, so this is usable as a gate rather than
    // something whose output somebody has to remember to read. exitCode rather
    // than exit(): a piped stdout is written asynchronously, and exiting here
    // truncates the tail naming the unreachable repositories.
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  usage();
}

// Only when run as a program. Without this guard, importing anything from this
// module (parsePort, in the tests) starts a server and can exit the process,
// which is why none of the entrypoint's safety split was testable before.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
