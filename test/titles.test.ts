/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { parseQueueFilter } from "../src/tricorder/attention/filter.js";
import {
  overviewTitle,
  queueTitle,
  repoTitle,
  reviewsTitle,
  unknownRepoTitle,
} from "../src/tricorder/web/titles.js";

// EXPERIENCE.md, Document titles: the title is the first thing a screen
// reader speaks after a notification link, so every row of the table is
// pinned whole. `nothing pressing` and `nothing collected yet` are different
// facts (AD-28) and never collapse into one.

const WATCHED = [{ owner: "no42-org", name: "twiki" }];

describe("document titles", () => {
  const quiet = (unconfirmed = 0) => ({ now: 0, soon: 0, unconfirmed });

  it.each([
    [
      { now: 2, soon: 6, unconfirmed: 0 },
      true,
      0,
      "2 now, 6 soon · gitricorder",
    ],
    [
      { now: 1, soon: 0, unconfirmed: 0 },
      true,
      0,
      "1 now, 0 soon · gitricorder",
    ],
    [
      { now: 0, soon: 3, unconfirmed: 0 },
      true,
      0,
      "0 now, 3 soon · gitricorder",
    ],
    [quiet(), true, 0, "nothing pressing · gitricorder"],
    // The board withholds "nothing pressing" while a repository is
    // unconfirmed or a row is unreadable; so does the title (AD-28).
    [quiet(1), true, 0, "0 now, 0 soon · gitricorder"],
    [quiet(), true, 1, "0 now, 0 soon · gitricorder"],
    [quiet(), false, 0, "nothing collected yet · gitricorder"],
  ])(
    "overview %j collected=%s unreadable=%s reads %s",
    (summary, collected, unreadable, title) => {
      expect(overviewTitle(summary, collected, unreadable)).toBe(title);
    },
  );

  it.each([
    [undefined, undefined, "queue · gitricorder"],
    ["dependencies", undefined, "queue · dependencies · gitricorder"],
    [undefined, "no42-org/twiki", "queue · no42-org/twiki · gitricorder"],
    [
      "dependencies",
      "no42-org/twiki",
      "queue · dependencies · no42-org/twiki · gitricorder",
    ],
    // A value the grammar does not know renders the no-matches state, so
    // the title names no filter, not even the half it understood.
    ["foo", undefined, "queue · gitricorder"],
    [undefined, "no42-org/unwatched", "queue · gitricorder"],
    ["foo", "no42-org/twiki", "queue · gitricorder"],
    ["dependencies", "no42-org/unwatched", "queue · gitricorder"],
    // The repository is folded the way the page folds it (AD-33).
    [
      "Security",
      "No42-Org/TWiki",
      "queue · security · no42-org/twiki · gitricorder",
    ],
  ])("queue topic=%s repo=%s reads %s", (topic, repo, title) => {
    expect(queueTitle(parseQueueFilter(topic, repo, WATCHED))).toBe(title);
  });

  it("names the repository and its tier", () => {
    expect(repoTitle("no42-org/twiki", "soon")).toBe(
      "no42-org/twiki · soon · gitricorder",
    );
    expect(repoTitle("no42-org/twiki", "now")).toBe(
      "no42-org/twiki · now · gitricorder",
    );
    expect(unknownRepoTitle()).toBe("unknown repository · gitricorder");
  });

  it("counts the reviews waiting, zero included, only once a sweep has confirmed them", () => {
    expect(reviewsTitle(2, true)).toBe("reviews · 2 waiting · gitricorder");
    expect(reviewsTitle(0, true)).toBe("reviews · 0 waiting · gitricorder");
    // Nothing collected is not zero waiting (AD-28).
    expect(reviewsTitle(0, false)).toBe("reviews · unconfirmed · gitricorder");
  });
});
