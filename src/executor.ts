/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { Config } from "./config.js";
import { resolvePolicy } from "./config.js";
import { isSettled, mergeBlock } from "./gates.js";
import type { GitHubPort } from "./github/port.js";
import type { Plan, RepoPlan } from "./plan.js";
import type {
  PrOutcome,
  ReleaseOutcome,
  RepoResult,
  RunResult,
} from "./result.js";
import { nextPatchTag } from "./semver.js";
import {
  type PullRequest,
  type RepoFacts,
  type RepoPolicy,
  repoSlug,
} from "./types.js";

// The executor: the ONLY component that mutates GitHub. It re-validates every
// gate against current facts before acting, independent of the advisor plan, so
// the plan can only narrow outcomes. In shadow mode it runs the identical
// pipeline but performs no writes (D8).

export async function applyPlan(
  factsList: RepoFacts[],
  plan: Plan,
  config: Config,
  github: GitHubPort,
): Promise<RunResult> {
  const repos: RepoResult[] = [];
  for (const facts of factsList) {
    repos.push(await applyRepo(facts, plan, config, github));
  }
  return { mode: config.mode, repos };
}

async function applyRepo(
  facts: RepoFacts,
  plan: Plan,
  config: Config,
  github: GitHubPort,
): Promise<RepoResult> {
  const slug = repoSlug(facts.repo);
  const policy = resolvePolicy(config, facts.repo);
  const repoPlan = plan.repos.find((r) => r.repo === slug);
  const enforce = config.mode === "enforce";

  try {
    const prs = await evaluatePrs(facts, policy, repoPlan, github, enforce);
    const release = await evaluateRelease(facts, policy, github, enforce);
    return {
      repo: slug,
      mainRed: facts.mainChecks === "red",
      prs,
      release,
    };
  } catch (err) {
    return {
      repo: slug,
      mainRed: facts.mainChecks === "red",
      prs: [],
      release: { status: "waiting", detail: "repo errored" },
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function evaluatePrs(
  facts: RepoFacts,
  policy: RepoPolicy,
  repoPlan: RepoPlan | undefined,
  github: GitHubPort,
  enforce: boolean,
): Promise<PrOutcome[]> {
  const out: PrOutcome[] = [];
  for (const pr of facts.prs) {
    out.push(await evaluatePr(pr, policy, repoPlan, github, enforce));
  }
  return out;
}

async function evaluatePr(
  pr: PullRequest,
  policy: RepoPolicy,
  repoPlan: RepoPlan | undefined,
  github: GitHubPort,
  enforce: boolean,
): Promise<PrOutcome> {
  const base = { number: pr.number, title: pr.title, security: pr.isSecurity };

  // Majors (and indeterminate bumps) are never auto-merged — always flagged.
  if (pr.bump.level === "major" || pr.bump.indeterminate) {
    const urgency = pr.isSecurity ? "URGENT security major" : "major bump";
    return {
      ...base,
      status: "flagged-major",
      detail: `${urgency} — needs human review`,
    };
  }

  const decision = repoPlan?.prDecisions.find((d) => d.number === pr.number);

  // No advisory decision → conservatively hold.
  if (!decision || decision.action === "hold") {
    return {
      ...base,
      status: "held",
      detail: decision?.reason ?? "no advisor decision — held",
    };
  }

  // Advisor said merge — re-validate the gate independently before acting.
  const block = mergeBlock(pr, policy);
  if (block !== null) {
    return { ...base, status: "blocked", detail: `gate: ${block}` };
  }

  if (enforce) {
    await github.mergePR(pr.repo, pr.number);
    return { ...base, status: "merged", detail: decision.reason };
  }
  return { ...base, status: "would-merge", detail: decision.reason };
}

async function evaluateRelease(
  facts: RepoFacts,
  policy: RepoPolicy,
  github: GitHubPort,
  enforce: boolean,
): Promise<ReleaseOutcome> {
  if (!isSettled(facts, policy)) {
    return {
      status: "waiting",
      detail: settledBlockers(facts, policy).join("; "),
    };
  }

  // Settled — but these repo-level conditions still block an actual release and
  // are reported distinctly (spec batch-release).
  if (policy.mergeOnly) {
    return { status: "skipped-merge-only", detail: "repo is merge-only" };
  }
  if (!facts.hasTagReleaseWorkflow) {
    return {
      status: "no-release-workflow",
      detail: "settled but no tag-triggered release workflow",
    };
  }

  // Re-check the latest tag immediately before tagging to avoid racing a
  // concurrent human release (D2/D4).
  const freshTag = await github.latestTag(facts.repo);
  const version = nextPatchTag(freshTag);

  if (enforce) {
    const sha = await github.defaultBranchSha(facts.repo);
    await github.pushTag(facts.repo, version, sha);
    return { status: "released", version, detail: "patch release tagged" };
  }
  return {
    status: "would-release",
    version,
    detail: "would tag patch release",
  };
}

function settledBlockers(facts: RepoFacts, policy: RepoPolicy): string[] {
  const reasons: string[] = [];
  if (facts.prs.some((pr) => mergeBlock(pr, policy) === null)) {
    reasons.push("mergeable Dependabot PRs still open");
  }
  if (facts.mainChecks !== "green") reasons.push(`main is ${facts.mainChecks}`);
  if (facts.unreleasedDependencyCommits <= 0) {
    reasons.push("no unreleased dependency changes");
  }
  return reasons.length > 0 ? reasons : ["not settled"];
}
