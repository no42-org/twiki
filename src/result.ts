/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { FailingCheck, Mode } from "./types.js";

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
  status: "reran" | "would-rerun" | "rebased" | "would-rebase";
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
}

export interface RunResult {
  mode: Mode;
  repos: RepoResult[];
}
