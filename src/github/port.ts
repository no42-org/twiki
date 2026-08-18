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

/**
 * HTTP validators for a conditional request (AD-25). Structurally identical
 * to the store's Validator on purpose: the lane passes one straight through.
 */
export interface RequestValidator {
  etag: string | null;
  lastModified: string | null;
  /**
   * The installation-token generation the validator was captured under.
   * GitHub's ETags vary with the Authorization header (undocumented, which is
   * why the auth tests pin token reuse), so a validator from a previous token
   * is a guaranteed miss and is treated as cold rather than sent.
   */
  tokenGen: string;
}

/**
 * The validator-cache key for one organisation's alert listing (AD-25: keyed
 * by installation and request URL). One derivation, used by the lane to load
 * and save and by nothing else, so the two sides cannot drift.
 */
export function orgAlertsUrl(org: string): string {
  return `/orgs/${org.toLowerCase()}/dependabot/alerts?state=open&per_page=100`;
}

export interface OrgAlertPage {
  alerts: RawDependabotAlert[];
  /** Payloads the mapper could not read. Never silently discarded. */
  unreadable: number;
  /**
   * True when GitHub answered 304: the listing is byte-identical to the one
   * the cached validator was captured from. `alerts` is empty then, and the
   * caller confirms its stored rows instead of rewriting them.
   */
  notModified: boolean;
  /**
   * The validator to cache, or null when this response must not be
   * revalidated against: a listing that spanned pages has no single validator
   * (each page carries its own, and a 304 on page one says nothing about page
   * two), so only a listing that fit in one page is cacheable.
   */
  validator: RequestValidator | null;
}

/**
 * Reads only. A consumer that holds just this cannot mutate GitHub, and the
 * compiler enforces that: there is no write method on the type to call. A
 * read-only App installation enforces the same thing at runtime, and the two
 * fail independently.
 */
export interface GitHubReadPort {
  /** Every repository in the organisation, with the states the listing carries. */
  listOrgRepos(org: string): Promise<RawRepoMeta[]>;
  /** Is Dependabot actually watching this repository? One call. */
  probeDependabotAccess(repo: RepoRef): Promise<DependabotAccess>;

  /**
   * Open pull requests in the organisation authored by any of `authors`.
   *
   * The authors are search-qualifier logins from configuration (AD-19), passed
   * through verbatim: no bot login literal exists in source, and an empty list
   * is the caller's problem to refuse before it gets here.
   */
  listOpenUpdatePRs(
    org: string,
    authors: readonly string[],
  ): Promise<UpdatePrPage>;

  /**
   * Open issues in the given repositories that nobody has picked up.
   *
   * Search with explicit qualifiers, never @me: an installation token has no
   * user identity, and the whole-account issue endpoints are excluded from
   * installation tokens entirely. Scoped per repository, not `org:`, because
   * `org:` matches only organization accounts (a personal-account
   * installation would read as a confident zero) and an org-wide result set
   * spends the 1000-result search ceiling on unwatched repositories.
   */
  listUntriagedIssues(repos: readonly RepoRef[]): Promise<IssuePage>;

  /**
   * What dependabotUpdate reports per open alert of one repository.
   *
   * GraphQL-only: the REST alert payload carries no link to the update PR and
   * no error, and this is the only place "GitHub could not prepare the fix"
   * exists at all.
   */
  listDependabotUpdateStatuses(repo: RepoRef): Promise<RawUpdateStatus[]>;

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
   *
   * `cached` carries the validator from the previous sweep, or null for an
   * unconditional fetch (AD-25). A validator from a different token
   * generation is ignored, not sent.
   */
  listOrgDependabotAlerts(
    org: string,
    cached?: RequestValidator | null,
  ): Promise<OrgAlertPage>;
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

/** An open dependency-update pull request, as the search returned it. */
export interface RawUpdatePr {
  /** GraphQL node id: the PR's stable identity (AD-22). */
  nodeId: string;
  repo: RepoRef;
  number: number;
  title: string;
  /** The author login GitHub reports, e.g. `dependabot`. */
  author: string;
  htmlUrl: string;
  createdAt: string;
}

export interface UpdatePrPage {
  prs: RawUpdatePr[];
  /** Nodes the mapper could not read. Never silently discarded. */
  unreadable: number;
  /**
   * True when GitHub returned fewer results than the query matched.
   *
   * Search hard-caps at 1000 results and reports the truncation only through
   * `issueCount`: the last page still says hasNextPage false, so without this
   * flag a capped sweep looks complete and the tombstone pass concludes every
   * PR beyond the cap was closed.
   */
  truncated: boolean;
}

/** An open, unassigned issue, as the search returned it. */
export interface RawIssue {
  /** GraphQL node id: the issue's stable identity (AD-22). */
  nodeId: string;
  repo: RepoRef;
  number: number;
  title: string;
  author: string;
  htmlUrl: string;
  createdAt: string;
}

export interface IssuePage {
  issues: RawIssue[];
  /** Nodes the mapper could not read. Never silently discarded. */
  unreadable: number;
  /** True when GitHub returned fewer results than the query matched. */
  truncated: boolean;
}

/** What dependabotUpdate says about one alert's automated fix. */
export interface RawUpdateStatus {
  repo: RepoRef;
  alertNumber: number;
  /**
   * Null when GitHub is not attempting an automated fix for this alert at
   * all, which is a fact (n/a), not a gap: collapsing it into "no error"
   * would report an update nobody is preparing as prepared normally.
   */
  update: {
    /** The PR Dependabot opened for it, when one exists. */
    pullRequestNumber: number | null;
    /** Why GitHub could not prepare the update, when it could not. */
    error: string | null;
  } | null;
}

/** Repository metadata the coverage lane needs, one call per 100 repos. */
export interface RawRepoMeta {
  repo: RepoRef;
  archived: boolean;
  disabled: boolean;
}

/**
 * What a per-repository Dependabot probe told us.
 *
 * Measured 2026-08-17: `200` when the feature is on, with or without open
 * alerts; `403 "Dependabot alerts are disabled for this repository."` when it
 * is off; `403 "Resource not accessible by integration"` when the repository
 * is outside the installation. The two failures SHARE A STATUS CODE and differ
 * only in the message, so translation reads the message, and anything
 * unrecognised is `unknown` rather than a guess between them.
 */
export type DependabotAccess =
  | "covered"
  | "alerts_disabled"
  | "unreachable"
  | "unknown";
