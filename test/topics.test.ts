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
      // Three kinds under Security: a Dependabot alert, a code scanning
      // finding and a leaked credential are all "something GitHub found
      // here", and the topic is what makes the chips, tiles and filters count
      // them as one number.
      ["security", ["alert", "code_scanning", "secret_scanning"]],
      ["ci", ["ci_failure"]],
      ["dependencies", ["update_pr"]],
      // Pull requests has a lane now (#167), and its kind is the COMPLEMENT
      // of `update_pr`: a pull request is one or the other, never both.
      // Reviews stays empty permanently - it never joins the queue.
      ["pulls", ["pull_request"]],
      ["issues", ["issue"]],
      ["reviews", []],
    ]);
    expect(topicOf("alert")).toBe("security");
    expect(topicOf("code_scanning")).toBe("security");
    expect(topicOf("secret_scanning")).toBe("security");
    expect(topicOf("ci_failure")).toBe("ci");
    expect(topicOf("update_pr")).toBe("dependencies");
    expect(topicOf("pull_request")).toBe("pulls");
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
    // Nor is a human pull request. Its KEV term is n/a by construction, and
    // the one term it speaks with is `stuck` (#167).
    ["pull_request", false],
    // A build is not an advisory: its KEV term is n/a by construction, so
    // the page never gets a chance to shout about it.
    ["ci_failure", false],
    // Nor is a static-analysis finding. It has no CVE to look up, so its KEV
    // term is n/a and no page may shout `in CISA KEV` over it.
    ["code_scanning", false],
    // The one kind whose KEV TERM is `true` and whose flag is still false.
    // The term is what reaches `now`; the flag is what prints the citation,
    // and an open secret is not in CISA's catalogue (#158).
    ["secret_scanning", false],
  ] as const)("%s: %s", (kind, expected) => {
    expect(kevListedFor(kind)).toBe(expected);
  });
});

describe("KIND_REASONS", () => {
  it("has a table for every kind; only the alert and the update PR keep the chain's own words", () => {
    expect(Object.keys(KIND_REASONS).sort()).toEqual([
      "alert",
      "ci_failure",
      "code_scanning",
      "issue",
      "pull_request",
      "secret_scanning",
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
    // Four terms silenced and two worded. `severity` says what is missing is
    // a GRADE, not an advisory - the alert IS the finding. `bump` carries the
    // branch phrase because the chain prints its terms in order and the
    // sentence a reader wants is `Trivy, severity high, on the default
    // branch`; `broken` is absent here because the tool name is supplied per
    // item, as the CI failure's verdict is.
    expect(KIND_REASONS.code_scanning).toEqual({
      kev: { na: "" },
      epss: { na: "" },
      severity: { na: "no severity from the tool" },
      bump: { na: "on the default branch" },
      stuck: { na: "" },
    });
    // Five terms silenced and `stuck` deliberately ABSENT (#167): the queue
    // supplies its whole entry per item, because all four of its states say
    // something this table cannot know - which way a broken run went, and
    // which of the two `n/a` readings applies (checks running, or no run
    // observed on this head ref).
    expect(KIND_REASONS.pull_request).toEqual({
      broken: { na: "" },
      kev: { na: "" },
      epss: { na: "" },
      severity: { na: "" },
      bump: { na: "" },
    });
    // The one table that rewords a term's KNOWN state rather than its
    // absence, and the reason it exists at all. An open secret sets the KEV
    // term to `true` to reach `now`, and the chain's own word for that is
    // "listed in CISA KEV" - a citation of a catalogue this finding is not
    // in. Three terms are silenced; `broken` and `bump` are ABSENT because
    // the queue supplies both per item, and an entry for either would be
    // overridden on every item and read as a rule nothing follows (#158).
    expect(KIND_REASONS.secret_scanning).toEqual({
      kev: { listed: "an open secret is a confirmed exposure" },
      epss: { na: "" },
      severity: { na: "" },
      stuck: { na: "" },
    });
  });
});
