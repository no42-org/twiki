/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { toAdvisorFacts } from "../src/advisor.js";
import {
  buildConfig,
  type Config,
  type RemediationConfig,
} from "../src/config.js";
import { applyPlan } from "../src/executor.js";
import type { Plan } from "../src/plan.js";
import type { Mode } from "../src/types.js";
import {
  FakeGitHub,
  type FakeRepoData,
  makeFacts,
  makePr,
  makeRun,
} from "./fakes.js";

const SLUG = "no42-org/demo";
const EMPTY: Plan = { repos: [] };

function config(
  mode: Mode,
  remediation: RemediationConfig = { enabled: true, maxAttempts: 2 },
): Config {
  return buildConfig({ mode, repos: [{ repo: SLUG }] }, undefined, remediation);
}

function gh(over: Partial<FakeRepoData> = {}): FakeGitHub {
  const data: FakeRepoData = {
    rawPrs: [],
    prChecks: {},
    mainChecks: "green",
    latestTag: "v1.2.3",
    unreleased: 0,
    hasWorkflow: true,
    defaultSha: "main-sha",
    ...over,
  };
  return new FakeGitHub(new Map([[SLUG, data]]));
}

describe("ci-remediation — re-run", () => {
  it("enforce re-runs an eligible failed run once (deduped)", async () => {
    const facts = makeFacts({
      prs: [
        makePr({
          number: 7,
          checks: "red",
          workflowRuns: [makeRun({ runId: 42, runAttempt: 1 })],
        }),
      ],
    });
    const github = gh();
    const res = await applyPlan([facts], EMPTY, config("enforce"), github);
    expect(github.reran).toEqual([{ repo: SLUG, runId: 42 }]);
    expect(res.repos[0]?.remediations).toContainEqual(
      expect.objectContaining({
        kind: "rerun",
        status: "reran",
        ref: "run 42",
      }),
    );
  });

  it("shadow reports would-re-run and performs no write", async () => {
    const facts = makeFacts({
      prs: [
        makePr({
          number: 7,
          checks: "red",
          workflowRuns: [makeRun({ runId: 42, runAttempt: 1 })],
        }),
      ],
    });
    const github = gh();
    const res = await applyPlan([facts], EMPTY, config("shadow"), github);
    expect(github.reran).toEqual([]);
    expect(res.repos[0]?.remediations?.[0]?.status).toBe("would-rerun");
  });

  it("does not exceed the attempt ceiling across ticks (stateless bound)", async () => {
    // run_attempt already at the ceiling — a repeated tick must not re-run.
    const facts = makeFacts({
      prs: [
        makePr({
          number: 7,
          checks: "red",
          workflowRuns: [makeRun({ runId: 42, runAttempt: 2 })],
        }),
      ],
    });
    const github = gh();
    await applyPlan([facts], EMPTY, config("enforce"), github);
    await applyPlan([facts], EMPTY, config("enforce"), github);
    expect(github.reran).toEqual([]);
  });

  it("never re-triggers an in-progress run", async () => {
    const facts = makeFacts({
      prs: [
        makePr({
          number: 7,
          checks: "pending",
          workflowRuns: [
            makeRun({
              runId: 42,
              runAttempt: 1,
              status: "in_progress",
              conclusion: null,
            }),
          ],
        }),
      ],
    });
    const github = gh();
    await applyPlan([facts], EMPTY, config("enforce"), github);
    expect(github.reran).toEqual([]);
  });

  it("re-runs a failing main run on the same terms (D8)", async () => {
    const facts = makeFacts({
      mainChecks: "red",
      mainWorkflowRuns: [makeRun({ runId: 99, runAttempt: 1 })],
    });
    const github = gh({ mainChecks: "red" });
    await applyPlan([facts], EMPTY, config("enforce"), github);
    expect(github.reran).toEqual([{ repo: SLUG, runId: 99 }]);
  });
});

describe("ci-remediation — rebase", () => {
  it("enforce rebases a behind, not-red, in-policy PR once", async () => {
    const facts = makeFacts({
      prs: [makePr({ number: 7, checks: "green", behindBy: 3 })],
    });
    const github = gh();
    const res = await applyPlan([facts], EMPTY, config("enforce"), github);
    expect(github.rebased).toEqual([{ repo: SLUG, number: 7 }]);
    expect(res.repos[0]?.remediations).toContainEqual(
      expect.objectContaining({ kind: "rebase", status: "rebased", ref: "#7" }),
    );
  });

  it("shadow reports would-rebase and performs no write", async () => {
    const facts = makeFacts({
      prs: [makePr({ number: 7, checks: "green", behindBy: 3 })],
    });
    const github = gh();
    const res = await applyPlan([facts], EMPTY, config("shadow"), github);
    expect(github.rebased).toEqual([]);
    expect(res.repos[0]?.remediations?.[0]?.status).toBe("would-rebase");
  });

  it("anti-thrash: a behind PR red on its own merits is never rebased", async () => {
    const facts = makeFacts({
      // red head: behindBy is undefined in real facts, but assert the guard
      // directly by forcing both behind and red here.
      prs: [makePr({ number: 7, checks: "red", behindBy: 9 })],
    });
    const github = gh();
    await applyPlan([facts], EMPTY, config("enforce"), github);
    await applyPlan([facts], EMPTY, config("enforce"), github);
    expect(github.rebased).toEqual([]);
  });
});

