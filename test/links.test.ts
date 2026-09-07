/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import {
  absoluteUrl,
  overviewPath,
  queueClearPath,
  queuePath,
  queueRepoPath,
  repoPath,
  reviewsPath,
  topicPath,
} from "../src/tricorder/attention/links.js";

// AD-39: every internal path is built here, with the repository folded the
// way every lane folds it (AD-33) and the topic value taken from TOPICS.

describe("links (AD-39)", () => {
  it("builds the repository path per segment, encoding what a path cannot carry", () => {
    expect(repoPath("no42-org/twiki")).toBe("/repo/no42-org/twiki");
    // A slug is two path segments; the slash between them must survive and
    // anything else that is not path-safe must not.
    expect(repoPath("no42-org/we ird?")).toBe("/repo/no42-org/we%20ird%3F");
  });

  it("filters the queue by topic, and by repository before topic with the folded slug", () => {
    expect(queuePath("issues")).toBe("/queue?topic=issues");
    expect(queuePath("security", { owner: "No42-Org", name: "TWiki" })).toBe(
      "/queue?repo=no42-org%2Ftwiki&topic=security",
    );
  });

  it("refuses a queue filter for reviews, which are not in the queue", () => {
    expect(() => queuePath("reviews")).toThrow(/reviews has no queue filter/);
    expect(reviewsPath()).toBe("/reviews");
    expect(topicPath("reviews")).toBe("/reviews");
    expect(topicPath("reviews", { owner: "no42-org", name: "twiki" })).toBe(
      "/reviews",
    );
    expect(topicPath("ci")).toBe("/queue?topic=ci");
  });

  it("clears every filter with the bare queue path", () => {
    expect(queueClearPath()).toBe("/queue");
    expect(overviewPath()).toBe("/");
  });

  it("narrows the queue to one repository, every topic, with the folded slug", () => {
    expect(queueRepoPath({ owner: "No42-Org", name: "TWiki" })).toBe(
      "/queue?repo=no42-org%2Ftwiki",
    );
  });

  it("joins an internal path to TRICORDER_BASE_URL", () => {
    expect(
      absoluteUrl(new URL("https://twiki.app.labmonkeys.space"), "/repo/x/y"),
    ).toBe("https://twiki.app.labmonkeys.space/repo/x/y");
    // A base under a prefix keeps the prefix, whether or not it ends in a
    // slash; a double slash or a dropped prefix would both 404.
    expect(
      absoluteUrl(new URL("https://example.test/dash/"), queuePath("issues")),
    ).toBe("https://example.test/dash/queue?topic=issues");
    expect(absoluteUrl(new URL("https://example.test/dash"), "/reviews")).toBe(
      "https://example.test/dash/reviews",
    );
    expect(
      absoluteUrl(new URL("https://example.test/dash//"), "/reviews"),
    ).toBe("https://example.test/dash/reviews");
  });

  it("refuses a path that is not one of its own", () => {
    expect(() => absoluteUrl(new URL("https://example.test"), "queue")).toThrow(
      "absoluteUrl needs a path starting with /: queue",
    );
  });
});
