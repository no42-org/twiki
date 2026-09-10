/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import {
  isDefaultBranchRef,
  isDefaultBranchRun,
  isPullRequestRun,
} from "../src/core/branch.js";
import { buildConfig, resolveDefaultBranch } from "../src/core/config.js";
import { DEFAULT_POLICY } from "../src/core/types.js";

// The default branch as a declared fact: what repos.yaml says it is, how the
// one accessor answers, and which refs count as that branch.
//
// Nothing renders from any of this yet. It exists because the read side is
// about to sort workflow runs by the default branch, and a repository on
// `master` would otherwise have its default-branch build treated as just
// another branch - so a red main would read as quiet.

const config = (
  repos: { repo: string; defaultBranch?: string }[],
): ReturnType<typeof buildConfig> =>
  buildConfig({ mode: "shadow", repos, bots: [], reviewers: [] });

describe("the declared default branch", () => {
  it("is main when the repository declares nothing", () => {
    const c = config([{ repo: "no42-org/twiki" }]);
    expect(resolveDefaultBranch(c, { owner: "no42-org", name: "twiki" })).toBe(
      "main",
    );
    // And the policy carries the same answer, so the two are one fact rather
    // than two structures that can drift apart.
    expect(c.policies.get("no42-org/twiki")?.defaultBranch).toBe("main");
  });

  it("is whatever the repository declares", () => {
    const c = config([{ repo: "no42-org/legacy", defaultBranch: "master" }]);
    expect(resolveDefaultBranch(c, { owner: "no42-org", name: "legacy" })).toBe(
      "master",
    );
    expect(c.policies.get("no42-org/legacy")?.defaultBranch).toBe("master");
  });

  it("answers the same whatever casing the question is asked in", () => {
    // repos.yaml is hand-written and GitHub reports its own casing, so
    // neither side is authoritative (AD-22). Folding only one still lets one
    // repository be two, with the wrong branch name on the second.
    const c = config([{ repo: "No42-Org/Legacy", defaultBranch: "master" }]);
    expect(resolveDefaultBranch(c, { owner: "no42-org", name: "legacy" })).toBe(
      "master",
    );
    expect(resolveDefaultBranch(c, { owner: "No42-Org", name: "Legacy" })).toBe(
      "master",
    );
    // The policy map keeps the raw declared slug, which is twiki's allowlist
    // key and is deliberately NOT folded. Asserting it here is what stops the
    // accessor's folding being "fixed" by re-keying that map instead.
    expect(c.policies.has("No42-Org/Legacy")).toBe(true);
    expect(c.policies.has("no42-org/legacy")).toBe(false);
  });

  it("answers main for a repository nobody declared", () => {
    // The same answer an undeclared allowlisted repository gets. This
    // accessor is not the place to discover a repository is unwatched.
    const c = config([{ repo: "no42-org/twiki", defaultBranch: "master" }]);
    expect(resolveDefaultBranch(c, { owner: "other-org", name: "thing" })).toBe(
      DEFAULT_POLICY.defaultBranch,
    );
    expect(DEFAULT_POLICY.defaultBranch).toBe("main");
  });

  it("keeps every declaration apart", () => {
    const c = config([
      { repo: "no42-org/twiki" },
      { repo: "no42-org/legacy", defaultBranch: "master" },
      { repo: "no42-org/odd", defaultBranch: "release/1.2" },
    ]);
    expect(c.repos.map((r) => resolveDefaultBranch(c, r))).toEqual([
      "main",
      "master",
      "release/1.2",
    ]);
  });
});

