/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_RANK_POLICY, NOT_APPLICABLE, rank } from "../src/core/rank.js";
import { type QueueKind, TOPICS } from "../src/core/topics.js";
import type { RepoRef } from "../src/core/types.js";
import {
  applyQueueFilter,
  type FilteredQueue,
  parseQueueFilter,
  type QueueFilter,
} from "../src/tricorder/attention/filter.js";
import type { Queue, QueueItem } from "../src/tricorder/attention/queue.js";

// AD-39: one filter grammar over two query parameters. Every matrix row of
// Story 1.5, asserted on the whole QueueFilter or the whole FilteredQueue,
// never on one field of it.

const WATCHED: readonly RepoRef[] = [
  { owner: "no42-org", name: "twiki" },
  { owner: "Riptide-Labs", name: "riptide" },
];

const NO_FILTER: QueueFilter = {
  topic: null,
  repo: null,
  repoRef: null,
  unknownTopic: null,
  unknownRepo: null,
};

const spec = (topic: string) => {
  const found = TOPICS.find((t) => t.topic === topic);
  if (found === undefined) throw new Error(`no topic ${topic}`);
  return found;
};

/** A queue item of one kind in one repository. Ranking is not under test. */
const item = (kind: QueueKind, repo: string, number: number): QueueItem => {
  const ranking = rank(
    {
      kev: NOT_APPLICABLE,
      epss: NOT_APPLICABLE,
      severity: NOT_APPLICABLE,
      bump: NOT_APPLICABLE,
      stuck: NOT_APPLICABLE,
    },
    DEFAULT_RANK_POLICY,
  );
  return {
    kind,
    key: `${repo}#${kind}#${number}`,
    repo,
    number,
    packageName: null,
    title: null,
    advisory: null,
    htmlUrl: null,
    explanation: ranking.explanation,
    kevListed: false,
    displaySeverity: null,
    ranking,
    freshness: "fresh",
    age: "1m ago",
  };
};

const queueOf = (items: QueueItem[]): Queue => ({
  items,
  unreadable: 0,
  kev: { usable: false, version: null, age: "never" },
});

const nothing = (counted: QueueItem[], empty: string): FilteredQueue => ({
  shown: [],
  delisted: [],
  counted,
  sentence: null,
  empty,
});

describe("parseQueueFilter", () => {
  it("reads nothing from nothing, and treats an empty value as absent", () => {
    expect(parseQueueFilter(undefined, undefined, WATCHED)).toEqual(NO_FILTER);
    expect(parseQueueFilter("", "", WATCHED)).toEqual(NO_FILTER);
  });

  it("takes the five queue topics by their query value", () => {
    for (const t of TOPICS) {
      if (t.query === null) continue;
      expect(parseQueueFilter(t.query, undefined, WATCHED)).toEqual({
        ...NO_FILTER,
        topic: t,
      });
    }
  });

  it("folds the repository and matches it against the allowlist", () => {
    expect(
      parseQueueFilter(undefined, "Riptide-Labs/riptide", WATCHED),
    ).toEqual({
      ...NO_FILTER,
      repo: "riptide-labs/riptide",
      repoRef: WATCHED[1],
    });
    expect(parseQueueFilter("security", "no42-org/twiki", WATCHED)).toEqual({
      ...NO_FILTER,
      topic: spec("security"),
      repo: "no42-org/twiki",
      repoRef: WATCHED[0],
    });
  });

  it("folds the topic too, and keeps an unknown one as typed", () => {
    expect(parseQueueFilter(" Security ", undefined, WATCHED)).toEqual({
      ...NO_FILTER,
      topic: spec("security"),
    });
    expect(parseQueueFilter("Foo", undefined, WATCHED)).toEqual({
      ...NO_FILTER,
      unknownTopic: "Foo",
    });
  });

  it("keeps an unknown topic, an unwatched repository, and reviews as unknown", () => {
    expect(parseQueueFilter("foo", undefined, WATCHED)).toEqual({
      ...NO_FILTER,
      unknownTopic: "foo",
    });
    // Reviews has no queue filter: its query is null, so it is unknown here
    // and the bar's `reviews` entry is the only way to /reviews.
    expect(parseQueueFilter("reviews", undefined, WATCHED)).toEqual({
      ...NO_FILTER,
      unknownTopic: "reviews",
    });
    expect(parseQueueFilter(undefined, "not/watched", WATCHED)).toEqual({
      ...NO_FILTER,
      unknownRepo: "not/watched",
    });
  });
});

