/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { serve } from "@hono/node-server";
import type { Hono } from "hono";

// The deployment is private and unauthenticated, so the bind address is a
// safety property, not a preference (AD-12). The default is loopback and there
// is no code path that defaults to 0.0.0.0: exposing this has to be a
// deliberate act by whoever runs it, not something that happens because a
// variable was unset.

export const DEFAULT_HOST = "127.0.0.1";

/** Spellings that are genuinely loopback. A false warning trains people to ignore the real one. */
const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
export const DEFAULT_PORT = 8787;

export interface ServeOptions {
  host?: string;
  port?: number;
  log?: (msg: string) => void;
}

export function startServer(app: Hono, opts: ServeOptions = {}) {
  const hostname = opts.host?.trim() || DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const log = opts.log ?? (() => {});

  if (!LOOPBACK.has(hostname)) {
    // Not a refusal: someone may genuinely be putting this behind their own
    // authenticated proxy. But it must never be quiet, because there is no UI
    // auth in front of ~718 repositories' security posture.
    log(
      `WARNING: binding ${hostname}, not loopback. There is no UI authentication; ` +
        "anything that can reach this port can read every collected alert.",
    );
  }

  log(`listening on http://${hostname}:${port}`);
  return serve({ fetch: app.fetch, hostname, port });
}
