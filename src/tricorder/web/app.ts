/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { Hono } from "hono";
import { DEFAULT_RANK_POLICY, type RankPolicy } from "../../core/rank.js";
import { DEFAULT_HUNG_AFTER_MS } from "../../core/run-verdict.js";
import { DEFAULT_REVIEW_BUDGET_DAYS, defaultCutRank } from "../../core/tier.js";
import type { RepoRef } from "../../core/types.js";
import { buildBoard } from "../attention/board.js";
import { applyQueueFilter, parseQueueFilter } from "../attention/filter.js";
import type { FreshnessPolicy } from "../attention/freshness.js";
import { buildQueue } from "../attention/queue.js";
import { LANE as COVERAGE_LANE } from "../collect/coverage.js";
import { LANE as KEV_LANE } from "../collect/kev.js";
import { LANE as ACTIONS_LANE } from "../collect/workflow-runs.js";
import type { StorePort } from "../store/port.js";
import {
  Page,
  QueuePage,
  RepoPage,
  ReviewsPage,
  UnknownRepoPage,
} from "./components.js";
import { buildRepoView } from "./repo-view.js";
import { buildReviewView } from "./review-view.js";

// Routes read through StorePort only: no SQL, no table name, no predicate
// composed here (AD-27). No GitHub call happens on the request path (AD-3).

/**
 * What the web role is handed.
 *
 * Five of these are optional, and that is deliberate: the many tests that
 * construct an app legitimately want the defaults, and making a field
 * required costs every one of those call sites. The production wiring proves
 * it supplies all of them anyway, by returning `Required<AppDeps>` from
 * `buildWebDeps` in `src/tricorder.ts`, so a binding dropped there is a build
 * failure rather than a default nobody notices (#143).
 *
 * The note for whoever adds the next optional field, which is who this is
 * written for: adding it here makes the wiring fail to compile until it
 * supplies it, and that is the whole protection. It reaches exactly as far as
 * this list does. A value that SHOULD have been a dependency and never became
 * one - read straight from the environment somewhere downstream, or defaulted
 * in a helper - is invisible to it, and no amount of `Required<>` will find
 * it.
 */
export interface AppDeps {
  store: StorePort;
  watched: readonly RepoRef[];
  policy: FreshnessPolicy;
  /** Cadence per lane name, for the collection-health table (AD-11). */
  lanePolicies?: Readonly<Record<string, FreshnessPolicy>>;
  /** Ranking thresholds. Order stays code; only the numbers move (AD-20). */
  rankPolicy?: RankPolicy;
  /**
   * The `now` cut as a term rank, `epssRank(cut, bands)` (AD-29). Defaults
   * to the default cut over the rank policy in use.
   */
  cutRank?: number;
  /** Days a review request may wait before a repository is at least soon. */
  reviewBudgetDays?: number;
  /**
   * What a repository calls its default branch, in production
   * `resolveDefaultBranch` bound to the loaded config (AD-33). Read by the
   * per-repository run list, to order its rows.
   *
   * Required, with no default, for the reason Story 2.1's own review found
   * the hard way: an optional binding that falls back to `main` lets the
   * wiring be deleted with the whole suite still green, and then every
   * repository on `master` silently orders its side branches above its main
   * line. A required field makes deleting the binding a compile error.
   */
  defaultBranchOf: (repo: RepoRef) => string;
  /**
   * How long a run may sit unfinished before the pages call it hung. The
   * wiring passes twice the Actions cadence, the same expression the lane's
   * wiring uses, so the page and the lane agree about a row. Read by the
   * repository page's run list AND by the `broken` term behind every CI
   * item, so a run one paints red is one the other ranks.
   */
  hungAfterMs?: number;
  now: () => Date;
}

/**
 * The repository's declared default branch, or null when the resolver
 * refused to say.
 *
 * Null and never `main`. Every route below now asks this question - the
 * board and the queue derive CI items from it, not just the run list's
 * ordering - and a guard that answered `main` would turn one broken config
 * into a confident CI `0` on every repository that is not on `main`. Null
 * derives no item and renders `unconfirmed` beside it, which is the honest
 * shape of "we could not tell" (AD-28).
 */
