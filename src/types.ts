/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// Shared domain types. These describe facts derived from GitHub and the
// per-repo policy that governs decisions. Kept free of any I/O so the
// decision logic that consumes them stays pure and testable.

export interface RepoRef {
  owner: string;
  name: string;
}

export function repoSlug(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

export function parseRepoSlug(slug: string): RepoRef {
  const [owner, name] = slug.split("/");
  if (!owner || !name) {
    throw new Error(`Invalid repo slug: "${slug}" (expected "owner/name")`);
  }
  return { owner, name };
}

/** Aggregate CI status for a ref or PR. */
export type CheckStatus = "green" | "red" | "pending";

/** A single failing check run, surfaced for diagnostics (read-only). */
export interface FailingCheck {
  name: string;
  conclusion: string | null;
  detailsUrl: string;
}

/**
 * A workflow run backing a check set, carrying the fields the re-run predicate
 * needs. `runAttempt` is GitHub's 1-based attempt counter (the bound that keeps
 * re-runs stateless); a run is only re-runnable once `status === "completed"`.
 */
export interface WorkflowRunRef {
  runId: number;
  runAttempt: number;
  status: string;
  conclusion: string | null;
}

export type BumpLevel = "patch" | "minor" | "major";

export interface Bump {
  level: BumpLevel;
  /** True when from/to could not be reliably parsed; treated as `major`. */
  indeterminate: boolean;
  name?: string;
  from?: string;
  to?: string;
}

export interface PullRequest {
  repo: RepoRef;
  number: number;
  title: string;
  branch: string;
  headSha: string;
  /** Whether GitHub flagged this as a security update. */
  isSecurity: boolean;
  /** Whether this PR is authored by Dependabot (rebase only applies to these). */
  isDependabot: boolean;
  bump: Bump;
  checks: CheckStatus;
  /** Untrusted: contains third-party changelog text. Treated as data only. */
  body: string;
  // --- Remediation facts (read-only; never feed mergeBlock/isSettled, and are
  // stripped from the advisor's input by toAdvisorFacts). ---
  /** Commits the head is behind its base; `null`/absent = unknown (fail-closed). */
  behindBy?: number | null;
  /** Failing check runs on the head, gathered only when checks are not green. */
  failingChecks?: FailingCheck[];
  /** Workflow runs backing the head's checks (for the re-run predicate). */
  workflowRuns?: WorkflowRunRef[];
}

export interface RepoFacts {
  repo: RepoRef;
  mainChecks: CheckStatus;
  latestTag: string | null;
  /** Whether the repo has a tag-triggered release workflow. */
  hasTagReleaseWorkflow: boolean;
  /** Count of Dependabot-attributable commits since the latest tag. */
  unreleasedDependencyCommits: number;
  prs: PullRequest[];
  // --- Remediation facts for `main` (read-only; advisor never sees these). ---
  /** Failing check runs on `main`, gathered only when main is not green. */
  mainFailingChecks?: FailingCheck[];
  /** Workflow runs backing `main`'s checks (for the re-run predicate). */
  mainWorkflowRuns?: WorkflowRunRef[];
}

export interface RepoPolicy {
  /** Auto-merge minor bumps (in addition to always-on patch). Default true. */
  autoMergeMinor: boolean;
  /** Never cut releases for this repo; merge only. Default false. */
  mergeOnly: boolean;
}

export const DEFAULT_POLICY: RepoPolicy = {
  autoMergeMinor: true,
  mergeOnly: false,
};

export type Mode = "shadow" | "enforce";
