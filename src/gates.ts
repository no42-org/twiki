/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { PullRequest, RepoFacts, RepoPolicy } from "./types.js";

// The deterministic safety gates. These are pure functions with no I/O and no
// dependency on the LLM. The executor re-validates them immediately before any
// action, so the LLM plan can only ever narrow what happens — never widen it.

/** Which gate, if any, blocks a merge. `null` means the PR may be merged. */
export type MergeBlock = "ci-not-green" | "above-minor" | null;

/** Patch always; minor only when policy allows; major/indeterminate never. */
export function withinMergePolicy(
  pr: PullRequest,
  policy: RepoPolicy,
): boolean {
  if (pr.bump.indeterminate) return false;
  switch (pr.bump.level) {
    case "patch":
      return true;
    case "minor":
      return policy.autoMergeMinor;
    case "major":
      return false;
  }
}

/** Re-validates every merge gate; returns the first blocking gate or null. */
export function mergeBlock(pr: PullRequest, policy: RepoPolicy): MergeBlock {
  if (pr.checks !== "green") return "ci-not-green";
  if (!withinMergePolicy(pr, policy)) return "above-minor";
  return null;
}

export function canMerge(pr: PullRequest, policy: RepoPolicy): boolean {
  return mergeBlock(pr, policy) === null;
}

/**
 * The "settled" predicate (design D5). Release iff: no open Dependabot PR
 * remains that policy would merge, AND main is green, AND there are
 * merged-but-unreleased dependency commits.
 *
 * A stuck *red* PR is not something we'd merge, so it does not block release.
 * Note: `mergeOnly` and a missing release workflow are handled by the executor
 * as separate, reportable conditions — they are intentionally not folded here.
 */
export function isSettled(facts: RepoFacts, policy: RepoPolicy): boolean {
  const noMergeablePrOpen = facts.prs.every((pr) => !canMerge(pr, policy));
  const mainGreen = facts.mainChecks === "green";
  const hasUnreleased = facts.unreleasedDependencyCommits > 0;
  return noMergeablePrOpen && mainGreen && hasUnreleased;
}
