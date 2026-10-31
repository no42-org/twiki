/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { REFUSAL_WORDS } from "../../core/merge.js";
import type { Mode } from "../../core/types.js";
import type { MergeFacts } from "../attention/queue.js";

// Whether a row's merge icon is enabled, or why it is dimmed. Read from
// collected data, so this is only how the icon looks: twiki re-reads the pull
// request and decides. Where a reason has a refusal, it uses the refusal's
// words, so the tooltip and the answer to a click cannot disagree.

export type MergeAction =
  | { enabled: true }
  | { enabled: false; reason: string };

const dim = (reason: string): MergeAction => ({ enabled: false, reason });

/** The first reason not to merge wins. Unknown is never green (AD-28). */
export function mergeAction(input: {
  mode: Mode;
  configured: boolean;
  watched: boolean;
  facts: MergeFacts | null;
}): MergeAction {
  const { mode, configured, watched, facts } = input;
  if (mode === "shadow") return dim(REFUSAL_WORDS["shadow-mode"]);
  if (!configured) return dim("Merging not configured");
  if (!watched) return dim(REFUSAL_WORDS["not-allowlisted"]);
  if (facts === null) return dim(REFUSAL_WORDS["no-checks"]);
  if (facts.checks === "failed") return dim(REFUSAL_WORDS["ci-failed"]);
  if (facts.checks === "running") return dim(REFUSAL_WORDS["ci-running"]);
  if (facts.checks === "none") return dim(REFUSAL_WORDS["no-checks"]);
  if (facts.isDraft === true) return dim(REFUSAL_WORDS.draft);
  if (facts.reviewDecision === "CHANGES_REQUESTED") {
    return dim(REFUSAL_WORDS["changes-requested"]);
  }
  if (facts.reviewDecision === "REVIEW_REQUIRED") {
    return dim(REFUSAL_WORDS["review-required"]);
  }
  if (facts.reviewDecision === "unknown" || facts.isDraft === null) {
    return dim("Review state not observed");
  }
  return { enabled: true };
}
