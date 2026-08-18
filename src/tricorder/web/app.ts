/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { Hono } from "hono";
import type { RepoRef } from "../../core/types.js";
import { LANE as COVERAGE_LANE } from "../collect/coverage.js";
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
  /** Cadence per lane name, for the collection-health table (AD-11). */
  lanePolicies?: Readonly<Record<string, FreshnessPolicy>>;
  now: () => Date;
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();

  app.get("/", (c) => {
    const now = deps.now();
    const rows = buildRepoRows(
      deps.store,
      deps.watched,
      now,
      deps.policy,
      deps.lanePolicies?.[COVERAGE_LANE],
    );
    const health = buildCollectionHealth(
      deps.store,
      now,
      deps.policy,
      deps.lanePolicies,
    );
    // Without the doctype browsers render in quirks mode, where the box model
    // and table metrics differ from what the styles were written against.
    const body = Page({ rows, health, generatedAt: now.toISOString() });
    // Every freshness verdict on this page is computed against the render
    // clock. A cached copy re-presents those verdicts later, still claiming
    // "fresh", which is the one thing the page must never do.
    c.header("Cache-Control", "no-store");
    return c.html(`<!DOCTYPE html>${body}`);
  });

  /** Liveness only. It deliberately says nothing about collection health. */
  app.get("/healthz", (c) => c.text("ok"));

  return app;
}
