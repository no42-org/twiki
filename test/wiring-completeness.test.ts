/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/core/config.js";
import { DEFAULT_RANK_POLICY } from "../src/core/rank.js";
import type { RepoRef } from "../src/core/types.js";
import type { GitHubReadPort } from "../src/github/port.js";
import { LANE as COVERAGE_LANE } from "../src/tricorder/collect/coverage.js";
import { LANE as KEV_LANE } from "../src/tricorder/collect/kev.js";
import type { ActionsDeps } from "../src/tricorder/collect/workflow-runs.js";
import type { StorePort } from "../src/tricorder/store/port.js";
import type { AppDeps } from "../src/tricorder/web/app.js";
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
