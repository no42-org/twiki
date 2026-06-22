/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { GitHubPort } from "./github/port.js";
import { classifyBump } from "./semver.js";
import type {
  FailingCheck,
  PullRequest,
  RepoFacts,
  RepoRef,
  WorkflowRunRef,
} from "./types.js";

/**
 * Gather all decision-relevant facts for one repo, freshly from GitHub.
 *
 * Stateless by design (D4): every tick re-derives truth here, so a skipped or
 * repeated run self-heals. The PR `body` is carried through verbatim as
 * untrusted data for the advisor to read; it never influences the gates.
 */
export async function gatherFacts(
  github: GitHubPort,
  repo: RepoRef,
): Promise<RepoFacts> {
  const [rawPrs, mainChecks, latestTag, hasTagReleaseWorkflow] =
    await Promise.all([
      github.listOpenDependabotPRs(repo),
      github.branchChecks(repo, "main"),
      github.latestTag(repo),
      github.hasTagReleaseWorkflow(repo),
    ]);

  const unreleasedDependencyCommits = await github.dependabotCommitsSince(
    repo,
    latestTag,
  );

  // Remediation detail for `main` — only fetched when main is not green.
  let mainFailingChecks: FailingCheck[] | undefined;
  let mainWorkflowRuns: WorkflowRunRef[] | undefined;
  if (mainChecks !== "green") {
    const mainSha = await github.defaultBranchSha(repo);
    [mainFailingChecks, mainWorkflowRuns] = await Promise.all([
      github.failingChecks(repo, mainSha),
      github.workflowRunsForSha(repo, mainSha),
    ]);
  }

  const prs: PullRequest[] = await Promise.all(
    rawPrs.map(async (raw): Promise<PullRequest> => {
      const checks = await github.prChecks(repo, raw.headSha);

      // Failing-check / workflow-run detail only when not green; behindBy only
      // when not red (a red PR is never rebase-eligible, so skip the API call).
      let failingChecks: FailingCheck[] | undefined;
      let workflowRuns: WorkflowRunRef[] | undefined;
      if (checks !== "green") {
        [failingChecks, workflowRuns] = await Promise.all([
          github.failingChecks(repo, raw.headSha),
          github.workflowRunsForSha(repo, raw.headSha),
        ]);
      }
      const behindBy =
        checks === "red" ? undefined : await github.behindBy(repo, raw.headSha);

      return {
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
      };
    }),
  );

  return {
    repo,
    mainChecks,
    latestTag,
    hasTagReleaseWorkflow,
    unreleasedDependencyCommits,
    prs,
    mainFailingChecks,
    mainWorkflowRuns,
  };
}
