/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { DEFAULT_RANK_POLICY, epssRank, KNOWN_BASE } from "../src/core/rank.js";
import {
  parseAttentionEnv,
  parseBaseUrl,
  parseNowEpss,
  parseReviewBudgetDays,
} from "../src/tricorder.js";

// The attention settings both processes parse at startup (AD-29). A bad value
// refuses to start with a named error rather than a stack trace.

describe("TRICORDER_NOW_EPSS", () => {
  it("defaults to 0.1 and becomes the rank of that band", () => {
    const rank = parseNowEpss(undefined, DEFAULT_RANK_POLICY);
    expect(rank).toBe(epssRank(0.1, DEFAULT_RANK_POLICY.epssBands));
    // Middle band of three: one above the floor.
    expect(rank).toBe(KNOWN_BASE + 1);
    expect(parseNowEpss("  ", DEFAULT_RANK_POLICY)).toBe(rank);
  });

  it("accepts any configured band", () => {
    expect(parseNowEpss("0.5", DEFAULT_RANK_POLICY)).toBe(KNOWN_BASE + 2);
    expect(parseNowEpss("0.01", DEFAULT_RANK_POLICY)).toBe(KNOWN_BASE);
  });

  it("refuses a cut that is not one of the bands, naming both", () => {
    expect(() => parseNowEpss("0.2", DEFAULT_RANK_POLICY)).toThrow(
      "TRICORDER_NOW_EPSS 0.2 is not one of the configured EPSS bands 0.5,0.1,0.01",
    );
  });

  it("refuses the default when the configured bands do not carry it", () => {
    // An operator who moved the bands away from 0.1 has moved the line
    // "now" would sit on; silently picking a neighbour would hide that.
    expect(() => parseNowEpss(undefined, { epssBands: [0.5, 0.3] })).toThrow(
      "TRICORDER_NOW_EPSS 0.1 is not one of the configured EPSS bands 0.5,0.3",
    );
  });

  it("refuses a value that is not a number", () => {
    expect(() => parseNowEpss("x", DEFAULT_RANK_POLICY)).toThrow(
      /^TRICORDER_NOW_EPSS x is not a number/,
    );
  });
});

describe("the attention settings together", () => {
  // Which roles call this is decided in main() and is not testable from
  // here: web and collect do, doctor does not.
  it("resolves the defaults from an empty environment", () => {
    expect(parseAttentionEnv({})).toEqual({
      rankPolicy: DEFAULT_RANK_POLICY,
      cutRank: KNOWN_BASE + 1,
      reviewBudgetDays: 3,
      baseUrl: null,
    });
  });

  it("checks the cut against the bands actually configured", () => {
    expect(() =>
      parseAttentionEnv({ TRICORDER_EPSS_BANDS: "0.5,0.3" }),
    ).toThrow(
      "TRICORDER_NOW_EPSS 0.1 is not one of the configured EPSS bands 0.5,0.3",
    );
    expect(
      parseAttentionEnv({
        TRICORDER_EPSS_BANDS: "0.5,0.3",
        TRICORDER_NOW_EPSS: "0.3",
        TRICORDER_REVIEW_BUDGET_DAYS: "7",
        TRICORDER_BASE_URL: "https://twiki.app.labmonkeys.space",
      }),
    ).toEqual({
      rankPolicy: { epssBands: [0.5, 0.3] },
      cutRank: KNOWN_BASE,
      reviewBudgetDays: 7,
      baseUrl: new URL("https://twiki.app.labmonkeys.space"),
    });
  });

  it("refuses a bad base URL with the others, by name", () => {
    expect(() => parseAttentionEnv({ TRICORDER_BASE_URL: "garbage" })).toThrow(
      "TRICORDER_BASE_URL is not a URL: garbage",
    );
  });
});

describe("TRICORDER_BASE_URL", () => {
  it("is null when unset or blank", () => {
    expect(parseBaseUrl(undefined)).toBeNull();
    expect(parseBaseUrl("")).toBeNull();
    expect(parseBaseUrl("  ")).toBeNull();
  });

  it("parses an https URL, trimmed", () => {
    expect(parseBaseUrl(" https://twiki.app.labmonkeys.space ")).toEqual(
      new URL("https://twiki.app.labmonkeys.space"),
    );
  });

  it.each([
    "https://twiki.app.labmonkeys.space/?x=1",
    "https://twiki.app.labmonkeys.space/#top",
    "https://user:pw@twiki.app.labmonkeys.space",
    "https://user@twiki.app.labmonkeys.space",
  ])("refuses a query, fragment or credentials: %s", (raw) => {
    expect(() => parseBaseUrl(raw)).toThrow(
      `TRICORDER_BASE_URL must not carry a query, fragment or credentials: ${raw}`,
    );
  });

  it("refuses http and garbage by name", () => {
    expect(() => parseBaseUrl("http://twiki.app.labmonkeys.space")).toThrow(
      "TRICORDER_BASE_URL must be https: http://twiki.app.labmonkeys.space",
    );
    expect(() => parseBaseUrl("not a url")).toThrow(
      "TRICORDER_BASE_URL is not a URL: not a url",
    );
  });
});

describe("TRICORDER_REVIEW_BUDGET_DAYS", () => {
  it("defaults to 3 when unset or blank", () => {
    expect(parseReviewBudgetDays(undefined)).toBe(3);
    expect(parseReviewBudgetDays("")).toBe(3);
    expect(parseReviewBudgetDays("  ")).toBe(3);
  });

  it("accepts a positive integer", () => {
    expect(parseReviewBudgetDays("1")).toBe(1);
    expect(parseReviewBudgetDays(" 14 ")).toBe(14);
  });

  it.each(["0", "-1", "x", "1.5", "3d"])("refuses %s by name", (raw) => {
    expect(() => parseReviewBudgetDays(raw)).toThrow(
      `TRICORDER_REVIEW_BUDGET_DAYS is not a positive integer: ${raw}`,
    );
  });
});
