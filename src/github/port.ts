/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type {
  CheckStatus,
  FailingCheck,
  RepoRef,
  WorkflowRunRef,
} from "../core/types.js";

// The GitHub port: the single seam between decision logic and the GitHub API.
// Decision logic depends only on these interfaces, so tests can substitute a
// fake. Every mutating method lives on GitHubWritePort, and only the executor
// ever calls one; a consumer typed to GitHubReadPort has none to call.

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

/**
 * One Dependabot alert as the org-level REST endpoint returns it.
 *
 * EPSS ships on this payload. It is not available from GraphQL, which is why
 * the org-level REST lane owns Dependabot alerts (AD-15). The value is a
 * point-in-time forecast, so it is written into the immutable observation at
 * ingest and never re-read for a historical item: re-scoring old alerts with
 * today's EPSS inflates the queue by between 2.3x and 53.2x (AD-18).
 */
export interface RawDependabotAlert {
  /** Per-repository, not global. Subject identity is repo + this (AD-22). */
  number: number;
  repo: RepoRef;
  state: "open" | "fixed" | "dismissed" | "auto_dismissed";
  /** low, moderate, high or critical (the GHSA scale); `unknown` when GitHub omitted it. */
  severity: string;
  ghsaId: string | null;
  cveId: string | null;
  packageName: string | null;
  ecosystem: string | null;
  /** Exploit Prediction Scoring System, 0..1, as captured now. */
  epssPercentage: number | null;
  epssPercentile: number | null;
  /** direct or transitive, when GitHub reports it. */
  relationship: string | null;
  /** runtime or development, when GitHub reports it. */
  scope: string | null;
  htmlUrl: string | null;
  /** Null when GitHub did not supply one; never an empty string. */
  createdAt: string | null;
}

export interface OrgAlertPage {
  alerts: RawDependabotAlert[];
  /** Payloads the mapper could not read. Never silently discarded. */
  unreadable: number;
}

/**
 * Reads only. A consumer that holds just this cannot mutate GitHub, and the
 * compiler enforces that: there is no write method on the type to call. A
 * read-only App installation enforces the same thing at runtime, and the two
 * fail independently.
 */
export interface GitHubReadPort {
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

  // Organisation-scoped reads. These collapse N repositories into one paginated
  // call, which is why the twelve org installations cost about 36 calls per
  // cycle while a personal account, having no org-level endpoint, does not
  // collapse at all (AD-15).

  /**
   * Open Dependabot alerts across every repository in the org, unfiltered.
   *
   * `unreadable` counts payloads that could not be mapped. A caller must not
   * treat an empty result as authoritative without checking it: silently
   * dropping every alert and reporting zero is the confident-zero failure this
   * design exists to avoid.
   */
  listOrgDependabotAlerts(org: string): Promise<OrgAlertPage>;
}

/** Mutating — executor only, enforce mode only. */
export interface GitHubWritePort {
  mergePR(repo: RepoRef, prNumber: number): Promise<void>;
  pushTag(repo: RepoRef, tag: string, sha: string): Promise<void>;
  /** Re-run only the failed jobs of a workflow run (bounded by run_attempt). */
  rerunFailedJobs(repo: RepoRef, runId: number): Promise<void>;
  /** Ask Dependabot to rebase a PR by posting `@dependabot rebase`. */
  requestDependabotRebase(repo: RepoRef, prNumber: number): Promise<void>;
}

/** What the write side needs: both halves. The adapter implements this. */
export interface GitHubPort extends GitHubReadPort, GitHubWritePort {}

// App-level reads: what this App is, and where it is installed. These are
// distinct from GitHubReadPort because they authenticate as the APP, not as an
// installation, and no installation token can make them.

export interface AppIdentity {
  slug: string | null;
  name: string | null;
  /**
   * Permission name to access level, exactly as GitHub reports it, or null
   * when the field was absent. Null is not an empty object: an empty object
   * reads as "this App holds no permissions", which a caller checking for
   * write access would treat as proof of safety.
   */
  permissions: Record<string, string> | null;
}

export interface InstallationRef {
  id: number;
  /** The org or user login, or an enterprise slug. Null when neither is present. */
  account: string | null;
  /** `all` or `selected`, as GitHub reports it. */
  repositorySelection: string;
}

export interface GitHubAppPort {
  identity(): Promise<AppIdentity>;
  listInstallations(): Promise<InstallationRef[]>;
  /** Every repository this installation can actually see. */
  listInstallationRepos(installationId: number): Promise<RepoRef[]>;
}
