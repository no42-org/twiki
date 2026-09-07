/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { ReasonTable } from "./rank.js";

// Per-kind wording and display rules (AD-31, AD-32).
//
// The chain ranks every kind on the same terms; what differs per kind is what
// those terms mean in words, and which of them the page may shout about. Both
// live here, once, so a queue builder cannot invent a phrase of its own. The
// kind-to-topic map joins this file in Story 1.4.

export type QueueKind = "alert" | "update_pr" | "issue";

/**
 * The reasons table per kind.
 *
 * `alert` and `update_pr` keep the chain's default wording: every term is a
 * real question about an advisory. An issue is not an advisory, so its five
 * absences are one fact, said once; the words ride through the table rather
 * than through an override on the item, so the explanation is still the
 * chain's, in chain order.
 */
export const KIND_REASONS: Readonly<Record<QueueKind, ReasonTable>> = {
  alert: {},
  update_pr: {},
  issue: {
    kev: { na: "untriaged issue" },
    epss: { na: "" },
    severity: { na: "" },
    bump: { na: "nobody assigned" },
    stuck: { na: "" },
  },
};

/**
 * Whether the KEV term of this kind can mean "listed in CISA KEV".
 *
 * True only where the term is fed by a catalogue lookup on a CVE: alerts, and
 * the update PRs that inherit an alert's terms. Any other kind's KEV term is
 * `n/a` by construction, and the page must not be able to shout about it.
 */
export function kevListedFor(kind: QueueKind): boolean {
  return kind === "alert" || kind === "update_pr";
}
