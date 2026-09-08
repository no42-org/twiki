/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RANK_POLICY,
  epssRank,
  NOT_APPLICABLE,
  type RankInput,
  rank,
} from "../src/core/rank.js";
import {
  cutRankFor,
  DEFAULT_NOW_EPSS,
  defaultCutRank,
  maxTier,
  type Tier,
  tier,
} from "../src/core/tier.js";

// AD-29: three buckets over the chain's term ranks, never a second ranking.

const P = DEFAULT_RANK_POLICY;
const CUT = epssRank(DEFAULT_NOW_EPSS, P.epssBands);

/** The all-least-known baseline: every term measured and found harmless. */
const quietItem = (over: Partial<RankInput> = {}): RankInput => ({
  // n/a, the state every kind but a CI failure passes; the measured-green
  // `false` is a row of the table below.
  broken: NOT_APPLICABLE,
  kev: false,
  epss: NOT_APPLICABLE,
  severity: "low",
  bump: "patch",
  stuck: false,
  ...over,
});

const bucket = (input: RankInput, cut = CUT): Tier => tier(rank(input, P), cut);

describe("tier() over every term state (AD-29)", () => {
  it("is quiet only when every term sits at least-known", () => {
    expect(bucket(quietItem())).toBe("quiet");
    // n/a is least-known too: nothing to know is not something to act on.
    expect(
      bucket({
        broken: NOT_APPLICABLE,
        kev: NOT_APPLICABLE,
        epss: NOT_APPLICABLE,
        severity: NOT_APPLICABLE,
        bump: NOT_APPLICABLE,
        stuck: NOT_APPLICABLE,
      }),
    ).toBe("quiet");
  });

  it("is soon, never quiet and never now, when every term is unknown", () => {
    // Unknown sits above least-known (AD-20), so a signal we failed to
    // collect cannot read as quiet; and nothing unknown is evidence for now.
    expect(
      bucket({
        broken: null,
        kev: null,
        epss: null,
        severity: null,
        bump: null,
        stuck: null,
      }),
    ).toBe("soon");
  });

  describe.each<[keyof RankInput, RankInput[keyof RankInput], Tier]>([
    // One term at a time from the quiet baseline, every state of it.
    // A red default branch is the chain's leading term, and the only other
    // one that reaches `now` on its own: nothing ships from a broken main.
    ["broken", null, "soon"],
    ["broken", NOT_APPLICABLE, "quiet"],
    ["broken", false, "quiet"],
    ["broken", true, "now"],
    ["kev", null, "soon"],
    ["kev", NOT_APPLICABLE, "quiet"],
    ["kev", false, "quiet"],
    ["kev", true, "now"],
    ["epss", null, "soon"],
    ["epss", NOT_APPLICABLE, "quiet"],
    ["epss", 0.001, "quiet"],
    ["epss", 0.01, "soon"],
    ["epss", 0.0999, "soon"],
    ["epss", 0.1, "now"],
    ["epss", 0.5, "now"],
    ["severity", null, "soon"],
    ["severity", NOT_APPLICABLE, "quiet"],
    ["severity", "low", "quiet"],
    ["severity", "medium", "soon"],
    ["severity", "high", "soon"],
    ["severity", "critical", "soon"],
    ["bump", null, "soon"],
    ["bump", NOT_APPLICABLE, "quiet"],
    ["bump", "patch", "quiet"],
    ["bump", "minor", "soon"],
    ["bump", "major", "soon"],
    ["stuck", null, "soon"],
    ["stuck", NOT_APPLICABLE, "quiet"],
    ["stuck", false, "quiet"],
    ["stuck", true, "soon"],
  ])("%s = %s", (term, value, expected) => {
    it(`is ${expected}`, () => {
      expect(bucket(quietItem({ [term]: value }))).toBe(expected);
    });
  });

  it("puts a KEV listing in now whatever the EPSS says", () => {
    expect(bucket(quietItem({ kev: true, epss: 0.001 }))).toBe("now");
    expect(bucket(quietItem({ kev: true, epss: null }))).toBe("now");
  });

  it("puts an EPSS at the cut in now and one just below it in soon", () => {
    expect(bucket(quietItem({ kev: false, epss: 0.1 }))).toBe("now");
    expect(
      bucket(quietItem({ kev: false, epss: 0.0999, severity: "high" })),
    ).toBe("soon");
  });

  it("has no severity floor: a critical alert below the cut is soon", () => {
    expect(
      bucket(quietItem({ kev: false, epss: 0.05, severity: "critical" })),
    ).toBe("soon");
  });

  it("compares the cut as a rank, so moving the cut moves the line", () => {
    const top = epssRank(0.5, P.epssBands);
    expect(bucket(quietItem({ epss: 0.1 }), top)).toBe("soon");
    expect(bucket(quietItem({ epss: 0.5 }), top)).toBe("now");
  });

  it("refuses a cut that is not a measured EPSS rank", () => {
    // LEAST_KNOWN or UNKNOWN as the cut is satisfied by every item, all-n/a
    // issues included, and the whole estate reads as now.
    expect(() => tier(rank(quietItem(), P), 0)).toThrow(
      "cutRank 0 is not a measured EPSS rank",
    );
    expect(() => tier(rank(quietItem(), P), 1)).toThrow(
      "cutRank 1 is not a measured EPSS rank",
    );
  });

  it("reads a ranking with no terms as soon, never now", () => {
    // A term the ranking does not carry is unknown, and unknown is not
    // evidence for now.
    const ranking = rank(quietItem({ kev: true }), P);
    expect(tier({ ...ranking, terms: [] }, CUT)).toBe("soon");
  });

  it("reads the term ranks, not the key, so the two cannot be confused", () => {
    // A ranking whose key says "listed" but whose terms say otherwise is
    // judged on the terms: they are what the explanation was built from.
    const ranking = rank(quietItem(), P);
    expect(tier({ ...ranking, key: [9, 9, 9, 9, 9] }, CUT)).toBe("quiet");
  });
});

describe("the cut as a rank (AD-29)", () => {
  it("resolves a configured band to its rank, and the default likewise", () => {
    expect(cutRankFor(0.5, P)).toBe(epssRank(0.5, P.epssBands));
    expect(defaultCutRank(P)).toBe(epssRank(DEFAULT_NOW_EPSS, P.epssBands));
  });

  it("refuses a cut the bands do not carry, the default included", () => {
    expect(() => cutRankFor(0.2, P)).toThrow(
      "TRICORDER_NOW_EPSS 0.2 is not one of the configured EPSS bands 0.5,0.1,0.01",
    );
    // Bands moved away from 0.1 with no cut configured: the pages' fallback
    // must refuse exactly as startup does, not resolve to LEAST_KNOWN.
    expect(() => defaultCutRank({ epssBands: [0.5, 0.3] })).toThrow(
      "TRICORDER_NOW_EPSS 0.1 is not one of the configured EPSS bands 0.5,0.3",
    );
  });
});

describe("maxTier", () => {
  it("orders now above soon above quiet", () => {
    expect(maxTier("quiet", "soon")).toBe("soon");
    expect(maxTier("soon", "now")).toBe("now");
    expect(maxTier("now", "quiet")).toBe("now");
    expect(maxTier("quiet", "quiet")).toBe("quiet");
  });
});
