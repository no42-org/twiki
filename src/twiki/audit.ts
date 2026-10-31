/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { appendFileSync } from "node:fs";
import type { MergeResponse } from "../core/merge.js";
import type { RunResult } from "./result.js";

// Append-only JSONL audit log of decisions and actions. Non-authoritative —
// every decision is re-derived from GitHub each tick (D4); this is for humans
// to inspect what happened, not a source of truth the agent reads back.

/**
 * One operator merge. `error` replaces `response` when the merge attempt threw:
 * nothing was answered, and the merge may still have landed.
 */
export type OperatorMergeEntry = {
  repo: string;
  number: number;
  headSha: string | null;
} & ({ response: MergeResponse } | { error: string });

export interface AuditSink {
  record(result: RunResult, at: string): void;
  /**
   * One line per merge the operator asked for, whatever the outcome. The
   * exception is a read that throws before any merge was tried: that is logged
   * only, because nothing can have happened.
   */
  recordOperatorMerge(entry: OperatorMergeEntry, at: string): void;
}

export class JsonlAudit implements AuditSink {
  constructor(private readonly path = "audit.jsonl") {}

  record(result: RunResult, at: string): void {
    // advisorFailed included deliberately. Without it, six hours of ticks
    // during an outage are byte-identical to ticks where a healthy advisor
    // held everything on purpose, and the operator reconstructing "why did
    // nothing merge overnight" hits the exact confusion the digest banner
    // exists to prevent.
    const line = JSON.stringify({
      at,
      mode: result.mode,
      repos: result.repos,
      ...(result.advisorFailed !== undefined
        ? { advisorFailed: result.advisorFailed }
        : {}),
      ...(result.rulesOnly ? { rulesOnly: true } : {}),
    });
    try {
      appendFileSync(this.path, `${line}\n`);
    } catch {
      // Audit is best-effort and must never break a run.
    }
  }

  recordOperatorMerge(entry: OperatorMergeEntry, at: string): void {
    try {
      appendFileSync(
        this.path,
        `${JSON.stringify({ at, kind: "operator-merge", ...entry })}\n`,
      );
    } catch {
      // Best-effort, as record(): a failed audit write must not undo a merge.
    }
  }
}

export class NullAudit implements AuditSink {
  record(): void {}
  recordOperatorMerge(): void {}
}
