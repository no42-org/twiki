/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { Hono } from "hono";
import { DEFAULT_RANK_POLICY, type RankPolicy } from "../../core/rank.js";
import { DEFAULT_HUNG_AFTER_MS } from "../../core/run-verdict.js";
import { DEFAULT_REVIEW_BUDGET_DAYS, defaultCutRank } from "../../core/tier.js";
import type { RepoRef } from "../../core/types.js";
import { type BoardDeps, buildBoard } from "../attention/board.js";
import { applyQueueFilter, parseQueueFilter } from "../attention/filter.js";
import type { FreshnessPolicy } from "../attention/freshness.js";
import { buildQueue, type QueueDeps } from "../attention/queue.js";
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
import { buildRepoView, type RepoViewDeps } from "./repo-view.js";
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
 *
 * The hops BELOW this one are guarded the same way, and there are four:
 * `resolveAppDeps`, which declares no optional member and is what lets the
 * other three be `Required<>` at all, then `boardDeps`, `queueDeps` and
 * `repoViewDeps`.
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

/**
 * `AppDeps` with every optional member already resolved to a value, computed
 * once per app and handed to the three builders below.
 *
 * It is what makes those three literals assertable at all. A builder that
 * resolved `deps.lanePolicies?.[COVERAGE_LANE]` for itself would be handing
 * `FreshnessPolicy | undefined` to a field `Required<>` makes mandatory, and
 * the only way to satisfy the compiler would be the silent fallback this
 * exists to remove (#154). Resolving in one place also means the builders
 * cannot each apply a different default to the same field.
 *
 * Declares no optional member, so this type is its own guard: the hop from
 * `AppDeps` to here fails to compile if it stops filling something.
 */
export interface ResolvedDeps {
  /** The full-sweep budget: what a lane with no cadence of its own is judged on. */
  policy: FreshnessPolicy;
  /** Cadence per lane name, for the collection-health table (AD-11); empty when unset. */
  lanePolicies: Readonly<Record<string, FreshnessPolicy>>;
  /** The coverage lane's own daily cadence (AD-11). */
  coveragePolicy: FreshnessPolicy;
  /** The KEV catalogue's own daily cadence (AD-11). */
  kevPolicy: FreshnessPolicy;
  /** The Actions lane's own hourly cadence (AD-11). */
  actionsPolicy: FreshnessPolicy;
  rankPolicy: RankPolicy;
  cutRank: number;
  reviewBudgetDays: number;
  hungAfterMs: number;
  /** The guarded resolver; null where the caller's resolver threw. */
  defaultBranchOf: (repo: RepoRef) => string | null;
}

/** Every default this role applies, in one place. */
export function resolveAppDeps(deps: AppDeps): ResolvedDeps {
  const rankPolicy = deps.rankPolicy ?? DEFAULT_RANK_POLICY;
  return {
    policy: deps.policy,
    lanePolicies: deps.lanePolicies ?? {},
    // Three lanes with a cadence of their own (AD-11): coverage and the KEV
    // catalogue daily, Actions hourly. Judged on the sweep budget instead,
    // each reads stale minutes after succeeding, and every KEV verdict on
    // the page degrades to unknown.
    //
    // Each looked up by its lane's exported constant, never a string
    // literal: a literal would survive a lane rename and go on judging that
    // lane on the sweep budget with no error anywhere. Unpinnable by
    // mutation while the constant equals the literal; the shared symbol is
    // the protection.
    coveragePolicy: deps.lanePolicies?.[COVERAGE_LANE] ?? deps.policy,
    kevPolicy: deps.lanePolicies?.[KEV_LANE] ?? deps.policy,
    actionsPolicy: deps.lanePolicies?.[ACTIONS_LANE] ?? deps.policy,
    rankPolicy,
    cutRank: deps.cutRank ?? defaultCutRank(rankPolicy),
    reviewBudgetDays: deps.reviewBudgetDays ?? DEFAULT_REVIEW_BUDGET_DAYS,
    hungAfterMs: deps.hungAfterMs ?? DEFAULT_HUNG_AFTER_MS,
    // The guarded resolver, resolved to a branch name for the builders that
    // want one. This is where a throwing resolver stops: the queue builder
    // deliberately has no guard of its own, because a second fallback to
    // `main` inside it would be indistinguishable from having dropped the
    // binding.
    defaultBranchOf: (repo) => defaultBranchOrNull(deps, repo),
  };
}

