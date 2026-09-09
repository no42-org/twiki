/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/core/config.js";
import { DEFAULT_RANK_POLICY } from "../src/core/rank.js";
import type { RepoRef } from "../src/core/types.js";
import type { GitHubReadPort } from "../src/github/port.js";
import type { BoardDeps } from "../src/tricorder/attention/board.js";
import type { QueueDeps } from "../src/tricorder/attention/queue.js";
import { LANE as COVERAGE_LANE } from "../src/tricorder/collect/coverage.js";
import { LANE as KEV_LANE } from "../src/tricorder/collect/kev.js";
import {
  LANE as ACTIONS_LANE,
  type ActionsDeps,
} from "../src/tricorder/collect/workflow-runs.js";
import type { StorePort } from "../src/tricorder/store/port.js";
import {
  type AppDeps,
  boardDeps,
  queueDeps,
  repoViewDeps,
  resolveAppDeps,
} from "../src/tricorder/web/app.js";
import type { RepoViewDeps } from "../src/tricorder/web/repo-view.js";
import {
  ACTIONS_CADENCE_MS,
  ALERT_CADENCE_MS,
  buildWebDeps,
  COVERAGE_CADENCE_MS,
  KEV_CADENCE_MS,
} from "../src/tricorder.js";

// The production wiring must not be able to stop supplying something. Three
// stories running, each fixed one field that had gone missing, and each time
// the whole suite stayed green because the fallback was right for every test
// and wrong only for the operator who had configured the value (#143).
//
// Two halves, and both are needed. `buildWebDeps` returns `Required<AppDeps>`,
// so the COMPILER demands every field where the object is built; the runtime
// half below asserts the whole structure that function actually returns, so
// deleting the annotation is a test failure and not just a quieter build.
// The `@ts-expect-error` directives are the third: an unused one is itself a
// typecheck error, so they cannot rot into decoration.

// A store-shaped hole. Nothing calls a method on it: the wiring passes the
// store through without touching it, and the assertions here are about which
// object literals the compiler accepts and what the factory hands back.
const store = null as unknown as StorePort;
const github = null as unknown as GitHubReadPort;

const config = buildConfig({
  mode: "shadow",
  repos: [{ repo: "no42-org/legacy", defaultBranch: "master" }],
  bots: [],
  reviewers: [],
});

/** A parsed attention block that is not the default in any of its fields. */
const attention = {
  rankPolicy: DEFAULT_RANK_POLICY,
  cutRank: 41,
  reviewBudgetDays: 9,
  baseUrl: null,
};

describe("the web role's wiring", () => {
  it("supplies every field AppDeps declares, with the configured values", () => {
    const now = () => new Date("2026-09-08T00:00:00.000Z");

    const deps = buildWebDeps({ store, config, attention, now });

    // The whole structure, not the field somebody happened to worry about.
    // The `:latest` guard was tested and correct while the two tags written
    // beside it were wrong for three months, because the test only ever
    // looked at `:latest` (#66). A dropped binding here is a missing key.
    expect(Object.keys(deps).sort()).toEqual([
      "cutRank",
      "defaultBranchOf",
      "hungAfterMs",
      "lanePolicies",
      "now",
      "policy",
      "rankPolicy",
      "reviewBudgetDays",
      "store",
      "watched",
    ]);
    expect(deps).toEqual({
      store,
      watched: config.repos,
      policy: { cadenceMs: ALERT_CADENCE_MS },
      lanePolicies: {
        [KEV_LANE]: { cadenceMs: KEV_CADENCE_MS },
        [COVERAGE_LANE]: { cadenceMs: COVERAGE_CADENCE_MS },
        // The hourly lane, missing here until Story 2.3: judged on the
        // fifteen-minute alert cadence its whole CI section read stale
        // within minutes of a successful sweep.
        [ACTIONS_LANE]: { cadenceMs: ACTIONS_CADENCE_MS },
      },
      rankPolicy: DEFAULT_RANK_POLICY,
      // The two the operator configures and no issue ever named. Values that
      // are not the defaults, so a binding replaced by its fallback fails
      // here rather than passing by coincidence.
      cutRank: 41,
      reviewBudgetDays: 9,
      // Derived from the Actions cadence, the same expression the lane's
      // wiring uses, so the page and the lane call the same run hung.
      hungAfterMs: ACTIONS_CADENCE_MS * 2,
      defaultBranchOf: deps.defaultBranchOf,
      now,
    });

    // Bound to the loaded config rather than defaulted to `main`: the
    // resolver is a function, so the structural assertion above cannot see
    // through it and this is what says it resolves anything.
    expect(deps.defaultBranchOf({ owner: "no42-org", name: "legacy" })).toBe(
      "master",
    );
    expect(deps.now()).toEqual(new Date("2026-09-08T00:00:00.000Z"));
  });
});

