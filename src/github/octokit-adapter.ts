/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
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
import type {
  AppIdentity,
  DependabotAccess,
  GitHubAppPort,
  GitHubPort,
  InstallationRef,
  OrgAlertPage,
  RawDependabotAlert,
  RawPullRequest,
  RawRepoMeta,
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
      // No installation resolves for this repository at all.
      return "unreachable";
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

  async listOrgDependabotAlerts(org: string): Promise<OrgAlertPage> {
    if (!this.orgOctokitFor) {
      throw new Error(
        "listOrgDependabotAlerts needs an org resolver; this client was built without one",
      );
    }
    const gh = await this.orgOctokitFor(org);
    const raw = await gh.paginate(gh.dependabot.listAlertsForOrg, {
      org,
      state: "open",
      per_page: 100,
    });

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
    return { alerts, unreadable };
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

/** Parse "Bump <name> from <a> to <b>" (and common variants) from a PR title. */
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

export function parseDependency(
  title: string,
): { name?: string; from?: string; to?: string } | undefined {
  const m = title.match(/bump\s+(\S+)\s+from\s+(\S+)\s+to\s+(\S+)/i);
  if (!m) return undefined;
  return { name: m[1], from: m[2], to: m[3] };
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
      client = installationOctokit(this.auth, installationId);
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
export function createTricorderAppFromEnv(env = process.env): GitHubAppPort {
  const auth = loadAppAuthFromEnv(env, "TRICORDER");
  return new OctokitGitHubApp(
    new Octokit({ authStrategy: createAppAuth, auth }),
    auth,
  );
}
