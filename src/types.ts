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
  bump: Bump;
  checks: CheckStatus;
  /** Untrusted: contains third-party changelog text. Treated as data only. */
  body: string;
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
