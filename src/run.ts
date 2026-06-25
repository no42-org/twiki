/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import {
  type Advisor,
  type AdvisorRepoInput,
  toAdvisorFacts,
} from "./advisor.js";
import type { AuditSink } from "./audit.js";
import { type Config, resolvePolicy } from "./config.js";
import { applyPlan } from "./executor.js";
import { gatherFacts } from "./facts.js";
import type { GitHubPort } from "./github/port.js";
import type { Notifier } from "./notify.js";
import type { Plan } from "./plan.js";
import { buildDigest, hasActionableActivity } from "./report.js";
import type { RepoResult, RunResult } from "./result.js";
import { type RepoFacts, repoSlug } from "./types.js";

// Orchestrates a single tick: gather facts → advisor plan → execute (gated) →
// report → audit. Resilient at every step — a single repo (or the advisor)
// failing degrades conservatively rather than aborting the run.

export interface RunDeps {
  github: GitHubPort;
  advisor: Advisor;
  notifier: Notifier;
  audit: AuditSink;
  /** Injected clock so runs are deterministic in tests. */
  now: () => string;
  log?: (msg: string) => void;
}

export async function runOnce(
  config: Config,
  deps: RunDeps,
): Promise<RunResult> {
  const log = deps.log ?? (() => {});
  const good: RepoFacts[] = [];
  const errored: RepoResult[] = [];

  for (const repo of config.repos) {
    try {
      good.push(await gatherFacts(deps.github, repo));
    } catch (err) {
      errored.push({
        repo: repoSlug(repo),
        mainRed: false,
        prs: [],
        release: { status: "waiting", detail: "fact-gathering failed" },
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const plan = await safePlan(good, config, deps, log);
  const result = await applyPlan(good, plan, config, deps.github);
  result.repos.push(...errored);

  // Skip purely-routine ticks (nothing to release, deps up to date) so the
  // channel isn't spammed every poll; the audit log still records every tick.
  if (hasActionableActivity(result)) {
    const digest = buildDigest(result);
    try {
      await deps.notifier.send(digest);
    } catch (err) {
      log(`notify failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    log("no actionable activity this tick — digest suppressed");
  }
  deps.audit.record(result, deps.now());
  return result;
}

/**
 * Get the advisor plan, degrading to an empty plan on failure. An empty plan
 * means no PR has a `merge` decision, so the executor holds everything —
 * conservative by construction.
 */
async function safePlan(
  good: RepoFacts[],
  config: Config,
  deps: RunDeps,
  log: (msg: string) => void,
): Promise<Plan> {
  if (good.length === 0) return { repos: [] };
  const input: AdvisorRepoInput[] = good.map((facts) => ({
    facts: toAdvisorFacts(facts),
    policy: resolvePolicy(config, facts.repo),
  }));
  try {
    return await deps.advisor.plan(input);
  } catch (err) {
    log(
      `advisor failed, holding all: ${err instanceof Error ? err.message : String(err)}`,
    );
    return { repos: [] };
  }
}
