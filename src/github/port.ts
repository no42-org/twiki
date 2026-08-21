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
 * by installation and request URL). A naming convention, not the literal
 * request: the adapter hard-codes the same parameters independently, so a
 * parameter change there leaves this key describing the old query. That
 * drift self-heals at runtime (the old ETag misses and the next sweep is a
 * 200), which is why the two are not forced together the way the KEV lane's
 * endpoint() is.
 */
export function orgAlertsUrl(org: string): string {
  return `/orgs/${org.toLowerCase()}/dependabot/alerts?state=open&per_page=100`;
}

export interface OrgAlertPage {
  alerts: RawDependabotAlert[];
  /** Payloads the mapper could not read. Never silently discarded. */
  unreadable: number;
  /**
   * Whole repositories that could not be read, on the per-repository path.
   *
   * Counted apart from `unreadable` because they are a different fact and
   * the operator-facing detail says which: folding three unreachable
   * repositories into "3 alert payloads could not be read" points the
   * reader at a mapper bug that does not exist. Zero on the org path,
   * which reads one listing or none.
   */
  unreachable: number;
  /**
   * True when GitHub answered 304: the listing is byte-identical to the one
   * the cached validator was captured from. `alerts` is empty then, and the
   * caller confirms its stored rows instead of rewriting them.
   */
  notModified: boolean;
  /**
   * True when pagination stopped at the safety cap with more pages claimed.
   * The result set is incomplete, exactly like the search lanes' ceiling: the
   * caller must degrade to partial and tombstone nothing.
   */
  truncated: boolean;
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
  /**
   * Every repository the account owns, with the states the listing carries.
   * Organisations and user accounts have different endpoints for this, and
   * the org one 404s on a user account.
   */
  listOrgRepos(org: string): Promise<RawRepoMeta[]>;
  /** Is Dependabot actually watching this repository? One call. */
  probeDependabotAccess(repo: RepoRef): Promise<DependabotAccess>;

  /**
   * Open pull requests in the given repositories authored by any of
   * `authors`.
   *
   * The authors are search-qualifier logins from configuration (AD-19), passed
   * through verbatim: no bot login literal exists in source, and an empty list
   * is the caller's problem to refuse before it gets here.
   *
   * Scoped per repository, not `org:`, for the same reason as the issue
   * search. MEASURED 2026-08-19, not assumed: `org:<user>` and `user:<user>` return
   * the SAME 37 results on a personal account, so the org-scoped search was
   * never the confident zero an earlier comment here claimed. What the
   * repo-scoped search actually buys is spending the 1000-result ceiling
   * only on watched repositories: the same live account returned 37 PRs
   * org-wide against 3 in the allowlist, so 34 results of ceiling went to
   * repositories nobody is watching.
   */
  listOpenUpdatePRs(
    repos: readonly RepoRef[],
    authors: readonly string[],
  ): Promise<UpdatePrPage>;

  /**
   * Open issues in the given repositories that nobody has picked up.
   *
   * Search with explicit qualifiers, never @me: an installation token has no
   * user identity, and the whole-account issue endpoints are excluded from
   * installation tokens entirely. Scoped per repository, not `org:`:
   * MEASURED 2026-08-19, not assumed: `org:<user>` and `user:<user>` return
   * the SAME 37 results on a personal account, so the org-scoped search was
   * never the confident zero an earlier comment here claimed. What the
   * repo-scoped search actually buys is spending the 1000-result ceiling
   * only on watched repositories: the same live account returned 37 PRs
   * org-wide against 3 in the allowlist, so 34 results of ceiling went to
   * repositories nobody is watching.
   */
  listUntriagedIssues(repos: readonly RepoRef[]): Promise<IssuePage>;

  /**
   * Open pull requests awaiting review from any of `reviewers` (CAP-5).
   *
   * Deliberately NOT scoped to the allowlist, unlike every other search
   * here. A review request is a claim on the maintainer's attention
   * wherever it lands, and measured on this estate 38 of 40 were in
   * repositories nobody watches; scoping would have made the capability
   * almost empty. What that costs is coverage: these repositories have no
   * freshness or coverage discipline behind them, so they are kept in
   * their own subject type and rendered apart from the watched estate,
   * never mixed into the ranked queue.
   *
   * `viaInstallation` only chooses which installation token authenticates
   * the call. The search itself is global: measured 2026-08-21, all three
   * installations returned the identical 40 results, including
   * repositories the App is not installed on.
   */
  listReviewRequests(
    viaInstallation: string,
    reviewers: readonly string[],
  ): Promise<ReviewRequestPage>;

  /**
   * What dependabotUpdate reports per open alert of one repository.
   *
   * GraphQL-only: the REST alert payload carries no link to the update PR and
   * no error, and this is the only place "GitHub could not prepare the fix"
   * exists at all.
   */
  listDependabotUpdateStatuses(repo: RepoRef): Promise<RawUpdateStatus[]>;

