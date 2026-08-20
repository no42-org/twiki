/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { AlertObservation } from "../collect/dependabot-alerts.js";
import type { IssueObservation } from "../collect/issues.js";
import type { UpdatePrObservation } from "../collect/update-prs.js";
import type { UpdateStatusObservation } from "../collect/update-status.js";
import type { WorkflowRunObservation } from "../collect/workflow-runs.js";

// Payload shape checks, shared by every page that reads stored observations.
//
// One copy on purpose: the queue and the per-repository page consume the same
// rows, and a guard that drifts between them would let a row render on one
// page and vanish from the other with no way to tell which is lying.
//
// The posture throughout is "counted, not guessed at". An early version of
// readAlert checked two fields and let the rest detonate downstream: a row
// with `cveId: 42` passed, kevSignal called `(42).trim()`, and the whole page
// answered 500. A guard that forwards a row it has not actually checked is
// the thing its own comment claims it is not.

/** A field that must be a string or an explicit null, never anything else. */
export function stringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * The shape check behind "counted, not guessed at".
 *
 * Every field the queue consumes is validated, because the first version
 * checked two and let the rest detonate downstream: a row with `cveId: 42`
 * passed the guard, kevSignal called `(42).trim()`, and the whole page
 * answered 500. A guard that forwards a row it has not actually checked is
 * the thing this function's own comment promised it was not.
 */
export function readAlert(payload: unknown): AlertObservation | null {
  const a = payload as AlertObservation | null | undefined;
  if (!a || typeof a !== "object") return null;
  if (typeof a.number !== "number" || typeof a.repo !== "string") return null;
  if (typeof a.severity !== "string") return null;
  if (!stringOrNull(a.cveId)) return null;
  if (!stringOrNull(a.ghsaId)) return null;
  if (!stringOrNull(a.packageName)) return null;
  if (!stringOrNull(a.htmlUrl)) return null;
  if (a.epssPercentage !== null && typeof a.epssPercentage !== "number") {
    return null;
  }
  return a;
}

/**
 * The PR shape check, same posture as readAlert: counted, not guessed at.
 */
export function readPr(payload: unknown): UpdatePrObservation | null {
  const p = payload as UpdatePrObservation | null | undefined;
  if (!p || typeof p !== "object") return null;
  if (typeof p.number !== "number" || typeof p.repo !== "string") return null;
  if (typeof p.title !== "string" || typeof p.author !== "string") return null;
  if (typeof p.htmlUrl !== "string") return null;
  if (p.packageName !== null && typeof p.packageName !== "string") return null;
  if (
    p.bump !== null &&
    p.bump !== "patch" &&
    p.bump !== "minor" &&
    p.bump !== "major"
  ) {
    return null;
  }
  return p;
}

/**
 * The issue shape check, same posture as readAlert: counted, not guessed at.
 */
export function readIssue(payload: unknown): IssueObservation | null {
  const i = payload as IssueObservation | null | undefined;
  if (!i || typeof i !== "object") return null;
  if (typeof i.number !== "number" || typeof i.repo !== "string") return null;
  // Only the fields the page consumes: rejecting a row over a field nothing
  // renders (author, createdAt) would hide a real issue behind the
  // "items not shown" banner for no reader-visible reason.
  if (typeof i.title !== "string") return null;
  if (typeof i.htmlUrl !== "string") return null;
  return i;
}

/**
 * The update-status shape check.
 *
 * A malformed row is skipped rather than counted into `unreadable`: a status
 * is never itself a queue item, and its absence already degrades honestly to
 * "stuck state unknown" on the alert it belonged to (AD-20), which the page
 * shows. Counting it would make the "items not shown" banner claim items
 * that were never items.
 */
export function readStatus(payload: unknown): UpdateStatusObservation | null {
  const s = payload as UpdateStatusObservation | null | undefined;
  if (!s || typeof s !== "object") return null;
  if (typeof s.repo !== "string") return null;
  if (typeof s.alertNumber !== "number") return null;
  if (s.update !== null) {
    if (!s.update || typeof s.update !== "object") return null;
    if (
      s.update.pullRequestNumber !== null &&
      typeof s.update.pullRequestNumber !== "number"
    ) {
      return null;
    }
    if (!stringOrNull(s.update.error)) return null;
  }
  return s;
}

/**
 * The workflow-run shape check. `conclusion` is legitimately null while a run
 * is still going, which is a state the page shows rather than a defect.
 */
export function readWorkflowRun(
  payload: unknown,
): WorkflowRunObservation | null {
  const r = payload as WorkflowRunObservation | null | undefined;
  if (!r || typeof r !== "object") return null;
  if (typeof r.repo !== "string") return null;
  if (typeof r.workflowName !== "string") return null;
  if (typeof r.runNumber !== "number") return null;
  if (typeof r.status !== "string") return null;
  if (!stringOrNull(r.conclusion)) return null;
  if (!stringOrNull(r.headBranch)) return null;
  if (typeof r.htmlUrl !== "string") return null;
  return r;
}
