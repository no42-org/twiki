/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/core/config.js";
import type { CheckStatus } from "../src/core/types.js";
import type { RawPullRequest } from "../src/github/port.js";
import {
  advisorFromEnv,
  ClaudeAdvisor,
  RulesAdvisor,
} from "../src/twiki/advisor.js";
import { JsonlAudit, NullAudit } from "../src/twiki/audit.js";
import { runOnce } from "../src/twiki/run.js";
import {
  CapturingNotifier,
  FakeGitHub,
  type FakeRepoData,
  mergeEverythingAdvisor,
} from "./fakes.js";

// Rules-only mode (#202): twiki without an LLM. The advisor votes merge on
// everything, so what these tests pin is that the gates still refuse what they
// refused before, and that the run says no changelog was read.

const SLUG = "no42-org/demo";

function pr(number: number, from: string, to: string): RawPullRequest {
  return {
    number,
    headSha: `sha-${number}`,
    title: `Bump pkg from ${from} to ${to}`,
    branch: `dependabot/pkg-${number}`,
    body: "Routine dependency update.",
    isSecurity: false,
    dependency: { name: "pkg", from, to },
  };
}

// One pull request per gate outcome. Only #1 and #2 may merge.
function estate(): FakeGitHub {
  const checks: Record<string, CheckStatus> = {
    "sha-1": "green",
    "sha-2": "green",
    "sha-3": "green",
    "sha-4": "red",
    "sha-5": "none",
  };
  const data: FakeRepoData = {
    rawPrs: [
      pr(1, "1.0.0", "1.0.1"),
      pr(2, "1.0.0", "1.1.0"),
      pr(3, "1.0.0", "2.0.0"),
      pr(4, "1.0.0", "1.0.2"),
      pr(5, "1.0.0", "1.0.3"),
    ],
    prChecks: checks,
    mainChecks: "green",
    latestTag: "v1.0.0",
    defaultSha: "main-sha",
  };
  return new FakeGitHub(new Map([[SLUG, data]]));
}

const enforce = () =>
  buildConfig({ mode: "enforce", repos: [{ repo: SLUG }] }, undefined, {
    enabled: false,
    maxAttempts: 3,
  });

describe("RulesAdvisor", () => {
  it("votes merge on every pull request of every repository", async () => {
    const plan = await new RulesAdvisor().plan([
      {
        facts: {
          repo: { owner: "no42-org", name: "a" },
          mainChecks: "green",
          prs: [7, 9].map((number) => ({
            number,
            title: "t",
            isSecurity: false,
            bump: { level: "patch", indeterminate: false, from: "1", to: "2" },
            checks: "green",
            body: "",
          })),
        },
        policy: { autoMergeMinor: true, defaultBranch: "main" },
      },
      {
        facts: {
          repo: { owner: "no42-org", name: "b" },
          mainChecks: "green",
          prs: [],
        },
        policy: { autoMergeMinor: true, defaultBranch: "main" },
      },
    ]);

    const decision = (number: number) => ({
      number,
      action: "merge",
      reason: "rules-only: gates passed, changelog not read",
      risk: "low",
    });
    expect(plan).toEqual({
      repos: [
        { repo: "no42-org/a", prDecisions: [decision(7), decision(9)] },
        { repo: "no42-org/b", prDecisions: [] },
      ],
    });
  });
});

describe("a rules-only run", () => {
  it("merges green patch and minor bumps and nothing else", async () => {
    const github = estate();
    const notifier = new CapturingNotifier();

    const res = await runOnce(enforce(), {
      github,
      advisor: new RulesAdvisor(),
      notifier,
      audit: new NullAudit(),
      now: () => "2026-10-29T00:00:00Z",
    });

    expect(github.merged).toEqual([
      { repo: SLUG, number: 1 },
      { repo: SLUG, number: 2 },
    ]);
    expect(
      res.repos[0]?.prs.map(({ number, status, detail }) => ({
        number,
        status,
        detail,
      })),
    ).toEqual([
      {
        number: 1,
        status: "merged",
        detail: "rules-only: gates passed, changelog not read",
      },
      {
        number: 2,
        status: "merged",
        detail: "rules-only: gates passed, changelog not read",
      },
      {
        number: 3,
        status: "flagged-major",
        detail: "major bump — needs human review",
      },
      { number: 4, status: "blocked", detail: "gate: ci-not-green" },
      { number: 5, status: "blocked", detail: "gate: no-checks" },
    ]);
    expect(res.rulesOnly).toBe(true);
    expect(notifier.messages[0]).toContain("Rules-only: no changelog was read");
  });

  it("holds minor bumps where the repository does not allow them", async () => {
    const github = estate();
    const config = buildConfig(
      {
        mode: "enforce",
        repos: [{ repo: SLUG, autoMergeMinor: false }],
      },
      undefined,
      { enabled: false, maxAttempts: 3 },
    );

    const res = await runOnce(config, {
      github,
      advisor: new RulesAdvisor(),
      notifier: new CapturingNotifier(),
      audit: new NullAudit(),
      now: () => "2026-10-29T00:00:00Z",
    });

    expect(github.merged).toEqual([{ repo: SLUG, number: 1 }]);
    expect(res.repos[0]?.prs.find((p) => p.number === 2)?.detail).toBe(
      "gate: above-minor",
    );
  });

  it("is marked in the audit line, and an LLM run is not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "twiki-rules-"));
    try {
      const lines = [];
      for (const advisor of [new RulesAdvisor(), mergeEverythingAdvisor]) {
        const path = join(dir, `${advisor.kind}.jsonl`);
        const notifier = new CapturingNotifier();
        await runOnce(enforce(), {
          github: estate(),
          advisor,
          notifier,
          audit: new JsonlAudit(path),
          now: () => "2026-10-29T00:00:00Z",
        });
        lines.push({
          audit: JSON.parse(readFileSync(path, "utf8")),
          digest: notifier.messages[0] ?? "",
        });
      }
      const [rules, claude] = lines;
      expect(rules?.audit.rulesOnly).toBe(true);
      expect(claude && "rulesOnly" in claude.audit).toBe(false);
      expect(claude?.digest).not.toContain("Rules-only");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("advisorFromEnv", () => {
  it("defaults to the LLM advisor when the key is set", () => {
    for (const TWIKI_ADVISOR of [undefined, "", "claude"]) {
      const advisor = advisorFromEnv({
        TWIKI_ADVISOR,
        ANTHROPIC_API_KEY: "sk-ant-test",
      });
      expect(advisor).toBeInstanceOf(ClaudeAdvisor);
    }
  });

  it("needs no key for the rules advisor", () => {
    expect(advisorFromEnv({ TWIKI_ADVISOR: "rules" })).toBeInstanceOf(
      RulesAdvisor,
    );
  });

  it("refuses the LLM advisor without a key, naming both ways out", () => {
    expect(() => advisorFromEnv({})).toThrow(/ANTHROPIC_API_KEY.*rules/s);
  });

  it("refuses an unknown advisor, naming the variable and the value", () => {
    expect(() =>
      advisorFromEnv({ TWIKI_ADVISOR: "rulez", ANTHROPIC_API_KEY: "k" }),
    ).toThrow(/TWIKI_ADVISOR.*"rulez"/);
  });
});
