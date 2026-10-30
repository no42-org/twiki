/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import {
  overviewTitle,
  repoTitle,
  unknownRepoTitle,
} from "../src/tricorder/web/titles.js";

// EXPERIENCE.md, Document titles: the title is the first thing a screen
// reader speaks, so each is pinned whole. A count nobody confirmed is not a
// zero (AD-28).

describe("document titles", () => {
  it("counts each box, and says unconfirmed rather than zero", () => {
    expect(
      overviewTitle([
        { group: "SECURITY", count: 4 },
        { group: "PULL REQUESTS", count: 0 },
        { group: "RELEASE WORTHY", count: null },
      ]),
    ).toBe(
      "4 security · 0 pull requests · unconfirmed release worthy · gitricorder",
    );
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
});
