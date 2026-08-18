/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { Hono } from "hono";
import { DEFAULT_RANK_POLICY, type RankPolicy } from "../../core/rank.js";
import type { RepoRef } from "../../core/types.js";
import { LANE as COVERAGE_LANE } from "../collect/coverage.js";
import { LANE as KEV_LANE } from "../collect/kev.js";
import type { StorePort } from "../store/port.js";
import { Page, QueuePage } from "./components.js";
import type { FreshnessPolicy } from "./freshness.js";
import { buildQueue } from "./queue.js";
import { buildCollectionHealth, buildRepoRows } from "./view.js";

// Routes read through StorePort only: no SQL, no table name, no predicate
// composed here (AD-27). No GitHub call happens on the request path (AD-3).

export interface AppDeps {
  store: StorePort;
  watched: readonly RepoRef[];
  policy: FreshnessPolicy;
  /** Cadence per lane name, for the collection-health table (AD-11). */
  lanePolicies?: Readonly<Record<string, FreshnessPolicy>>;
  /** Ranking thresholds. Order stays code; only the numbers move (AD-20). */
  rankPolicy?: RankPolicy;
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

  app.get("/queue", (c) => {
    const now = deps.now();
    const queue = buildQueue(deps.store, now, {
      policy: deps.policy,
      // The KEV catalogue is judged on its own daily cadence, or the index
      // would read stale within the hour and every verdict would be unknown.
      // Keyed by the exported constant, exactly as COVERAGE_LANE is above: a
      // string literal here would survive a lane rename and silently judge the
      // daily catalogue on the sweep cadence, degrading every verdict to
      // unknown with no error anywhere. Unpinnable by mutation while the
      // constant equals the literal; the shared symbol is the protection.
      kevPolicy: deps.lanePolicies?.[KEV_LANE] ?? deps.policy,
      rankPolicy: deps.rankPolicy ?? DEFAULT_RANK_POLICY,
    });
    const body = QueuePage({ queue, generatedAt: now.toISOString() });
    c.header("Cache-Control", "no-store");
    return c.html(`<!DOCTYPE html>${body}`);
  });

  /** Liveness only. It deliberately says nothing about collection health. */
  app.get("/healthz", (c) => c.text("ok"));

  return app;
}
