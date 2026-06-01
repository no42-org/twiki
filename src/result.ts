/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { Mode } from "./types.js";

// The outcome of a single tick: what happened (or would happen, in shadow mode)
// per repo. Produced by the executor, rendered by the report, persisted by the
// audit log.

export interface PrOutcome {
  number: number;
  title: string;
  security: boolean;
  status: "merged" | "would-merge" | "flagged-major" | "blocked" | "held";
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
  error?: string;
}

export interface RunResult {
  mode: Mode;
  repos: RepoResult[];
}
