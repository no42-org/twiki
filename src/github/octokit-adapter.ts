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
  RawUpdatePr,
  RawUpdateStatus,
  RawWorkflowRun,
  RequestValidator,
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
 * GitHub caps search queries at 256 characters, so the watched repositories
 * are spread over as many queries as their slugs need. Pure and exported so
 * the packing (every repo present, every query under the cap, base qualifiers
 * on each) is testable without an API.
 */
export const SEARCH_QUERY_MAX = 256;
const ISSUE_SEARCH_BASE = "is:issue is:open no:assignee";

/** Pagination sanity cap: 50 pages is 5,000 open alerts in one org. */
export const MAX_ALERT_PAGES = 50;

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

export function issueSearchQueries(repos: readonly RepoRef[]): string[] {
  const queries: string[] = [];
  let current = ISSUE_SEARCH_BASE;
  for (const repo of repos) {
    const qualifier = ` repo:${repo.owner}/${repo.name}`;
    if (current.length + qualifier.length > SEARCH_QUERY_MAX) {
      queries.push(current);
      current = ISSUE_SEARCH_BASE + qualifier;
    } else {
      current += qualifier;
    }
  }
  if (current !== ISSUE_SEARCH_BASE) queries.push(current);
  return queries;
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
async function runNodeSearch(
  gh: Octokit,
  nodeType: "PullRequest" | "Issue",
  query: string,
): Promise<{ items: RawUpdatePr[]; unreadable: number; truncated: boolean }> {
  const items: RawUpdatePr[] = [];
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
               id
               number
               title
               url
               createdAt
               author { login }
               repository { name owner { login } }
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
      items.push({
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
      });
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
 * GitHubPort backed by Octokit. Scoped to the allowlist: every call asserts the
 * repo is permitted before touching the API (defense in depth — run.ts already
 * only passes allowlisted repos).
 */
export class OctokitGitHub implements GitHubPort {
  constructor(
    private readonly octokitFor: OctokitResolver,
    private readonly isAllowed: (repo: RepoRef) => boolean,
    private readonly orgOctokitFor?: OrgOctokitResolver,
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
    const client = await this.orgOctokitFor(org);
    const repos = await client.paginate(client.repos.listForOrg, {
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
    org: string,
    authors: readonly string[],
  ): Promise<UpdatePrPage> {
    if (!this.orgOctokitFor) {
      throw new Error(
        "listOpenUpdatePRs needs an org resolver; this client was built without one",
      );
    }
    const gh = await this.orgOctokitFor(org);
    // Search with explicit logins, never @me: an installation token has no
    // user identity, and the whole-account issue endpoints are excluded from
    // installation tokens entirely. Multiple author qualifiers OR together.
    const query = [
      `org:${org}`,
      "is:pr",
      "is:open",
      ...authors.map((a) => `author:${a}`),
    ].join(" ");

    const page = await runNodeSearch(gh, "PullRequest", query);
    return {
      prs: page.items,
      unreadable: page.unreadable,
      truncated: page.truncated,
    };
  }

  async listUntriagedIssues(repos: readonly RepoRef[]): Promise<IssuePage> {
    if (!this.orgOctokitFor) {
      throw new Error(
        "listUntriagedIssues needs an org resolver; this client was built without one",
      );
    }
    if (repos.length === 0)
      return { issues: [], unreadable: 0, truncated: false };
    const gh = await this.orgOctokitFor(repos[0]?.owner ?? "");

    // One search per query chunk. Scoped by repo: qualifiers, not org:, for
    // two reasons: `org:` matches only organization accounts, so a
    // personal-account installation would get a confident-empty "ok" sweep
    // every time; and an org-wide query counts every unwatched repository's
    // issues against the 1000-result ceiling, which can starve the watched
    // repositories out of the window entirely while still looking complete.
    const issues: RawIssue[] = [];
    let unreadable = 0;
    let truncated = false;
    for (const query of issueSearchQueries(repos)) {
      const page = await runNodeSearch(gh, "Issue", query);
      issues.push(...page.items);
      unreadable += page.unreadable;
      truncated = truncated || page.truncated;
    }
    return { issues, unreadable, truncated };
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

  async listOrgDependabotAlerts(
    org: string,
    cached: RequestValidator | null = null,
  ): Promise<OrgAlertPage> {
    if (!this.orgOctokitFor) {
      throw new Error(
        "listOrgDependabotAlerts needs an org resolver; this client was built without one",
      );
    }
    const gh = await this.orgOctokitFor(org);

    // A validator from a previous token generation is a guaranteed miss:
    // GitHub's ETags vary with the Authorization header. Cold, not sent. An
    // all-null validator is not a validator: sending nothing while treating
    // the request as conditional is how an unsolicited 304 gets honoured.
    // A null generation (auth carried no expiry) fails closed on both sides:
    // nothing is sent and nothing is cached, because a generation that
    // cannot be compared would otherwise compare equal across rotations.
    const tokenGen = await installationTokenGen(gh);
    const send =
      cached &&
      tokenGen !== null &&
      cached.tokenGen === tokenGen &&
      (cached.etag || cached.lastModified)
        ? cached
        : null;
    // Both headers when both exist, same rationale as the KEV path: RFC 9110
    // prefers If-None-Match, and a proxy honouring only Last-Modified still
    // gets its chance to answer 304 (AD-25).
    const conditionalHeaders: Record<string, string> = {};
    if (send?.etag) conditionalHeaders["if-none-match"] = send.etag;
    if (send?.lastModified) {
      conditionalHeaders["if-modified-since"] = send.lastModified;
    }

    // Paginated by link header rather than gh.paginate: the conditional
    // request needs the first page's response headers (etag, 304), which
    // paginate does not expose.
    const raw: unknown[] = [];
    let pages = 0;
    let firstEtag: string | null = null;
    let firstLastModified: string | null = null;
    let next: string | null = null;
    for (;;) {
      pages++;
      let res: {
        data: unknown;
        headers: Record<string, string | number | undefined>;
      };
      try {
        res = next
          ? await gh.request(`GET ${next}`)
          : await gh.request("GET /orgs/{org}/dependabot/alerts", {
              org,
              state: "open",
              per_page: 100,
              headers: conditionalHeaders,
            });
      } catch (err) {
        if ((err as { status?: number }).status === 304) {
          if (send && pages === 1) {
            // Byte-identical to the listing the validator came from. No
            // pages to walk: a single-page listing is the only kind we cache
            // for. The send guard already proved send.tokenGen === tokenGen,
            // so the cached validator goes back as it came.
            return {
              alerts: [],
              unreadable: 0,
              notModified: true,
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
      if (pages === 1) {
        firstEtag =
          typeof res.headers.etag === "string" ? res.headers.etag : null;
        firstLastModified =
          typeof res.headers["last-modified"] === "string"
            ? res.headers["last-modified"]
            : null;
      }
      if (!Array.isArray(res.data)) {
        // A proxy error page or unexpected object: spreading it would either
        // throw an illegible TypeError or spread a string character by
        // character into a nonsense unreadable count.
        throw new Error(
          `alert listing for ${org} returned a non-array body (page ${pages})`,
        );
      }
      raw.push(...(res.data as unknown[]));
      const link = typeof res.headers.link === "string" ? res.headers.link : "";
      next = nextLink(link);
      if (!next) break;
      // The cap is judged on the CLAIM of more pages, after the link parse:
      // a listing that genuinely ends at page MAX is served in full, while a
      // proxy echoing a self-referential Link header cannot loop this lane
      // forever. Hitting the cap is a fault, and a fault must not look like
      // the end of the listing.
      if (pages >= MAX_ALERT_PAGES) {
        throw new Error(
          `alert listing for ${org} claims more than ${MAX_ALERT_PAGES} pages; refusing to loop`,
        );
      }
      // The next URL is followed with the installation token attached, so it
      // must stay on GitHub's API origin: a proxy-injected Link header must
      // not be able to point the Authorization header at another host.
      if (!next.startsWith("https://api.github.com/")) {
        throw new Error(
          `alert listing for ${org} carried a cross-origin next link; refusing to follow it`,
        );
      }
    }

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
      notModified: false,
      // Only a listing that fit in one page gets a validator: each page
      // carries its own ETag, and a 304 on page one says nothing about the
      // pages behind it.
      // A validator earns caching only when it can make a request
      // conditional: an all-null one would count as "cached" while sending
      // no header, the unsolicited-304 state guarded against above.
      validator:
        pages === 1 && (firstEtag || firstLastModified) && tokenGen !== null
          ? { etag: firstEtag, lastModified: firstLastModified, tokenGen }
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
    const send =
      cached &&
      tokenGen !== null &&
      cached.tokenGen === tokenGen &&
      (cached.etag || cached.lastModified)
        ? cached
        : null;
    const headers: Record<string, string> = {};
    if (send?.etag) headers["if-none-match"] = send.etag;
    if (send?.lastModified) headers["if-modified-since"] = send.lastModified;

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

    const etag = typeof res.headers.etag === "string" ? res.headers.etag : null;
    const lastModified =
      typeof res.headers["last-modified"] === "string"
        ? res.headers["last-modified"]
        : null;
    return {
      runs,
      unreadable,
      notModified: false,
      validator:
        (etag || lastModified) && tokenGen !== null
          ? { etag, lastModified, tokenGen }
          : null,
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
function toDependabotAlert(raw: unknown): RawDependabotAlert | null {
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
  const owner = a.repository?.owner?.login;
  const name = a.repository?.name;
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
        | { login?: string; slug?: string }
        | null
        | undefined;
      return {
        id: i.id,
        account: account?.login ?? account?.slug ?? null,
        repositorySelection: i.repository_selection ?? "unknown",
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
  for (const i of await appPort.listInstallations()) {
    if (i.account) byAccount.set(i.account.toLowerCase(), i.id);
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
        if (i.account) byAccount.set(i.account.toLowerCase(), i.id);
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
  );
}
