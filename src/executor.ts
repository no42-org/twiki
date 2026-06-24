/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { Config } from "./config.js";
import { resolvePolicy } from "./config.js";
import { canRebase, canRerunCi, isSettled, mergeBlock } from "./gates.js";
import type { GitHubPort } from "./github/port.js";
import type { Plan, RepoPlan } from "./plan.js";
import type {
  PrOutcome,
  ReleaseOutcome,
  RemediationOutcome,
  RepoResult,
  RunResult,
} from "./result.js";
import { nextPatchTag } from "./semver.js";
import {
  type PullRequest,
  type RepoFacts,
  type RepoPolicy,
  repoSlug,
  type WorkflowRunRef,
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
    const remediations = await remediate(
      facts,
      policy,
      config,
      github,
      enforce,
    );
    return {
      repo: slug,
      mainRed: facts.mainChecks === "red",
      prs,
      release,
      mainFailingChecks: facts.mainFailingChecks,
      remediations,
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

/**
 * CI remediation (spec: ci-remediation). Re-validates the pure eligibility
 * predicates against fresh facts, then — in enforce mode only — re-runs failed
 * jobs and requests Dependabot rebases. Disabled entirely when
 * `config.remediation.enabled` is false (diagnostics are still gathered/reported).
 * The advisor is never consulted here.
 */
async function remediate(
  facts: RepoFacts,
  policy: RepoPolicy,
  config: Config,
  github: GitHubPort,
  enforce: boolean,
): Promise<RemediationOutcome[]> {
  if (!config.remediation.enabled) return [];
  const { maxAttempts } = config.remediation;
  const out: RemediationOutcome[] = [];

  // Re-run: gather eligible runs from PR heads and main, deduped by run id.
  const eligibleRuns = new Map<number, WorkflowRunRef>();
  const allRuns: WorkflowRunRef[] = [
    ...facts.prs.flatMap((pr) => pr.workflowRuns ?? []),
    ...(facts.mainWorkflowRuns ?? []),
  ];
  for (const run of allRuns) {
    if (canRerunCi(run, maxAttempts)) eligibleRuns.set(run.runId, run);
  }
  // Each write is best-effort: a remediation failure (e.g. a 403 before the
  // Actions:write grant is approved, or a transient API error) must NOT discard
  // the merge/release outcomes already computed for this repo, nor abort the
  // remaining remediations. The action is simply retried on the next tick.
  for (const run of eligibleRuns.values()) {
    if (
      enforce &&
      !(await tryWrite(() => github.rerunFailedJobs(facts.repo, run.runId)))
    ) {
      continue;
    }
    out.push({
      kind: "rerun",
      status: enforce ? "reran" : "would-rerun",
      ref: `run ${run.runId}`,
      detail: `attempt ${run.runAttempt}/${maxAttempts}`,
    });
  }

  // Rebase: per eligible Dependabot PR.
  for (const pr of facts.prs) {
    if (!canRebase(pr, policy)) continue;
    if (
      enforce &&
      !(await tryWrite(() =>
        github.requestDependabotRebase(facts.repo, pr.number),
      ))
    ) {
      continue;
    }
    out.push({
      kind: "rebase",
      status: enforce ? "rebased" : "would-rebase",
      ref: `#${pr.number}`,
      detail: `behind by ${pr.behindBy}`,
    });
  }

  return out;
}

/** Run a remediation write; return false (and swallow) if it fails. */
async function tryWrite(fn: () => Promise<void>): Promise<boolean> {
  try {
    await fn();
    return true;
  } catch {
    return false;
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
    return {
      ...base,
      status: "blocked",
      detail: `gate: ${block}`,
      ...(block === "ci-not-green" && pr.failingChecks?.length
        ? { failingChecks: pr.failingChecks }
        : {}),
    };
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
      detail: settledBlockers(facts, policy).join(" "),
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
    reasons.push("mergeable Dependabot PRs still open.");
  }
  if (facts.unreleasedDependencyCommits <= 0) {
    reasons.push("🎉 Dependencies up to date.");
  }
  if (facts.mainChecks !== "green") {
    reasons.push(
      facts.mainChecks === "pending"
        ? "⚙️ CI/CD is running."
        : `main is ${facts.mainChecks}.`,
    );
  }
  return reasons.length > 0 ? reasons : ["not settled."];
}
