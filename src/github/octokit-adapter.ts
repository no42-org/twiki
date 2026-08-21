/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { parseDependency } from "../core/semver.js";
import type {
  CheckStatus,
  FailingCheck,
  RepoRef,
  WorkflowRunRef,
} from "../core/types.js";
import { repoSlug } from "../core/types.js";
import {
  type AppAuthConfig,
  installationOctokit,
  loadAppAuthFromEnv,
} from "./auth.js";
import { installationTokenGen, withRequestDiscipline } from "./discipline.js";
import type {
  AccountKind,
  AppIdentity,
  DependabotAccess,
  GitHubAppPort,
  GitHubPort,
  GitHubReadPort,
  InstallationRef,
  IssuePage,
  OrgAlertPage,
  RawDependabotAlert,
  RawIssue,
  RawPullRequest,
  RawRepoMeta,
  RawReviewRequest,
  RawUpdatePr,
  RawUpdateStatus,
  RawWorkflowRun,
  RequestValidator,
  ReviewRequestPage,
  UpdatePrPage,
  WorkflowRunPage,
} from "./port.js";

const DEPENDABOT_LOGIN = "dependabot[bot]";

/** Check-run conclusions that count as a red/failing result. */
const FAILED_CONCLUSIONS = [
  "failure",
  "timed_out",
  "cancelled",
  "action_required",
  "stale",
];

/** Resolves an installation-scoped Octokit for a given repo. */
export type OctokitResolver = (repo: RepoRef) => Promise<Octokit>;
/**
 * Resolves the installation client for a whole organisation, for the org-level
 * reads that collapse N repositories into one call. Optional: twiki never makes
 * one, so its wiring does not need to supply this.
 */
export type OrgOctokitResolver = (org: string) => Promise<Octokit>;
/**
 * What kind of account an installation is on. Supplied by the factory from
 * the installation payload, so nothing here has to probe or guess.
 */
export type AccountKindResolver = (login: string) => AccountKind;

/**
 * GitHub caps search queries at 256 characters, so the watched repositories
 * are spread over as many queries as their slugs need. Pure and exported so
 * the packing (every repo present, every query under the cap, base qualifiers
 * on each) is testable without an API.
 */
export const SEARCH_QUERY_MAX = 256;
const ISSUE_SEARCH_BASE = "is:issue is:open no:assignee";

/**
 * Pagination sanity cap: 200 pages is 20,000 open alerts in one org, far
 * past any real estate, so this bounds a self-linking proxy rather than a
 * large organisation. Hitting it truncates the result honestly (the caller
 * degrades to partial and tombstones nothing); it is not an error, because
 * failing the whole lane would ingest nothing at all.
 */
export const MAX_ALERT_PAGES = 200;

/**
 * The rel="next" target from a Link header, or null.
 *
 * Parsed per RFC 8288 shape rather than one regex over the whole header,
 * exported so the parsing is testable on its own. Three traps a naive split
 * falls into, each of which silently truncates the listing at the current
 * page - and page one's validator then gets cached for an incomplete
 * listing: a comma inside a bracketed URL (legal in query strings), an
 * unquoted `rel=next`, and a list-valued `rel="next last"`.
 */
