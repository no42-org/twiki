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
import {
  FakeGitHub,
  type FakeRepoData,
  makeBump,
  makeFacts,
  makePr,
} from "./fakes.js";

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
    //
    // The failure goes on #2 of four, NOT the last one. An earlier version of
    // this test failed on #4 and asserted "merged has length 3", which holds
    // whether the loop stops or continues - there was no pull request after
    // the failing one to attempt. A mutation that recorded the error and
    // carried on passed the entire 673-test suite.
    const github = gh();
    github.failMergeOn.set(
      2,
      new Error("You have exceeded a secondary rate limit"),
    );

    const result = await applyPlan(
      [facts()],
      mergePlan(FOUR),
      config(),
      github,
    );

    // #1 merged, #2 refused, #3 and #4 never attempted.
    expect(github.merged.map((m) => m.number)).toEqual([1]);
    expect(result.repos[0]?.prs.map((p) => p.number)).toEqual([1]);
    // Three pull requests have no outcome: the one that failed, plus the two
    // after it.
    expect(result.repos[0]?.notEvaluated).toBe(3);
  });

  it("leaves a completed repository making no early-stop claim", async () => {
    // The other half: an empty outcome list must keep meaning "nothing to do".
    const result = await applyPlan([facts()], mergePlan(FOUR), config(), gh());

    expect(result.repos[0]?.stoppedEarly).toBeFalsy();
    expect(result.repos[0]?.notEvaluated).toBeFalsy();
  });
});

describe("a failure after the merges is caught by the backstop", () => {
  it("keeps the pull-request outcomes when the RELEASE write fails", async () => {
    // The other way into applyRepo's catch, and the one the executor cannot
    // see coming: evaluatePrs returns cleanly, then pushTag throws. Nothing
    // exercised this path before, so `prs` being held outside the try was
    // deletable with a green suite - the mutation battery found it, not a
    // review.
    const github = gh();
    github.failTagWith = new Error(
      "refusing to create tag: ref already exists",
    );

    // A major bump is out of policy, so it is flagged rather than merged.
    // That matters here: a MERGEABLE pull request would hold the release
    // (`isSettled` requires none open), and the release write is the failure
    // this test needs.
    const flagged = makePr({ number: 9, bump: makeBump({ level: "major" }) });

    const result = await applyPlan(
      [makeFacts({ prs: [flagged] })],
      {
        repos: [
          {
            repo: SLUG,
            prDecisions: [],
            release: { action: "release" as const, reason: "settled" },
          },
        ],
      },
      config(),
      github,
    );

    // The outcome computed before the release failed is still reported.
    expect(result.repos[0]?.prs.map((p) => p.number)).toEqual([9]);
    expect(result.repos[0]?.error).toMatch(/ref already exists/);
    // Every pull request WAS evaluated; only the release failed.
    expect(result.repos[0]?.notEvaluated).toBe(0);
    expect(buildDigest(result)).toContain("#9");
  });
});

describe("the stop does not claim a cause it cannot know", () => {
  it("a read failure in the release step is not called a failed write", async () => {
    // evaluateRelease reads latestTag and defaultBranchSha BEFORE it pushes
    // anything, so a 502 on either stops the repository with no write
    // attempted. The digest used to say "stopped early after a failed write"
    // regardless, and RepoResult documented the flag as "true when a write
    // failed".
    const github = gh();
    github.failLatestTagWith = new Error(
      "502 Bad Gateway from the tag listing",
    );

    const result = await applyPlan(
      [
        makeFacts({
          prs: [makePr({ number: 9, bump: makeBump({ level: "major" }) })],
        }),
      ],
      {
        repos: [
          {
            repo: SLUG,
            prDecisions: [],
            release: { action: "release" as const, reason: "settled" },
          },
        ],
      },
      config(),
      github,
    );

    const digest = buildDigest(result);
    expect(result.repos[0]?.stoppedEarly).toBe(true);
    expect(digest).toContain("stopped early");
    expect(digest).not.toMatch(/failed write/);
    // The real cause is still on the page, from `error`.
    expect(digest).toMatch(/502/);
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

  it("renders identically across ticks, so the notifier can dedupe it", async () => {
    // A persistent failure - the Actions grant still not approved - would
    // otherwise post to chat every poll. DedupingNotifier hashes the digest
    // and skips an unchanged one, which only works while the rendering is
    // stable. This pins that: putting a timestamp or a request id into
    // `detail` would defeat the dedupe and spam the channel hourly.
    const tick = async () => {
      const github = gh();
      github.failRebaseOn.set(
        7,
        new Error("Resource not accessible by integration"),
      );
      return buildDigest(
        await applyPlan(
          [makeFacts({ prs: [behindPr()] })],
          noPlan(),
          config(),
          github,
        ),
      );
    };

    expect(await tick()).toBe(await tick());
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
