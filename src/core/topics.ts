/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { ReasonTable } from "./rank.js";

// Per-kind wording and display rules, and the topic vocabulary (AD-31, AD-32).
//
// The chain ranks every kind on the same terms; what differs per kind is what
// those terms mean in words, and which of them the page may shout about. Both
// live here, once, so a queue builder cannot invent a phrase of its own. The
// six topics, their order, their `topic=` values and the kind-to-topic map
// live here too, so a tile, a chip, a column header and a queue filter cannot
// disagree about what a topic is called or which items belong to it.

export type QueueKind = "alert" | "update_pr" | "issue";

/** The six topics, in the order every surface shows them. */
export type Topic =
  | "security"
  | "ci"
  | "dependencies"
  | "pulls"
  | "issues"
  | "reviews";

export interface TopicSpec {
  readonly topic: Topic;
  /** The column header and tile label. */
  readonly label: string;
  /**
   * The `topic=` value on the queue, or null for Reviews, which is not in the
   * queue at all: review requests are collected estate-wide and have their
   * own page.
   */
  readonly query: string | null;
  /**
   * The queue kinds that count under this topic. Empty for CI and Pull
   * requests until their lanes exist, and permanently empty for Reviews,
   * which is never in the queue.
   */
  readonly kinds: readonly QueueKind[];
}

/**
 * CI and Pull requests have no queue kind until Epics 2 and 3. Their entries
 * stay in the table so every surface already has the column, and their empty
 * `kinds` is what makes a tile or chip read `unconfirmed` rather than `0`
 * (AD-28): no sweep has confirmed anything about them.
 */
export const TOPICS: readonly TopicSpec[] = [
  { topic: "security", label: "Security", query: "security", kinds: ["alert"] },
  { topic: "ci", label: "CI", query: "ci", kinds: [] },
  {
    topic: "dependencies",
    label: "Dependencies",
    query: "dependencies",
    kinds: ["update_pr"],
  },
  { topic: "pulls", label: "Pull requests", query: "pulls", kinds: [] },
  { topic: "issues", label: "Issues", query: "issues", kinds: ["issue"] },
  { topic: "reviews", label: "Reviews", query: null, kinds: [] },
];

/** The topic a queue kind counts under. Derived from TOPICS, never a second table. */
export function topicOf(kind: QueueKind): Topic {
  const spec = TOPICS.find((t) => t.kinds.includes(kind));
  if (spec === undefined) {
    // Unreachable while every kind is in TOPICS; the day one is added without
    // a topic, this names it rather than filing it under the first tile.
    throw new Error(`queue kind ${kind} belongs to no topic`);
  }
  return spec.topic;
}

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