export function nextLink(header: string): string | null {
  for (const m of header.matchAll(/<([^>]*)>((?:[^,<"]|"[^"]*")*)/g)) {
    const url = m[1];
    const params = m[2] ?? "";
    const rel = params.match(/\brel\s*=\s*(?:"([^"]*)"|([^\s;,]+))/);
    const tokens = (rel?.[1] ?? rel?.[2] ?? "").toLowerCase().split(/\s+/);
    if (tokens.includes("next") && url) return url;
  }
  return null;
}

export interface SearchPlan {
  queries: string[];
  /**
   * Repositories whose own qualifier cannot fit alongside the base, so no
   * chunking can include them. Counted, never dropped: a repository we did
   * not search must not be indistinguishable from one we searched and found
   * clean, and its presence makes the sweep incomplete.
   */
  unsearchable: RepoRef[];
}

/**
 * Spread `repos` over as many `repo:`-qualified queries as the length cap
 * allows, each carrying `base`.
 *
 * Repo-scoped rather than `org:`-scoped to keep the 1000-result search
 * ceiling for repositories somebody is actually watching. Measured on a live
 * personal account 2026-08-19: 37 open bot PRs org-wide against 3 in the
 * allowlist, so 34 results of ceiling went to repositories nobody watches,
 * and a busy account could push the watched ones out of the window entirely
 * while the sweep still reported ok.
 *
 * NOT because `org:` fails on personal accounts. An earlier version of this
 * comment claimed that and it is false: `org:<user>` and `user:<user>`
 * return the same 37 results, measured the same day.
 */
/**
 * Pack `qualifiers` into as few queries under the length cap as possible,
 * reporting the indices of any that cannot fit a query at all.
 *
 * Shared by the repo-scoped and reviewer-scoped searches, which pack
 * identically and differ only in what an oversized qualifier means: a
 * repository the sweep must report as unsearchable, or a configured login
 * the lane must refuse over. Keeping one packer means a fix to the
 * arithmetic cannot land in one caller and leave the other building queries
 * GitHub rejects.
 */
function packQualifiers(
  base: string,
  qualifiers: readonly string[],
): { queries: string[]; oversized: Set<number> } {
  const queries: string[] = [];
  const oversized = new Set<number>();
  let current = base;
  qualifiers.forEach((qualifier, i) => {
    if (base.length + qualifier.length > SEARCH_QUERY_MAX) {
      // This ONE qualifier cannot be searched under this base, however the
      // rest are packed. Judged per qualifier rather than against the
      // longest: an earlier version refused the whole sweep when any single
      // slug was too long, so one 100-character repository name stopped the
      // other nine from being collected at all.
      oversized.add(i);
      return;
    }
    if (current.length + qualifier.length > SEARCH_QUERY_MAX) {
      queries.push(current);
      current = base + qualifier;
    } else {
      current += qualifier;
    }
  });
  if (current !== base) queries.push(current);
  return { queries, oversized };
}

export function searchQueries(
  base: string,
  repos: readonly RepoRef[],
): SearchPlan {
  const { queries, oversized } = packQualifiers(
    base,
    repos.map((repo) => ` repo:${repo.owner}/${repo.name}`),
  );
  return { queries, unsearchable: repos.filter((_, i) => oversized.has(i)) };
}

/**
 * Spread `reviewers` over as many queries as the length cap allows.
 *
 * The reviewer qualifiers OR together, so splitting them across queries and
 * merging the results returns the same set - unlike the repo-scoped
 * searches, where every chunk narrows a different slice.
 */
export function reviewerQueries(reviewers: readonly string[]): string[] {
  const { queries, oversized } = packQualifiers(
    "is:pr is:open",
    reviewers.map((reviewer) => ` review-requested:${reviewer}`),
  );
  for (const i of oversized) {
    // One login so long it cannot share a query with the base at all.
    // Skipping it silently would drop that reviewer's requests without a
    // word, so it is refused where the reason is legible. Unlike an
    // unsearchable repository, this is configuration the operator wrote and
    // can fix.
    throw new Error(
      `review-requested qualifier for ${reviewers[i]} exceeds the ${SEARCH_QUERY_MAX}-character search cap`,
    );
  }
  return queries;
}

export function issueSearchQueries(repos: readonly RepoRef[]): SearchPlan {
  return searchQueries(ISSUE_SEARCH_BASE, repos);
}

/**
 * One paginated node search, shared by the PR and issue lanes. Extracted
 * because the two copies each carried the subtle ceiling arithmetic below,
 * and a fix landing in one copy would leave the other lane tombstoning
 * against an incomplete result set.
 *
 * PullRequest and Issue nodes are read through one shape: the two fragments
 * request the same fields.
 */
const NODE_FIELDS = `
  id
  number
  title
  url
  createdAt
  author { login }
  repository { name owner { login } }
`;

/** The shape every search node here shares, before the caller's mapping. */
interface SearchNodeRaw {
  id?: string;
  number?: number;
  title?: string;
  url?: string;
  createdAt?: string;
  author?: { login?: string } | null;
  repository?: { name?: string; owner?: { login?: string } } | null;
}

async function runNodeSearch<T>(
  gh: Octokit,
  nodeType: "PullRequest" | "Issue",
  query: string,
  /** Extra node sub-selection, for a caller that needs more than the shared fields. */
  extraFields = "",
  /** Maps a node the shared guard accepted. Defaults to the update-PR shape. */
  map: (raw: SearchNodeRaw, base: RawUpdatePr) => T = (_raw, base) =>
    base as unknown as T,
): Promise<{ items: T[]; unreadable: number; truncated: boolean }> {
  const items: T[] = [];
  let unreadable = 0;
  let cursor: string | null = null;
  for (;;) {
    const page: {
      search: {
        issueCount: number;
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: unknown[];
      } | null;
    } = await gh.graphql(
      `query ($q: String!, $cursor: String) {
         search(type: ISSUE, query: $q, first: 100, after: $cursor) {
           issueCount
           pageInfo { hasNextPage endCursor }
           nodes {
             ... on ${nodeType} {
               ${NODE_FIELDS}
               ${extraFields}
             }
           }
         }
       }`,
      { q: query, cursor },
    );
    if (!page.search) {
      // A missing container is a failed read, never an empty result: treating
      // it as complete would hand the lane a clean "ok" sweep whose tombstone
      // pass concludes everything unseen was closed.
      throw new Error(`search returned no result container for: ${query}`);
    }
    for (const node of page.search.nodes) {
      const item = node as {
        id?: string;
        number?: number;
        title?: string;
        url?: string;
        createdAt?: string;
        author?: { login?: string } | null;
        repository?: { name?: string; owner?: { login?: string } } | null;
      } | null;
      if (
        !item?.id ||
        typeof item.number !== "number" ||
        typeof item.title !== "string" ||
        !item.repository?.owner?.login ||
        !item.repository.name
      ) {
        unreadable++;
        continue;
      }
      items.push(
        map(item, {
          nodeId: item.id,
          repo: {
            owner: item.repository.owner.login,
            name: item.repository.name,
          },
          number: item.number,
          title: item.title,
          author: item.author?.login ?? "unknown",
          htmlUrl: item.url ?? "",
          createdAt: item.createdAt ?? "",
        }),
      );
    }
    if (!page.search.pageInfo.hasNextPage) {
      // hasNextPage goes false at the 1000-result search ceiling exactly as
      // it does at a genuine end, so completeness is judged against what the
      // query matched, not against pagination.
      const collected = items.length + unreadable;
      return {
        items,
        unreadable,
        truncated: collected < page.search.issueCount,
      };
    }
    cursor = page.search.pageInfo.endCursor;
  }
}

/**
 * The AD-25 send rule, in one place for every conditional endpoint.
 *
 * Three ways a cached validator must NOT go on the wire, each of which was
 * separately load-bearing: a different token generation (GitHub's ETags vary
 * with the Authorization header, so it is a guaranteed miss), an unknowable
 * generation (null cannot be compared, and a sentinel would compare equal to
 * itself across rotations), and an all-null validator (it adds no header, so
 * treating the request as conditional is how an unsolicited 304 gets
 * honoured and freezes stored state).
 */
export function sendableValidator(
  cached: RequestValidator | null | undefined,
  tokenGen: string | null,
): RequestValidator | null {
  if (!cached || tokenGen === null) return null;
  if (cached.tokenGen !== tokenGen) return null;
  if (!cached.etag && !cached.lastModified) return null;
  return cached;
}

/**
 * The conditional headers for a sendable validator. Both when both exist:
 * RFC 9110 prefers If-None-Match, and a proxy honouring only Last-Modified
 * still gets its chance to answer 304.
 */
export function conditionalHeadersFor(
  send: RequestValidator | null,
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (send?.etag) headers["if-none-match"] = send.etag;
  if (send?.lastModified) headers["if-modified-since"] = send.lastModified;
  return headers;
}

/**
 * The validator a 200's headers earn, or null when they earn none. A
 * validator that cannot make the next request conditional is not stored:
 * see sendableValidator's third rule.
 */
export function validatorFrom(
  headers: Record<string, string | number | undefined>,
  tokenGen: string | null,
): RequestValidator | null {
  if (tokenGen === null) return null;
  const etag = typeof headers.etag === "string" ? headers.etag : null;
  const lastModified =
    typeof headers["last-modified"] === "string"
      ? headers["last-modified"]
      : null;
  if (!etag && !lastModified) return null;
  return { etag, lastModified, tokenGen };
}

interface PageResponse {
  data: unknown;
  headers: Record<string, string | number | undefined>;
}

/**
 * Walk a Link-header-paginated listing under the guards this codebase has
 * already paid for, rather than handing the job to gh.paginate.
 *
 * Three of them are load-bearing and none of them are octokit's: the page
 * cap, which stops a proxy echoing a self-referential Link header from
 * looping a lane forever; the origin check, because the next URL is followed
 * with the installation token attached and a proxy-injected header must not
 * point that token at another host; and the array check, because a proxy
 * error page would otherwise spread character by character into a nonsense
 * count. Truncating at the cap is reported rather than thrown, so what was
 * read is still ingested and the caller degrades to partial (AD-23).
 *
 * Shared because the org path and the per-repository fan-out are the same
 * walk, and the first version of the fan-out reached for gh.paginate and
 * silently dropped all three.
 */
async function walkLinkedPages(
  label: string,
  first: () => Promise<PageResponse>,
  followUp: (url: string) => Promise<PageResponse>,
): Promise<{
  items: unknown[];
  firstPage: PageResponse;
  pages: number;
  truncated: boolean;
}> {
  const items: unknown[] = [];
  let pages = 0;
  let truncated = false;
  let next: string | null = null;
  let firstPage: PageResponse | null = null;
  for (;;) {
    pages++;
    const res: PageResponse = next ? await followUp(next) : await first();
    if (firstPage === null) firstPage = res;
    if (!Array.isArray(res.data)) {
      throw new Error(`${label} returned a non-array body (page ${pages})`);
    }
    items.push(...(res.data as unknown[]));
    const link = typeof res.headers.link === "string" ? res.headers.link : "";
    next = nextLink(link);
    if (!next) break;
    if (pages >= MAX_ALERT_PAGES) {
      truncated = true;
      break;
    }
    if (!next.startsWith("https://api.github.com/")) {
      throw new Error(
        `${label} carried a cross-origin next link; refusing to follow it`,
      );
    }
  }
  return { items, firstPage, pages, truncated };
}

/**
 * GitHubPort backed by Octokit. Scoped to the allowlist: every call asserts the
 * repo is permitted before touching the API (defense in depth — run.ts already
 * only passes allowlisted repos).
 */
export class OctokitGitHub implements GitHubPort {
  constructor(
    private readonly octokitFor: OctokitResolver,
    private readonly isAllowed: (repo: RepoRef) => boolean,
    private readonly orgOctokitFor?: OrgOctokitResolver,
    /** Defaults to treating every account as an organisation, which is what
     * this adapter did before user accounts were handled at all. */
    private readonly accountKindFor: AccountKindResolver = () => "organization",
  ) {}

  private async client(repo: RepoRef): Promise<Octokit> {
    if (!this.isAllowed(repo)) {
      throw new Error(
        `Refusing to act on non-allowlisted repo ${repoSlug(repo)}`,
      );
    }
    return this.octokitFor(repo);
  }

  async listOrgRepos(org: string): Promise<RawRepoMeta[]> {
    if (!this.orgOctokitFor) {
      throw new Error(
        "listOrgRepos needs an org resolver; this client was built without one",
      );
    }
    // Resolved BEFORE the kind is read: the kind map is filled by the same
    // resolver's lazy re-resolve, so asking first returns "unknown" for an
    // installation created since startup and silently routes it down the
    // organisation path.
    const client = await this.orgOctokitFor(org);
    // A user account has no /orgs listing at all: it answers 404, which the
    // coverage lane records as a failed run every cycle, leaving every
    // personal repository's coverage permanently unknown.
    //
    // NOT /users/{login}/repos, which measurement rules out: it returned
    // 223 repositories against the installation's 240 on the live account,
    // every one of the 17 private ones missing. Coverage would then find no
    // metadata for a watched private repository, never report it archived,
    // and fall through to the probe - promising "covered" for a repository
    // that is archived, which is the false promise the archived branch
    // exists to prevent. The installation's own listing carries all of
    // them, and is the honest universe anyway: it is exactly what this App
    // can see.
    const repos =
      this.accountKindFor(org) === "user"
        ? await client.paginate(client.apps.listReposAccessibleToInstallation, {
            per_page: 100,
          })
        : await client.paginate(client.repos.listForOrg, {
            org,
            per_page: 100,
          });
    return repos.map(
      (r: {
        owner: { login: string };
        name: string;
        archived?: boolean;
        disabled?: boolean;
      }) => ({
        repo: { owner: r.owner.login, name: r.name },
        archived: r.archived === true,
        disabled: r.disabled === true,
      }),
    );
  }

  async probeDependabotAccess(repo: RepoRef): Promise<DependabotAccess> {
    let client: Octokit;
    try {
      client = await this.client(repo);
    } catch {
      // NOT "unreachable". This catch also sees the allowlist guard and any
      // transient token-mint failure, and reporting either as "the App is not
      // installed" is the confident guess translateDependabotProbe refuses to
      // make a few lines below. A token-mint outage would otherwise mark every
      // repository in the organisation as uncovered at once.
      return "unknown";
    }
    try {
      await client.request("GET /repos/{owner}/{repo}/dependabot/alerts", {
        owner: repo.owner,
        repo: repo.name,
        per_page: 1,
      });
      return "covered";
    } catch (err) {
      return translateDependabotProbe(err);
    }
  }

  async listOpenUpdatePRs(
    repos: readonly RepoRef[],
    authors: readonly string[],
  ): Promise<UpdatePrPage> {
    if (!this.orgOctokitFor) {
      throw new Error(
        "listOpenUpdatePRs needs an org resolver; this client was built without one",
      );
    }
    if (repos.length === 0) {
      return { prs: [], unreadable: 0, truncated: false, unsearchable: 0 };
    }
    const gh = await this.orgOctokitFor(repos[0]?.owner ?? "");
    // Search with explicit logins, never @me: an installation token has no
    // user identity, and the whole-account issue endpoints are excluded from
    // installation tokens entirely. Multiple author qualifiers OR together.
    const base = [
      "is:pr",
      "is:open",
      ...authors.map((a) => `author:${a}`),
    ].join(" ");

    const plan = searchQueries(base, repos);
    const prs: RawUpdatePr[] = [];
    let unreadable = 0;
    let truncated = false;
    for (const query of plan.queries) {
      const page = await runNodeSearch<RawUpdatePr>(gh, "PullRequest", query);
      prs.push(...page.items);
      unreadable += page.unreadable;
      truncated = truncated || page.truncated;
    }
    return {
      prs,
      unreadable,
      truncated,
      unsearchable: plan.unsearchable.length,
    };
  }

  async listUntriagedIssues(repos: readonly RepoRef[]): Promise<IssuePage> {
    if (!this.orgOctokitFor) {
      throw new Error(
        "listUntriagedIssues needs an org resolver; this client was built without one",
      );
    }
    if (repos.length === 0)
      return { issues: [], unreadable: 0, truncated: false, unsearchable: 0 };
    const gh = await this.orgOctokitFor(repos[0]?.owner ?? "");

    // One search per query chunk, scoped by repo: qualifiers rather than
    // org:, so the 1000-result ceiling is spent only on repositories
    // somebody watches: an org-wide query counts every unwatched
    // repository's issues against it and can starve the watched ones out of
    // the window entirely while still looking complete.
    const plan = issueSearchQueries(repos);
    const issues: RawIssue[] = [];
    let unreadable = 0;
    let truncated = false;
    for (const query of plan.queries) {
      const page = await runNodeSearch<RawIssue>(gh, "Issue", query);
      issues.push(...page.items);
      unreadable += page.unreadable;
      truncated = truncated || page.truncated;
    }
    return {
      issues,
      unreadable,
      truncated,
      unsearchable: plan.unsearchable.length,
    };
  }

  async listReviewRequests(
    viaInstallation: string,
    reviewers: readonly string[],
  ): Promise<ReviewRequestPage> {
    if (!this.orgOctokitFor) {
      throw new Error(
        "listReviewRequests needs an org resolver; this client was built without one",
      );
    }
    if (reviewers.length === 0) {
      return { requests: [], unreadable: 0, truncated: false };
    }
    const gh = await this.orgOctokitFor(viaInstallation);
    // Multiple review-requested qualifiers OR together, exactly as author:
    // does - measured 2026-08-21: adding a login nobody has heard of left
    // the count unchanged rather than emptying it.
    //
    // Chunked under the same 256-character cap the repo-scoped searches
    // respect. Nothing bounded the length here at first, and each
    // qualifier is roughly twenty characters: about ten configured
    // reviewers crossed the cap, GitHub rejected the query, and the lane
    // recorded failed every cycle with nothing on the page to suggest the
    // reviewer count was the cause.
    //
    // No repo: qualifiers, and this is the one search here without them:
    // the point of this lane is the requests that arrive from outside the
    // watched estate, which were 38 of 40 on the measured account.
    const requests: RawReviewRequest[] = [];
    let unreadable = 0;
    let truncated = false;
    for (const chunk of reviewerQueries(reviewers)) {
      const page = await runNodeSearch<RawReviewRequest>(
        gh,
        "PullRequest",
        chunk,
        `reviewRequests(first: 100) {
           nodes {
             requestedReviewer {
               ... on User { login }
               ... on Team { slug }
             }
           }
         }`,
        (raw, base) => ({
          ...base,
          requestedReviewers: (
            (
              raw as {
                reviewRequests?: {
                  nodes?:
                    | ({
                        requestedReviewer?: {
                          login?: string;
                          slug?: string;
                        } | null;
                      } | null)[]
                    | null;
                } | null;
              }
            ).reviewRequests?.nodes ?? []
          )
            .map(
              (n) => n?.requestedReviewer?.login ?? n?.requestedReviewer?.slug,
            )
            .filter((n): n is string => typeof n === "string"),
        }),
      );
      requests.push(...page.items);
      unreadable += page.unreadable;
      truncated = truncated || page.truncated;
    }
    return { requests, unreadable, truncated };
  }

  async listDependabotUpdateStatuses(
    repo: RepoRef,
  ): Promise<RawUpdateStatus[]> {
    const gh = await this.client(repo);
    const out: RawUpdateStatus[] = [];
    let cursor: string | null = null;
    for (;;) {
      const page: {
        repository: {
          vulnerabilityAlerts: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: {
              number?: number;
              dependabotUpdate?: {
                pullRequest?: { number?: number } | null;
                error?: { title?: string; errorType?: string } | null;
              } | null;
            }[];
          } | null;
        } | null;
      } = await gh.graphql(
        `query ($owner: String!, $name: String!, $cursor: String) {
           repository(owner: $owner, name: $name) {
             vulnerabilityAlerts(states: OPEN, first: 100, after: $cursor) {
               pageInfo { hasNextPage endCursor }
               nodes {
                 number
                 dependabotUpdate {
                   pullRequest { number }
                   error { title errorType }
                 }
               }
             }
           }
         }`,
        { owner: repo.owner, name: repo.name, cursor },
      );
      const alerts = page.repository?.vulnerabilityAlerts;
      if (!alerts) {
        // A missing container is a failed read (access lost, repository
        // renamed or transferred mid-run), never an empty alert list. Both
        // search loops crash on this shape and fail their lane loudly; this
        // one used to return [] cleanly, the lane reported "ok", and the
        // full-sweep reconciliation tombstoned every stored status for the
        // repository.
        throw new Error(
          `${repo.owner}/${repo.name}: vulnerabilityAlerts returned no container`,
        );
      }
      for (const node of alerts.nodes) {
        if (typeof node.number !== "number") continue;
        const update = node.dependabotUpdate;
        out.push({
          repo,
          alertNumber: node.number,
          // dependabotUpdate null means GitHub is not attempting a fix, which
          // is a different fact from an attempted fix with no error.
          update: update
            ? {
                pullRequestNumber: update.pullRequest?.number ?? null,
                error: update.error
                  ? (update.error.title ??
                    update.error.errorType ??
                    "unknown error")
                  : null,
              }
            : null,
        });
      }
      if (!alerts.pageInfo.hasNextPage) break;
      cursor = alerts.pageInfo.endCursor;
    }
    return out;
  }

  async listOpenDependabotPRs(repo: RepoRef): Promise<RawPullRequest[]> {
    const gh = await this.client(repo);
    const { data } = await gh.pulls.list({
      owner: repo.owner,
      repo: repo.name,
      state: "open",
      per_page: 100,
    });
    return data
      .filter((pr) => pr.user?.login === DEPENDABOT_LOGIN)
      .map((pr) => {
        const labels = pr.labels.map((l) =>
          typeof l === "string" ? l : (l.name ?? ""),
        );
        return {
          number: pr.number,
          title: pr.title,
          branch: pr.head.ref,
          headSha: pr.head.sha,
          body: pr.body ?? "",
          isSecurity: labels.some((l) => /security/i.test(l)),
          dependency: parseDependency(pr.title),
        };
      });
  }

  async prChecks(repo: RepoRef, headSha: string): Promise<CheckStatus> {
    return this.aggregateChecks(repo, headSha);
  }

  async branchChecks(repo: RepoRef, branch: string): Promise<CheckStatus> {
    const gh = await this.client(repo);
    const { data } = await gh.repos.getBranch({
      owner: repo.owner,
      repo: repo.name,
      branch,
    });
    return this.aggregateChecks(repo, data.commit.sha);
  }

  private async aggregateChecks(
    repo: RepoRef,
    sha: string,
  ): Promise<CheckStatus> {
    const gh = await this.client(repo);
    const [checks, status] = await Promise.all([
      gh.checks.listForRef({
        owner: repo.owner,
        repo: repo.name,
        ref: sha,
        per_page: 100,
      }),
      gh.repos.getCombinedStatusForRef({
        owner: repo.owner,
        repo: repo.name,
        ref: sha,
      }),
    ]);

    const runs = checks.data.check_runs;
    const failedRun = runs.some(
      (r) => r.conclusion !== null && FAILED_CONCLUSIONS.includes(r.conclusion),
    );
    const pendingRun = runs.some((r) => r.status !== "completed");
    const statusState = status.data.state; // success | failure | pending

    if (failedRun || statusState === "failure") return "red";
    if (pendingRun || statusState === "pending") return "pending";
    return "green";
  }

  async latestTag(repo: RepoRef): Promise<string | null> {
    const gh = await this.client(repo);
    try {
      const { data } = await gh.repos.getLatestRelease({
        owner: repo.owner,
        repo: repo.name,
      });
      return data.tag_name;
    } catch {
      return null; // no releases yet
    }
  }

  async dependabotCommitsSince(
    repo: RepoRef,
    tag: string | null,
  ): Promise<number> {
    const gh = await this.client(repo);
    if (!tag) {
      const { data } = await gh.repos.listCommits({
        owner: repo.owner,
        repo: repo.name,
        author: DEPENDABOT_LOGIN,
        per_page: 100,
      });
      return data.length;
    }
    const { data } = await gh.repos.compareCommitsWithBasehead({
      owner: repo.owner,
      repo: repo.name,
      basehead: `${tag}...HEAD`,
    });
    return data.commits.filter(
      (c) =>
        c.author?.login === DEPENDABOT_LOGIN ||
        /dependabot/i.test(c.commit.author?.name ?? ""),
    ).length;
  }

  async hasTagReleaseWorkflow(repo: RepoRef): Promise<boolean> {
    const gh = await this.client(repo);
    let files: { name: string }[];
    try {
      const { data } = await gh.repos.getContent({
        owner: repo.owner,
        repo: repo.name,
        path: ".github/workflows",
      });
      if (!Array.isArray(data)) return false;
      files = data.filter((f) => /\.ya?ml$/.test(f.name));
    } catch {
      return false;
    }
    for (const f of files) {
      const { data } = await gh.repos.getContent({
        owner: repo.owner,
        repo: repo.name,
        path: `.github/workflows/${f.name}`,
      });
      if (Array.isArray(data) || data.type !== "file" || !("content" in data))
        continue;
      const text = Buffer.from(data.content, "base64").toString("utf8");
      if (/on:[\s\S]*?push:[\s\S]*?tags:/.test(text)) return true;
    }
    return false;
  }

  async defaultBranchSha(repo: RepoRef): Promise<string> {
    const gh = await this.client(repo);
    const { data: meta } = await gh.repos.get({
      owner: repo.owner,
      repo: repo.name,
    });
    const { data } = await gh.repos.getBranch({
      owner: repo.owner,
      repo: repo.name,
      branch: meta.default_branch,
    });
    return data.commit.sha;
  }

  async failingChecks(repo: RepoRef, ref: string): Promise<FailingCheck[]> {
    const gh = await this.client(repo);
    const { data } = await gh.checks.listForRef({
      owner: repo.owner,
      repo: repo.name,
      ref,
      per_page: 100,
    });
    return data.check_runs
      .filter(
        (r) =>
          r.conclusion !== null && FAILED_CONCLUSIONS.includes(r.conclusion),
      )
      .map((r) => ({
        name: r.name,
        conclusion: r.conclusion,
        detailsUrl: r.details_url ?? r.html_url ?? "",
      }));
  }

  async workflowRunsForSha(
    repo: RepoRef,
    sha: string,
  ): Promise<WorkflowRunRef[]> {
    const gh = await this.client(repo);
    const { data } = await gh.actions.listWorkflowRunsForRepo({
      owner: repo.owner,
      repo: repo.name,
      head_sha: sha,
      per_page: 100,
    });
    return data.workflow_runs.map((r) => ({
      runId: r.id,
      runAttempt: r.run_attempt ?? 1,
      status: r.status ?? "completed",
      conclusion: r.conclusion ?? null,
    }));
  }

  async behindBy(repo: RepoRef, headSha: string): Promise<number | null> {
    const gh = await this.client(repo);
    try {
      // Compare against the repo's actual default branch, not a hardcoded
      // "main" — otherwise repos on master/develop would always compare-404
      // and silently never rebase.
      const { data: meta } = await gh.repos.get({
        owner: repo.owner,
        repo: repo.name,
      });
      const { data } = await gh.repos.compareCommitsWithBasehead({
        owner: repo.owner,
        repo: repo.name,
        basehead: `${meta.default_branch}...${headSha}`,
      });
      return data.behind_by;
    } catch {
      return null; // fail-closed: never rebase on an undeterminable comparison
    }
  }

  /**
   * The per-repository fallback. One call each, and a 403 saying alerts are
   * switched off is NOT a failure: it is the same fact the coverage probe
   * records, and counting it as unreadable would degrade every sweep of an
   * account that simply does not use Dependabot everywhere. Anything else
   * unreadable does count, so the sweep goes partial and tombstones
   * nothing (AD-23).
   */
  private async listDependabotAlertsPerRepo(
    repos: readonly RepoRef[],
  ): Promise<OrgAlertPage> {
    const alerts: RawDependabotAlert[] = [];
    let unreadable = 0;
    let unreachable = 0;
    let truncated = false;
    for (const repo of repos) {
      const slug = repoSlug(repo);
      let walked: Awaited<ReturnType<typeof walkLinkedPages>>;
      try {
        const gh = await this.client(repo);
        // The same guarded walk the org path uses. gh.paginate would drop
        // the page cap, the origin check and the array guard, all of which
        // this lane already paid for.
        walked = await walkLinkedPages(
          `alert listing for ${slug}`,
          () =>
            gh.request("GET /repos/{owner}/{repo}/dependabot/alerts", {
              owner: repo.owner,
              repo: repo.name,
              state: "open",
              per_page: 100,
            }),
          (url) => gh.request(`GET ${url}`),
        );
      } catch (err) {
        // Alerts switched off is a FACT, the same one the coverage probe
        // records, and most repositories on a personal account answer it.
        // Counting it would make every sweep partial forever.
        if (translateDependabotProbe(err) === "alerts_disabled") continue;
        unreachable++;
        continue;
      }
      truncated = truncated || walked.truncated;
      for (const item of walked.items) {
        const alert = toDependabotAlert(item, repo);
        if (alert === null) unreadable++;
        else alerts.push(alert);
      }
    }
    // No validator: each repository carries its own ETag, and one cached
    // value cannot describe a set of them. The next sweep pays full price
    // rather than revalidating against a listing that does not exist.
    return {
      alerts,
      unreadable,
      unreachable,
      notModified: false,
      truncated,
      validator: null,
    };
  }

  async listDependabotAlerts(
    org: string,
    repos: readonly RepoRef[] = [],
    cached: RequestValidator | null = null,
  ): Promise<OrgAlertPage> {
    if (!this.orgOctokitFor) {
      throw new Error(
        "listDependabotAlerts needs an org resolver; this client was built without one",
      );
    }
    // Resolved first, deliberately: the kind map is filled by this same
    // resolver's lazy re-resolve, so reading the kind before resolving
    // returns "unknown" for an installation created since the process
    // started, routes it to the org endpoint, and fails the lane every
    // cycle until someone restarts the container.
    const gh = await this.orgOctokitFor(org);
    // A user account has no org-level alert endpoint - `/orgs/{login}/...`
    // answers 404 - so there is nothing to collapse and the only route is
    // one call per watched repository. The spine prices this: 36 calls plus
    // three per allowlisted personal-account repository, of which this lane
    // is one.
    if (this.accountKindFor(org) === "user") {
      return this.listDependabotAlertsPerRepo(repos);
    }

    // A validator from a previous token generation is a guaranteed miss:
    // GitHub's ETags vary with the Authorization header. Cold, not sent. An
    // all-null validator is not a validator: sending nothing while treating
    // the request as conditional is how an unsolicited 304 gets honoured.
    // A null generation (auth carried no expiry) fails closed on both sides:
    // nothing is sent and nothing is cached, because a generation that
    // cannot be compared would otherwise compare equal across rotations.
    const tokenGen = await installationTokenGen(gh);
    const send = sendableValidator(cached, tokenGen);
    const conditionalHeaders = conditionalHeadersFor(send);

    // The same guarded walk the per-repository fan-out uses, not
    // gh.paginate: the cap, the origin check and the array guard all live
    // there, and a second copy of them is a second thing to forget.
    // Conditional handling stays here because only this path has a single
    // listing to revalidate.
    let walked: Awaited<ReturnType<typeof walkLinkedPages>>;
    try {
      walked = await walkLinkedPages(
        `alert listing for ${org}`,
        () =>
          gh.request("GET /orgs/{org}/dependabot/alerts", {
            org,
            state: "open",
            per_page: 100,
            headers: conditionalHeaders,
          }),
        (url) => gh.request(`GET ${url}`),
      );
    } catch (err) {
      if ((err as { status?: number }).status === 304) {
        if (send) {
          // Byte-identical to the listing the validator came from. The send
          // guard already proved send.tokenGen === tokenGen, so the cached
          // validator goes back as it came.
          return {
            alerts: [],
            unreadable: 0,
            unreachable: 0,
            notModified: true,
            truncated: false,
            validator: { ...send },
          };
        }
        // Same posture as the KEV path, same legible message: a broken
        // proxy confirming a validator we never sent, not an empty page.
        throw new Error(
          `alert listing for ${org} answered 304 to an unconditional request`,
        );
      }
      throw err;
    }
    const raw = walked.items;
    const pages = walked.pages;
    const truncated = walked.truncated;
    const firstEtag =
      typeof walked.firstPage.headers.etag === "string"
        ? walked.firstPage.headers.etag
        : null;
    const firstLastModified =
      typeof walked.firstPage.headers["last-modified"] === "string"
        ? walked.firstPage.headers["last-modified"]
        : null;

    // Deliberately unfiltered. Which repositories are watched is AD-10's rule
    // and belongs to the lane. This adapter's allowlist guard exists to stop
    // twiki ACTING on a repository, and its case-sensitivity is load-bearing
    // there; applying it to a read whose casing GitHub supplies would silently
    // drop alerts and report a confident zero.
    const alerts: RawDependabotAlert[] = [];
    let unreadable = 0;
    for (const item of raw) {
      const alert = toDependabotAlert(item);
      if (alert === null) unreadable++;
      else alerts.push(alert);
    }
    return {
      alerts,
      unreadable,
      // The org path reads one listing or none, so there is no such thing
      // as an unreachable repository here.
      unreachable: 0,
      notModified: false,
      truncated,
      // Only a listing that fit in one page gets a validator: each page
      // carries its own ETag, and a 304 on page one says nothing about the
      // pages behind it.
      // A validator earns caching only when it can make a request
      // conditional: an all-null one would count as "cached" while sending
      // no header, the unsolicited-304 state guarded against above.
      // A truncated listing earns no validator either: a 304 against it
      // would confirm an incomplete set as the whole answer. Unreachable
      // while the cap exceeds one page (truncation implies many), so no
      // test can kill it; kept because the two conditions are independent
      // reasons and a future cap change must not silently couple them.
      validator:
        pages === 1 && !truncated
          ? validatorFrom(
              {
                etag: firstEtag ?? undefined,
                "last-modified": firstLastModified ?? undefined,
              },
              tokenGen,
            )
          : null,
    };
  }

  async listRepoWorkflowRuns(
    repo: RepoRef,
    cached: RequestValidator | null = null,
  ): Promise<WorkflowRunPage> {
    const gh = await this.client(repo);

    // Same conditional posture as the alert listing: a validator from a
    // different (or unknowable) token generation is cold, an all-null one is
    // no validator, and both headers go when both exist (AD-25). Page one
    // only, so the single-page caching restriction never bites here.
    const tokenGen = await installationTokenGen(gh);
    const send = sendableValidator(cached, tokenGen);
    const headers = conditionalHeadersFor(send);

    let res: {
      data: unknown;
      headers: Record<string, string | number | undefined>;
    };
    try {
      res = await gh.request("GET /repos/{owner}/{repo}/actions/runs", {
        owner: repo.owner,
        repo: repo.name,
        per_page: 100,
        headers,
      });
    } catch (err) {
      if ((err as { status?: number }).status === 304) {
        if (send) {
          return {
            runs: [],
            unreadable: 0,
            notModified: true,
            validator: send,
          };
        }
        throw new Error(
          `run listing for ${repoSlug(repo)} answered 304 to an unconditional request`,
        );
      }
      throw err;
    }

    const body = res.data as { workflow_runs?: unknown } | null;
    if (!body || !Array.isArray(body.workflow_runs)) {
      throw new Error(
        `run listing for ${repoSlug(repo)} returned no workflow_runs array`,
      );
    }

    const runs: RawWorkflowRun[] = [];
    let unreadable = 0;
    for (const item of body.workflow_runs) {
      const r = item as {
        node_id?: string;
        workflow_id?: number;
        name?: string | null;
        run_number?: number;
        status?: string | null;
        conclusion?: string | null;
        head_branch?: string | null;
        event?: string;
        html_url?: string;
        created_at?: string;
      } | null;
      if (
        !r?.node_id ||
        typeof r.workflow_id !== "number" ||
        typeof r.run_number !== "number" ||
        typeof r.status !== "string" ||
        typeof r.event !== "string"
      ) {
        unreadable++;
        continue;
      }
      runs.push({
        nodeId: r.node_id,
        repo,
        workflowId: r.workflow_id,
        workflowName: r.name ?? `workflow ${r.workflow_id}`,
        runNumber: r.run_number,
        status: r.status,
        conclusion: r.conclusion ?? null,
        headBranch: r.head_branch ?? null,
        event: r.event,
        htmlUrl: r.html_url ?? "",
        createdAt: r.created_at ?? "",
      });
    }

    return {
      runs,
      unreadable,
      notModified: false,
      validator: validatorFrom(res.headers, tokenGen),
    };
  }

  async rateLimit(org: string): Promise<{ limit: number; remaining: number }> {
    if (!this.orgOctokitFor) {
      throw new Error(
        "rateLimit needs an org resolver; this client was built without one",
      );
    }
    const gh = await this.orgOctokitFor(org);
    const { data } = await gh.request("GET /rate_limit");
    const core = (
      data as { resources?: { core?: { limit?: number; remaining?: number } } }
    ).resources?.core;
    return { limit: core?.limit ?? 0, remaining: core?.remaining ?? 0 };
  }

  async mergePR(repo: RepoRef, prNumber: number): Promise<void> {
    const gh = await this.client(repo);
    await gh.pulls.merge({
      owner: repo.owner,
      repo: repo.name,
      pull_number: prNumber,
      merge_method: "squash",
    });
  }

  async pushTag(repo: RepoRef, tag: string, sha: string): Promise<void> {
    const gh = await this.client(repo);
    await gh.git.createRef({
      owner: repo.owner,
      repo: repo.name,
      ref: `refs/tags/${tag}`,
      sha,
    });
  }

  async rerunFailedJobs(repo: RepoRef, runId: number): Promise<void> {
    const gh = await this.client(repo);
    await gh.actions.reRunWorkflowFailedJobs({
      owner: repo.owner,
      repo: repo.name,
      run_id: runId,
    });
  }

  async requestDependabotRebase(
    repo: RepoRef,
    prNumber: number,
  ): Promise<void> {
    const gh = await this.client(repo);
    await gh.issues.createComment({
      owner: repo.owner,
      repo: repo.name,
      issue_number: prNumber,
      body: "@dependabot rebase",
    });
  }
}

/**
 * Translate a failed probe on OBSERVED behaviour, never on documented codes.
 *
 * Both failures are 403 and differ only in the message, so status alone cannot
 * tell "you switched this off" from "I cannot reach this". Anything not
 * recognised is `unknown`: guessing between the two would produce either a
 * false accusation about the operator's settings or a false claim of
 * inaccessibility, and both read as confident.
 */
export function translateDependabotProbe(err: unknown): DependabotAccess {
  // Aborted requests can surface a null rejection. Dereferencing it would throw
  // inside a catch block, escape the probe, and fail the whole installation
  // run, turning one repository's odd rejection into zero coverage rows.
  if (typeof err !== "object" || err === null) return "unknown";
  const e = err as { status?: number; message?: string };
  const message = (e.message ?? "").toLowerCase();
  if (e.status === 403 && message.includes("disabled for this repository")) {
    return "alerts_disabled";
  }
  if (e.status === 403 && message.includes("not accessible by integration")) {
    return "unreachable";
  }
  // 404 is how GitHub hides a repository the caller may not see at all.
  if (e.status === 404) return "unreachable";
  return "unknown";
}

/**
 * Build a GitHubPort from environment, resolving each repo's installation via
 * the App and caching installation-scoped clients.
 */
export function createGitHubFromEnv(
  isAllowed: (repo: RepoRef) => boolean,
  env = process.env,
): GitHubPort {
  const auth: AppAuthConfig = loadAppAuthFromEnv(env);
  const appClient = new Octokit({ authStrategy: createAppAuth, auth });
  const cache = new Map<number, Octokit>();

  const resolver: OctokitResolver = async (repo) => {
    const { data } = await appClient.apps.getRepoInstallation({
      owner: repo.owner,
      repo: repo.name,
    });
    let client = cache.get(data.id);
    if (!client) {
      client = installationOctokit(auth, data.id);
      cache.set(data.id, client);
    }
    return client;
  };

  const orgCache = new Map<string, Octokit>();
  const orgResolver: OrgOctokitResolver = async (org) => {
    const cached = orgCache.get(org);
    if (cached) return cached;
    const { data } = await appClient.apps.getOrgInstallation({ org });
    const client = installationOctokit(auth, data.id);
    orgCache.set(org, client);
    return client;
  };

  return new OctokitGitHub(resolver, isAllowed, orgResolver);
}

/**
 * Maps one org-level alert payload. Defensive by design: the endpoint's shape
 * has grown over time (EPSS is a recent addition) and a field the installed
 * Octokit types do not know about would otherwise be dropped silently.
 */
function toDependabotAlert(
  raw: unknown,
  /** The repository the caller asked about, when the payload cannot say. */
  knownRepo?: RepoRef,
): RawDependabotAlert | null {
  const a = raw as {
    number?: number;
    state?: string;
    html_url?: string;
    created_at?: string;
    repository?: { name?: string; owner?: { login?: string } };
    dependency?: {
      package?: { name?: string; ecosystem?: string };
      relationship?: string;
      scope?: string;
    };
    security_advisory?: {
      ghsa_id?: string;
      cve_id?: string | null;
      severity?: string;
      epss?: { percentage?: number; percentile?: number } | null;
    };
  };
  // The org-level listing names the repository on every alert; the
  // per-repository listing does NOT - measured 2026-08-21, `repository` is
  // absent from that payload entirely, because the URL already said which
  // repository it is. Without the fallback every alert from the
  // personal-account fan-out failed to map, and the lane reported 31
  // unreadable payloads and zero alerts for repositories that had them.
  const owner = a.repository?.owner?.login ?? knownRepo?.owner;
  const name = a.repository?.name ?? knownRepo?.name;
  if (typeof a.number !== "number" || !owner || !name) return null;

  return {
    number: a.number,
    repo: { owner, name },
    state: (a.state ?? "open") as RawDependabotAlert["state"],
    severity: a.security_advisory?.severity ?? "unknown",
    ghsaId: a.security_advisory?.ghsa_id ?? null,
    cveId: a.security_advisory?.cve_id ?? null,
    packageName: a.dependency?.package?.name ?? null,
    ecosystem: a.dependency?.package?.ecosystem ?? null,
    epssPercentage: a.security_advisory?.epss?.percentage ?? null,
    epssPercentile: a.security_advisory?.epss?.percentile ?? null,
    relationship: a.dependency?.relationship ?? null,
    scope: a.dependency?.scope ?? null,
    htmlUrl: a.html_url ?? null,
    // Null, not "": an empty string reaches core/stamp.ts and throws there
    // instead of being visibly absent here.
    createdAt: a.created_at ?? null,
  };
}

/** App-level reads, authenticated as the App rather than an installation. */
export class OctokitGitHubApp implements GitHubAppPort {
  private readonly clients = new Map<number, Octokit>();

  /**
   * Takes its credentials rather than reading the environment, so it stays
   * usable by either App and by a caller that loaded its key from somewhere
   * other than `process.env`.
   */
  constructor(
    private readonly app: Octokit,
    private readonly auth: AppAuthConfig,
    /** Test seam, threaded to the per-installation clients built below. */
    private readonly fetchImpl?: typeof fetch,
  ) {}

  async identity(): Promise<AppIdentity> {
    const { data } = await this.app.apps.getAuthenticated();
    const permissions = data?.permissions as Record<string, string> | undefined;
    return {
      slug: data?.slug ?? null,
      name: data?.name ?? null,
      // null, not {}. An empty object is indistinguishable from "this App holds
      // no permissions", which a caller checking for write access would read as
      // proof of safety. Absent means we could not tell.
      permissions: permissions ?? null,
    };
  }

  async listInstallations(): Promise<InstallationRef[]> {
    const data = await this.app.paginate(this.app.apps.listInstallations, {
      per_page: 100,
    });
    return data.map((i) => {
      // Enterprise installations carry a slug rather than a login. A synthetic
      // fallback that can never match a real owner is worse than saying so: it
      // would silently orphan every repository under that account.
      const account = i.account as
        | { login?: string; slug?: string; type?: string }
        | null
        | undefined;
      // Read, never inferred. Anything unrecognised stays `unknown`, which
      // the adapter treats as an organisation: that is what it did before
      // user accounts existed here, so an unfamiliar account type cannot
      // silently change how an installation is swept.
      const type = account?.type;
      return {
        id: i.id,
        account: account?.login ?? account?.slug ?? null,
        repositorySelection: i.repository_selection ?? "unknown",
        accountKind:
          type === "User"
            ? ("user" as const)
            : type === "Organization"
              ? ("organization" as const)
              : ("unknown" as const),
      };
    });
  }

  async listInstallationRepos(installationId: number): Promise<RepoRef[]> {
    let client = this.clients.get(installationId);
    if (!client) {
      // Cached: building one re-reads the private key from disk and mints a
      // fresh installation token, and a diagnosis walks every installation.
      // Disciplined like every other collector client (AD-24): these hit
      // installation buckets, and an undisciplined one here would be the
      // only requests in the system with no retry-after handling.
      client = withRequestDiscipline(
        this.fetchImpl
          ? new Octokit({
              authStrategy: createAppAuth,
              auth: { ...this.auth, installationId },
              request: { fetch: this.fetchImpl },
            })
          : installationOctokit(this.auth, installationId),
      );
      this.clients.set(installationId, client);
    }
    const repos = await client.paginate(
      client.apps.listReposAccessibleToInstallation,
      { per_page: 100 },
    );
    return repos.map((r) => ({ owner: r.owner.login, name: r.name }));
  }
}

/** Build the App-level client for gitricorder's read-only App (AD-21). */
export function createTricorderAppFromEnv(
  env = process.env,
  /** Test seam only, like createTricorderReadPort's: it exists so a test
   * can prove the discipline hook rides the client THIS factory builds. */
  fetchImpl?: typeof fetch,
): GitHubAppPort {
  const auth = loadAppAuthFromEnv(env, "TRICORDER");
  return new OctokitGitHubApp(
    // Disciplined like the installation clients (AD-24): listInstallations
    // runs at startup and again on every resolver miss, and those are
    // collector requests too, on the App's own JWT bucket.
    withRequestDiscipline(
      new Octokit({
        authStrategy: createAppAuth,
        auth,
        ...(fetchImpl ? { request: { fetch: fetchImpl } } : {}),
      }),
    ),
    auth,
    fetchImpl,
  );
}

/**
 * Build gitricorder's read port over its read-only App (AD-21).
 *
 * Installation clients are resolved once and cached: minting one re-reads the
 * private key and issues a token request, and a cycle touches every
 * installation.
 *
 * Octokit's own request logging is silenced by default. The coverage lane
 * EXPECTS 403s, one per repository with Dependabot switched off, and printing
 * each as a raw warning would put fourteen alarming lines in front of an
 * operator on a healthy run. Nothing is lost: every lane records its outcome
 * and detail in the store and logs it with lane, installation and scope
 * attached (AD-16), which is strictly more than the raw line carried. Set
 * TRICORDER_VERBOSE to get them back while debugging.
 */
export async function createTricorderReadPort(
  appPort: GitHubAppPort,
  /** repos.yaml is the entire universe (AD-10); the adapter enforces it too. */
  isAllowed: (repo: RepoRef) => boolean,
  env: NodeJS.ProcessEnv = process.env,
  /**
   * Test seam only: the transport handed to each installation Octokit. It
   * exists so a test can prove the discipline hook is attached to the
   * clients THIS factory builds - the wrapper was deletable with a green
   * suite, because every discipline test constructed its own client.
   */
  fetchImpl?: typeof fetch,
): Promise<GitHubReadPort> {
  const auth = loadAppAuthFromEnv(env, "TRICORDER");
  const verbose = (env.TRICORDER_VERBOSE ?? "").trim() !== "";
  const quiet = {
    debug: () => {},
    info: () => {},
    warn: verbose ? console.error : () => {},
    error: verbose ? console.error : () => {},
  };

  const byAccount = new Map<string, number>();
  const kindByAccount = new Map<string, AccountKind>();
  for (const i of await appPort.listInstallations()) {
    if (i.account) {
      byAccount.set(i.account.toLowerCase(), i.id);
      kindByAccount.set(i.account.toLowerCase(), i.accountKind);
    }
  }

  const clients = new Map<number, Octokit>();
  const clientFor = (id: number): Octokit => {
    let c = clients.get(id);
    if (!c) {
      // Every collector request flows through the discipline hook (AD-24):
      // honour retry-after once, fail fast and legibly on primary exhaustion.
      c = withRequestDiscipline(
        new Octokit({
          authStrategy: createAppAuth,
          auth: { ...auth, installationId: id },
          log: quiet,
          ...(fetchImpl ? { request: { fetch: fetchImpl } } : {}),
        }),
      );
      clients.set(id, c);
    }
    return c;
  };

  let resolved = false;
  const forAccount = async (account: string): Promise<Octokit> => {
    let id = byAccount.get(account.toLowerCase());
    if (id === undefined && !resolved) {
      // Re-resolve once per miss. Installation ids change when an App is
      // uninstalled and reinstalled, which is exactly what an operator does
      // after `doctor` reports a problem, and a cache fixed at startup would
      // fail that organisation every cycle until somebody restarted the
      // container, with nothing in the log suggesting that.
      resolved = true;
      for (const i of await appPort.listInstallations()) {
        if (i.account) {
          byAccount.set(i.account.toLowerCase(), i.id);
          kindByAccount.set(i.account.toLowerCase(), i.accountKind);
        }
      }
      clients.clear();
      id = byAccount.get(account.toLowerCase());
    }
    if (id === undefined) {
      // Named rather than guessed. The doctor reports this case up front, and
      // a lane that hit it should say which account, not "not accessible".
      throw new Error(
        `the gitricorder App is not installed on ${account}; run "tricorder doctor"`,
      );
    }
    return clientFor(id);
  };

  // The guard is kept, not passed as `() => true`. Both current lanes filter
  // by their own watched set, so it is redundant today; the next lane to call a
  // per-repository method would otherwise get no guard at all, silently.
  return new OctokitGitHub(
    async (repo) => forAccount(repo.owner),
    isAllowed,
    forAccount,
    // Unknown until the installations resolve, and unknown is treated as an
    // organisation: that is the behaviour every account had before user
    // accounts were handled, so an unfamiliar type cannot quietly change
    // how an installation is swept.
    (login) => kindByAccount.get(login.toLowerCase()) ?? "unknown",
  );
}
