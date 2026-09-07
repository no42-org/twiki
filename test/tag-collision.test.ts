/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { buildConfig, type Config } from "../src/core/config.js";
import type { Mode } from "../src/core/types.js";
import { TagExistsError } from "../src/github/port.js";
import { applyPlan } from "../src/twiki/executor.js";
import type { Plan } from "../src/twiki/plan.js";
import { buildDigest, hasActionableActivity } from "../src/twiki/report.js";
import { FakeGitHub, type FakeRepoData, makeFacts } from "./fakes.js";

// A tag that exists when twiki pushes it (#110).
//
// With `latestTag` reading the ref store, the only way to hit
// "Reference already exists" is a tagger racing between the re-check and the
// push. That is their tag, not a failed write: the repository continues, the
// outcome is named, and the digest says what release state the tag has so
// the reader knows whether a human is mid-release or a stray tag needs
// attention. Before, this was "repo errored" with `stoppedEarly`, every tick.

const SLUG = "no42-org/demo";

function config(mode: Mode = "enforce"): Config {
  return buildConfig({ mode, repos: [{ repo: SLUG }] });
}

function gh(over: Partial<FakeRepoData> = {}): FakeGitHub {
  const data: FakeRepoData = {
    rawPrs: [],
    prChecks: {},
    mainChecks: "green",
    latestTag: "v0.5.12",
    unreleased: 1,
    hasWorkflow: true,
    defaultSha: "main-sha",
    ...over,
  };
  return new FakeGitHub(new Map([[SLUG, data]]));
}

const releasePlan: Plan = {
  repos: [
    {
      repo: SLUG,
      prDecisions: [],
      release: { action: "release", reason: "settled" },
    },
  ],
};

async function collide(state?: "published" | "draft") {
  const github = gh();
  github.failTagWith = new TagExistsError("v0.5.13");
  if (state) github.releaseStates.set(`${SLUG}@v0.5.13`, state);
  const result = await applyPlan(
    [makeFacts({})],
    releasePlan,
    config(),
    github,
  );
  return { github, result, repo: result.repos[0] };
}

describe("a tag that appeared between the re-check and the push", () => {
  it("is a named outcome, not an errored or stopped repository", async () => {
    const { repo, github } = await collide("draft");
    expect(repo?.release.status).toBe("tag-exists");
    expect(repo?.release.version).toBe("v0.5.13");
    expect(repo?.error).toBeUndefined();
    expect(repo?.stoppedEarly).toBeFalsy();
    expect(github.tagged).toEqual([]);
  });

  it("says what GitHub holds for the tag", async () => {
    for (const [state, expected] of [
      ["draft", /release: draft/],
      ["published", /release: published/],
      [undefined, /release: none/],
    ] as const) {
      const { repo } = await collide(state);
      expect(repo?.release.detail).toMatch(expected);
      expect(repo?.release.detail).toMatch(
        /appeared before twiki could push it/,
      );
    }
  });

  it("renders in the digest without claiming a failed write", async () => {
    const { result } = await collide("draft");
    const digest = buildDigest(result);
    expect(hasActionableActivity(result)).toBe(true);
    expect(digest).toContain("v0.5.13 appeared before twiki could push it");
    expect(digest).toContain("release: draft");
    expect(digest).not.toMatch(/errored|failed write|stopped early/i);
  });

  it("other push failures keep the existing handling", async () => {
    const github = gh();
    github.failTagWith = new Error(
      "403 Resource not accessible by integration",
    );
    const result = await applyPlan(
      [makeFacts({})],
      releasePlan,
      config(),
      github,
    );
    expect(result.repos[0]?.release.status).not.toBe("tag-exists");
    expect(result.repos[0]?.error).toMatch(/403/);
  });
});
