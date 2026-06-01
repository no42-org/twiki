/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { buildConfig, type Config } from "../src/config.js";
import { applyPlan } from "../src/executor.js";
import type { Plan } from "../src/plan.js";
import type { Mode } from "../src/types.js";
import { FakeGitHub, type FakeRepoData, makeBump, makeFacts, makePr } from "./fakes.js";

const SLUG = "no42-org/demo";

function config(mode: Mode, mergeOnly = false): Config {
  return buildConfig({ mode, repos: [{ repo: SLUG, mergeOnly }] });
}

function gh(over: Partial<FakeRepoData> = {}): FakeGitHub {
  const data: FakeRepoData = {
    rawPrs: [],
    prChecks: {},
    mainChecks: "green",
    latestTag: "v1.2.3",
    unreleased: 1,
    hasWorkflow: true,
    defaultSha: "main-sha",
    ...over,
  };
  return new FakeGitHub(new Map([[SLUG, data]]));
}

function mergePlan(number: number): Plan {
  return {
    repos: [
      {
        repo: SLUG,
        prDecisions: [{ number, action: "merge", reason: "ok", risk: "low" }],
        release: { action: "wait", reason: "n/a" },
      },
    ],
  };
}

describe("executor — merge decisions", () => {
  it("shadow mode reports would-merge and performs no write", async () => {
    const facts = makeFacts({ prs: [makePr({ number: 7 })] });
    const github = gh();
    const res = await applyPlan([facts], mergePlan(7), config("shadow"), github);
    expect(res.repos[0]?.prs[0]?.status).toBe("would-merge");
    expect(github.merged).toEqual([]);
  });

  it("enforce mode merges a green patch", async () => {
    const facts = makeFacts({ prs: [makePr({ number: 7 })] });
    const github = gh();
    const res = await applyPlan([facts], mergePlan(7), config("enforce"), github);
    expect(res.repos[0]?.prs[0]?.status).toBe("merged");
    expect(github.merged).toEqual([{ repo: SLUG, number: 7 }]);
  });

  it("holds when the advisor says hold", async () => {
    const facts = makeFacts({ prs: [makePr({ number: 7 })] });
    const plan: Plan = {
      repos: [
        {
          repo: SLUG,
          prDecisions: [{ number: 7, action: "hold", reason: "risky changelog", risk: "high" }],
          release: { action: "wait", reason: "n/a" },
        },
      ],
    };
    const res = await applyPlan([facts], plan, config("enforce"), gh());
    expect(res.repos[0]?.prs[0]).toMatchObject({ status: "held", detail: "risky changelog" });
  });

  it("holds when the advisor gives no decision", async () => {
    const facts = makeFacts({ prs: [makePr({ number: 7 })] });
    const empty: Plan = { repos: [] };
    const res = await applyPlan([facts], empty, config("enforce"), gh());
    expect(res.repos[0]?.prs[0]?.status).toBe("held");
  });
});

describe("executor — gates cannot be widened by the plan (safety)", () => {
  it("does NOT merge a red PR even when the plan says merge (enforce)", async () => {
    const facts = makeFacts({ prs: [makePr({ number: 7, checks: "red" })] });
    const github = gh();
    const res = await applyPlan([facts], mergePlan(7), config("enforce"), github);
    expect(res.repos[0]?.prs[0]).toMatchObject({ status: "blocked", detail: "gate: ci-not-green" });
    expect(github.merged).toEqual([]);
  });

  it("does NOT merge a major even when the plan says merge (enforce)", async () => {
    const facts = makeFacts({
      prs: [makePr({ number: 7, bump: makeBump({ level: "major" }) })],
    });
    const github = gh();
    const res = await applyPlan([facts], mergePlan(7), config("enforce"), github);
    expect(res.repos[0]?.prs[0]?.status).toBe("flagged-major");
    expect(github.merged).toEqual([]);
  });

  it("flags a security major as urgent", async () => {
    const facts = makeFacts({
      prs: [makePr({ number: 7, isSecurity: true, bump: makeBump({ level: "major" }) })],
    });
    const res = await applyPlan([facts], mergePlan(7), config("enforce"), gh());
    expect(res.repos[0]?.prs[0]?.detail).toContain("URGENT");
  });
});

describe("executor — release decisions", () => {
  const settled = () => makeFacts({ prs: [] });

  it("enforce mode cuts the next patch tag when settled", async () => {
    const github = gh();
    const res = await applyPlan([settled()], { repos: [] }, config("enforce"), github);
    expect(res.repos[0]?.release).toMatchObject({ status: "released", version: "v1.2.4" });
    expect(github.tagged).toEqual([{ repo: SLUG, tag: "v1.2.4", sha: "main-sha" }]);
  });

  it("shadow mode reports would-release and pushes no tag", async () => {
    const github = gh();
    const res = await applyPlan([settled()], { repos: [] }, config("shadow"), github);
    expect(res.repos[0]?.release).toMatchObject({ status: "would-release", version: "v1.2.4" });
    expect(github.tagged).toEqual([]);
  });

  it("reports a missing release workflow when settled", async () => {
    const github = gh();
    const facts = makeFacts({ prs: [], hasTagReleaseWorkflow: false });
    const res = await applyPlan([facts], { repos: [] }, config("enforce"), github);
    expect(res.repos[0]?.release.status).toBe("no-release-workflow");
    expect(github.tagged).toEqual([]);
  });

  it("skips release for a merge-only repo", async () => {
    const res = await applyPlan([settled()], { repos: [] }, config("enforce", true), gh());
    expect(res.repos[0]?.release.status).toBe("skipped-merge-only");
  });

  it("waits when not settled", async () => {
    const facts = makeFacts({ prs: [], unreleasedDependencyCommits: 0 });
    const res = await applyPlan([facts], { repos: [] }, config("enforce"), gh());
    expect(res.repos[0]?.release.status).toBe("waiting");
  });
});
