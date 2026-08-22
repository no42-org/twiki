/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildConfig, type Config } from "../src/core/config.js";
import type { Mode } from "../src/core/types.js";
import { JsonlAudit } from "../src/twiki/audit.js";
import { applyPlan } from "../src/twiki/executor.js";
import type { Plan } from "../src/twiki/plan.js";
import { buildDigest, hasActionableActivity } from "../src/twiki/report.js";
import { FakeGitHub, type FakeRepoData, makeFacts, makePr } from "./fakes.js";

// What a run reports when it stops part-way through a repository.
//
// twiki could merge three pull requests, fail on the fourth, and tell the
// maintainer it merged none. `evaluatePrs` accumulated outcomes into a local
// array, `mergePR` was unguarded, and the throw reached `applyRepo`'s catch,
// which returned `prs: []`. That one empty array fed BOTH reporting surfaces,
// because the digest and the audit are built from the same RunResult.
//
// The design document names twiki's defining constraint as trust, and
// justifies the GitHub App on "honest provenance in the audit log". A record
// that omits merges it performed is a hole in exactly that.
//
// Nothing exotic is needed to reach it: a permissions 403, a 405 merge
// conflict, a 409 on a changed head, or a transient 502 all do.

const SLUG = "no42-org/demo";

function config(mode: Mode = "enforce"): Config {
  return buildConfig({ mode, repos: [{ repo: SLUG }] });
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

/** Merge every listed pull request, in order. */
function mergePlan(numbers: number[]): Plan {
  return {
    repos: [
      {
        repo: SLUG,
        prDecisions: numbers.map((number) => ({
          number,
          action: "merge" as const,
          reason: "ok",
          risk: "low" as const,
        })),
        release: { action: "wait", reason: "n/a" },
      },
    ],
  };
}

const FOUR = [1, 2, 3, 4];
const facts = () => makeFacts({ prs: FOUR.map((n) => makePr({ number: n })) });

/** Merge 1-3, fail on 4. The scenario the whole change is about. */
async function runWithFailureOnFourth() {
  const github = gh();
  github.failMergeOn.set(
    4,
    Object.assign(new Error("You have exceeded a secondary rate limit"), {
      status: 403,
    }),
  );
  const result = await applyPlan([facts()], mergePlan(FOUR), config(), github);
  return { github, result, repo: result.repos[0] };
}

describe("a repository that stops part-way still reports what it did", () => {
  it("keeps the merges that landed before the failure", async () => {
    const { github, repo } = await runWithFailureOnFourth();

    // The merges really happened: the fake recorded them.
    expect(github.merged.map((m) => m.number)).toEqual([1, 2, 3]);
    // ...so the result must say so. It reported `prs: []` before this change.
    expect(repo?.prs.map((p) => p.number)).toEqual([1, 2, 3]);
    expect(repo?.prs.every((p) => p.status === "merged")).toBe(true);
  });

  it("names the pull request it failed on, and why", async () => {
    const { repo } = await runWithFailureOnFourth();

    expect(repo?.error).toContain("#4");
    expect(repo?.error).toMatch(/secondary rate limit/i);
  });

  it("says how much it did not get to", async () => {
    // Stopping creates a NEW way for a pull request to be absent, and if it
    // renders like "evaluated, nothing to do" the result reproduces the
    // confident-zero failure the read side keeps having to fix (AD-28).
    const { repo } = await runWithFailureOnFourth();

    expect(repo?.stoppedEarly).toBe(true);
    expect(repo?.notEvaluated).toBe(1);
  });

  it("stops rather than attempting the remaining merges", async () => {
    // Under a secondary limit, carrying on means hammering the endpoint that
    // just refused, which is what AD-24 exists to prevent. The next tick
    // retries from the beginning with fresh facts.
    const { github } = await runWithFailureOnFourth();

    expect(github.merged.map((m) => m.number)).not.toContain(5);
    expect(github.merged).toHaveLength(3);
  });

  it("leaves a completed repository making no early-stop claim", async () => {
    // The other half: an empty outcome list must keep meaning "nothing to do".
    const result = await applyPlan([facts()], mergePlan(FOUR), config(), gh());

    expect(result.repos[0]?.stoppedEarly).toBeFalsy();
    expect(result.repos[0]?.notEvaluated).toBeFalsy();
  });
});

describe("a skipped remediation says why it was skipped", () => {
  // tryWrite caught everything and returned false, so the remediation was
  // simply absent from the output. Absent is also what an INELIGIBLE pull
  // request produces, because canRebase skips it before tryWrite is reached.
  // An operator reading "0 rebases" during a throttling episode saw exactly
  // what a healthy quiet run looks like.
  const behindPr = () => makePr({ number: 7, behindBy: 3, checks: "green" });
  const noPlan = (): Plan => ({
    repos: [
      {
        repo: SLUG,
        prDecisions: [],
        release: { action: "wait", reason: "n/a" },
      },
    ],
  });

  it("a throttled run does not read like a run with nothing eligible", async () => {
    const throttled = gh();
    throttled.failRebaseOn.set(
      7,
      Object.assign(new Error("You have exceeded a secondary rate limit"), {
        status: 403,
      }),
    );
    const attempted = await applyPlan(
      [makeFacts({ prs: [behindPr()] })],
      noPlan(),
      config(),
      throttled,
    );

    // Nothing was eligible here: the PR is not behind, so no rebase is tried.
    const quiet = await applyPlan(
      [makeFacts({ prs: [makePr({ number: 7, behindBy: 0 })] })],
      noPlan(),
      config(),
      gh(),
    );

    expect(attempted.repos[0]?.remediations).not.toEqual(
      quiet.repos[0]?.remediations,
    );
  });

  it("reports the failed attempt with its reason", async () => {
    const github = gh();
    github.failRebaseOn.set(
      7,
      new Error("Resource not accessible by integration"),
    );

    const res = await applyPlan(
      [makeFacts({ prs: [behindPr()] })],
      noPlan(),
      config(),
      github,
    );

    const rem = res.repos[0]?.remediations?.[0];
    expect(rem?.status).toBe("failed-rebase");
    expect(rem?.detail).toMatch(/not accessible/i);
  });

  it("an ineligible remediation is not reported as a failed write", async () => {
    const res = await applyPlan(
      [makeFacts({ prs: [makePr({ number: 7, behindBy: 0 })] })],
      noPlan(),
      config(),
      gh(),
    );

    const statuses = (res.repos[0]?.remediations ?? []).map((r) => r.status);
    expect(statuses).not.toContain("failed-rebase");
  });

  it("a remediation failure does not stop the repository", async () => {
    // The existing contract, kept: "a remediation failure must NOT discard the
    // merge/release outcomes already computed for this repo".
    const github = gh();
    github.failRebaseOn.set(7, new Error("nope"));

    const res = await applyPlan(
      [makeFacts({ prs: [behindPr()] })],
      noPlan(),
      config(),
      github,
    );

    expect(res.repos[0]?.error).toBeUndefined();
    expect(res.repos[0]?.stoppedEarly).toBeFalsy();
  });
});

describe("both reporting surfaces agree with what happened", () => {
  it("the digest reports the merges that landed", async () => {
    // The surface with a human on the other end. `repoLines` returned early
    // on `repo.error`, so the digest showed the error and nothing else - even
    // once the outcomes survived the executor.
    const { result } = await runWithFailureOnFourth();

    const digest = buildDigest(result);

    expect(digest).toContain("#1");
    expect(digest).toContain("#2");
    expect(digest).toContain("#3");
    expect(digest).toMatch(/secondary rate limit/i);
  });

  it("the digest says the repository stopped early", async () => {
    const { result } = await runWithFailureOnFourth();

    expect(buildDigest(result)).toMatch(/stopped|not evaluated/i);
  });

  it("the digest is still sent for a failed repository", async () => {
    // Currently correct, and pinned before the result shape moves: a fix that
    // started suppressing failed repositories would be strictly worse than
    // the bug it replaced.
    const { result } = await runWithFailureOnFourth();

    expect(hasActionableActivity(result)).toBe(true);
  });

  it("the audit records the merges too", async () => {
    // The first test to exercise JsonlAudit at all: every other test in the
    // suite uses NullAudit, so the writer of the record this change is about
    // had no coverage.
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const path = join(dir, "audit.jsonl");
    const { result } = await runWithFailureOnFourth();

    new JsonlAudit(path).record(result, "2026-08-22T12:00:00.000Z");

    const line = JSON.parse(readFileSync(path, "utf8").trim());
    const numbers = line.repos[0].prs.map((p: { number: number }) => p.number);
    expect(numbers).toEqual([1, 2, 3]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("the two surfaces cannot disagree about a merge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "audit-"));
    const path = join(dir, "audit.jsonl");
    const { result } = await runWithFailureOnFourth();

    const digest = buildDigest(result);
    new JsonlAudit(path).record(result, "2026-08-22T12:00:00.000Z");
    const line = JSON.parse(readFileSync(path, "utf8").trim());

    for (const pr of line.repos[0].prs) {
      expect(digest).toContain(`#${pr.number}`);
    }
    rmSync(dir, { recursive: true, force: true });
  });
});
