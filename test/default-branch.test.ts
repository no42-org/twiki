/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { isDefaultBranchRef } from "../src/core/branch.js";
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
