/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { Advisor, AdvisorRepoInput } from "../src/advisor.js";
import type { GitHubPort, RawPullRequest } from "../src/github/port.js";
import type { Plan } from "../src/plan.js";
import type { Notifier } from "../src/notify.js";
import {
  type Bump,
  type CheckStatus,
  type PullRequest,
  type RepoFacts,
  type RepoRef,
  repoSlug,
} from "../src/types.js";

const REPO: RepoRef = { owner: "no42-org", name: "demo" };

export function makeBump(partial: Partial<Bump> = {}): Bump {
  return { level: "patch", indeterminate: false, ...partial };
}

export function makePr(partial: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: REPO,
    number: 1,
    title: "Bump demo from 1.0.0 to 1.0.1",
    branch: "dependabot/demo-1.0.1",
    headSha: "sha-1",
    isSecurity: false,
    bump: makeBump(),
    checks: "green",
    body: "",
    ...partial,
  };
}

export function makeFacts(partial: Partial<RepoFacts> = {}): RepoFacts {
  return {
    repo: REPO,
    mainChecks: "green",
    latestTag: "v1.2.3",
    hasTagReleaseWorkflow: true,
    unreleasedDependencyCommits: 1,
    prs: [],
    ...partial,
  };
}

/** Advisor stub: returns a fixed plan, or one derived from the input. */
export class StubAdvisor implements Advisor {
  constructor(private readonly impl: Plan | ((i: AdvisorRepoInput[]) => Plan)) {}
  async plan(input: AdvisorRepoInput[]): Promise<Plan> {
    return typeof this.impl === "function" ? this.impl(input) : this.impl;
  }
}

/** Advisor that recommends merging every PR the executor is shown. */
export const mergeEverythingAdvisor = new StubAdvisor((input) => ({
  repos: input.map(({ facts }) => ({
    repo: repoSlug(facts.repo),
    prDecisions: facts.prs.map((pr) => ({
      number: pr.number,
      action: "merge" as const,
      reason: "stub: merge",
      risk: "low" as const,
    })),
    release: { action: "release" as const, reason: "stub: release" },
  })),
}));

export class CapturingNotifier implements Notifier {
  messages: string[] = [];
  async send(text: string): Promise<void> {
    this.messages.push(text);
  }
}

export interface FakeRepoData {
  rawPrs: RawPullRequest[];
  prChecks: Record<string, CheckStatus>;
  mainChecks: CheckStatus;
  latestTag: string | null;
  unreleased: number;
  hasWorkflow: boolean;
  defaultSha: string;
}

export class FakeGitHub implements GitHubPort {
  merged: { repo: string; number: number }[] = [];
  tagged: { repo: string; tag: string; sha: string }[] = [];

  constructor(private readonly data: Map<string, FakeRepoData>) {}

  private get(repo: RepoRef): FakeRepoData {
    const d = this.data.get(repoSlug(repo));
    if (!d) throw new Error(`no fake data for ${repoSlug(repo)}`);
    return d;
  }

  async listOpenDependabotPRs(repo: RepoRef): Promise<RawPullRequest[]> {
    return this.get(repo).rawPrs;
  }
  async prChecks(repo: RepoRef, headSha: string): Promise<CheckStatus> {
    return this.get(repo).prChecks[headSha] ?? "pending";
  }
  async branchChecks(repo: RepoRef): Promise<CheckStatus> {
    return this.get(repo).mainChecks;
  }
  async latestTag(repo: RepoRef): Promise<string | null> {
    return this.get(repo).latestTag;
  }
  async dependabotCommitsSince(repo: RepoRef): Promise<number> {
    return this.get(repo).unreleased;
  }
  async hasTagReleaseWorkflow(repo: RepoRef): Promise<boolean> {
    return this.get(repo).hasWorkflow;
  }
  async defaultBranchSha(repo: RepoRef): Promise<string> {
    return this.get(repo).defaultSha;
  }
  async mergePR(repo: RepoRef, prNumber: number): Promise<void> {
    this.merged.push({ repo: repoSlug(repo), number: prNumber });
  }
  async pushTag(repo: RepoRef, tag: string, sha: string): Promise<void> {
    this.tagged.push({ repo: repoSlug(repo), tag, sha });
  }
}

export { REPO };
