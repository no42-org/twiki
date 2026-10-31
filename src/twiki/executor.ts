/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { Config } from "../core/config.js";
import { resolvePolicy } from "../core/config.js";
import {
  type PullRequest,
  type RepoFacts,
  type RepoPolicy,
  repoSlug,
  type WorkflowRunRef,
} from "../core/types.js";
import type { GitHubPort } from "../github/port.js";
import { canRebase, canRerunCi, mergeBlock } from "./gates.js";
import { statusOf } from "./operator-merge.js";
import type { Plan, RepoPlan } from "./plan.js";
import type {
  PrOutcome,
  RemediationOutcome,
  RepoResult,
  RunResult,
} from "./result.js";

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

  // Held OUTSIDE the try, so an action already performed survives whatever
  // fails after it. Nothing below currently throws: `evaluatePrs` returns its
  // write failure instead, and every write in `remediate` goes through
  // `tryWrite`. The catch is a backstop with no current path in. If a step
  // that can throw is added, or an unguarded call appears in `remediate`,
  // pin the backstop with a test that can fail, and hoist `remediations` too
  // if it can throw after remediations were performed.
  let prs: PrOutcome[] = [];
  const stopped = (error: string): RepoResult => ({
    repo: slug,
    mainRed: facts.mainChecks === "red",
    prs,
    mainFailingChecks: facts.mainFailingChecks,
    ...(facts.protection.state !== "protected"
      ? { protection: facts.protection }
      : {}),
    stoppedEarly: true,
    // Reported rather than derived from the gap: a reader counting
    // `facts.prs` against `prs` would need facts the result does not carry.
    notEvaluated: facts.prs.length - prs.length,
    error,
  });

  try {
    const evaluated = await evaluatePrs(
      facts,
      policy,
      repoPlan,
      github,
      enforce,
    );
    prs = evaluated.prs;
    if (evaluated.error !== undefined) {
      // A write refused. Stop this repository rather than issuing the
      // remaining ones: under a secondary rate limit, carrying on means
      // hammering the endpoint that just refused (AD-24), and under a
      // permissions failure it means N identical 403s. The next tick retries
      // from the beginning with fresh facts.
      return stopped(evaluated.error);
    }
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
      mainFailingChecks: facts.mainFailingChecks,
      ...(facts.protection.state !== "protected"
        ? { protection: facts.protection }
        : {}),
      remediations,
    };
  } catch (err) {
    // The backstop (see above: no current path in). Whatever completed is
    // kept. Not necessarily a write, so neither this result nor the digest
    // line claims one failed; `error` carries the real cause.
    return stopped(err instanceof Error ? err.message : String(err));
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
  // the merge outcomes already computed for this repo, nor abort the
  // remaining remediations. The action is simply retried on the next tick.
  for (const run of eligibleRuns.values()) {
    const ref = `run ${run.runId}`;
    if (enforce) {
      const failed = await tryWrite(() =>
        github.rerunFailedJobs(facts.repo, run.runId),
      );
      if (failed !== null) {
        out.push({
          kind: "rerun",
          status: "failed-rerun",
          ref,
          detail: failed,
        });
        continue;
      }
    }
    out.push({
      kind: "rerun",
      status: enforce ? "reran" : "would-rerun",
      ref,
      detail: `attempt ${run.runAttempt}/${maxAttempts}`,
    });
  }

  // Rebase: per eligible Dependabot PR.
  for (const pr of facts.prs) {
    if (!canRebase(pr, policy)) continue;
    const ref = `#${pr.number}`;
    if (enforce) {
      const failed = await tryWrite(() =>
        github.requestDependabotRebase(facts.repo, pr.number),
      );
      if (failed !== null) {
        out.push({
          kind: "rebase",
          status: "failed-rebase",
          ref,
          detail: failed,
        });
        continue;
      }
    }
    out.push({
      kind: "rebase",
      status: enforce ? "rebased" : "would-rebase",
      ref,
      detail: `behind by ${pr.behindBy}`,
    });
  }

  return out;
}

/**
 * Run a remediation write. Returns null on success, or the reason it failed.
 *
 * The reason is returned rather than swallowed because a bare `false` made
 * three different facts identical in the output: the grant is not approved
 * yet, the API errored transiently, and a secondary rate limit refused the
 * write. All three produced no remediation entry at all - which is also what
 * an INELIGIBLE pull request produces, since `canRebase` skips it before this
 * is reached. An operator reading "0 rebases" during a throttling episode saw
 * exactly what a healthy quiet run looks like.
 */
// Every write in `remediate` goes through this, which is load-bearing beyond
// this function: because nothing in `remediate` can throw, `applyRepo`'s
// backstop never has completed remediations to preserve, and can build a
// fresh result. An unguarded call added to `remediate` breaks that assumption silently.
async function tryWrite(fn: () => Promise<void>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}

/** What completed, and - when a write refused - which pull request and why. */
interface PrEvaluation {
  prs: PrOutcome[];
  error?: string;
}

async function evaluatePrs(
  facts: RepoFacts,
  policy: RepoPolicy,
  repoPlan: RepoPlan | undefined,
  github: GitHubPort,
  enforce: boolean,
): Promise<PrEvaluation> {
  const out: PrOutcome[] = [];
  for (const pr of facts.prs) {
    try {
      out.push(await evaluatePr(pr, policy, repoPlan, github, enforce));
    } catch (err) {
      // Returned, not thrown: throwing is what discarded `out` and cost the
      // record of every merge that had already landed.
      const reason = err instanceof Error ? err.message : String(err);
      return { prs: out, error: `#${pr.number}: ${reason}` };
    }
  }
  return { prs: out };
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
    try {
      await github.mergePR(pr.repo, pr.number);
    } catch (err) {
      // The operator merge listener runs beside this loop, so a click can land
      // this pull request after the facts were gathered. GitHub answers 405,
      // which also means "not mergeable", so only a re-read can tell them apart.
      if (statusOf(err) !== 405) throw err;
      const live = await github.livePullRequest(pr.repo, pr.number);
      if (live.state !== "MERGED") throw err;
      return {
        ...base,
        status: "already-merged",
        detail: "merged before this tick reached it, not by this tick",
      };
    }
    return { ...base, status: "merged", detail: decision.reason };
  }
  return { ...base, status: "would-merge", detail: decision.reason };
}
