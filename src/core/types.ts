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
/**
 * What twiki concludes about a commit's CI.
 *
 * `green` means something ran and everything that ran passed - NOT merely that
 * nothing objected. `none` is the difference: a commit that reported nothing at
 * all is not green, not red and not pending, and saying so is the point.
 *
 * Three values could not express absence, so it landed on whichever neighbour
 * happened to catch it. It landed on `pending`, by accident of GitHub's
 * combined-status endpoint reporting `pending` for a commit with zero legacy
 * statuses - which made every Actions-only repository permanently unmergeable
 * (#87). Absence must be stated, not inherited (AD-28).
 */
export type CheckStatus = "green" | "red" | "pending" | "none";

/**
 * Whether a managed repository's default branch is defended.
 *
 * Three values for the same reason `CheckStatus` has four: a boolean forces
 * the unreadable case into one of the two answers and both are lies. twiki
 * cannot read legacy branch protection at all - `GET .../branches/main/
 * protection` returns 403 for every allowlisted repository, because that
 * endpoint needs `administration: read` and the App does not hold it - so
 * `false` would mean "undefended" about repositories that are defended, and
 * `true` would claim defence on no evidence.
 *
 * Both mistakes have live examples on this estate: `blitsbom` keeps its
 * required checks in legacy protection and would read as undefended, and
 * `blittermib` answers "Branch not protected" through the legacy endpoint
 * while carrying eleven required contexts through a ruleset.
 *
 * `undefended` is the only value worth reporting, and the only one that may
 * be stated positively. Absence must be stated, not inherited (AD-28).
 */
export type BranchProtection = "protected" | "undefended" | "unknown";

/**
 * What twiki could determine about a default branch's defences, and why.
 *
 * The `why` fields exist because "undefended" on its own sends the reader to
 * look at settings that may be present but inert. A ruleset named "main
 * protection" that enforces nothing reads as protection in every listing;
 * naming it is the difference between a report and a wild goose chase.
 */
export interface ProtectionFact {
  state: BranchProtection;
  /** Rule types in force on the branch, from the effective-rules endpoint. */
  rulesInForce: string[];
  /** Rulesets that target the branch but do not enforce, by name and mode. */
  inertRulesets: { name: string; enforcement: string }[];
  /** A source twiki was not permitted to read. Its own limitation, not the repo's. */
  unreadableSources: string[];
}

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
  /**
   * Whether `main` is defended. Gathered and REPORTED ONLY - no gate reads it.
   * Refusing to release from an undefended branch is a policy decision with a
   * deadlock attached, and this fact exists so that decision can be made with
   * evidence rather than in the abstract (D4).
   */
  protection: ProtectionFact;
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
