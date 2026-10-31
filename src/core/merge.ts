/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// The contract for merging a pull request from gitricorder's overview through
// twiki's write side. Shared here so neither role imports the other.

/** Why twiki declined a merge the operator asked for. */
export type MergeRefusal =
  | "shadow-mode"
  | "not-allowlisted"
  | "closed"
  | "draft"
  | "ci-failed"
  | "ci-running"
  | "no-checks"
  | "changes-requested"
  | "review-required"
  | "head-changed"
  | "not-mergeable"
  | "unreachable";

/** GitHub's review decision; null when the repository requires no review. */
export type ReviewDecision =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "REVIEW_REQUIRED"
  | null;

/** A review decision as read: "unknown" where the data did not state it. */
export type ReviewDecisionRead = ReviewDecision | "unknown";

/**
 * Reads GitHub's reviewDecision from a boundary value. Only an explicit null
 * means "no review required". A missing field or an unrecognised string is
 * "unknown", which is never green (AD-28).
 */
export function readReviewDecision(value: unknown): ReviewDecisionRead {
  if (
    value === null ||
    value === "APPROVED" ||
    value === "CHANGES_REQUESTED" ||
    value === "REVIEW_REQUIRED"
  ) {
    return value;
  }
  return "unknown";
}

export interface MergeRequest {
  repo: string;
  number: number;
}

export type MergeResponse =
  | { outcome: "merged" }
  | { outcome: "already-merged" }
  | { outcome: "refused"; refusal: MergeRefusal };

/** The words the operator reads for each refusal. */
export const REFUSAL_WORDS: Readonly<Record<MergeRefusal, string>> = {
  "shadow-mode": "Shadow mode",
  "not-allowlisted": "Not in the allowlist",
  closed: "Closed",
  draft: "Draft",
  "ci-failed": "CI failed",
  "ci-running": "CI running",
  "no-checks": "Checks not observed",
  "changes-requested": "Changes requested",
  "review-required": "Review required",
  "head-changed": "New commits pushed",
  "not-mergeable": "GitHub refused the merge",
  unreachable: "twiki is not reachable",
};
