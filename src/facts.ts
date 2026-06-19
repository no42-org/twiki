/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { GitHubPort } from "./github/port.js";
import { classifyBump } from "./semver.js";
import type { PullRequest, RepoFacts, RepoRef } from "./types.js";

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

  const prs: PullRequest[] = await Promise.all(
    rawPrs.map(async (raw): Promise<PullRequest> => {
      const checks = await github.prChecks(repo, raw.headSha);
      return {
        repo,
        number: raw.number,
        title: raw.title,
        branch: raw.branch,
        headSha: raw.headSha,
        isSecurity: raw.isSecurity,
        body: raw.body,
        checks,
        bump: classifyBump(
          raw.dependency?.from,
          raw.dependency?.to,
          raw.dependency?.name,
        ),
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
  };
}
