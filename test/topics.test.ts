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
      ["ci", []],
      ["dependencies", ["update_pr"]],
      ["pulls", []],
      ["issues", ["issue"]],
      ["reviews", []],
    ]);
    expect(topicOf("alert")).toBe("security");
    expect(topicOf("update_pr")).toBe("dependencies");
    expect(topicOf("issue")).toBe("issues");
    expect(() => topicOf("workflow" as never)).toThrow(/belongs to no topic/);
  });

  it("names each topic's singular noun for the filter sentence", () => {
    expect(TOPICS.map((t) => [t.topic, t.noun])).toEqual([
      ["security", "Security"],
      ["ci", "CI"],
      ["dependencies", "Dependency"],
      ["pulls", "Pull request"],
      ["issues", "Issue"],
      ["reviews", "Review"],
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
  ] as const)("%s: %s", (kind, expected) => {
    expect(kevListedFor(kind)).toBe(expected);
  });
});

describe("KIND_REASONS", () => {
  it("has a table for every kind, and only the issue rewords the chain", () => {
    expect(Object.keys(KIND_REASONS).sort()).toEqual([
      "alert",
      "issue",
      "update_pr",
    ]);
    expect(KIND_REASONS.alert).toEqual({});
    expect(KIND_REASONS.update_pr).toEqual({});
  });
});
