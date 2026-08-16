/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { isAllowlisted, loadConfig } from "./core/config.js";
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

  if (role === "web") {
    // Read-only, and refuses a schema this build does not understand rather
    // than serving misread rows (AD-26).
    const store = SqliteStore.openForRead(dbPath);
    const config = loadConfig(configPath);
    const watched = config.repos.filter((r) => isAllowlisted(config, r));

    const app = createApp({
      store,
      watched,
      // Matches the full-sweep cadence the architecture plans for.
      policy: { cadenceMs: 15 * 60_000 },
      now: () => new Date(),
    });

    startServer(app, {
      host: env.TRICORDER_HOST,
      port: env.TRICORDER_PORT ? Number(env.TRICORDER_PORT) : undefined,
      log,
    });
    return;
  }

  if (role === "collect") {
    // The collector's scheduling and lane wiring land with the scheduling
    // story. Opening for write here migrates the schema forward, which is the
    // collector's job and only the collector's (AD-26).
    const store = SqliteStore.openForWrite(dbPath);
    log(`store ready at ${dbPath}, schema v${store.schemaVersion()}`);
    store.close();
    return;
  }

  usage();
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