describe("applyQueueFilter", () => {
  const alerts = [
    item("alert", "no42-org/twiki", 1),
    item("alert", "Riptide-Labs/riptide", 2),
    item("alert", "riptide-labs/riptide", 3),
  ];
  const prs = Array.from({ length: 7 }, (_, i) =>
    item(
      "update_pr",
      i % 2 === 0 ? "no42-org/twiki" : "riptide-labs/riptide",
      i,
    ),
  );
  const issue = item("issue", "no42-org/twiki", 9);
  const delisted = item("alert", "no42-org/gone", 4);
  const all = [...alerts, ...prs, issue, delisted];
  const counted = [...alerts, ...prs, issue];

  it("topic filter: only that topic's kinds, in queue order", () => {
    const filter = parseQueueFilter("dependencies", undefined, WATCHED);
    expect(applyQueueFilter(queueOf(all), filter, WATCHED)).toEqual({
      shown: prs,
      delisted: [],
      counted,
      sentence: "Dependency items · 7 shown",
      empty: null,
    });
  });

  it("topic and repo: folded slug match, only that repository's items", () => {
    const filter = parseQueueFilter(
      "security",
      "Riptide-Labs/riptide",
      WATCHED,
    );
    expect(applyQueueFilter(queueOf(all), filter, WATCHED)).toEqual({
      shown: [alerts[1], alerts[2]],
      delisted: [],
      counted,
      sentence: "Security items in riptide-labs/riptide · 2 shown",
      empty: null,
    });
  });

  it("repo only: every kind for that repository", () => {
    const filter = parseQueueFilter(undefined, "no42-org/twiki", WATCHED);
    expect(applyQueueFilter(queueOf(all), filter, WATCHED)).toEqual({
      shown: [alerts[0], prs[0], prs[2], prs[4], prs[6], issue],
      delisted: [],
      counted,
      sentence: "Items in no42-org/twiki · 6 shown",
      empty: null,
    });
  });

  it("unknown topic, reviews as topic, unwatched repo: nothing, said in words", () => {
    expect(
      applyQueueFilter(
        queueOf(all),
        parseQueueFilter("foo", undefined, WATCHED),
        WATCHED,
      ),
    ).toEqual(nothing(counted, "No foo items open."));
    expect(
      applyQueueFilter(
        queueOf(all),
        parseQueueFilter("reviews", undefined, WATCHED),
        WATCHED,
      ),
    ).toEqual(nothing(counted, "No reviews items open."));
    expect(
      applyQueueFilter(
        queueOf(all),
        parseQueueFilter(undefined, "not/watched", WATCHED),
        WATCHED,
      ),
    ).toEqual(nothing(counted, "No items open in not/watched."));
    expect(
      applyQueueFilter(
        queueOf(all),
        parseQueueFilter("security", "not/watched", WATCHED),
        WATCHED,
      ),
    ).toEqual(nothing(counted, "No security items open in not/watched."));
  });

  it("topic with kinds but nothing open: the no-matches sentence", () => {
    const filter = parseQueueFilter("issues", undefined, WATCHED);
    const noIssues = [...alerts, ...prs, delisted];
    expect(applyQueueFilter(queueOf(noIssues), filter, WATCHED)).toEqual(
      nothing([...alerts, ...prs], "No issue items open."),
    );
  });

  it("topic with no collector yet: not collected, never a zero (AD-28)", () => {
    expect(
      applyQueueFilter(
        queueOf(all),
        parseQueueFilter("pulls", "no42-org/twiki", WATCHED),
        WATCHED,
      ),
    ).toEqual(
      nothing(
        counted,
        "Pull request items are not collected yet in no42-org/twiki.",
      ),
    );
    expect(
      applyQueueFilter(
        queueOf(all),
        parseQueueFilter("ci", undefined, WATCHED),
        WATCHED,
      ),
    ).toEqual(nothing(counted, "CI items are not collected yet."));
  });

  it("repo filter on a de-listed repository with open items: says why, not zero", () => {
    expect(
      applyQueueFilter(
        queueOf(all),
        parseQueueFilter(undefined, "No42-org/gone", WATCHED),
        WATCHED,
      ),
    ).toEqual(nothing(counted, "no42-org/gone is no longer watched."));
    // With a topic too: still the de-listing, which is the reason either way.
    expect(
      applyQueueFilter(
        queueOf(all),
        parseQueueFilter("security", "no42-org/gone", WATCHED),
        WATCHED,
      ),
    ).toEqual(nothing(counted, "no42-org/gone is no longer watched."));
    // A repository with no items at all is plainly unwatched, not de-listed.
    expect(
      applyQueueFilter(
        queueOf(counted),
        parseQueueFilter(undefined, "no42-org/gone", WATCHED),
        WATCHED,
      ),
    ).toEqual(nothing(counted, "No items open in no42-org/gone."));
  });

  it("delisted repository: listed apart on the unfiltered queue, counted nowhere", () => {
    expect(applyQueueFilter(queueOf(all), NO_FILTER, WATCHED)).toEqual({
      shown: counted,
      delisted: [delisted],
      counted,
      sentence: null,
      empty: null,
    });
  });

  it("delisted with a topic filter: omitted", () => {
    const filter = parseQueueFilter("security", undefined, WATCHED);
    expect(applyQueueFilter(queueOf(all), filter, WATCHED)).toEqual({
      shown: alerts,
      delisted: [],
      counted,
      sentence: "Security items · 3 shown",
      empty: null,
    });
  });

  it("empty unfiltered queue: no sentence, so the page keeps its own words", () => {
    expect(applyQueueFilter(queueOf([]), NO_FILTER, WATCHED)).toEqual({
      shown: [],
      delisted: [],
      counted: [],
      sentence: null,
      empty: null,
    });
  });
});
