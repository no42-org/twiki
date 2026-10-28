/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// Is a repository worth releasing? Pure: the lane stores the evidence and this
// judges it at read time, so a rule change needs no recollection.

import { normaliseSeverity, worstSeverity } from "./severity.js";

export type ImprovementKind = "breaking" | "feat" | "fix" | "perf";

export interface CommitRef {
  sha: string;
  subject: string;
  url: string;
}

export interface FixedAlertRef {
  number: number;
  severity: string;
  ghsaId: string | null;
  cveId: string | null;
  packageName: string | null;
  scope: string | null;
  htmlUrl: string | null;
  fixedAt: string;
}

/** What the lane stores; judged at read time so a rule change needs no recollection. */
export interface ReleaseEvidence {
  /** Newest stable semver tag, or null. */
  tag: string | null;
  /** Committer date of the tagged commit, ISO. */
  tagDate: string | null;
  commits: readonly CommitRef[];
  /** More commits exist than were read. */
  truncated: boolean;
  fixedAlerts: readonly FixedAlertRef[];
}

/**
 * What the lane stores for a repository whose reads threw: why, and no
 * evidence. The reason is the error message, which names the repository and
 * the cause, e.g. a tag off the default branch.
 */
export interface ReleaseReadFailure {
  readFailed: string;
}

export interface ReleaseVerdict {
  ready: boolean;
  tag: string | null;
  securityFixes: readonly FixedAlertRef[];
  improvements: readonly (CommitRef & { kind: ImprovementKind })[];
  truncated: boolean;
}

const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?(!)?:\s/;

/**
 * The improvement a commit subject announces, or null.
 * Scope `deps` never counts, whatever the type or `!`. The `BREAKING CHANGE:`
 * footer is not read, only the subject.
 */
export function improvementKind(subject: string): ImprovementKind | null {
  const match = CONVENTIONAL.exec(subject);
  if (match === null) return null;
  const [, type, scope, bang] = match;
  if (scope?.toLowerCase() === "deps") return null;
  if (bang !== undefined) return "breaking";
  const lower = (type ?? "").toLowerCase();
  return lower === "feat" || lower === "fix" || lower === "perf" ? lower : null;
}

export function assessRelease(evidence: ReleaseEvidence): ReleaseVerdict {
  const since =
    evidence.tag !== null && evidence.tagDate !== null
      ? new Date(evidence.tagDate).getTime()
      : null;

  const securityFixes = evidence.fixedAlerts.filter(
    (a) =>
      (a.scope === null || a.scope === "runtime") &&
      (since === null || new Date(a.fixedAt).getTime() > since),
  );

  const improvements: (CommitRef & { kind: ImprovementKind })[] = [];
  for (const c of evidence.commits) {
    const kind = improvementKind(c.subject);
    if (kind !== null) improvements.push({ ...c, kind });
  }

  return {
    ready: securityFixes.length > 0 || improvements.length > 0,
    tag: evidence.tag,
    securityFixes,
    improvements,
    truncated: evidence.truncated,
  };
}

const LABELS: readonly [ImprovementKind, string, string][] = [
  ["breaking", "breaking change", "breaking changes"],
  ["feat", "feature", "features"],
  ["fix", "fix", "fixes"],
  ["perf", "perf", "perf"],
];

/** One line for the board, e.g. `1 security fix (high, lodash) · 2 fixes since v0.4.1`. Empty when not ready. */
export function releaseSummary(verdict: ReleaseVerdict): string {
  if (!verdict.ready) return "";
  const parts: string[] = [];

  const sec = verdict.securityFixes;
  if (sec.length > 0) {
    const worst = worstSeverity(sec.map((a) => a.severity));
    const top =
      sec.find((a) => normaliseSeverity(a.severity) === worst) ?? sec[0];
    const detail = [worst, top?.packageName].filter(
      (x): x is string => x !== null && x !== undefined,
    );
    parts.push(
      `${sec.length} security fix${sec.length === 1 ? "" : "es"}` +
        (detail.length > 0 ? ` (${detail.join(", ")})` : ""),
    );
  }

  const counts: string[] = [];
  for (const [kind, one, many] of LABELS) {
    const n = verdict.improvements.filter((i) => i.kind === kind).length;
    if (n === 0) continue;
    const plus = verdict.truncated ? "+" : "";
    counts.push(`${n}${plus} ${n === 1 && !verdict.truncated ? one : many}`);
  }
  if (counts.length > 0) parts.push(counts.join(", "));

  const since = verdict.tag === null ? "the first commit" : verdict.tag;
  return `${parts.join(" · ")} since ${since}`;
}
