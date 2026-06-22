/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type {
  CheckStatus,
  FailingCheck,
  RepoRef,
  WorkflowRunRef,
} from "../types.js";

// The GitHub port: the single seam between decision logic and the GitHub API.
// Decision logic depends only on this interface, so tests can substitute a
// fake. The only mutating methods are mergePR and pushTag — and only the
// executor ever calls them.

export interface RawPullRequest {
  number: number;
  title: string;
  branch: string;
  headSha: string;
  /** Untrusted: embeds third-party changelog text. */
  body: string;
  isSecurity: boolean;
  dependency?: { name?: string; from?: string; to?: string };
}

export interface GitHubPort {
  listOpenDependabotPRs(repo: RepoRef): Promise<RawPullRequest[]>;
  prChecks(repo: RepoRef, headSha: string): Promise<CheckStatus>;
  branchChecks(repo: RepoRef, branch: string): Promise<CheckStatus>;
  latestTag(repo: RepoRef): Promise<string | null>;
  /** Count of Dependabot-attributable commits since `tag` (or all, if null). */
  dependabotCommitsSince(repo: RepoRef, tag: string | null): Promise<number>;
  hasTagReleaseWorkflow(repo: RepoRef): Promise<boolean>;
  defaultBranchSha(repo: RepoRef): Promise<string>;

  // Remediation reads (read-only). `ref` is a SHA or branch name.
  failingChecks(repo: RepoRef, ref: string): Promise<FailingCheck[]>;
  workflowRunsForSha(repo: RepoRef, sha: string): Promise<WorkflowRunRef[]>;
  /** Commits `headSha` is behind `main`; `null` when GitHub can't tell (fail-closed). */
  behindBy(repo: RepoRef, headSha: string): Promise<number | null>;

  // Mutating — executor only, enforce mode only.
  mergePR(repo: RepoRef, prNumber: number): Promise<void>;
  pushTag(repo: RepoRef, tag: string, sha: string): Promise<void>;
  /** Re-run only the failed jobs of a workflow run (bounded by run_attempt). */
  rerunFailedJobs(repo: RepoRef, runId: number): Promise<void>;
  /** Ask Dependabot to rebase a PR by posting `@dependabot rebase`. */
  requestDependabotRebase(repo: RepoRef, prNumber: number): Promise<void>;
}