// The compile-time half. These pin the SHAPE the wiring leans on - that
// `Required<T>` demands a field `T` declares optional - for both dependency
// types, including the case nobody has written yet.

/** Somewhere to hand a literal that must satisfy the whole contract. */
const wireWeb = (deps: Required<AppDeps>): Required<AppDeps> => deps;
const wireLane = (deps: Required<ActionsDeps>): Required<ActionsDeps> => deps;

/** Everything `buildWebDeps` returns, as a literal a field can be cut from. */
const webDeps = {
  store,
  watched: [] as readonly RepoRef[],
  policy: { cadenceMs: ALERT_CADENCE_MS },
  lanePolicies: {},
  rankPolicy: DEFAULT_RANK_POLICY,
  cutRank: 1,
  reviewBudgetDays: 3,
  defaultBranchOf: () => "main",
  hungAfterMs: ACTIONS_CADENCE_MS * 2,
  now: () => new Date(),
};

/** Everything the Actions lane's literal supplies. */
const laneDeps = {
  github,
  store,
  watchedIn: () => [] as readonly RepoRef[],
  defaultBranchOf: () => "main",
  hungAfterMs: ACTIONS_CADENCE_MS * 2,
  now: () => "2026-09-08T00:00:00.000Z",
  log: () => {},
};

describe("Required<AppDeps>", () => {
  it("rejects a literal missing any binding, derived or configured", () => {
    // Derived from ACTIONS_CADENCE_MS at the wiring and twinned by a
    // hardcoded fallback in core, which is how deleting the binding used to
    // compile and leave the whole suite green (#143).
    const { hungAfterMs: _hung, ...noHungAfterMs } = webDeps;
    // @ts-expect-error the hung threshold cannot be dropped from the wiring
    wireWeb(noHungAfterMs);

    // TRICORDER_NOW_EPSS. No issue names it; dropping the binding made the
    // web role silently ignore the operator's configured cut.
    const { cutRank: _cut, ...noCutRank } = webDeps;
    // @ts-expect-error the attention cut cannot be dropped from the wiring
    wireWeb(noCutRank);

    // TRICORDER_REVIEW_BUDGET_DAYS, the same shape again.
    const { reviewBudgetDays: _budget, ...noReviewBudget } = webDeps;
    // @ts-expect-error the review budget cannot be dropped from the wiring
    wireWeb(noReviewBudget);

    expect(wireWeb(webDeps)).toBe(webDeps);
  });

  it("covers a field added to the dependency type later", () => {
    // The guard is not a list of the three fields somebody noticed: it is
    // every field the type declares, so a new optional dependency is a build
    // failure at the wiring until the wiring supplies it.
    interface LaterAppDeps extends AppDeps {
      addedLater?: number;
    }
    const wireLater = (d: Required<LaterAppDeps>): Required<LaterAppDeps> => d;

    // @ts-expect-error a dependency added later must fail until it is bound
    wireLater(webDeps);

    expect(wireLater({ ...webDeps, addedLater: 1 })).toMatchObject({
      addedLater: 1,
    });
  });

  it("leaves the optional fields optional for tests", () => {
    // The reason the guard sits on the wiring rather than on the type: the 32
    // `createApp` constructions in this suite legitimately want the defaults,
    // and none of them changed.
    const minimal: AppDeps = {
      store,
      watched: [],
      policy: { cadenceMs: ALERT_CADENCE_MS },
      defaultBranchOf: () => "main",
      now: () => new Date(),
    };

    expect(Object.keys(minimal).sort()).toEqual([
      "defaultBranchOf",
      "now",
      "policy",
      "store",
      "watched",
    ]);
  });
});

