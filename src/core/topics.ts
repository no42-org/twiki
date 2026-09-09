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

export type QueueKind =
  | "alert"
  | "code_scanning"
  | "ci_failure"
  | "update_pr"
  | "issue";

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
   * The singular noun the queue's filter sentence uses (`Dependency items`,
   * `No issue items open`). Not derivable from the label: `Dependencies`
   * and `Issues` are plurals and `Pull requests` is two words.
   */
  readonly noun: string;
  /**
   * The same noun in the MIDDLE of a sentence (`No pull request items
   * open`). Not derivable by lowercasing `noun`: `CI` is an acronym and is
   * spelled the same in both positions, so the rule is per topic. It was a
   * per-letter heuristic for one commit, which also uppercased whatever a
   * reader had typed into `?topic=`.
   */
  readonly sentenceNoun: string;
  /**
   * The `topic=` value on the queue, or null for Reviews, which is not in the
   * queue at all: review requests are collected estate-wide and have their
   * own page.
   */
  readonly query: string | null;
  /**
   * The queue kinds that count under this topic. Empty for Pull requests
   * until its lane exists, and permanently empty for Reviews, which is never
   * in the queue.
   */
  readonly kinds: readonly QueueKind[];
}

/**
 * Pull requests has no queue kind until Epic 3. Its entry stays in the table
 * so every surface already has the column, and its empty `kinds` is what
 * makes a tile or chip read `unconfirmed` rather than `0` (AD-28): no sweep
 * has confirmed anything about it.
 *
 * CI's emptiness ended with Story 2.3. It now carries `ci_failure`, and its
 * absences are told apart the way Security's are: by whether the Actions
 * lane confirmed this repository, not by whether a kind exists.
 */
export const TOPICS: readonly TopicSpec[] = [
  {
    topic: "security",
    label: "Security",
    noun: "Security",
    sentenceNoun: "security",
    query: "security",
    // Two kinds, and the topic is what makes them one number: a Dependabot
    // alert and a code scanning finding are both "something GitHub found in
    // this repository", and every chip, tile and filter counts them together
    // by reading this list rather than naming a kind (#156).
    kinds: ["alert", "code_scanning"],
  },
  {
    topic: "ci",
    label: "CI",
    noun: "CI",
    sentenceNoun: "CI",
    query: "ci",
    kinds: ["ci_failure"],
  },
  {
    topic: "dependencies",
    label: "Dependencies",
    noun: "Dependency",
    sentenceNoun: "dependency",
    query: "dependencies",
    kinds: ["update_pr"],
  },
  {
    topic: "pulls",
    label: "Pull requests",
    noun: "Pull request",
    sentenceNoun: "pull request",
    query: "pulls",
    kinds: [],
  },
  {
    topic: "issues",
    label: "Issues",
    noun: "Issue",
    sentenceNoun: "issue",
    query: "issues",
    kinds: ["issue"],
  },
  {
    topic: "reviews",
    label: "Reviews",
    noun: "Review",
    sentenceNoun: "review",
    query: null,
    kinds: [],
  },
];

/**
 * The topic behind a `topic=` query value, or undefined when no queue topic
 * carries it. Reviews can never come back: its `query` is null, so
 * `?topic=reviews` is an unknown value like any other, which is what keeps
 * review requests out of the queue by construction rather than by a check
 * on the page.
 */
export function topicByQuery(query: string): TopicSpec | undefined {
  return TOPICS.find((t) => t.query !== null && t.query === query);
}

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
  // A broken build is not an advisory either, and the one thing worth saying
  // about it is said by the `broken` term, whose wording the queue builder
  // supplies per item so the sentence carries the run's own verdict and age.
  // The five security terms are silenced rather than reworded: reciting five
  // absences would bury the sentence a reader came for.
  ci_failure: {
    kev: { na: "" },
    epss: { na: "" },
    severity: { na: "" },
    bump: { na: "" },
    stuck: { na: "" },
  },
  // A static-analysis finding is not an advisory either. Four of the six
  // terms are silenced; the two that speak are the severity the tool graded
  // and, in the `bump` slot, the fact that puts the item in the queue at all.
  //
  // The branch phrase rides in `bump` because the chain prints its terms in
  // order and the sentence a reader wants is `Trivy, severity high, on the
  // default branch`: the tool name is supplied per item in the leading
  // `broken` slot, severity says its own words, and this is the slot after
  // it. It is true by construction rather than by measurement here - the
  // queue builder derives an item only from an alert whose most recent
  // instance is on the default branch, so an item that reached this table
  // cannot be anywhere else.
  code_scanning: {
    kev: { na: "" },
    epss: { na: "" },
    // Not the chain's "no advisory": the alert IS the finding, and what is
    // missing is a grade for it. Three of the estate's 73 alerts are in this
    // state, all from one tool that grades nothing.
    severity: { na: "no severity from the tool" },
    bump: { na: "on the default branch" },
    stuck: { na: "" },
  },
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
