/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type {
  PullRequest,
  RepoFacts,
  RepoPolicy,
  WorkflowRunRef,
} from "../core/types.js";

// The deterministic safety gates. These are pure functions with no I/O and no
// dependency on the LLM. The executor re-validates them immediately before any
// action, so the LLM plan can only ever narrow what happens — never widen it.

/**
 * Which gate, if any, blocks a merge. `null` means the PR may be merged.
 *
 * `no-checks` is distinct from `ci-not-green` on purpose: one means a build
 * failed or is running, the other means nothing reported. Collapsing them
 * sends the reader hunting a failing build that does not exist.
 */
export type MergeBlock = "ci-not-green" | "no-checks" | "above-minor" | null;

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
  if (pr.checks === "none") return "no-checks";
  if (pr.checks !== "green") return "ci-not-green";
  if (!withinMergePolicy(pr, policy)) return "above-minor";
  return null;
}

export function canMerge(pr: PullRequest, policy: RepoPolicy): boolean {
  return mergeBlock(pr, policy) === null;
}

/**
 * The "settled" predicate (design agent-D5, docs/design/dependabot-release-agent.md). Release iff: no open Dependabot PR
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

// --- CI remediation gates (spec: ci-remediation). Pure, no I/O. The advisor is
// never consulted; the executor evaluates these against fresh per-tick facts,
// which IS the at-execution re-validation. ---

/** Conclusions that mean a run finished red and is worth re-running. */
export function isFailing(conclusion: string | null): boolean {
  return (
    conclusion === "failure" ||
    conclusion === "timed_out" ||
    conclusion === "cancelled"
  );
}

/**
 * A failed workflow run may be re-run only while it is completed-failing and
 * below the attempt ceiling. `runAttempt` is GitHub's 1-based counter, so the
 * bound is stateless: re-runs cannot accumulate past `maxAttempts` across ticks,
 * and an in-progress run (status !== "completed") is never re-triggered.
 */
export function canRerunCi(run: WorkflowRunRef, maxAttempts: number): boolean {
  return (
    run.status === "completed" &&
    isFailing(run.conclusion) &&
    run.runAttempt < maxAttempts
  );
}

/**
 * A Dependabot PR is rebase-eligible only when it is within merge policy, known
 * to be behind base (`behindBy > 0`), and NOT red on its own merits. The not-red
 * + within-policy guard makes the action self-terminating (a refreshed PR merges
 * out; a red-on-its-merits PR is never looped), and an unknown `behindBy`
 * (null/undefined) is fail-closed.
 */
export function canRebase(pr: PullRequest, policy: RepoPolicy): boolean {
  return (
    pr.isDependabot &&
    withinMergePolicy(pr, policy) &&
    pr.behindBy != null &&
    pr.behindBy > 0 &&
    // Explicit list rather than `!== "red"`, so a future status has to be
    // considered rather than silently included. `none` IS permitted here, and
    // that is the one place it differs from the merge gate.
    //
    // A rebase publishes nothing. It asks Dependabot to refresh its own pull
    // request, so the "never act without a positive signal" rule that governs
    // merging does not carry - and refusing here removes the only path out of
    // a real deadlock. A repository that adds its first workflow while older
    // Dependabot pull requests are open leaves those heads with no checks
    // forever: the merge gate blocks on `no-checks`, `canRerunCi` has no runs
    // to re-run, and without this a human has to intervene. Rebasing produces
    // a new head, which the workflow then runs against.
    (pr.checks === "green" || pr.checks === "pending" || pr.checks === "none")
  );
}
