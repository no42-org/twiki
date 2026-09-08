/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { Config } from "../core/config.js";
import { resolvePolicy } from "../core/config.js";
import { nextPatchTag } from "../core/semver.js";
import {
  type PullRequest,
  type RepoFacts,
  type RepoPolicy,
  type RepoRef,
  repoSlug,
  type VersionSource,
  type WorkflowRunRef,
} from "../core/types.js";
import { matchVersion, versionsAgree } from "../core/version-agreement.js";
import type { GitHubPort } from "../github/port.js";
import { TagExistsError } from "../github/port.js";
import { canRebase, canRerunCi, isSettled, mergeBlock } from "./gates.js";
import type { Plan, RepoPlan } from "./plan.js";
import type {
  PrOutcome,
  ReleaseOutcome,
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

  // Held OUTSIDE the try. Everything below can fail against GitHub, and an
  // action already performed must survive whatever fails after it: twiki
  // could merge three pull requests, fail on the fourth, and report `prs: []`
  // to both the digest and the audit, because this array was a local inside
  // the try and the catch built a fresh result without it.
  //
  // Only `prs` is hoisted, and deliberately so. Hoisting `release` and
  // `remediations` too was considered: the worry is a release that really
  // pushed a tag being discarded by the catch, which would be this same
  // dishonesty one step later. It cannot happen. `remediate` is the last
  // step, so if it completes we return normally and never reach `stopped`;
  // and it cannot throw, because every write in it goes through `tryWrite`
  // and the rest is pure. Both hoists were therefore unreachable, and a
  // mutation removing either passed the whole suite - which is the honest
  // signal that they were dead code, not defence. If a future step is added
  // after `evaluateRelease`, or an unguarded call appears in `remediate`,
  // hoist them then and pin it with a test that can fail.
  let prs: PrOutcome[] = [];
  const stopped = (detail: string, error: string): RepoResult => ({
    repo: slug,
    mainRed: facts.mainChecks === "red",
    prs,
    release: { status: "waiting", detail },
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
      return stopped("stopped after a failed write", evaluated.error);
    }
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
      ...(facts.protection.state !== "protected"
        ? { protection: facts.protection }
        : {}),
      remediations,
    };
  } catch (err) {
    // The backstop: anything the release or remediation step throws.
    // Whatever completed is kept, never discarded.
    //
    // NOT necessarily a write. `evaluateRelease` reads `latestTag`,
    // `defaultBranchSha` and any declared version source before it pushes
    // anything, so a 502 on the tag listing lands here too - which is why
    // neither this detail nor the digest line claims a write failed. A
    // version source that is merely ABSENT does not come here: that is an
    // answer, and it blocks the release without erroring the repository.
    // `error` carries the real cause.
    return stopped(
      "repo errored",
      err instanceof Error ? err.message : String(err),
    );
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
// backstop never has a completed release to preserve, and can build a fresh
// one. An unguarded call added to `remediate` breaks that assumption silently.
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

  // Does the tree agree that this is its version (#145)?
  //
  // Reached identically in both modes, so an operator sees a blocked release
  // in shadow BEFORE enforce would have cut a wrong one - only the push below
  // is gated by the mode. A repository that declares no source reads nothing
  // and behaves exactly as it did before this check existed: an undeclared
  // tree carries no version, which is a real answer and not an opt-out.
  //
  // The sha is read here and handed to the push, rather than read twice: the
  // tree that is checked has to be the tree that gets tagged, and a commit
  // landing in between must not be able to separate them.
  let sha: string | undefined;
  if (policy.versionSources.length > 0) {
    sha = await github.defaultBranchSha(facts.repo);
    const disagreement = await versionDisagreement(
      facts.repo,
      policy.versionSources,
      version,
      sha,
      github,
    );
    if (disagreement !== null) {
      // Nothing was written and nothing failed, so this is neither an
      // error nor a stop. An error would stop this repository before its
      // remaining steps, count its pull requests as unevaluated, and read as
      // a fault in a repository that has nothing wrong with it.
      return { status: "tree-version-mismatch", version, detail: disagreement };
    }
  }

  if (enforce) {
    // `sha` is already set for a repository that declared a source, and it
    // is deliberately not re-read: the commit that was checked has to be the
    // commit that gets tagged.
    const tagSha = sha ?? (await github.defaultBranchSha(facts.repo));
    try {
      await github.pushTag(facts.repo, version, tagSha);
    } catch (err) {
      if (!(err instanceof TagExistsError)) throw err;
      // Someone tagged between the re-check above and this push. The tag is
      // theirs; say what GitHub holds for it and move on. Nothing was
      // written, so the repository is neither errored nor stopped (#110).
      const state = await github.releaseStateForTag(facts.repo, version);
      return {
        status: "tag-exists",
        version,
        detail: `tag ${version} appeared before twiki could push it (release: ${state})`,
      };
    }
    return { status: "released", version, detail: "patch release tagged" };
  }
  return {
    status: "would-release",
    version,
    detail: "would tag patch release",
  };
}

