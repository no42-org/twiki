/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

/** The only prefix a branch ref carries. Tags and PR refs use their own. */
const HEADS_PREFIX = "refs/heads/";

/**
 * Whether a ref names the repository's default branch.
 *
 * The one comparison, so that everything deciding "is this branch the default
 * one" decides it the same way (AD-33) rather than each growing its own. It
 * answers a question about a STRING. Callers asking about a RUN want
 * `isDefaultBranchRun` below, which is a different question and the one the
 * actions lane, the stored-row reclassification and the run list all ask.
 *
 * GitHub reports a branch in more than one shape - `main` on a workflow run's
 * `head_branch`, `refs/heads/main` on a ref - so the one prefix is stripped
 * and everything else is compared as it stands. That is why `refs/pull/7/
 * merge` and `refs/tags/v1` are false rather than parsed: they are not
 * branches, and inventing a branch name out of them would let a pull-request
 * build count as a build of main.
 *
 * A null ref is false, not an error: `head_branch` on a workflow run is
 * nullable, and "GitHub named no branch" is not "GitHub named this one".
 *
 * The comparison is exact, case included. Git refs are case-sensitive, so
 * `Main` is a different branch from `main` and saying otherwise would be
 * wrong about a repository that has both.
 */
export function isDefaultBranchRef(
  ref: string | null,
  defaultBranch: string,
): boolean {
  if (ref === null) return false;
  const branch = ref.startsWith(HEADS_PREFIX)
    ? ref.slice(HEADS_PREFIX.length)
    : ref;
  return branch === defaultBranch;
}

/**
 * The run fields that decide whether it built the default branch.
 *
 * Structural, as `runVerdict` takes its run, so core imports nothing.
 */
export interface BranchRun {
  /** GitHub's `head_branch`, nullable as it reports it. */
  headBranch: string | null;
  /** GitHub's `event`, the trigger that started the run. */
  event: string;
}

/**
 * Events that are never a build of the default branch, whatever branch they
 * name.
 *
 * A pull-request run builds a PROPOSED MERGE, not the branch it came from. It
 * reports the head repository's branch name, so a contributor working on
 * their fork's own `main` produces a run in this repository whose
 * `head_branch` is `main` (#141). Bucketing that as a build of our default
 * branch let a stranger's failed pull request supersede the genuine push row
 * and count as "main is broken".
 *
 * A DENYLIST, deliberately, and deliberately unlike the allowlist of statuses
 * that may become `hung`. There the dangerous direction is over-reporting, so
 * an unknown status must not qualify. Here the dangerous direction is
 * UNDER-reporting: a missed red main is the failure this whole line of work
 * exists to prevent. An allowlist would have to name every trigger that can
 * legitimately build a branch, and would silently drop the next one GitHub
 * adds. Measured on this estate before choosing: of 797 runs on a default
 * branch, 493 were `push`, 218 `dynamic`, 72 `schedule` and 14
 * `workflow_dispatch`, so an allowlist written from the obvious three would
 * have dropped 27% of them.
 */
const NEVER_DEFAULT_BRANCH_EVENTS: ReadonlySet<string> = new Set([
  "pull_request",
  "pull_request_target",
]);

/**
 * Whether a workflow run is a build of the repository's default branch.
 *
 * The question every caller actually asks, and the reason `isDefaultBranchRef`
 * is not enough on its own: a branch NAME is not evidence about whose branch
 * it is. The name can come from a fork, and only the event says so.
 */
export function isDefaultBranchRun(
  run: BranchRun,
  defaultBranch: string,
): boolean {
  if (NEVER_DEFAULT_BRANCH_EVENTS.has(run.event)) return false;
  return isDefaultBranchRef(run.headBranch, defaultBranch);
}
