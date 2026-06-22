/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { Advisor, AdvisorRepoInput } from "../src/advisor.js";
import type { GitHubPort, RawPullRequest } from "../src/github/port.js";
import type { Notifier } from "../src/notify.js";
import type { Plan } from "../src/plan.js";
import {
  type Bump,
  type CheckStatus,
  type FailingCheck,
  type PullRequest,
  type RepoFacts,
  type RepoRef,
  repoSlug,
  type WorkflowRunRef,
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
    isDependabot: true,
    bump: makeBump(),
    checks: "green",
    body: "",
    ...partial,
  };
}

export function makeRun(partial: Partial<WorkflowRunRef> = {}): WorkflowRunRef {
  return {
    runId: 100,
    runAttempt: 1,
    status: "completed",
    conclusion: "failure",
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
  constructor(
    private readonly impl: Plan | ((i: AdvisorRepoInput[]) => Plan),
  ) {}
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
  /** Failing checks keyed by ref (PR head SHA, or the main SHA = defaultSha). */
  failing?: Record<string, FailingCheck[]>;
  /** Workflow runs keyed by SHA (PR head SHA, or the main SHA = defaultSha). */
  workflowRuns?: Record<string, WorkflowRunRef[]>;
  /** behind_by keyed by PR head SHA. */
  behindByMap?: Record<string, number | null>;
}

export class FakeGitHub implements GitHubPort {
  merged: { repo: string; number: number }[] = [];
  tagged: { repo: string; tag: string; sha: string }[] = [];
  reran: { repo: string; runId: number }[] = [];
  rebased: { repo: string; number: number }[] = [];

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
  async failingChecks(repo: RepoRef, ref: string): Promise<FailingCheck[]> {
    return this.get(repo).failing?.[ref] ?? [];
  }
  async workflowRunsForSha(
    repo: RepoRef,
    sha: string,
  ): Promise<WorkflowRunRef[]> {
    return this.get(repo).workflowRuns?.[sha] ?? [];
  }
  async behindBy(repo: RepoRef, headSha: string): Promise<number | null> {
    // Default null (unknown/fail-closed), matching the real adapter on error.
    return this.get(repo).behindByMap?.[headSha] ?? null;
  }
  async mergePR(repo: RepoRef, prNumber: number): Promise<void> {
    this.merged.push({ repo: repoSlug(repo), number: prNumber });
  }
  async pushTag(repo: RepoRef, tag: string, sha: string): Promise<void> {
    this.tagged.push({ repo: repoSlug(repo), tag, sha });
  }
  async rerunFailedJobs(repo: RepoRef, runId: number): Promise<void> {
    this.reran.push({ repo: repoSlug(repo), runId });
  }
  async requestDependabotRebase(
    repo: RepoRef,
    prNumber: number,
  ): Promise<void> {
    this.rebased.push({ repo: repoSlug(repo), number: prNumber });
  }
}

export { REPO };
