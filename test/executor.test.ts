/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { buildConfig, type Config } from "../src/core/config.js";
import type { Mode } from "../src/core/types.js";
import { applyPlan } from "../src/twiki/executor.js";
import type { Plan } from "../src/twiki/plan.js";
import { buildDigest } from "../src/twiki/report.js";
import {
  FakeGitHub,
  type FakeRepoData,
  makeBump,
  makeFacts,
  makePr,
} from "./fakes.js";

const SLUG = "no42-org/demo";

function config(mode: Mode): Config {
  return buildConfig({ mode, repos: [{ repo: SLUG }] });
}

function gh(over: Partial<FakeRepoData> = {}): FakeGitHub {
  const data: FakeRepoData = {
    rawPrs: [],
    prChecks: {},
    mainChecks: "green",
    latestTag: "v1.2.3",
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
      },
    ],
  };
}

describe("executor — merge decisions", () => {
  it("shadow mode reports would-merge and performs no write", async () => {
    const facts = makeFacts({ prs: [makePr({ number: 7 })] });
    const github = gh();
    const res = await applyPlan(
      [facts],
      mergePlan(7),
      config("shadow"),
      github,
    );
    expect(res.repos[0]?.prs[0]?.status).toBe("would-merge");
    expect(github.merged).toEqual([]);
  });

  it("enforce mode merges a green patch", async () => {
    const facts = makeFacts({ prs: [makePr({ number: 7 })] });
    const github = gh();
    const res = await applyPlan(
      [facts],
      mergePlan(7),
      config("enforce"),
      github,
    );
    expect(res.repos[0]?.prs[0]?.status).toBe("merged");
    expect(github.merged).toEqual([{ repo: SLUG, number: 7 }]);
  });

  it("holds when the advisor says hold", async () => {
    const facts = makeFacts({ prs: [makePr({ number: 7 })] });
    const plan: Plan = {
      repos: [
        {
          repo: SLUG,
          prDecisions: [
            {
              number: 7,
              action: "hold",
              reason: "risky changelog",
              risk: "high",
            },
          ],
        },
      ],
    };
    const res = await applyPlan([facts], plan, config("enforce"), gh());
    expect(res.repos[0]?.prs[0]).toMatchObject({
      status: "held",
      detail: "risky changelog",
    });
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
    const res = await applyPlan(
      [facts],
      mergePlan(7),
      config("enforce"),
      github,
    );
    expect(res.repos[0]?.prs[0]).toMatchObject({
      status: "blocked",
      detail: "gate: ci-not-green",
    });
    expect(github.merged).toEqual([]);
  });

  it("does NOT merge a major even when the plan says merge (enforce)", async () => {
    const facts = makeFacts({
      prs: [makePr({ number: 7, bump: makeBump({ level: "major" }) })],
    });
    const github = gh();
    const res = await applyPlan(
      [facts],
      mergePlan(7),
      config("enforce"),
      github,
    );
    expect(res.repos[0]?.prs[0]?.status).toBe("flagged-major");
    expect(github.merged).toEqual([]);
  });

  it("flags a security major as urgent", async () => {
    const facts = makeFacts({
      prs: [
        makePr({
          number: 7,
          isSecurity: true,
          bump: makeBump({ level: "major" }),
        }),
      ],
    });
    const res = await applyPlan([facts], mergePlan(7), config("enforce"), gh());
    expect(res.repos[0]?.prs[0]?.detail).toContain("URGENT");
  });
});

describe("executor - a merge lost to an operator click", () => {
  const raced = async (state: "OPEN" | "MERGED") => {
    const first = makePr({ number: 7, title: "first" });
    const second = makePr({ number: 8, title: "second" });
    const github = gh();
    github.failMergeOn.set(
      7,
      Object.assign(new Error("HTTP 405"), { status: 405 }),
    );
    github.live.set(`${SLUG}#7`, {
      state,
      isDraft: false,
      headSha: "sha-7",
      reviewDecision: null,
    });
    const plan: Plan = {
      repos: [
        {
          repo: SLUG,
          prDecisions: [7, 8].map((number) => ({
            number,
            action: "merge" as const,
            reason: "ok",
            risk: "low" as const,
          })),
        },
      ],
    };
    const res = await applyPlan(
      [makeFacts({ prs: [first, second] })],
      plan,
      config("enforce"),
      github,
    );
    return { res, github, first, second };
  };

  it("reports already-merged and carries on with the repository", async () => {
    const { res, github, first, second } = await raced("MERGED");
    expect(res.repos).toEqual([
      {
        repo: SLUG,
        mainRed: false,
        prs: [
          {
            number: 7,
            title: first.title,
            security: first.isSecurity,
            status: "already-merged",
            detail: "merged before this tick reached it, not by this tick",
          },
          {
            number: 8,
            title: second.title,
            security: second.isSecurity,
            status: "merged",
            detail: "ok",
          },
        ],
        remediations: [],
      },
    ]);
    expect(github.merged).toEqual([{ repo: SLUG, number: 8 }]);
  });

  it("shows the lost race in the digest and does not claim the merge", async () => {
    const { res } = await raced("MERGED");
    const lines = buildDigest(res).split("\n");
    expect(lines).toContain(
      "  ☑️ already merged #7 — first (merged before this tick reached it, not by this tick)",
    );
    expect(lines).not.toContain("  ✅ merged #7 — first");
  });

  it("still stops the repository on a 405 for a pull request still open", async () => {
    const { res, github } = await raced("OPEN");
    expect(res.repos).toEqual([
      {
        repo: SLUG,
        mainRed: false,
        prs: [],
        stoppedEarly: true,
        notEvaluated: 2,
        error: "#7: HTTP 405",
      },
    ]);
    expect(github.merged).toEqual([]);
  });
});
