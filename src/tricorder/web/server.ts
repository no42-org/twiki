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

export const DEFAULT_PORT = 8787;

/**
 * Is this address genuinely loopback?
 *
 * A false warning trains people to ignore the real one, so this recognises the
 * spellings that actually reach the loopback interface rather than four literal
 * strings: the whole of 127.0.0.0/8, `localhost` in any case, bracketed and
 * IPv4-mapped forms, and IPv6 loopback both compressed and expanded.
 */
export function isLoopback(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[/, "").replace(/\]$/, "");
  if (h === "localhost") return true;
  // ::ffff:127.0.0.1 is the IPv4-mapped form of an IPv4 loopback address.
  const v4 = h.startsWith("::ffff:") ? h.slice("::ffff:".length) : h;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)) return true;
  return h === "::1" || /^(?:0:){7}0*1$/.test(h);
}

export interface ServeOptions {
  host?: string;
  port?: number;
  log?: (msg: string) => void;
}

export function startServer(app: Hono, opts: ServeOptions = {}) {
  const hostname = opts.host?.trim() || DEFAULT_HOST;
  const port = opts.port ?? DEFAULT_PORT;
  const log = opts.log ?? (() => {});

  if (!isLoopback(hostname)) {
    // Not a refusal: someone may genuinely be putting this behind their own
    // authenticated proxy. But it must never be quiet, because there is no UI
    // auth in front of ~718 repositories' security posture.
    log(
      `WARNING: binding ${hostname}, not loopback. There is no UI authentication; ` +
        "anything that can reach this port can read every collected alert.",
    );
  }

  // Logged from the listening callback, with the port the kernel actually
  // gave us. Announcing before the bind tells the operator the server is up
  // when EADDRINUSE is about to say otherwise.
  const server = serve({ fetch: app.fetch, hostname, port }, (info) => {
    log(`listening on http://${hostname}:${info.port}`);
  });

  // Without this the bind failure surfaces as an unhandled 'error' event and a
  // raw stack, after the reassuring line above would have been printed.
  server.on("error", (err: Error) => {
    log(`failed to bind ${hostname}:${port}: ${err.message}`);
    process.exitCode = 1;
    server.close();
  });

  return server;
}
