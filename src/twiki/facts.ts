/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { classifyBump } from "../core/semver.js";
import type {
  FailingCheck,
  PullRequest,
  RepoFacts,
  RepoRef,
  WorkflowRunRef,
} from "../core/types.js";
import type { GitHubRepoReadPort } from "../github/port.js";

/**
 * Gather all decision-relevant facts for one repo, freshly from GitHub.
 *
 * Stateless by design (D4): every tick re-derives truth here, so a skipped or
 * repeated run self-heals. The PR `body` is carried through verbatim as
 * untrusted data for the advisor to read; it never influences the gates.
 */
export async function gatherFacts(
  github: GitHubRepoReadPort,
  repo: RepoRef,
): Promise<RepoFacts> {
  // Serial, all the way down. AD-24's first clause: requests are issued
  // serially per installation, as GitHub advises, never fanned out
  // concurrently within a bucket - and every call here shares one installation
  // token. Measured before this change on the live 15-pull-request shape: 126
  // requests at peak concurrency 30.
  //
  // The cost is about eleven seconds per repository per tick. twiki polls
  // hourly with nothing waiting on it, so the concurrency bought latency
  // nobody was spending.
  const rawPrs = await github.listOpenDependabotPRs(repo);
  const mainChecks = await github.branchChecks(repo, "main");
  const latestTag = await github.latestTag(repo);
  const hasTagReleaseWorkflow = await github.hasTagReleaseWorkflow(repo);
  const protection = await github.branchProtection(repo, "main");

  const unreleasedDependencyCommits = await github.dependabotCommitsSince(
    repo,
    latestTag,
  );

  // Remediation detail for `main` — only fetched when main is not green.
  let mainFailingChecks: FailingCheck[] | undefined;
  let mainWorkflowRuns: WorkflowRunRef[] | undefined;
  if (mainChecks !== "green") {
    const mainSha = await github.defaultBranchSha(repo);
    mainFailingChecks = await github.failingChecks(repo, mainSha);
    mainWorkflowRuns = await github.workflowRunsForSha(repo, mainSha);
  }

  // The one that mattered most: this was `Promise.all(rawPrs.map(...))`, so
  // its width was the number of open Dependabot pull requests - fifteen on
  // the measured repository, and whatever has piled up over a quiet fortnight
  // on any other. Nobody controls that number, which is what made it a burst
  // rather than a batch.
  const prs: PullRequest[] = [];
  for (const raw of rawPrs) {
    const checks = await github.prChecks(repo, raw.headSha);

    // Failing-check / workflow-run detail only when not green; behindBy only
    // when not red (a red PR is never rebase-eligible, so skip the API call).
    let failingChecks: FailingCheck[] | undefined;
    let workflowRuns: WorkflowRunRef[] | undefined;
    if (checks !== "green") {
      failingChecks = await github.failingChecks(repo, raw.headSha);
      workflowRuns = await github.workflowRunsForSha(repo, raw.headSha);
    }
    const behindBy =
      checks === "red" ? undefined : await github.behindBy(repo, raw.headSha);

    prs.push({
      repo,
      number: raw.number,
      title: raw.title,
      branch: raw.branch,
      headSha: raw.headSha,
      isSecurity: raw.isSecurity,
      isDependabot: true,
      body: raw.body,
      checks,
      bump: classifyBump(
        raw.dependency?.from,
        raw.dependency?.to,
        raw.dependency?.name,
      ),
      behindBy,
      failingChecks,
      workflowRuns,
    });
  }

  return {
    repo,
    mainChecks,
    latestTag,
    hasTagReleaseWorkflow,
    protection,
    unreleasedDependencyCommits,
    prs,
    mainFailingChecks,
    mainWorkflowRuns,
  };
}