function defaultBranchOrNull(deps: AppDeps, repo: RepoRef): string | null {
  try {
    return deps.defaultBranchOf(repo);
  } catch {
    // Nothing to log to: a route has no logger here, and a page that says
    // `unconfirmed` for one repository is a smaller failure than one that
    // 500s for the whole estate.
    return null;
  }
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const rankPolicy = deps.rankPolicy ?? DEFAULT_RANK_POLICY;
  const cutRank = deps.cutRank ?? defaultCutRank(rankPolicy);
  const reviewBudgetDays = deps.reviewBudgetDays ?? DEFAULT_REVIEW_BUDGET_DAYS;
  // The KEV catalogue is judged on its own daily cadence, or the index
  // would read stale within the hour and every verdict would be unknown.
  // Keyed by the exported constant, exactly as COVERAGE_LANE is below: a
  // string literal here would survive a lane rename and silently judge the
  // daily catalogue on the sweep cadence, degrading every verdict to
  // unknown with no error anywhere. Unpinnable by mutation while the
  // constant equals the literal; the shared symbol is the protection.
  const kevPolicy = deps.lanePolicies?.[KEV_LANE] ?? deps.policy;
  // The Actions lane runs hourly, not on the sweep's fifteen minutes (AD-11).
  // Keyed by the exported constant for the reason spelled out above.
  const actionsPolicy = deps.lanePolicies?.[ACTIONS_LANE] ?? deps.policy;
  const hungAfterMs = deps.hungAfterMs ?? DEFAULT_HUNG_AFTER_MS;
  // The guarded resolver, resolved to a branch name for the builders that
  // want one. `defaultBranchOrDefault` is where a throwing resolver stops:
  // the queue builder deliberately has no guard of its own, because a second
  // fallback to `main` inside it would be indistinguishable from having
  // dropped the binding.
  const defaultBranchOf = (repo: RepoRef): string | null =>
    defaultBranchOrNull(deps, repo);

  app.get("/", (c) => {
    const now = deps.now();
    // One queue build per request (AD-32): tiles, rows, summary and the
    // collection-health table all read this one result.
    const board = buildBoard(deps.store, deps.watched, now, {
      policy: deps.policy,
      kevPolicy,
      actionsPolicy,
      rankPolicy,
      cutRank,
      reviewBudgetDays,
      hungAfterMs,
      defaultBranchOf,
      coveragePolicy: deps.lanePolicies?.[COVERAGE_LANE],
      lanePolicies: deps.lanePolicies,
    });
    // Without the doctype browsers render in quirks mode, where the box model
    // and table metrics differ from what the styles were written against.
    const body = Page({ board, generatedAt: now.toISOString() });
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
      kevPolicy,
      actionsPolicy,
      rankPolicy,
      hungAfterMs,
      defaultBranchOf,
    });
    // The two parameters are the whole filter grammar (AD-39). A value the
    // grammar does not know renders the no-matches state, still 200: a
    // stale link must land on a sentence, never on an error page.
    const filter = parseQueueFilter(
      c.req.query("topic"),
      c.req.query("repo"),
      deps.watched,
    );
    const filtered = applyQueueFilter(queue, filter, deps.watched);
    const body = QueuePage({
      queue,
      filtered,
      filter,
      generatedAt: now.toISOString(),
    });
    c.header("Cache-Control", "no-store");
    return c.html(`<!DOCTYPE html>${body}`);
  });

  app.get("/repo/:owner/:name", (c) => {
    const now = deps.now();
    const owner = c.req.param("owner");
    const name = c.req.param("name");
    // repos.yaml is the entire universe (AD-10), so an unwatched repository
    // has no page: rendering empty sections for one would be a dashboard
    // full of confident nothings about a repository nobody collects.
    // Matched case-insensitively, because subject keys are folded and a
    // reader may well type the casing GitHub displays.
    const repo = deps.watched.find(
      (r) =>
        r.owner.toLowerCase() === owner.toLowerCase() &&
        r.name.toLowerCase() === name.toLowerCase(),
    );
    c.header("Cache-Control", "no-store");
    if (!repo) {
      const body = UnknownRepoPage({
        slug: `${owner}/${name}`,
        generatedAt: now.toISOString(),
      });
      return c.html(`<!DOCTYPE html>${body}`, 404);
    }
    const view = buildRepoView(deps.store, repo, now, {
      policy: deps.policy,
      coveragePolicy: deps.lanePolicies?.[COVERAGE_LANE],
      actionsPolicy,
      // The same policy, cut and KEV cadence the queue ranks with, so the
      // header's tier and the queue's order come from one chain (AD-29).
      kevPolicy,
      rankPolicy,
      cutRank,
      reviewBudgetDays,
      hungAfterMs,
      // Guarded exactly as the lane guards the same call. The resolver is
      // the caller's, and a throw here would answer 500 for a whole
      // repository page where the lane merely degrades one repository. Null
      // reaches the view as "no branch is the default one", which shuffles
      // the run list and derives no CI item, rather than as a page that will
      // not render.
      defaultBranch: defaultBranchOf(repo),
    });
    const body = RepoPage({ view, generatedAt: now.toISOString() });
    return c.html(`<!DOCTYPE html>${body}`);
  });

  app.get("/reviews", (c) => {
    const now = deps.now();
    const view = buildReviewView(deps.store, deps.watched, now, deps.policy);
    const body = ReviewsPage({ view, generatedAt: now.toISOString() });
    c.header("Cache-Control", "no-store");
    return c.html(`<!DOCTYPE html>${body}`);
  });

  /** Liveness only. It deliberately says nothing about collection health. */
  app.get("/healthz", (c) => c.text("ok"));

  return app;
}