/**
 * Why the tree cannot be confirmed to carry the version about to be tagged,
 * or null when it can.
 *
 * Sources are checked in declaration order and the FIRST problem wins, so a
 * repository declaring four files gets one sentence about one file rather
 * than a list to work through.
 *
 * Every problem blocks, and every sentence says only what was established.
 * A path that holds a directory is not "not in the tree", a file GitHub
 * declined to inline did not "fail to match", and a pattern matching in two
 * places is not a version the check may pick between - each of those wordings
 * would send an operator somewhere the fault is not.
 */
async function versionDisagreement(
  repo: RepoRef,
  sources: readonly VersionSource[],
  version: string,
  sha: string,
  github: GitHubPort,
): Promise<string | null> {
  const at = sha.slice(0, 7);
  const not = (why: string) => `not tagging ${version}: ${why}`;
  for (const source of sources) {
    const where = `${source.path} at ${at}`;
    const file = await github.readFileAtRef(repo, source.path, sha);
    if (file.kind === "absent") {
      return not(`${source.path} is not in the tree at ${at}`);
    }
    if (file.kind === "not-a-file") {
      return not(`${where} is a ${file.type}, not a file`);
    }
    if (file.kind === "too-large") {
      return not(
        `GitHub will not inline ${where}: ${file.bytes} bytes against a ` +
          `${file.limitBytes}-byte limit, answered as \`encoding: "${file.encoding}"\``,
      );
    }
    const found = matchVersion(file.text, source.pattern);
    if (found.kind === "too-large") {
      return not(
        `${where} is ${found.chars} characters, past the ${found.limit} this check scans`,
      );
    }
    if (found.kind === "none") {
      // "finds no version" rather than "matches nothing": a pattern CAN
      // match while capturing nothing, or capture only blank, and all three
      // mean the same thing to the reader.
      return not(`/${source.pattern}/ finds no version in ${where}`);
    }
    if (found.kind === "many") {
      // Worded for any number of matches. The count is not carried, because
      // the scan stops at the second: whether a second exists is the whole
      // question, and past that the answer does not change.
      return not(
        `/${source.pattern}/ matches in more than one place in ${where}, ` +
          "so which of them is the version is not declared",
      );
    }
    if (!versionsAgree(version, found.version)) {
      return not(`${source.path} says ${found.version} at ${at}`);
    }
  }
  return null;
}

/**
 * Why a repository is not settled, in the operator's words.
 *
 * Exported for test only. The wording is the point: "main is RED" sends the
 * reader hunting a failing build, and "CI/CD is running" is untrue of a
 * repository where nothing ran - both were reachable from the same branch
 * before `none` existed.
 */
export function settledBlockers(
  facts: RepoFacts,
  policy: RepoPolicy,
): string[] {
  const reasons: string[] = [];
  if (facts.prs.some((pr) => mergeBlock(pr, policy) === null)) {
    reasons.push("mergeable Dependabot PRs still open.");
  }
  if (facts.unreleasedDependencyCommits <= 0) {
    reasons.push("🎉 Dependencies up to date.");
  }
  if (facts.mainChecks !== "green") {
    // "nothing reported" must not render as red or as running. "main is RED"
    // sends the reader hunting a failing build that does not exist, and
    // "CI/CD is running" is untrue of a repository with no CI at all.
    reasons.push(
      facts.mainChecks === "pending"
        ? "⚙️ CI/CD is running."
        : facts.mainChecks === "none"
          ? // Covers TWO causes, and must not assert either. `none` is
            // reached both when nothing ran and when everything that ran was
            // skipped (#88), and the two send a reader to different places:
            // one to whether CI is configured at all, the other to which
            // `if:` condition is false. `CheckStatus` does not distinguish
            // them, so the sentence must not pretend to.
            "❔ main has no check results to judge — nothing ran, or everything that ran was skipped."
          : `main is ${facts.mainChecks}.`,
    );
  }
  return reasons.length > 0 ? reasons : ["not settled."];
}
