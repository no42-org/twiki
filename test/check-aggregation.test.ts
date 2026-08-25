/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type {
  CheckStatus,
  PullRequest,
  RepoPolicy,
} from "../src/core/types.js";
import { createGitHubFromEnv } from "../src/github/octokit-adapter.js";
import { settledBlockers } from "../src/twiki/executor.js";
import { canRebase, isSettled, mergeBlock } from "../src/twiki/gates.js";

// What twiki concludes about a commit's CI, from two GitHub systems that
// disagree.
//
// The fakes every gate test runs against return a CheckStatus DIRECTLY, so
// they never reach this aggregation at all. That is exactly how #87 shipped:
// twiki could not merge anything in any managed repository, because GitHub's
// combined-status endpoint reports `pending` for a commit with zero legacy
// statuses and that was read as evidence. Every gate test passed on both
// sides of the bug.
//
// EVERY PAYLOAD HERE WAS RECORDED FROM THE LIVE API, none derived. Measured
// on the scratch repository 2026-08-25: an Actions-only commit returns
// `state: "pending"`, `total_count: 0` whether its runs passed, failed, or
// never ran - the field carries no information and was deciding the outcome.

const FIXTURES = join(import.meta.dirname, "fixtures/github");
const recorded = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));

const TEST_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const REPO = { owner: "no42-org", name: "twiki-write-spike" };
/** Irrelevant to CI aggregation; no gate reads it (protection-is-a-fact D4). */
const PROTECTED = {
  state: "protected" as const,
  rulesInForce: ["pull_request"],
  inertRulesets: [],
  unreadableSources: [],
};

/** Serve one recorded check-runs payload and one recorded status payload. */
function githubServing(runsFixture: string, statusFixture: string) {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const body = url.pathname.endsWith("/check-runs")
      ? recorded(runsFixture)
      : url.pathname.endsWith("/status")
        ? recorded(statusFixture)
        : url.pathname.endsWith("/installation")
          ? { id: 7 }
          : url.pathname.endsWith("/access_tokens")
            ? {
                token: "ghs_test",
                expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              }
            : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return createGitHubFromEnv(
    () => true,
    {
      TWIKI_GITHUB_APP_ID: "1",
      TWIKI_GITHUB_APP_PRIVATE_KEY: TEST_KEY,
    } as NodeJS.ProcessEnv,
    fetchImpl,
  );
}

describe("CI status is aggregated from two systems that disagree", () => {
  // runs × statuses. The first row is the column every allowlisted repository
  // lives in, and the row where #87 lived.
  const cases: [string, string, string, string][] = [
    ["actions green, no statuses", "check-runs-green", "status-empty", "green"],
    ["actions red, no statuses", "check-runs-red", "status-empty", "red"],
    [
      "actions running, no statuses",
      "check-runs-pending",
      "status-empty",
      "pending",
    ],
    ["nothing at all", "check-runs-empty", "status-empty", "none"],
    ["statuses only, passing", "check-runs-empty", "status-success", "green"],
    [
      "actions green and a passing status",
      "check-runs-green",
      "status-success",
      "green",
    ],
    ["actions red, status passing", "check-runs-red", "status-success", "red"],
  ];

  for (const [name, runs, status, expected] of cases) {
    it(`${name} → ${expected}`, async () => {
      const github = githubServing(runs, status);
      await expect(github.prChecks(REPO, "deadbeef")).resolves.toBe(expected);
    });
  }

  it("a truncated page cannot support green", async () => {
    // DERIVED, not recorded: this estate does not currently produce a commit
    // with more than one page of check runs - the busiest measured is 62
    // against a per_page of 100, which is closer to the bound than is
    // comfortable. The shape is the recorded green payload with
    // total_count raised above the array length, which is exactly what GitHub
    // returns when the page is short.
    //
    // Without this, a failing run on page two is invisible, nothing failed as
    // far as the code can see, and a truncated view reports green - the same
    // merge-on-no-evidence hole the `none` branch closes, by another door.
    // Review caught it; the first version of this fix was untested and a
    // mutation removing it passed the whole suite.
    const github = githubServing(
      "check-runs-truncated.derived",
      "status-empty",
    );
    await expect(github.prChecks(REPO, "deadbeef")).resolves.toBe("pending");
  });

  it("a commit whose every run was skipped has verified nothing", async () => {
    // RECORDED from a constructed repository (#88), not derived: two runs,
    // both `skipped`, `total_count: 2`. This is NOT the #87 no-runs case -
    // the objects exist, and the old aggregation counted their existence as
    // "something ran".
    //
    // Nothing else catches this. On that same head, with the skipped job's
    // context set as a REQUIRED status check, GitHub reported the pull
    // request CLEAN and merged it. twiki's verdict is the only gate.
    const skipped = recorded("check-runs-all-skipped") as {
      total_count: number;
      check_runs: { conclusion: string }[];
    };
    expect(skipped.total_count).toBe(2);
    expect(skipped.check_runs.every((r) => r.conclusion === "skipped")).toBe(
      true,
    );

    const github = githubServing("check-runs-all-skipped", "status-empty");
    await expect(github.prChecks(REPO, "deadbeef")).resolves.toBe("none");
  });

  it("one real result among skipped runs is still evidence", async () => {
    // The other side of the same rule, and the reason this is a filter rather
    // than a blanket refusal. A conditional job that legitimately does not
    // apply must not stop a commit whose real gate passed from being green -
    // skipped runs are ubiquitous here (every commit has some, up to 26.5% of
    // one commit's runs) and none of them should count against it.
    const github = githubServing(
      "check-runs-skipped-and-green.derived",
      "status-empty",
    );
    await expect(github.prChecks(REPO, "deadbeef")).resolves.toBe("green");
  });

  it("a failure among skipped runs is still a failure", async () => {
    const github = githubServing(
      "check-runs-skipped-and-red.derived",
      "status-empty",
    );
    await expect(github.prChecks(REPO, "deadbeef")).resolves.toBe("red");
  });

  it("emptiness is what GitHub counts, not what one page returned", async () => {
    // `runs.length === 0` and `total_count === 0` differ exactly when a page
    // is short. Using the array length would call a truncated-to-zero view
    // "nothing reported" rather than "we did not see it all".
    const empty = recorded("check-runs-empty") as { total_count: number };
    expect(empty.total_count).toBe(0);
    const github = githubServing("check-runs-empty", "status-empty");
    await expect(github.prChecks(REPO, "deadbeef")).resolves.toBe("none");
  });

  it("an empty combined status is not evidence of anything", async () => {
    // The whole defect in one assertion. The recorded payload really does say
    // `pending` while carrying no statuses, and green must survive it.
    const empty = recorded("status-empty") as {
      state: string;
      total_count: number;
    };
    expect(empty.state).toBe("pending");
    expect(empty.total_count).toBe(0);

    const github = githubServing("check-runs-green", "status-empty");
    await expect(github.prChecks(REPO, "deadbeef")).resolves.toBe("green");
  });
});

