/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type {
  CheckStatus,
  FailingCheck,
  ProtectionFact,
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
 * The validator-cache key for one organisation's code scanning listing (#156).
 *
 * Same convention as orgAlertsUrl, and separate from it because it is a
 * separate listing: one cache entry per installation and request URL (AD-25).
 */
export function orgCodeScanningUrl(org: string): string {
  return `/orgs/${org.toLowerCase()}/code-scanning/alerts?state=open&per_page=100`;
}

/**
 * One code scanning alert as the REST listing returns it (#156).
 *
 * Deliberately NOT a copy of RawDependabotAlert. Two fields cannot be copied,
 * and both are the reason this is its own type:
 *
 *   `state`     GitHub's schema permits null here, where a Dependabot alert's
 *               is always one of four words. Unobserved across the 73 open
 *               alerts measured on 2026-09-09 and still typed, because a shape
 *               the mapper refuses to represent is a row it silently drops.
 *   `severity`  comes from `rule.security_severity_level`, which is ABSENT on
 *               some alerts rather than null: the three zizmor findings in
 *               this estate carry no such key at all, so a mapper handling
 *               only null reads `undefined` and ranks it as a graded value.
 */
export interface RawCodeScanningAlert {
  /** Per-repository, not global. Subject identity is repo + this (AD-22). */
  number: number;
  repo: RepoRef;
  /**
   * `open`, `fixed` or `dismissed` as GitHub reported it, or null: the schema
   * permits it and this estate has never produced one. Informational, like
   * the Dependabot alert's: the projection's own state carries the tombstone,
   * and the lane asks only for open alerts.
   */
  state: string | null;
  /**
   * `rule.security_severity_level`, or `n/a` when GitHub sent no such level.
   *
   * The sentinel rather than null, because the ranking chain reads the two
   * differently and the difference is the whole of this story's severity
   * handling: `n/a` says this tool grades nothing, which ranks at the
   * least-urgent end, where null would rank as a signal we failed to collect.
   * No severity level GitHub sends is spelled `n/a`, so it cannot shadow one.
   *
   * NEVER `rule.severity`. That carries the linting scale (`error`,
   * `warning`, `note`), on which a Scorecard `error` outranks this estate's
   * one Trivy `critical`.
   */
  securitySeverity: string;
  /** `rule.id`: `CVE-2026-31789` from Trivy, `zizmor/...` from zizmor. */
  ruleId: string | null;
  /** The scanner that found it: Trivy, CodeQL, Scorecard, zizmor. */
  tool: string | null;
  /**
   * `most_recent_instance.ref`, e.g. `refs/heads/main`, `refs/pull/7/merge`.
   *
   * The queue's default-branch condition reads this and nothing else. NOT
   * `most_recent_instance.state`: one alert on this estate holds two
   * instances on the same ref from two analysis categories, one open and one
   * fixed, and `most_recent_instance` returned a different one from two reads
   * minutes apart. Gating on it would add and remove the item on alternating
   * sweeps for no change on GitHub; the alert's own `state` is the authority.
   */
  ref: string | null;
  htmlUrl: string | null;
  /** Null when GitHub did not supply one; never an empty string. */
  createdAt: string | null;
}

/**
 * One repository a sweep could not speak for, and why.
 *
 * The reason has two legitimate sources and no third. Where GitHub answered,
 * it is GitHub's own message, redacted and bounded. Where the failure is
 * ours and its cause is knowable - a `repo:` qualifier that cannot fit a
 * query, say - it is the sentence the port wrote for that one cause. It is
 * null only where neither exists.
 *
 * What it must never be is a guess: a lane never invents a reason and never
 * rewrites the one it was handed. Carried rather than dropped because this
 * is exactly the boundary read the house rule is about: an error that names
 * neither the repository nor the answer sends an operator nowhere.
 */
export interface UnlistedRepo {
  repo: RepoRef;
  reason: string | null;
}

/**
 * One sweep of the code scanning listing. Mirrors OrgAlertPage term for term,
 * with the two it needs and the Dependabot page does not.
 */
export interface CodeScanningAlertPage {
  alerts: RawCodeScanningAlert[];
  /** Payloads the mapper could not read. Never silently discarded. */
  unreadable: number;
  /**
   * Repositories the fan-out reached NO ANSWER about: a transport failure, a
   * 5xx, a token that could not be minted. The sweep is incomplete, so the
   * caller degrades and tombstones nothing.
   *
   * Named rather than counted, like `skipped`. This is a boundary read, and
   * a bare integer cannot say which repository failed or what came back from
   * it - the two questions an operator asks first.
   */
  unreachable: UnlistedRepo[];
  /**
   * Repositories the fan-out asked and GitHub ANSWERED without a listing:
   * `404 no analysis found`, `403 Resource not accessible by integration`, or
   * any other refusal it sends steadily. Not a failure: the answer is stable,
   * so retrying it every sweep returns the same words, and degrading on it
   * would hold the lane partial for as long as the repository exists.
   *
   * A LIST rather than a count, because the lane does more with it than
   * report it: a repository here gets no rows and no confirmation, so it
   * reads `unconfirmed` rather than a confident zero (AD-28), and the run
   * detail names it and quotes what GitHub said. A count could say neither.
   */
  skipped: UnlistedRepo[];
  /** True when GitHub answered 304 against the cached validator. */
  notModified: boolean;
  /** True when pagination stopped at the safety cap with more pages claimed. */
  truncated: boolean;
  /** The validator to cache, or null when this response must not be revalidated against. */
  validator: RequestValidator | null;
}

/**
 * The validator-cache key for one organisation's secret scanning listing
 * (#158).
 *
 * Same convention as orgCodeScanningUrl, and separate from it for the same
 * reason: one cache entry per installation and request URL (AD-25). Sharing a
 * key would have one listing's 304 confirm the other's rows.
 */
export function orgSecretScanningUrl(org: string): string {
  return `/orgs/${org.toLowerCase()}/secret-scanning/alerts?state=open&per_page=100`;
}

/**
 * One secret scanning alert as the REST listing returns it (#158).
 *
 * THE CREDENTIAL HAS NO FIELD HERE, and its absence is the whole design.
 * GitHub sends `secret` on both listings; `src/core/redact.ts` matches GitHub
 * tokens and JWTs only, so an AWS key, a Slack token or a private key would
 * pass through redaction untouched. A field that is never mapped cannot be
 * stored by a later edit that forgets to redact it, which is the same reason
 * RawCodeScanningAlert omits `rule.severity`.
 *
 * Built from `@octokit/openapi-types`, where EVERY field of both the
 * `secret-scanning-alert` and `organization-secret-scanning-alert` components
 * is optional - `number` and `state` included - so the mapper handles absence
 * everywhere rather than on the two fields a page happens to read.
 */
export interface RawSecretScanningAlert {
  /** Per-repository, not global. Subject identity is repo + this (AD-22). */
  number: number;
  repo: RepoRef;
  /**
   * `open` or `resolved` as GitHub reported it, or null where it said
   * nothing. Informational, like the two sibling alert types': the
   * projection's own state carries the tombstone, and the lane asks only for
   * open alerts.
   */
  state: string | null;
  /**
   * `secret_type_display_name`, the ONLY name of the finding that may reach a
   * page: `Amazon AWS Access Key ID` rather than the key itself.
   *
   * Null where GitHub sent none. Never `secret_type`, which is the machine
   * slug, and never `secret`, which is the credential.
   */
  secretType: string | null;
  /**
   * The token status at GitHub's latest validity check: `active`, `inactive`
   * or `unknown`.
   *
   * Always a word, never absent. The schema makes the field optional AND
   * gives it its own literal `"unknown"`, so GitHub can express the same
   * fact two ways; both mean "nobody checked, or the check said nothing" to a
   * reader, and both must store the same value or one repository's finding
   * would read differently from its identical neighbour's. A plain string
   * rather than the union, so a status GitHub adds tomorrow is carried
   * through rather than dropped.
   */
  validity: string;
  /**
   * GitHub REPORTED the secret as publicly leaked.
   *
   * `publicly_leaked` is `boolean | null` and optional, which is four states,
   * and only `true` is a report of a public leak. The other three are folded
   * to false here rather than carried as a tri-state, because nothing ranks
   * or branches on the difference and a page must never claim a public leak
   * that was not reported.
   */
  publiclyLeaked: boolean;
  htmlUrl: string | null;
  /** Null when GitHub did not supply one; never an empty string. */
  createdAt: string | null;
}

/**
 * One sweep of the secret scanning listing.
 *
 * Term for term the code scanning page, because the two lanes answer the same
 * shapes: an org listing that collapses into one call, a per-repository
 * fan-out on a user account, and repositories GitHub answers without a
 * listing to give.
 */
export interface SecretScanningAlertPage {
  alerts: RawSecretScanningAlert[];
  /** Payloads the mapper could not read. Never silently discarded. */
  unreadable: number;
  /**
   * Repositories the fan-out reached NO ANSWER about: a transport failure, a
   * 5xx, a token that could not be minted. The sweep is incomplete, so the
   * caller degrades and tombstones nothing.
   */
  unreachable: UnlistedRepo[];
  /**
   * Repositories the fan-out asked and GitHub ANSWERED without a listing.
   * `404 "Secret scanning is disabled on this repository."` is the measured
   * one, live on `CoolModFiles` on 2026-09-09. Not a failure: the answer is
   * stable, so degrading on it would hold the lane partial for as long as
   * that repository exists.
   *
   * A repository here gets no rows and no confirmation, so it reads
   * `unconfirmed` rather than a confident zero (AD-28).
   */
  skipped: UnlistedRepo[];
  /** True when GitHub answered 304 against the cached validator. */
  notModified: boolean;
  /** True when pagination stopped at the safety cap with more pages claimed. */
  truncated: boolean;
  /** The validator to cache, or null when this response must not be revalidated against. */
  validator: RequestValidator | null;
}

/**
 * Reads only, of one named repository.
 *
 * Every method here names the repository it acts on, so its installation
 * resolves from that repository via `GET /repos/{owner}/{repo}/installation`.
 * That endpoint answers for a user account exactly as it does for an
 * organisation: measured 2026-08-22 against `indigo423`, it resolved to
 * installation 154359759. So this half of the surface works on any account
 * type, and a factory needs nothing but a per-repository resolver to honour
 * every method on it.
 *
 * A consumer holding only this cannot mutate GitHub, and the compiler
 * enforces that: there is no write method on the type to call. A read-only
 * App installation enforces the same thing at runtime, and the two fail
 * independently.
 */
export interface GitHubRepoReadPort {
  /** Is Dependabot actually watching this repository? One call. */
  probeDependabotAccess(repo: RepoRef): Promise<DependabotAccess>;

  /**
   * Has code scanning analysed this repository? One call.
   *
   * Not "is it enabled": that is the question GitHub declines to answer to a
   * read-only App. `security_and_analysis` on the repository payload names
   * every feature's state and would settle this with no extra call, but
   * GitHub sends that block only to callers with admin rights. Verified
   * absent, live on 2026-09-09, from both the organisation listing and the
   * single-repository read. The recorded fixture carries a populated block
   * because it was captured with an admin token, so an implementation
   * reading it passes every test here and sees nothing in production.
   */
  probeCodeScanning(repo: RepoRef): Promise<FeatureProbe>;

  /** Is secret scanning switched on for this repository? One call. */
  probeSecretScanning(repo: RepoRef): Promise<FeatureProbe>;

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

  listOpenDependabotPRs(repo: RepoRef): Promise<RawPullRequest[]>;
  prChecks(repo: RepoRef, headSha: string): Promise<CheckStatus>;
  branchChecks(repo: RepoRef, branch: string): Promise<CheckStatus>;
  /**
   * The newest stable semver tag among the repository's tag refs, prefix
   * preserved, or null when no tag parses. Release objects are not consulted:
   * a tag with a draft release or no release still counts. Prerelease tags
   * are skipped. Throws when the tag listing is truncated, because a partial
   * maximum could re-derive a tag that already exists.
   */
  latestTag(repo: RepoRef): Promise<string | null>;
  /** Count of Dependabot-attributable commits since `tag` (or all, if null). */
  dependabotCommitsSince(repo: RepoRef, tag: string | null): Promise<number>;
  hasTagReleaseWorkflow(repo: RepoRef): Promise<boolean>;
  /** Whether the default branch is defended, and what could not be read. */
  branchProtection(repo: RepoRef, branch: string): Promise<ProtectionFact>;
  defaultBranchSha(repo: RepoRef): Promise<string>;
  /**
   * What is at one path at one ref: its text, or WHICH of the several
   * different reasons there is no text to read.
   *
   * `ref` is a sha, branch or tag. The release check passes the sha it is
   * about to tag, so what it reads is the tree that gets tagged and not
   * whatever the branch has moved on to.
   *
   * One `null` for all of them was the first shape and it was wrong: the
   * caller then said "not in the tree" about a path holding a directory, a
   * symlink, a submodule or a file too big to inline, sending an operator to
   * look for a file that is right there. Each answer says only what was
   * established.
   *
   * None of them is a failure. A 403, a 502 or anything else THROWS, because
   * "we could not read it" and "it is not there" send a reader to different
   * places, and only one of them is the repository's business.
   */
  readFileAtRef(repo: RepoRef, path: string, ref: string): Promise<FileAtRef>;

  // Remediation reads (read-only). `ref` is a SHA or branch name.
  failingChecks(repo: RepoRef, ref: string): Promise<FailingCheck[]>;
  workflowRunsForSha(repo: RepoRef, sha: string): Promise<WorkflowRunRef[]>;
  /** Commits `headSha` is behind `main`; `null` when GitHub can't tell (fail-closed). */
  behindBy(repo: RepoRef, headSha: string): Promise<number | null>;
}

/**
 * Reads only, of a whole account.
 *
 * Separate from the repo-scoped half because a per-repository resolver
 * cannot honour any of them: each names an account rather than a
 * repository. Honouring them means resolving an installation by account AND
 * knowing what kind of account it is, which is what
 * `createTricorderReadPort` does from the installation listing and what
 * `createGitHubFromEnv` deliberately does not.
 *
 * The account kind is load-bearing, not descriptive. Measured 2026-08-22
 * against `indigo423`: `GET /orgs/{login}/installation` and
 * `GET /orgs/{login}/repos` both answer 404, because a GitHub App on a user
 * account has no org-level endpoint. The adapter routes around that rather
 * than failing on it - `listOrgRepos` falls back to the installation's own
 * listing, `listDependabotAlerts` fans out per repository, and `rateLimit`
 * was never org-scoped at all (its argument only picks the token). So all
 * six ARE honourable on a user account, given a per-account resolver. What
 * cannot be honoured there is the org-level ENDPOINT, not the method.
 *
 * The split is a boundary rather than a taxonomy. A port that advertised
 * these without the wiring behind them failed at the call site with an
 * upstream 404 naming an orgs endpoint the caller never asked for: honest
 * status code, wrong story. Keeping them off `GitHubPort` makes that a
 * compile error instead.
 *
 * Three of the six are account-scoped only in how they obtain a token.
 * `listOpenUpdatePRs`, `listUntriagedIssues` and `listReviewRequests` search
 * per repository, and those searches work on a user account: measured
 * 2026-08-19, `org:X` and `user:X` return the same 37 results.
 */
export interface GitHubAccountReadPort {
  /**
   * Every repository the account owns, with the states the listing carries.
   * Organisations and user accounts have different endpoints for this, and
   * the org one 404s on a user account.
   */
  listOrgRepos(org: string): Promise<RawRepoMeta[]>;

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
   * Open pull requests in the given repositories that none of `excludeAuthors`
   * opened (#167).
   *
   * The authors are the same configured logins `listOpenUpdatePRs` requires,
   * passed through verbatim and negated with `-author:` (AD-19). Server-side,
   * not client-side, and the difference is not cosmetic: measured on this
   * estate 2026-09-10, all 19 open pull requests across the three watched
   * repositories are `dependabot[bot]`, so a search that asked for every open
   * pull request and discarded the bots afterwards would spend the
   * 1000-result ceiling on the rows it throws away, and a repository with a
   * long dependency backlog would truncate before one human pull request was
   * seen. The negation costs query length: `is:pr is:open` is 13 characters
   * and grows to 57 with two configured bots, which is 7 repositories per
   * query instead of 9 - more queries, and no new unsearchable repositories
   * for slugs of ordinary length.
   *
   * An EMPTY `excludeAuthors` is legitimate here, unlike on the update-PR
   * search: with no actor configured as a bot, every open pull request is a
   * human one and the base is simply unnegated.
   *
   * Scoped per repository for the reason the two searches beside it are:
   * the 1000-result ceiling is spent only on repositories somebody watches.
   */
  listOpenPullRequests(
    repos: readonly RepoRef[],
    excludeAuthors: readonly string[],
  ): Promise<PullRequestPage>;

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
   * The core budget, from GET /rate_limit: the one honest source (AD-24).
   * Free: the endpoint does not count against the limit it reports.
   */
  rateLimit(org: string): Promise<{ limit: number; remaining: number }>;

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

  /**
   * Open code scanning alerts across every repository in the org, unfiltered
   * and regardless of ref (#156).
   *
   * Every open alert is returned whatever branch its most recent instance is
   * on. The default-branch condition belongs to the queue builder, so the
   * repository page can list what the queue declines to rank.
   *
   * `repos` is the watched set for this installation, used only when the
   * account has no org-level endpoint to collapse into, exactly as on the
   * Dependabot listing: a user account costs one call per watched repository,
   * an organisation still costs one.
   */
  listCodeScanningAlerts(
    installation: string,
    repos: readonly RepoRef[],
    cached?: RequestValidator | null,
  ): Promise<CodeScanningAlertPage>;

  /**
   * Open secret scanning alerts across every repository in the org (#158).
   *
   * Needs no new App permission: `secret_scanning_alerts` is already held and
   * already required by `doctor`, because the coverage lane's probe reads
   * this same endpoint one alert at a time.
   *
   * `repos` is the watched set for this installation, used only when the
   * account has no org-level endpoint to collapse into, exactly as on the two
   * listings beside it.
   */
  listSecretScanningAlerts(
    installation: string,
    repos: readonly RepoRef[],
    cached?: RequestValidator | null,
  ): Promise<SecretScanningAlertPage>;
}

/** Every read, both halves. What gitricorder's collector consumes. */
export interface GitHubReadPort
  extends GitHubRepoReadPort,
    GitHubAccountReadPort {}

/** Mutating — executor only, enforce mode only. */
export interface GitHubWritePort {
  mergePR(repo: RepoRef, prNumber: number): Promise<void>;
  /**
   * Create the tag ref. Rejects with `TagExistsError` when GitHub answers
   * 422 "Reference already exists": with `latestTag` reading the ref store,
   * that only happens when someone tagged between the re-check and the push.
   */
  pushTag(repo: RepoRef, tag: string, sha: string): Promise<void>;
  /**
   * What GitHub holds for an existing tag, so a collision can say whether a
   * human is mid-release (published or draft) or a stray tag needs attention
   * (none). Read-only; twiki never publishes or deletes a release.
   */
  releaseStateForTag(repo: RepoRef, tag: string): Promise<ReleaseState>;
  /** Re-run only the failed jobs of a workflow run (bounded by run_attempt). */
  rerunFailedJobs(repo: RepoRef, runId: number): Promise<void>;
  /** Ask Dependabot to rebase a PR by posting `@dependabot rebase`. */
  requestDependabotRebase(repo: RepoRef, prNumber: number): Promise<void>;
}

/**
 * What the write side needs: the repo-scoped reads plus the writes.
 *
 * Deliberately not every read. twiki acts on the repositories its allowlist
 * names and never enumerates an account, so extending the account-scoped
 * half would advertise six methods `createGitHubFromEnv` cannot honour. It
 * did, until this split: that factory resolved installations with
 * `getOrgInstallation`, which 404s on a user account, and nothing in the
 * type said so.
 */
/** What GitHub holds for a tag: a published release, a draft, or nothing. */
/** What `readFileAtRef` found at a path, or why there was no text there. */
export type FileAtRef =
  | { kind: "text"; text: string }
  /** Nothing at that path at that ref: GitHub answered 404. */
  | { kind: "absent" }
  /**
   * Something is there and it is not a file with text in it. `type` is
   * GitHub's own word for it - `dir`, `symlink`, `submodule` - so the caller
   * repeats what GitHub said rather than guessing which one it was.
   */
  | { kind: "not-a-file"; type: string }
  /**
   * A file GitHub would not inline. The contents endpoint answers a file over
   * its size limit with empty content and `encoding: "none"`, which decodes
   * to an empty string - indistinguishable, without this, from a file that
   * really is empty, and reported as the operator's pattern finding nothing.
   */
  | { kind: "too-large"; bytes: number; limitBytes: number; encoding: string };

export type ReleaseState = "published" | "draft" | "none";

/**
 * The tag ref already existed when twiki tried to create it. Not a failure
 * of the write side: the repository continues, and the outcome is reported
 * as `tag-exists` with the release state of the tag that got there first.
 */
export class TagExistsError extends Error {
  readonly tag: string;
  constructor(tag: string) {
    super(`tag ${tag} already exists`);
    this.name = "TagExistsError";
    this.tag = tag;
  }
}

export interface GitHubPort extends GitHubRepoReadPort, GitHubWritePort {}

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

/**
 * A repository an installation can see, as the listing already reports it.
 *
 * `RepoRef` plus the branch GitHub calls default. Widening the existing
 * listing rather than adding a method is deliberate: `doctor` compares the
 * declared default branch against GitHub without making a second call, and
 * this port must keep exposing exactly the three reads it exposes, which is
 * what proves the read-only App cannot write (AD-21).
 *
 * `RepoRef` itself stays a bare key, because it is used everywhere as one.
 */
export interface InstallationRepo extends RepoRef {
  /** What GitHub reports as the repository's default branch. */
  defaultBranch: string;
}

export interface GitHubAppPort {
  identity(): Promise<AppIdentity>;
  listInstallations(): Promise<InstallationRef[]>;
  /** Every repository this installation can actually see. */
  listInstallationRepos(installationId: number): Promise<InstallationRepo[]>;
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
   * `repo:` qualifier does not fit alongside the query base: a long slug
   * against a base that grows with every configured bot login. Reachable in
   * production, unlike the issue page's identical field.
   *
   * Named rather than counted, like `unreachable` on the REST pages. A
   * count says the sweep is incomplete and nothing else: the operator
   * cannot see which repository to rename or shorten, and a caller that
   * withholds a confirmation per repository cannot tell which one to
   * withhold. There is one and only one way in, so the reason is knowable
   * rather than invented.
   */
  unsearchable: UnlistedRepo[];
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

/**
 * An open pull request that is not a dependency update, as the search
 * returned it (#167).
 *
 * The same node shape as `RawUpdatePr` plus the one field the stuck term
 * needs. Kept as its own interface rather than an alias, because the two
 * lanes disagree about what they are looking at: one collects the pull
 * requests a configured actor opened, the other every pull request no
 * configured actor opened, and a shared name would invite one lane's guard
 * to be reused on the other's rows.
 */
export interface RawOpenPullRequest {
  /** GraphQL node id: the PR's stable identity (AD-22). */
  nodeId: string;
  repo: RepoRef;
  number: number;
  title: string;
  /** The author login GitHub reports, e.g. `a-contributor`. */
  author: string;
  htmlUrl: string;
  createdAt: string;
  /**
   * `headRefName`: the branch the pull request is from, or null where the
   * node did not carry one.
   *
   * The one field beyond the shared node shape, and it is here for exactly
   * one reader: the queue's `stuck` term looks up the retained
   * `pull_request_workflow_run` row for this ref (#161). Nullable because
   * this is a boundary read - the schema says non-null, and a payload that
   * disagrees must leave the term reading `checks not observed` rather than
   * matching a row keyed by `undefined`.
   */
  headRef: string | null;
}

/**
 * One sweep of the plain pull-request search (#167).
 *
 * Term for term the update-PR page's shape, because the two searches fall
 * short in the same three ways. What differs is what the LANE does with
 * `unsearchable`: this one treats it as an answer about those repositories
 * and keeps the run `ok`, where `listOpenUpdatePRs`'s caller degrades. See
 * the divergence note on both lanes.
 */
export interface PullRequestPage {
  prs: RawOpenPullRequest[];
  /** Nodes the mapper could not read. Never silently discarded. */
  unreadable: number;
  /**
   * Repositories that could not be searched at all, because their own
   * `repo:` qualifier does not fit alongside the query base. The base here
   * grows with every configured bot login, exactly as the update-PR base
   * does, because the logins are negated rather than required.
   */
  unsearchable: UnlistedRepo[];
  /** True when GitHub returned fewer results than the query matched. */
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
   * `repo:` qualifier does not fit alongside the query base.
   *
   * IT CANNOT FIRE IN PRODUCTION, and is kept for the contract rather than
   * for the case. This base is fixed at 28 characters (`is:issue is:open
   * no:assignee`), and GitHub caps an owner at 39 characters and a
   * repository name at 100, so the longest qualifier it can ever build is
   * 146: 174 against a 256-character cap, with 82 to spare. Only the PR
   * page's identical field is reachable, because its base grows with every
   * configured bot login.
   *
   * Kept, and kept a list, because the two search pages are read together
   * and a caller that withholds a confirmation per unsearchable repository
   * must not have to special-case which page it is holding.
   */
  unsearchable: UnlistedRepo[];
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

/**
 * What one per-repository security-feature probe told us (#152).
 *
 * The two scanners do NOT answer symmetrically, and a mapping that assumed
 * they did would be wrong for half the estate. Measured 2026-09-09, and
 * recorded in test/fixtures/github/{code,secret}-scanning-404.json:
 *
 *   secret scanning off  404  "Secret scanning is disabled on this
 *                              repository."          -> off, unambiguous
 *   code scanning        404  "no analysis found"    -> unknown, NOT off
 *   either, enabled      200                         -> covered
 *
 * The second line is the one to get right: a repository that has code
 * scanning configured but has never completed a run answers exactly like one
 * that never configured it, and four of seven public repositories probed
 * answered that way. Reading it as off would put `not covered` on a
 * repository that is scanned.
 *
 * `reason` is GitHub's own message, redacted and bounded, so a page can quote
 * it instead of inventing one per state.
 *
 * `answered` says whether GitHub replied at all - NOT whether we recognised
 * what it said. An unmeasured body is an answer: it is stable, it is stored
 * with the body as its reason, and retrying it hourly for ever would return
 * the same words. Only a request that reached no answer - a transport failure,
 * a 5xx, an empty body, a token that could not be minted - degrades the lane's
 * run, which is what the retry hint exists for. Getting this backwards is how
 * one private repository without Advanced Security would hold a daily lane
 * permanently partial.
 */
export interface FeatureProbe {
  state: "covered" | "feature_off" | "unreachable" | "unknown";
  reason: string | null;
  answered: boolean;
}
