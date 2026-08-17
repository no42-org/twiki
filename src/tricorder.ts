/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { loadConfig } from "./core/config.js";
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
 */
function parsePort(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) {
    console.error(`[tricorder] TRICORDER_PORT is not a valid port: ${raw}`);
    process.exit(2);
  }
  return n;
}

function usage(): never {
  console.error("usage: tricorder <collect|web>");
  process.exit(2);
}

async function main(): Promise<void> {
  const role = process.argv[2];
  const env = process.env;
  const dbPath = env.TRICORDER_DB ?? DEFAULT_DB;
  const configPath = env.TWIKI_CONFIG ?? "repos.yaml";
  const log = (msg: string) => console.error(`[tricorder] ${msg}`);

  const port = parsePort(env.TRICORDER_PORT);

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
      now: () => new Date(),
    });

    startServer(app, {
      host: env.TRICORDER_HOST,
      port,
      log,
    });
    return;
  }

  if (role === "collect") {
    // The collector's scheduling and lane wiring land with the scheduling
    // story. Opening for write here migrates the schema forward, which is the
    // collector's job and only the collector's (AD-26).
    const store = SqliteStore.openForWrite(dbPath);
    const config = loadConfig(configPath);
    log(
      `store ready at ${dbPath}, schema v${store.schemaVersion()}, ` +
        `${config.repos.length} watched repositories`,
    );
    store.close();
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