describe("ci-remediation — disabled", () => {
  it("performs no writes but still produces diagnostics when disabled", async () => {
    const facts = makeFacts({
      prs: [
        makePr({
          number: 7,
          checks: "red",
          failingChecks: [
            { name: "unit", conclusion: "failure", detailsUrl: "https://x/1" },
          ],
          workflowRuns: [makeRun({ runId: 42, runAttempt: 1 })],
        }),
      ],
    });
    const github = gh();
    // Advisor says merge → the red PR becomes a blocked outcome carrying the
    // failing-check diagnostics, even though remediation writes are disabled.
    const plan: Plan = {
      repos: [
        {
          repo: SLUG,
          prDecisions: [
            { number: 7, action: "merge", reason: "ok", risk: "low" },
          ],
          release: { action: "wait", reason: "n/a" },
        },
      ],
    };
    const res = await applyPlan(
      [facts],
      plan,
      config("enforce", { enabled: false, maxAttempts: 2 }),
      github,
    );
    expect(github.reran).toEqual([]);
    expect(github.rebased).toEqual([]);
    expect(res.repos[0]?.remediations).toEqual([]);
    expect(res.repos[0]?.prs[0]?.failingChecks?.[0]?.name).toBe("unit");
  });
});

describe("ci-remediation — advisor isolation", () => {
  it("toAdvisorFacts strips every remediation field", () => {
    const facts = makeFacts({
      mainChecks: "red",
      mainFailingChecks: [
        {
          name: "MAIN-SECRET",
          conclusion: "failure",
          detailsUrl: "https://x/m",
        },
      ],
      mainWorkflowRuns: [makeRun({ runId: 5 })],
      prs: [
        makePr({
          number: 7,
          behindBy: 4,
          failingChecks: [
            {
              name: "PR-SECRET",
              conclusion: "failure",
              detailsUrl: "https://x/p",
            },
          ],
          workflowRuns: [makeRun({ runId: 6 })],
        }),
      ],
    });

    const projected = toAdvisorFacts(facts);
    const serialized = JSON.stringify(projected);

    // None of the remediation text or keys survive the projection.
    expect(serialized).not.toContain("SECRET");
    expect(serialized).not.toContain("behindBy");
    expect(serialized).not.toContain("failingChecks");
    expect(serialized).not.toContain("workflowRuns");
    expect(serialized).not.toContain("mainFailingChecks");
    // But the advisor-relevant fields remain.
    expect(projected.prs[0]?.number).toBe(7);
    expect(projected.mainChecks).toBe("red");
  });
});

describe("ci-remediation — resilience", () => {
  it("a failed re-run write does not discard already-merged outcomes", async () => {
    // A green patch merges; a failing main run is re-run-eligible but the
    // rerun API throws (e.g. 403 before the Actions grant is approved). The
    // merge must still be reported, and the repo must not be marked errored.
    const facts = makeFacts({
      mainChecks: "red",
      mainWorkflowRuns: [makeRun({ runId: 99, runAttempt: 1 })],
      prs: [makePr({ number: 7, checks: "green" })],
    });
    class ThrowingRerun extends FakeGitHub {
      override async rerunFailedJobs(): Promise<void> {
        throw new Error("403: Actions permission not yet approved");
      }
    }
    const github = new ThrowingRerun(
      new Map([
        [
          SLUG,
          {
            rawPrs: [],
            prChecks: {},
            mainChecks: "red",
            latestTag: "v1.2.3",
            unreleased: 0,
            hasWorkflow: true,
            defaultSha: "main-sha",
          },
        ],
      ]),
    );
    const plan: Plan = {
      repos: [
        {
          repo: SLUG,
          prDecisions: [
            { number: 7, action: "merge", reason: "ok", risk: "low" },
          ],
          release: { action: "wait", reason: "n/a" },
        },
      ],
    };
    const res = await applyPlan([facts], plan, config("enforce"), github);

    expect(github.merged).toEqual([{ repo: SLUG, number: 7 }]);
    expect(res.repos[0]?.error).toBeUndefined();
    expect(res.repos[0]?.prs[0]?.status).toBe("merged");
    // The failed re-run is simply not reported (retried next tick).
    expect(res.repos[0]?.remediations).toEqual([]);
  });
});