// The three inner wiring hops, each on a SIGNATURE returning `Required<>`,
// exactly as `buildWebDeps` guards the outer one (#143). Until now they were
// literals inside the routes with no assertion at all: a binding dropped
// there fell back to a default that was right for every test and wrong only
// in production, which is the same class of defect #143 fixed one field at a
// time on the outer hop (#154).
//
// Each restates its fields one per line rather than spreading `resolved`, and
// that restatement IS the assertion: a spread would satisfy the compiler
// while naming nothing, so nothing could go missing from it. The types stay
// optional for the many tests that legitimately want the defaults, so the
// guard costs no test call site.
//
// `ResolvedDeps` carries the same ten members `BoardDeps` needs today. That
// is a coincidence of the overview wanting everything, not an identity: the
// queue takes six of them and the repository view swaps the resolver for one
// resolved branch.

/** The overview's dependencies. */
export function boardDeps(resolved: ResolvedDeps): Required<BoardDeps> {
  return {
    policy: resolved.policy,
    lanePolicies: resolved.lanePolicies,
    coveragePolicy: resolved.coveragePolicy,
    kevPolicy: resolved.kevPolicy,
    actionsPolicy: resolved.actionsPolicy,
    rankPolicy: resolved.rankPolicy,
    cutRank: resolved.cutRank,
    reviewBudgetDays: resolved.reviewBudgetDays,
    hungAfterMs: resolved.hungAfterMs,
    defaultBranchOf: resolved.defaultBranchOf,
  };
}

/** The queue's dependencies: ranking, no tiles and no lane table. */
export function queueDeps(resolved: ResolvedDeps): Required<QueueDeps> {
  return {
    policy: resolved.policy,
    kevPolicy: resolved.kevPolicy,
    actionsPolicy: resolved.actionsPolicy,
    rankPolicy: resolved.rankPolicy,
    hungAfterMs: resolved.hungAfterMs,
    defaultBranchOf: resolved.defaultBranchOf,
  };
}

/**
 * One repository page's dependencies.
 *
 * The branch is resolved by the caller and passed in, because this view is
 * about one repository and takes the answer rather than the resolver (AD-33).
 */
export function repoViewDeps(
  resolved: ResolvedDeps,
  defaultBranch: string | null,
): Required<RepoViewDeps> {
  return {
    policy: resolved.policy,
    coveragePolicy: resolved.coveragePolicy,
    // The same policy, cut and KEV cadence the queue ranks with, so the
    // header's tier and the queue's order come from one chain (AD-29).
    kevPolicy: resolved.kevPolicy,
    actionsPolicy: resolved.actionsPolicy,
    rankPolicy: resolved.rankPolicy,
    cutRank: resolved.cutRank,
    reviewBudgetDays: resolved.reviewBudgetDays,
    hungAfterMs: resolved.hungAfterMs,
    defaultBranch,
  };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const resolved = resolveAppDeps(deps);

  app.get("/", (c) => {
    const now = deps.now();
    // One queue build per request (AD-32): tiles, rows, summary and the
    // collection-health table all read this one result.
    const board = buildBoard(
      deps.store,
      deps.watched,
      now,
      boardDeps(resolved),
    );
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
    const queue = buildQueue(deps.store, now, queueDeps(resolved));
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
    // The branch is asked for here and guarded in `resolveAppDeps`, which
    // answers null where the caller's resolver threw. Null reaches the view
    // as "no branch is the default one", which shuffles the run list and
    // derives no CI item, rather than as a page that will not render.
    const view = buildRepoView(
      deps.store,
      repo,
      now,
      repoViewDeps(resolved, resolved.defaultBranchOf(repo)),
    );
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