  /**
   * The newest page of workflow runs for one repository (CAP: build
   * failures). Page one only, newest first, by design: this is the lane the
   * spine prices at a hard per-repo floor, so it takes one call per
   * repository and lets conditional requests (AD-25) make quiet
   * repositories free. No org-level variant of this endpoint exists.
   */
  listRepoWorkflowRuns(
    repo: RepoRef,
    cached?: RequestValidator | null,
  ): Promise<WorkflowRunPage>;

  /**
   * The core budget, from GET /rate_limit: the one honest source (AD-24).
   * Free: the endpoint does not count against the limit it reports.
   */
  rateLimit(org: string): Promise<{ limit: number; remaining: number }>;

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
  /**
   * `repos` is the watched set for this installation, used only when the
   * account has no org-level endpoint to collapse into: a user account
   * costs one call per repository, an organisation still costs one call.
   */
  listDependabotAlerts(
    installation: string,
    repos: readonly RepoRef[],
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

/**
 * What kind of account an installation is on.
 *
 * Load-bearing, not descriptive: a GitHub App on a USER account has no
 * org-level endpoints at all. `/orgs/{login}/dependabot/alerts` and
 * `/orgs/{login}/repos` both answer 404 there, so the lanes that collapse an
 * organisation into one call must fan out per repository instead. Measured
 * 2026-08-21: the installation payload carries this, so nothing has to be
 * probed or guessed.
 */
export type AccountKind = "user" | "organization" | "unknown";

export interface InstallationRef {
  id: number;
  /** The org or user login, or an enterprise slug. Null when neither is present. */
  account: string | null;
  /** `all` or `selected`, as GitHub reports it. */
  repositorySelection: string;
  /** Unknown when GitHub reported something this build does not recognise. */
  accountKind: AccountKind;
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
   * Repositories that could not be searched at all, because their own
   * `repo:` qualifier does not fit alongside the query base (a long slug
   * against a base grown by many configured bot logins). Counted so the
   * sweep is incomplete rather than quietly missing a repository.
   */
  unsearchable: number;
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

/** An open pull request awaiting review from a configured login (CAP-5). */
export interface RawReviewRequest {
  /** GraphQL node id: the PR's stable identity (AD-22). */
  nodeId: string;
  repo: RepoRef;
  number: number;
  title: string;
  author: string;
  htmlUrl: string;
  createdAt: string;
  /**
   * Everyone currently asked to review, logins and team slugs alike.
   *
   * Kept because "waiting on you" reads differently when four other people
   * were asked too, and the node carries it for free.
   */
  requestedReviewers: string[];
}

export interface ReviewRequestPage {
  requests: RawReviewRequest[];
  /** Nodes the mapper could not read. Never silently discarded. */
  unreadable: number;
  /** True when GitHub returned fewer results than the query matched. */
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
  /**
   * Repositories that could not be searched at all, because their own
   * `repo:` qualifier does not fit alongside the query base (a long slug
   * against a base grown by many configured bot logins). Counted so the
   * sweep is incomplete rather than quietly missing a repository.
   */
  unsearchable: number;
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

/** One workflow run, as the per-repo REST listing returns it. */
export interface RawWorkflowRun {
  /** GraphQL node id: the run's stable identity (AD-22). */
  nodeId: string;
  repo: RepoRef;
  workflowId: number;
  /** The workflow's display name, e.g. `CI`. */
  workflowName: string;
  runNumber: number;
  /** queued, in_progress or completed, as GitHub reports it. */
  status: string;
  /** success, failure, cancelled... or null while the run is not completed. */
  conclusion: string | null;
  /**
   * Kept so a consumer can weigh a feature-branch failure differently from a
   * main failure. The run payload's own repository object has NO
   * default_branch key at all - the original measurement read it through
   * jq, which prints null for an absent key and a null one alike, and the
   * comment it produced claimed a null the payload never sends. Either way
   * the lane cannot filter by it, and test/adapter-contract.test.ts now
   * asserts the absence rather than the null.
   */
  headBranch: string | null;
  /** push, schedule, pull_request, workflow_dispatch, dynamic... */
  event: string;
  htmlUrl: string;
  createdAt: string;
}

export interface WorkflowRunPage {
  runs: RawWorkflowRun[];
  /** Payloads the mapper could not read. Never silently discarded. */
  unreadable: number;
  /** True when GitHub answered 304: nothing changed since the validator. */
  notModified: boolean;
  /** The validator to cache, or null when the response is not revalidatable. */
  validator: RequestValidator | null;
}

/**
 * The validator-cache key for one repository's run listing (AD-25). Same
 * convention as orgAlertsUrl: a naming convention the adapter's hard-coded
 * parameters match; drift self-heals via an ETag miss.
 */
export function workflowRunsUrl(repo: RepoRef): string {
  return `/repos/${repo.owner.toLowerCase()}/${repo.name.toLowerCase()}/actions/runs?per_page=100`;
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
