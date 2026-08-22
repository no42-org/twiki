/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { FailingCheck, Mode } from "../core/types.js";

// The outcome of a single tick: what happened (or would happen, in shadow mode)
// per repo. Produced by the executor, rendered by the report, persisted by the
// audit log.

export interface PrOutcome {
  number: number;
  title: string;
  security: boolean;
  status: "merged" | "would-merge" | "flagged-major" | "blocked" | "held";
  detail: string;
  /** Failing checks behind a `ci-not-green` block, for the digest. */
  failingChecks?: FailingCheck[];
}

/** A CI-remediation action taken (or that would be taken) this tick. */
export interface RemediationOutcome {
  kind: "rerun" | "rebase";
  /**
   * `failed-*` exists so a throttled run cannot read like a quiet one. An
   * ineligible pull request produces NO outcome at all, and before this
   * distinction a refused write produced none either, so "0 rebases" meant
   * both "nothing needed doing" and "we tried and could not".
   */
  status:
    | "reran"
    | "would-rerun"
    | "rebased"
    | "would-rebase"
    | "failed-rerun"
    | "failed-rebase";
  /** What was acted on, e.g. `run 123` or `#45`. */
  ref: string;
  detail: string;
}

export interface ReleaseOutcome {
  status:
    | "released"
    | "would-release"
    | "no-release-workflow"
    | "skipped-merge-only"
    | "waiting";
  version?: string;
  detail: string;
}

export interface RepoResult {
  repo: string;
  mainRed: boolean;
  prs: PrOutcome[];
  release: ReleaseOutcome;
  /** Failing checks on `main` when it is red, for the digest. */
  mainFailingChecks?: FailingCheck[];
  /** CI-remediation actions taken (or would-do) this tick. */
  remediations?: RemediationOutcome[];
  error?: string;
  /**
   * True when this repository stopped before finishing what it had to do.
   *
   * Deliberately does NOT claim a write failed. The usual cause is a refused
   * merge, but `evaluateRelease` reads `latestTag` and `defaultBranchSha`
   * before it pushes anything, so a 502 on either stops the repository with
   * no write attempted. `error` carries the actual cause; this flag only
   * says the work is incomplete.
   *
   * Load-bearing for the reader, not decoration. Stopping creates a second
   * reason a pull request can be missing from `prs`, alongside "evaluated and
   * nothing to do". Without this flag the two are the same absence, which is
   * the confident-zero failure the collector side keeps having to fix
   * (AD-28): an empty list read as authoritative.
   */
  stoppedEarly?: boolean;
  /** How many pull requests have no outcome here because it stopped. */
  notEvaluated?: number;
}

export interface RunResult {
  mode: Mode;
  repos: RepoResult[];
}