describe("every status decides the same way at every gate", () => {
  // The audit that the compiler cannot do. Widening CheckStatus produced ZERO
  // type errors - TypeScript does not force exhaustiveness on `if` chains - so
  // a new value silently inherits whichever branch happens to catch it. That
  // is how absence came to mean "permitted" in canRebase while meaning
  // "blocked" everywhere else. This table is the only thing that notices.
  const policy: RepoPolicy = { autoMergeMinor: true, mergeOnly: false };
  const pr = (checks: PullRequest["checks"]): PullRequest => ({
    repo: REPO,
    number: 1,
    title: "chore(deps): bump x from 1.0.0 to 1.0.1",
    branch: "dependabot/npm_and_yarn/x-1.0.1",
    headSha: "deadbeef",
    isSecurity: false,
    isDependabot: true,
    bump: { level: "patch", indeterminate: false },
    checks,
    body: "",
    behindBy: 3,
  });

  const table: [PullRequest["checks"], boolean, boolean][] = [
    // checks      may merge   may request a rebase
    ["green", true, true],
    ["red", false, false],
    ["pending", false, true],
    // `none` is the one row where the two columns disagree, and deliberately.
    // A merge publishes; a rebase asks Dependabot to refresh its own pull
    // request and publishes nothing. Refusing both would deadlock a repository
    // that adds its first workflow while older Dependabot PRs are open: those
    // heads never get checks, the merge gate blocks, there are no runs to
    // re-run, and nothing can produce a new head. Review caught this - the
    // first version of this row said false, false.
    ["none", false, true],
  ];

  for (const [checks, mayMerge, mayRebase] of table) {
    it(`${checks}: merge=${mayMerge} rebase=${mayRebase}`, () => {
      expect(mergeBlock(pr(checks), policy) === null).toBe(mayMerge);
      expect(canRebase(pr(checks), policy)).toBe(mayRebase);
    });
  }

  it("a merge blocked for absence says so, not that CI is not green", () => {
    // "ci-not-green" sends the reader hunting a failing build that does not
    // exist. Nothing failed; nothing ran.
    expect(mergeBlock(pr("none"), policy)).toBe("no-checks");
    expect(mergeBlock(pr("red"), policy)).toBe("ci-not-green");
  });

  it("a branch that reported nothing is not settled", () => {
    const facts = {
      repo: REPO,
      mainChecks: "none" as const,
      latestTag: "v1.0.0",
      hasTagReleaseWorkflow: true,
      unreleasedDependencyCommits: 3,
      protection: PROTECTED,
      prs: [],
    };
    expect(isSettled(facts, policy)).toBe(false);
    expect(isSettled({ ...facts, mainChecks: "green" }, policy)).toBe(true);
  });
});

describe("the operator is told what is absent, not what is failing", () => {
  const policy: RepoPolicy = { autoMergeMinor: true, mergeOnly: false };
  const facts = (mainChecks: CheckStatus) => ({
    repo: REPO,
    mainChecks,
    latestTag: "v1.0.0",
    hasTagReleaseWorkflow: true,
    unreleasedDependencyCommits: 3,
    protection: PROTECTED,
    prs: [],
  });

  it("a branch that reported nothing is neither red nor running", () => {
    const said = settledBlockers(facts("none"), policy).join(" ");
    expect(said).toContain("no check results");
    // Must not assert a cause. `none` is reached both by nothing running and
    // by everything that ran being skipped (#88), and naming the wrong one
    // costs the reader the search - the #70/#73 failure mode.
    expect(said).toContain("skipped");
    // The two lies the three-value vocabulary forced it to choose between.
    expect(said).not.toContain("RED");
    expect(said.toLowerCase()).not.toContain("is running");
  });

  it("a red branch still says red, and a running one still says running", () => {
    expect(settledBlockers(facts("red"), policy).join(" ")).toContain("red");
    expect(settledBlockers(facts("pending"), policy).join(" ")).toContain(
      "running",
    );
  });
});
