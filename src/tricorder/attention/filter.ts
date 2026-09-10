/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { foldSlug, watchKey } from "../../core/slug.js";
import { type TopicSpec, topicByQuery } from "../../core/topics.js";
import type { RepoRef } from "../../core/types.js";
import type { Queue, QueueItem } from "./queue.js";

// The queue filter (AD-39): two query parameters, one grammar.
//
// `topic` takes a queue topic's `topic=` value from TOPICS and `repo` takes a
// slug matched against the allowlist by `watchKey`. Anything else is not an
// error and not a 500: it is the no-matches state, said in words with status
// 200, because a stale link in a notification must land on a page that
// explains itself rather than on a stack trace.

export interface QueueFilter {
  /** The topic asked for, when it is one of the queue topics. */
  topic: TopicSpec | null;
  /** The folded slug asked for, when it is in the allowlist. */
  repo: string | null;
  /** The allowlist entry behind `repo`, for links that keep the filter. */
  repoRef: RepoRef | null;
  /** A `topic=` value no queue topic carries, as given. */
  unknownTopic: string | null;
  /** A `repo=` value not in the allowlist, as given. */
  unknownRepo: string | null;
}

export interface FilteredQueue {
  /** The rows the page lists, in chain order, ranked 1..n as shown. */
  shown: QueueItem[];
  /**
   * Items whose repository has left the allowlist. Non-empty only on the
   * unfiltered queue, where they are listed under their own heading; a
   * filter names allowlisted things, so under one they are omitted.
   */
  delisted: QueueItem[];
  /**
   * Every allowlisted item regardless of the filter, for the summary line:
   * `0 open alerts` beside seven update PRs must be the estate's zero, not
   * the filter's (AD-28, AD-32).
   */
  counted: QueueItem[];
  /**
   * The filter sentence up to the `clear` link, `Dependency items · 7
   * shown`, when a filter is active and matches. Null otherwise.
   */
  sentence: string | null;
  /**
   * The no-matches sentence up to the `Clear filter.` link, `No foo items
   * open.`, when a filter is active and matches nothing. Null otherwise.
   */
  empty: string | null;
}

/**
 * Read the two query parameters.
 *
 * A parameter that is absent or empty is no filter. The repo is folded the
 * way every lane folds it (AD-33) before the allowlist lookup, so a link
 * typed with GitHub's display casing still lands.
 */
export function parseQueueFilter(
  topic: string | undefined,
  repo: string | undefined,
  watched: readonly RepoRef[],
): QueueFilter {
  const filter: QueueFilter = {
    topic: null,
    repo: null,
    repoRef: null,
    unknownTopic: null,
    unknownRepo: null,
  };
  if (topic !== undefined && topic !== "") {
    // Folded like the repo: a typed `?topic=Security` means security.
    const spec = topicByQuery(topic.trim().toLowerCase());
    if (spec === undefined) filter.unknownTopic = topic;
    else filter.topic = spec;
  }
  if (repo !== undefined && repo !== "") {
    const folded = foldSlug(repo);
    const ref = watched.find((r) => watchKey(r) === folded);
    if (ref === undefined) filter.unknownRepo = repo;
    else {
      filter.repo = folded;
      filter.repoRef = ref;
    }
  }
  return filter;
}

/** Apply a parsed filter to the built queue. Pure; ranking is untouched. */
export function applyQueueFilter(
  queue: Queue,
  filter: QueueFilter,
  watched: readonly RepoRef[],
): FilteredQueue {
  const allowlisted = new Set(watched.map(watchKey));
  const counted = queue.items.filter((i) => allowlisted.has(slugOf(i)));
  const active =
    filter.topic !== null ||
    filter.repo !== null ||
    filter.unknownTopic !== null ||
    filter.unknownRepo !== null;

  if (!active) {
    return {
      shown: counted,
      delisted: queue.items.filter((i) => !allowlisted.has(slugOf(i))),
      counted,
      sentence: null,
      empty: null,
    };
  }

  // The sentence names what was asked for, known or not, so a reader who
  // followed `?topic=foo` sees `foo` and not a silent fall-back to `all`.
  const nounOf = filter.topic?.noun ?? filter.unknownTopic;
  const repoOf = filter.repo ?? filter.unknownRepo;
  const where = repoOf === null ? "" : ` in ${repoOf}`;

  const shown =
    filter.unknownTopic !== null || filter.unknownRepo !== null
      ? []
      : counted.filter(
          (i) =>
            (filter.topic === null || filter.topic.kinds.includes(i.kind)) &&
            (filter.repo === null || slugOf(i) === filter.repo),
        );

  if (shown.length === 0) {
    return {
      shown,
      delisted: [],
      counted,
      sentence: null,
      empty: emptySentence(queue, filter, nounOf, where),
    };
  }
  const head = nounOf === null ? "Items" : `${nounOf} items`;
  return {
    shown,
    delisted: [],
    counted,
    sentence: `${head}${where} · ${shown.length} shown`,
    empty: null,
  };
}

/**
 * Why nothing is shown, without claiming a zero nobody measured (AD-28).
 *
 * A de-listed repository with open items is not "nothing open": the
 * unfiltered page lists them, so the sentence says why this filter cannot.
 *
 * `not collected yet` used to be one of the answers here, for a topic with
 * no kind behind it. Nothing can reach it now (#167): every topic a
 * `?topic=` value can name has a lane, and Reviews - the one topic left with
 * no kind - has no query value, so `parseQueueFilter` can never hand it over.
 *
 * Every other topic reads `No <noun> items open`, which is a claim about the
 * QUEUE and not about the estate. It is deliberately not made conditional on
 * a sweep: this function is handed a built queue and a filter, and the
 * confirmations that would answer "did anyone look" are per repository, so
 * the honest form of the sentence cannot be written from what is here. The
 * overview is where absence is told from zero (AD-28), and it says
 * `unconfirmed` for the same store; the sentence below says only that the
 * list it sits under is empty.
 */
function emptySentence(
  queue: Queue,
  filter: QueueFilter,
  nounOf: string | null,
  where: string,
): string {
  if (filter.unknownRepo !== null) {
    const folded = foldSlug(filter.unknownRepo);
    if (queue.items.some((i) => slugOf(i) === folded)) {
      return `${folded} is no longer watched.`;
    }
  }
  // The topic's own sentence-middle form, from the table beside every other
  // name a surface may use, rather than a rule about letters: `CI` keeps its
  // case and `Pull request` loses it, and neither is a fact this function
  // can derive. An unknown topic is whatever the reader typed, folded the
  // way the lookup folded it.
  const noun = filter.topic?.sentenceNoun ?? nounOf?.toLowerCase() ?? null;
  const what = noun === null ? "items" : `${noun} items`;
  return `No ${what} open${where}.`;
}

/** The item's repository, folded like a subject key (AD-33). */
function slugOf(item: QueueItem): string {
  return foldSlug(item.repo);
}