describe("Required<ActionsDeps>", () => {
  it("rejects a literal missing any binding", () => {
    const { hungAfterMs: _hung, ...noHungAfterMs } = laneDeps;
    // @ts-expect-error the hung threshold cannot be dropped from the wiring
    wireLane(noHungAfterMs);

    const { defaultBranchOf: _branch, ...noDefaultBranch } = laneDeps;
    // @ts-expect-error the default-branch resolver cannot be dropped
    wireLane(noDefaultBranch);

    expect(wireLane(laneDeps)).toBe(laneDeps);
  });

  it("covers a field added to the lane's dependency type later", () => {
    // `ActionsDeps` declares no optional member today, so its guard is
    // future-proofing rather than a check that bites now. This is the future
    // it proofs against, and without it that claim rests on nothing.
    interface LaterActionsDeps extends ActionsDeps {
      addedLater?: number;
    }
    const wireLater = (
      d: Required<LaterActionsDeps>,
    ): Required<LaterActionsDeps> => d;

    // @ts-expect-error a lane dependency added later must fail until bound
    wireLater(laneDeps);

    expect(wireLater({ ...laneDeps, addedLater: 1 })).toMatchObject({
      addedLater: 1,
    });
  });
});

// The three INNER hops, the ones `buildWebDeps` cannot see. Each route used
// to build a fresh literal for its builder with no assertion on it at all, so
// a binding dropped between the resolved environment and a builder fell back
// to a default that was right for every test and wrong only in production -
// `coveragePolicy: deps.lanePolicies?.[COVERAGE_LANE]` being exactly that
// shape (#154). Same two halves as above: `Required<>` on each builder's
// signature, and a runtime assertion over the whole structure it returns.

/**
 * One app's dependencies, with four DISTINCT cadences.
 *
 * Synthetic rather than the production constants because `KEV_CADENCE_MS`
 * and `COVERAGE_CADENCE_MS` are both a day: with the real numbers a builder
 * that handed the KEV budget to the coverage lane would satisfy every
 * assertion here. Distinct values make a fallback, and a swap, both visible.
 */
const appDeps: AppDeps = {
  store,
  watched: [],
  policy: { cadenceMs: 1_000 },
  lanePolicies: {
    [KEV_LANE]: { cadenceMs: 2_000 },
    [COVERAGE_LANE]: { cadenceMs: 3_000 },
    [ACTIONS_LANE]: { cadenceMs: 4_000 },
  },
  // NOT `DEFAULT_RANK_POLICY`: asserted against the default, a helper that
  // hardcoded the default would satisfy every expectation here, and an
  // operator's configured bands would quietly revert on the overview and the
  // repository page while the queue still honoured them - one estate, two
  // rankings. The middle band is the one that moves.
  rankPolicy: { epssBands: [0.5, 0.3, 0.01] },
  cutRank: 41,
  reviewBudgetDays: 9,
  hungAfterMs: 5_000,
  defaultBranchOf: (repo) => (repo.name === "legacy" ? "master" : "main"),
  now: () => new Date("2026-09-09T00:00:00.000Z"),
};

const resolved = resolveAppDeps(appDeps);

