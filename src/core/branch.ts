/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

/** The only prefix a branch ref carries. Tags and PR refs use their own. */
const HEADS_PREFIX = "refs/heads/";

/**
 * Whether a ref names the repository's default branch.
 *
 * Nothing calls this yet outside its test. It is in core, and it is here now,
 * so that the actions lane and the rank chain that will decide "is this a
 * build of main" both decide it the same way (AD-33) rather than each growing
 * its own comparison.
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