describe("isDefaultBranchRef", () => {
  it("accepts the branch name and its refs/heads/ form", () => {
    expect(isDefaultBranchRef("main", "main")).toBe(true);
    expect(isDefaultBranchRef("refs/heads/main", "main")).toBe(true);
    expect(isDefaultBranchRef("master", "master")).toBe(true);
    expect(isDefaultBranchRef("refs/heads/master", "master")).toBe(true);
  });

  it("accepts a branch name with slashes in it", () => {
    // The prefix is stripped once, not split on. Splitting on `/` would make
    // this branch `release`, which is not a branch at all.
    expect(isDefaultBranchRef("refs/heads/release/1.2", "release/1.2")).toBe(
      true,
    );
    expect(isDefaultBranchRef("release/1.2", "release/1.2")).toBe(true);
  });

  it("rejects every ref that is not that branch", () => {
    // A pull-request merge ref and a tag are not branches. Parsing a branch
    // name out of them would let a pull-request build count as a build of
    // main, which is the whole failure this function exists to prevent.
    expect(isDefaultBranchRef("refs/pull/7/merge", "main")).toBe(false);
    expect(isDefaultBranchRef("refs/tags/v1", "main")).toBe(false);
    // Git refs are case-sensitive: `Main` is a different branch.
    expect(isDefaultBranchRef("Main", "main")).toBe(false);
    expect(isDefaultBranchRef("refs/heads/Main", "main")).toBe(false);
    // A prefix match is not a match.
    expect(isDefaultBranchRef("refs/heads/mainline", "main")).toBe(false);
    expect(isDefaultBranchRef("mainline", "main")).toBe(false);
    expect(isDefaultBranchRef("main", "master")).toBe(false);
  });

  it("rejects a null ref rather than throwing on it", () => {
    // `head_branch` on a workflow run is nullable, and "GitHub named no
    // branch" is not "GitHub named this one".
    expect(isDefaultBranchRef(null, "main")).toBe(false);
  });
});

describe("isDefaultBranchRun", () => {
  // The question the callers actually ask. A branch NAME is not evidence
  // about whose branch it is: a pull request from a fork's own `main`
  // produces a run in THIS repository whose head_branch is `main` (#141),
  // and only the event says the run built a proposed merge rather than the
  // branch. One row per case, each naming why it lands where it does.
  const run = (event: string, headBranch: string | null) => ({
    event,
    headBranch,
  });

  describe.each<[string, string, string | null, boolean]>([
    ["a push to it", "push", "main", true],
    ["a scheduled run on it", "schedule", "main", true],
    ["a dispatched run on it", "workflow_dispatch", "main", true],
    // 218 of the 797 default-branch runs measured on this estate were
    // `dynamic`. An allowlist of the obvious triggers would drop them, and
    // a dropped default-branch build is a red main nobody sees.
    ["a dynamic run on it", "dynamic", "main", true],
    [
      "an event this code has never heard of",
      "some_future_event",
      "main",
      true,
    ],
    ["a push to another branch", "push", "feature", false],
    ["a pull request from a fork's own main", "pull_request", "main", false],
    ["a pull request targeted at it", "pull_request_target", "main", false],
    ["a pull request from a feature branch", "pull_request", "feature", false],
    ["a run GitHub named no branch for", "push", null, false],
  ])("%s", (_name, event, headBranch, expected) => {
    it(`is ${expected}`, () => {
      expect(isDefaultBranchRun(run(event, headBranch), "main")).toBe(expected);
    });
  });

  it("follows the declared branch, not the word main", () => {
    // The repository declares `master`, so a push to master is its build and
    // a push to main is not.
    expect(isDefaultBranchRun(run("push", "master"), "master")).toBe(true);
    expect(isDefaultBranchRun(run("push", "main"), "master")).toBe(false);
  });

  it("still strips the one ref prefix the branch half handles", () => {
    // Delegated rather than reimplemented: the run-level question adds the
    // event and leaves the string comparison where it already lives.
    expect(isDefaultBranchRun(run("push", "refs/heads/main"), "main")).toBe(
      true,
    );
    expect(isDefaultBranchRun(run("push", "refs/tags/v1"), "main")).toBe(false);
  });
});

describe("isPullRequestRun", () => {
  // The other half of the same decision about the same field, and NOT the
  // complement of the one above: `pull_request_target` is never a build of
  // the default branch and is not a pull request check either, so it stays a
  // branch row (#161). The ref is read by nothing here - the event decides.
  const run = (event: string) => ({ event, headBranch: "main" });

  describe.each<[string, boolean]>([
    ["pull_request", true],
    ["pull_request_target", false],
    ["push", false],
    ["schedule", false],
    ["dynamic", false],
    ["some_future_event", false],
  ])("%s", (event, expected) => {
    it(`is ${expected}`, () => {
      expect(isPullRequestRun(run(event))).toBe(expected);
    });
  });

  it("reads the event and not the branch", () => {
    // Both halves, because an implementation that also demanded a non-default
    // ref would pass a check on either one alone - and it is exactly the
    // fork's `main` that #141 was reported about.
    expect(
      isPullRequestRun({ event: "pull_request", headBranch: "main" }),
    ).toBe(true);
    expect(
      isPullRequestRun({ event: "pull_request", headBranch: "feature/x" }),
    ).toBe(true);
    expect(isPullRequestRun({ event: "push", headBranch: "feature/x" })).toBe(
      false,
    );
  });
});