describe("the routes' own wiring", () => {
  it("resolves every optional dependency to a value, per lane", () => {
    // The whole structure, so a lane judged on the sweep budget by accident
    // is a failure here rather than a page that reads stale in production.
    expect(resolved).toEqual({
      policy: { cadenceMs: 1_000 },
      lanePolicies: appDeps.lanePolicies,
      coveragePolicy: { cadenceMs: 3_000 },
      kevPolicy: { cadenceMs: 2_000 },
      actionsPolicy: { cadenceMs: 4_000 },
      rankPolicy: { epssBands: [0.5, 0.3, 0.01] },
      cutRank: 41,
      reviewBudgetDays: 9,
      hungAfterMs: 5_000,
      // A wrapper round the caller's resolver, so the comparison above cannot
      // see through it; asserted by behaviour below.
      defaultBranchOf: resolved.defaultBranchOf,
    });
    expect(
      resolved.defaultBranchOf({ owner: "no42-org", name: "legacy" }),
    ).toBe("master");
  });

  it("falls back to the sweep budget only for a lane with no cadence", () => {
    const bare = resolveAppDeps({
      store,
      watched: [],
      policy: { cadenceMs: 1_000 },
      defaultBranchOf: () => "main",
      now: () => new Date(),
    });

    expect(bare.coveragePolicy).toEqual({ cadenceMs: 1_000 });
    expect(bare.kevPolicy).toEqual({ cadenceMs: 1_000 });
    expect(bare.actionsPolicy).toEqual({ cadenceMs: 1_000 });
    // `{}` and not undefined: the field is required at the builders now, and
    // the health table reads a lane absent from it as judged on `policy`.
    expect(bare.lanePolicies).toEqual({});
  });

  it("hands the overview every dependency BoardDeps declares", () => {
    expect(boardDeps(resolved)).toEqual({
      policy: { cadenceMs: 1_000 },
      lanePolicies: appDeps.lanePolicies,
      coveragePolicy: { cadenceMs: 3_000 },
      kevPolicy: { cadenceMs: 2_000 },
      actionsPolicy: { cadenceMs: 4_000 },
      rankPolicy: { epssBands: [0.5, 0.3, 0.01] },
      cutRank: 41,
      reviewBudgetDays: 9,
      hungAfterMs: 5_000,
      defaultBranchOf: resolved.defaultBranchOf,
    });
  });

  it("hands the queue every dependency QueueDeps declares", () => {
    expect(queueDeps(resolved)).toEqual({
      policy: { cadenceMs: 1_000 },
      kevPolicy: { cadenceMs: 2_000 },
      actionsPolicy: { cadenceMs: 4_000 },
      rankPolicy: { epssBands: [0.5, 0.3, 0.01] },
      hungAfterMs: 5_000,
      defaultBranchOf: resolved.defaultBranchOf,
    });
  });

  it("hands the repository view every dependency RepoViewDeps declares", () => {
    // The resolved branch, not the resolver: this view is handed the answer
    // for the one repository it is about (AD-33).
    expect(repoViewDeps(resolved, "master")).toEqual({
      policy: { cadenceMs: 1_000 },
      coveragePolicy: { cadenceMs: 3_000 },
      kevPolicy: { cadenceMs: 2_000 },
      actionsPolicy: { cadenceMs: 4_000 },
      rankPolicy: { epssBands: [0.5, 0.3, 0.01] },
      cutRank: 41,
      reviewBudgetDays: 9,
      hungAfterMs: 5_000,
      defaultBranch: "master",
    });
  });
});

// The compile-time half for the three inner hops. Somewhere to hand a literal
// that must satisfy each whole contract, and a literal a field can be cut
// from - which is what each builder returns.
const wireBoard = (deps: Required<BoardDeps>): Required<BoardDeps> => deps;
const wireQueue = (deps: Required<QueueDeps>): Required<QueueDeps> => deps;
const wireRepoView = (deps: Required<RepoViewDeps>): Required<RepoViewDeps> =>
  deps;

const board = boardDeps(resolved);
const queue = queueDeps(resolved);
const repoView = repoViewDeps(resolved, "master");

describe("Required<BoardDeps>", () => {
  it("rejects a literal missing any binding", () => {
    // The field the retrospective named: an optional member fed from an
    // optional lookup, which type-checked while silently resolving to
    // undefined and judging the daily coverage lane on the sweep budget.
    const { coveragePolicy: _coverage, ...noCoveragePolicy } = board;
    // @ts-expect-error the coverage cadence cannot be dropped from the wiring
    wireBoard(noCoveragePolicy);

    // The lane table's own map. Dropped, every lane in it reads on the sweep
    // budget and both daily lanes report themselves overdue.
    const { lanePolicies: _lanes, ...noLanePolicies } = board;
    // @ts-expect-error the lane cadences cannot be dropped from the wiring
    wireBoard(noLanePolicies);

    expect(wireBoard(board)).toBe(board);
  });

  it("covers a field added to BoardDeps later", () => {
    interface LaterBoardDeps extends BoardDeps {
      addedLater?: number;
    }
    const wireLater = (d: Required<LaterBoardDeps>): Required<LaterBoardDeps> =>
      d;

    // @ts-expect-error a dependency added later must fail until it is bound
    wireLater(board);

    expect(wireLater({ ...board, addedLater: 1 })).toMatchObject({
      addedLater: 1,
    });
  });
});

describe("Required<QueueDeps>", () => {
  it("rejects a literal missing any binding", () => {
    // `QueueDeps` declares no optional member today, so `Required<>` changes
    // nothing about it yet and the drop below would fail on the plain type.
    // The wrapper is what keeps that true the day a member goes optional,
    // which is how all three of the other types drifted.
    const { actionsPolicy: _actions, ...noActionsPolicy } = queue;
    // @ts-expect-error the Actions cadence cannot be dropped from the wiring
    wireQueue(noActionsPolicy);

    expect(wireQueue(queue)).toBe(queue);
  });

  it("covers a field added to QueueDeps later", () => {
    interface LaterQueueDeps extends QueueDeps {
      addedLater?: number;
    }
    const wireLater = (d: Required<LaterQueueDeps>): Required<LaterQueueDeps> =>
      d;

    // @ts-expect-error a dependency added later must fail until it is bound
    wireLater(queue);

    expect(wireLater({ ...queue, addedLater: 1 })).toMatchObject({
      addedLater: 1,
    });
  });
});

