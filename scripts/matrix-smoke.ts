/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { MatrixNotifier } from "../src/notify.js";

// Manual smoke test for the real Matrix delivery path against a live homeserver.
// Reads credentials from the environment so they never appear on the command
// line. Run with:
//
//   TWIKI_MATRIX_HOMESERVER=https://matrix.example.org \
//   TWIKI_MATRIX_TOKEN=... \
//   TWIKI_MATRIX_ROOM='!abc:example.org' \
//   npx tsx scripts/matrix-smoke.ts ["custom message"]

const homeserver = process.env.TWIKI_MATRIX_HOMESERVER;
const token = process.env.TWIKI_MATRIX_TOKEN;
const room = process.env.TWIKI_MATRIX_ROOM;

if (!homeserver || !token || !room) {
  console.error(
    "Missing env: set TWIKI_MATRIX_HOMESERVER, TWIKI_MATRIX_TOKEN and TWIKI_MATRIX_ROOM",
  );
  process.exit(2);
}

// Unique dedup file + timestamped message so every run actually delivers
// (the de-dup layer would otherwise skip an identical repeat).
const dedupePath = `/tmp/twiki-matrix-smoke-${process.pid}`;
const message = `twiki matrix smoke test — ${new Date().toISOString()}${
  process.argv[2] ? `\n${process.argv[2]}` : ""
}`;

const notifier = new MatrixNotifier(homeserver, token, room, dedupePath);

notifier
  .send(message)
  .then(() => {
    console.log(`✅ delivered to ${room} on ${homeserver}`);
  })
  .catch((err) => {
    console.error(`❌ ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  });
