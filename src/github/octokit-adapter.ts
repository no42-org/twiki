/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import type { CheckStatus, RepoRef } from "../types.js";
import { repoSlug } from "../types.js";
import {
  type AppAuthConfig,
  installationOctokit,
  loadAppAuthFromEnv,
} from "./auth.js";
import type { GitHubPort, RawPullRequest } from "./port.js";

const DEPENDABOT_LOGIN = "dependabot[bot]";

/** Resolves an installation-scoped Octokit for a given repo. */
export type OctokitResolver = (repo: RepoRef) => Promise<Octokit>;

/**
 * GitHubPort backed by Octokit. Scoped to the allowlist: every call asserts the
 * repo is permitted before touching the API (defense in depth — run.ts already
 * only passes allowlisted repos).
 */
export class OctokitGitHub implements GitHubPort {
  constructor(
    private readonly octokitFor: OctokitResolver,
    private readonly isAllowed: (repo: RepoRef) => boolean,
  ) {}

  private async client(repo: RepoRef): Promise<Octokit> {
    if (!this.isAllowed(repo)) {
      throw new Error(
        `Refusing to act on non-allowlisted repo ${repoSlug(repo)}`,
      );
    }
    return this.octokitFor(repo);
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
      (r) =>
        r.conclusion !== null &&
        [
          "failure",
          "timed_out",
          "cancelled",
          "action_required",
          "stale",
        ].includes(r.conclusion),
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
}

/** Parse "Bump <name> from <a> to <b>" (and common variants) from a PR title. */
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

  return new OctokitGitHub(resolver, isAllowed);
}
