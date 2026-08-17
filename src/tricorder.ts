/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { pathToFileURL } from "node:url";
import { loadConfig } from "./core/config.js";
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
  formatLine,
  type LaneSchedule,
  loop,
} from "./tricorder/collect/scheduler.js";
import { diagnose, formatReport } from "./tricorder/doctor.js";
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

/** Seconds between wake-ups. Invalid values fall back rather than hot-loop. */
function parseTickMs(raw: string | undefined): number {
  const n = Number((raw ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n * 1000 : 60_000;
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
      policy: { cadenceMs: 15 * 60_000 },
      // The coverage lane is daily (AD-15), so judging it on the sweep cadence
      // would report every attestation as stale within half an hour.
      coveragePolicy: { cadenceMs: 24 * 60 * 60_000 },
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

    const app = createTricorderAppFromEnv(env);
    const github = await createTricorderReadPort(app, env);

    const watchedIn = (installation: string) =>
      watched.filter((r) => r.owner.toLowerCase() === installation);
    const isWatched = (repo: { owner: string; name: string }) =>
      watched.some(
        (r) =>
          r.owner.toLowerCase() === repo.owner.toLowerCase() &&
          r.name.toLowerCase() === repo.name.toLowerCase(),
      );

    const laneDeps = {
      github,
      store,
      watchedIn,
      isWatched,
      now: () => new Date().toISOString(),
      log,
    };

    const schedules: LaneSchedule[] = [
      {
        lane: ALERT_LANE,
        scope: "full",
        cadenceMs: 15 * 60_000,
        run: (installation) => collectOrgAlerts(laneDeps, installation, "full"),
      },
      {
        lane: COVERAGE_LANE,
        scope: "full",
        cadenceMs: 24 * 60 * 60_000,
        run: (installation) => collectCoverage(laneDeps, installation, "full"),
      },
    ];

    log(
      `collecting ${watched.length} repositories across ${installations.length} installations: ${installations.join(", ")}`,
    );

    const once = (env.TRICORDER_ONCE ?? "").trim() !== "";
    await loop(
      {
        store,
        now: () => new Date(),
        log: (fields, msg) => log(formatLine(fields, msg)),
      },
      schedules,
      installations,
      { once, tickMs: parseTickMs(env.TRICORDER_TICK_SECONDS), log },
    );

    if (once) {
      store.close();
      return;
    }

    for (const signal of ["SIGTERM", "SIGINT"] as const) {
      process.once(signal, () => {
        log(`${signal}, shutting down`);
        store.close();
        process.exit(0);
      });
    }
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