describe("Required<RepoViewDeps>", () => {
  it("rejects a literal missing any binding", () => {
    // All six optional members, not the two somebody worried about: the
    // annotation covers every one, and a demonstration that covers a subset
    // is the shape this file exists to argue against.
    const { coveragePolicy: _coverage, ...noCoveragePolicy } = repoView;
    // @ts-expect-error the coverage cadence cannot be dropped from the wiring
    wireRepoView(noCoveragePolicy);

    const { kevPolicy: _kev, ...noKevPolicy } = repoView;
    // @ts-expect-error the KEV cadence cannot be dropped from the wiring
    wireRepoView(noKevPolicy);

    const { rankPolicy: _rank, ...noRankPolicy } = repoView;
    // @ts-expect-error the ranking bands cannot be dropped from the wiring
    wireRepoView(noRankPolicy);

    const { cutRank: _cut, ...noCutRank } = repoView;
    // @ts-expect-error the attention cut cannot be dropped from the wiring
    wireRepoView(noCutRank);

    const { reviewBudgetDays: _budget, ...noReviewBudget } = repoView;
    // @ts-expect-error the review budget cannot be dropped from the wiring
    wireRepoView(noReviewBudget);

    // The threshold twinned by a hardcoded fallback in core, which is how
    // dropping its binding used to compile and leave the suite green (#143).
    const { hungAfterMs: _hung, ...noHungAfterMs } = repoView;
    // @ts-expect-error the hung threshold cannot be dropped from the wiring
    wireRepoView(noHungAfterMs);

    expect(wireRepoView(repoView)).toBe(repoView);
  });

  it("covers a field added to RepoViewDeps later", () => {
    interface LaterRepoViewDeps extends RepoViewDeps {
      addedLater?: number;
    }
    const wireLater = (
      d: Required<LaterRepoViewDeps>,
    ): Required<LaterRepoViewDeps> => d;

    // @ts-expect-error a dependency added later must fail until it is bound
    wireLater(repoView);

    expect(wireLater({ ...repoView, addedLater: 1 })).toMatchObject({
      addedLater: 1,
    });
  });
});

// Nothing above keeps a ROUTE calling those helpers. Rewriting one back to an
// inline literal is type-legal and drops the guard with it, which is the
// defect this whole file exists to prevent. Structural, in the style of
// test/lifecycle.test.ts's "exactly one begin call", and against the real
// file rather than a list.
describe("the routes reach their builders through the guarded helpers", () => {
  const APP = join("src", "tricorder", "web", "app.ts");
  const source = readFileSync(APP, "utf8");
  /** Everything from `createApp` down: the routes and nothing else. */
  const routes = source.slice(source.indexOf("export function createApp"));

  it("hands each builder the helper's result", () => {
    expect(routes).toContain("boardDeps(resolved)");
    expect(routes).toContain("queueDeps(resolved)");
    expect(routes).toContain("repoViewDeps(resolved,");
  });

  it("leaves the routes no dependency literal of their own", () => {
    // Matched on each field as an object KEY, so prose naming one stays
    // legal. A route that rebuilt its literal inline would spell them here,
    // and every field below is one that has a default waiting to swallow it.
    const fields = [
      "policy:",
      "lanePolicies:",
      "coveragePolicy:",
      "kevPolicy:",
      "actionsPolicy:",
      "rankPolicy:",
      "cutRank:",
      "reviewBudgetDays:",
      "hungAfterMs:",
      "defaultBranchOf:",
      "defaultBranch:",
    ];

    expect(fields.filter((field) => routes.includes(field))).toEqual([]);
  });

  it("and the helpers do bind them", () => {
    // Without this the rule above is satisfied by builders that bind
    // nothing, exactly as the wrapper test needs its own second half.
    const helpers = source.slice(
      source.indexOf("export function boardDeps"),
      source.indexOf("export function createApp"),
    );

    expect(helpers).toContain("coveragePolicy: resolved.coveragePolicy");
    expect(helpers).toContain("lanePolicies: resolved.lanePolicies");
    expect(helpers).toContain("actionsPolicy: resolved.actionsPolicy");
    expect(helpers).toContain("hungAfterMs: resolved.hungAfterMs");
  });
});
