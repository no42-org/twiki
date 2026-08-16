/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { Hono } from "hono";
import type { RepoRef } from "../../core/types.js";
import type { StorePort } from "../store/port.js";
import { Page } from "./components.js";
import type { FreshnessPolicy } from "./freshness.js";
import { buildCollectionHealth, buildRepoRows } from "./view.js";

// Routes read through StorePort only: no SQL, no table name, no predicate
// composed here (AD-27). No GitHub call happens on the request path (AD-3).

export interface AppDeps {
  store: StorePort;
  watched: readonly RepoRef[];
  policy: FreshnessPolicy;
  now: () => Date;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const now = deps.now();
    const rows = buildRepoRows(deps.store, deps.watched, now, deps.policy);
    const health = buildCollectionHealth(deps.store, now, deps.policy);
    return c.html(
      Page({ rows, health, generatedAt: now.toISOString() }) as string,
    );
  });

  /** Liveness only. It deliberately says nothing about collection health. */
  app.get("/healthz", (c) => c.text("ok"));

  return app;
}
