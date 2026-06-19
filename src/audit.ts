/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { appendFileSync } from "node:fs";
import type { RunResult } from "./result.js";

// Append-only JSONL audit log of decisions and actions. Non-authoritative —
// every decision is re-derived from GitHub each tick (D4); this is for humans
// to inspect what happened, not a source of truth the agent reads back.

export interface AuditSink {
  record(result: RunResult, at: string): void;
}

export class JsonlAudit implements AuditSink {
  constructor(private readonly path = "audit.jsonl") {}

  record(result: RunResult, at: string): void {
    const line = JSON.stringify({ at, mode: result.mode, repos: result.repos });
    try {
      appendFileSync(this.path, `${line}\n`);
    } catch {
      // Audit is best-effort and must never break a run.
    }
  }
}

export class NullAudit implements AuditSink {
  record(): void {}
}
