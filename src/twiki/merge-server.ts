/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { z } from "zod";
import type { MergeRequest } from "../core/merge.js";
import { type OperatorMergeDeps, operatorMerge } from "./operator-merge.js";

// twiki's only HTTP surface. It is unauthenticated, so it is reachable only
// over the Compose network: compose.yml publishes no port for it, and the host
// defaults to loopback. It is off unless TWIKI_MERGE_PORT is set.

const DEFAULT_HOST = "127.0.0.1";

const BODY = z.object({
  repo: z.string(),
  number: z.number().int().positive(),
});

export function createMergeApp(deps: OperatorMergeDeps): Hono {
  const app = new Hono();
  app.post("/merge", async (c) => {
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return c.json({ error: "body must be JSON" }, 400);
    }
    const parsed = BODY.safeParse(raw);
    if (!parsed.success) {
      return c.json(
        { error: "expected { repo: string, number: integer }" },
        400,
      );
    }
    const request: MergeRequest = parsed.data;
    try {
      return c.json(await operatorMerge(request, deps));
    } catch {
      // operatorMerge has already logged the cause. The body stays blank of
      // detail: the caller is another container, not someone to debug for.
      return c.json({ error: "merge failed" }, 500);
    }
  });
  return app;
}

export interface MergeListener {
  host: string;
  port: number;
}

/**
 * Read the listener settings from the environment. Returns null when
 * TWIKI_MERGE_PORT is unset or empty, which means no listener.
 */
export function mergeListenerFrom(
  env: Record<string, string | undefined>,
): MergeListener | null {
  const raw = env.TWIKI_MERGE_PORT?.trim();
  if (!raw) return null;
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new Error(
      `TWIKI_MERGE_PORT must be a port number from 1 to 65535, got "${raw}"`,
    );
  }
  return { host: env.TWIKI_MERGE_HOST?.trim() || DEFAULT_HOST, port };
}

export function startMergeServer(
  app: Hono,
  opts: MergeListener & { log: (msg: string) => void },
) {
  const { host, port, log } = opts;
  const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
    log(`merge listener on http://${host}:${info.port}`);
  });
  // A failed bind must not take the tick loop down with it.
  server.on("error", (err: Error) => {
    log(`merge listener failed to bind ${host}:${port}: ${err.message}`);
    server.close();
  });
  return server;
}
