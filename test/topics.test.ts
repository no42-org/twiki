/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import {
  KIND_REASONS,
  kevListedFor,
  TOPICS,
  topicByQuery,
  topicOf,
} from "../src/core/topics.js";

// AD-31, AD-32: one owner for what each kind may say and shout about, and
// for the topic vocabulary every surface shows.

describe("TOPICS", () => {
  it("lists the six topics in vocabulary order, with the queue value of each", () => {
    expect(TOPICS.map((t) => [t.topic, t.label, t.query])).toEqual([
      ["security", "Security", "security"],
      ["ci", "CI", "ci"],
      ["dependencies", "Dependencies", "dependencies"],
      ["pulls", "Pull requests", "pulls"],
      ["issues", "Issues", "issues"],
      // Not in the queue: review requests have their own page.
      ["reviews", "Reviews", null],
    ]);
  });

  it("gives every queue kind exactly one topic, and the lane-less topics none", () => {
    expect(TOPICS.map((t) => [t.topic, [...t.kinds]])).toEqual([
      ["security", ["alert"]],
      ["ci", ["ci_failure"]],
      ["dependencies", ["update_pr"]],
      // Pull requests has no lane until Epic 3; Reviews never joins the queue.
      ["pulls", []],
      ["issues", ["issue"]],
      ["reviews", []],
    ]);
    expect(topicOf("alert")).toBe("security");
    expect(topicOf("ci_failure")).toBe("ci");
    expect(topicOf("update_pr")).toBe("dependencies");
    expect(topicOf("issue")).toBe("issues");
    expect(() => topicOf("workflow" as never)).toThrow(/belongs to no topic/);
  });

  it("names each topic's singular noun for the filter sentence, in both positions", () => {
    // Two forms per topic, because the second is not derivable from the
    // first: `CI` is an acronym and keeps its case mid-sentence where
    // `Pull request` loses it, and a rule about letters got that wrong in
    // both directions.
    expect(TOPICS.map((t) => [t.topic, t.noun, t.sentenceNoun])).toEqual([
      ["security", "Security", "security"],
      ["ci", "CI", "CI"],
      ["dependencies", "Dependency", "dependency"],
      ["pulls", "Pull request", "pull request"],
      ["issues", "Issue", "issue"],
      ["reviews", "Review", "review"],
    ]);
  });

  it("finds a topic by its query value, and never reviews", () => {
    expect(topicByQuery("dependencies")).toBe(TOPICS[2]);
    expect(topicByQuery("issues")).toBe(TOPICS[4]);
    expect(topicByQuery("reviews")).toBeUndefined();
    expect(topicByQuery("foo")).toBeUndefined();
    expect(topicByQuery("")).toBeUndefined();
  });
});

describe("kevListedFor", () => {
  it.each([
    ["alert", true],
    ["update_pr", true],
    ["issue", false],
    // A build is not an advisory: its KEV term is n/a by construction, so
    // the page never gets a chance to shout about it.
    ["ci_failure", false],
  ] as const)("%s: %s", (kind, expected) => {
    expect(kevListedFor(kind)).toBe(expected);
  });
});

describe("KIND_REASONS", () => {
  it("has a table for every kind; only the issue and the CI failure reword the chain", () => {
    expect(Object.keys(KIND_REASONS).sort()).toEqual([
      "alert",
      "ci_failure",
      "issue",
      "update_pr",
    ]);
    expect(KIND_REASONS.alert).toEqual({});
    expect(KIND_REASONS.update_pr).toEqual({});
    // The five security terms are silenced, and `broken` is deliberately
    // absent: its wording is supplied per item, because the sentence carries
    // the deciding run's own verdict word and age.
    expect(KIND_REASONS.ci_failure).toEqual({
      kev: { na: "" },
      epss: { na: "" },
      severity: { na: "" },
      bump: { na: "" },
      stuck: { na: "" },
    });
  });
});
