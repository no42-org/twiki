/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import {
  absoluteUrl,
  overviewPath,
  repoPath,
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

  it("leads each topic to the overview, filtered as far as the overview can", () => {
    const repo = { owner: "No42-Org", name: "TWiki" };
    expect(topicPath("security")).toBe("/?kind=SECURITY");
    expect(topicPath("pulls")).toBe("/?kind=PULL+REQUESTS");
    expect(topicPath("dependencies")).toBe("/?kind=PULL+REQUESTS");
    expect(topicPath("reviews")).toBe("/?kind=PULL+REQUESTS");
    expect(topicPath("security", repo)).toBe(
      "/?kind=SECURITY&repo=no42-org%2Ftwiki",
    );
    // CI and issues have no box, so only the repository narrows them.
    expect(topicPath("ci")).toBe("/");
    expect(topicPath("issues", repo)).toBe("/?repo=no42-org%2Ftwiki");
    expect(overviewPath()).toBe("/");
  });

  it("joins an internal path to TRICORDER_BASE_URL", () => {
    expect(
      absoluteUrl(new URL("https://twiki.app.labmonkeys.space"), "/repo/x/y"),
    ).toBe("https://twiki.app.labmonkeys.space/repo/x/y");
    // A base under a prefix keeps the prefix, whether or not it ends in a
    // slash; a double slash or a dropped prefix would both 404.
    expect(
      absoluteUrl(new URL("https://example.test/dash/"), topicPath("security")),
    ).toBe("https://example.test/dash/?kind=SECURITY");
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
