/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { canMerge, mergeBlock, withinMergePolicy } from "../src/gates.js";
import { DEFAULT_POLICY } from "../src/types.js";
import { makeBump, makePr } from "./fakes.js";

const minorOff = { autoMergeMinor: false, mergeOnly: false };

describe("withinMergePolicy", () => {
  it("allows patch always", () => {
    expect(
      withinMergePolicy(
        makePr({ bump: makeBump({ level: "patch" }) }),
        DEFAULT_POLICY,
      ),
    ).toBe(true);
  });
  it("allows minor only when enabled", () => {
    const pr = makePr({ bump: makeBump({ level: "minor" }) });
    expect(withinMergePolicy(pr, DEFAULT_POLICY)).toBe(true);
    expect(withinMergePolicy(pr, minorOff)).toBe(false);
  });
  it("never allows major or indeterminate", () => {
    expect(
      withinMergePolicy(
        makePr({ bump: makeBump({ level: "major" }) }),
        DEFAULT_POLICY,
      ),
    ).toBe(false);
    expect(
      withinMergePolicy(
        makePr({ bump: makeBump({ level: "patch", indeterminate: true }) }),
        DEFAULT_POLICY,
      ),
    ).toBe(false);
  });
});

describe("mergeBlock", () => {
  it("passes a green patch", () => {
    expect(mergeBlock(makePr(), DEFAULT_POLICY)).toBeNull();
    expect(canMerge(makePr(), DEFAULT_POLICY)).toBe(true);
  });
  it("blocks when CI is not green", () => {
    expect(mergeBlock(makePr({ checks: "red" }), DEFAULT_POLICY)).toBe(
      "ci-not-green",
    );
    expect(mergeBlock(makePr({ checks: "pending" }), DEFAULT_POLICY)).toBe(
      "ci-not-green",
    );
  });
  it("blocks a green major", () => {
    const pr = makePr({ bump: makeBump({ level: "major" }) });
    expect(mergeBlock(pr, DEFAULT_POLICY)).toBe("above-minor");
  });
  it("checks CI before policy", () => {
    const pr = makePr({ checks: "red", bump: makeBump({ level: "major" }) });
    expect(mergeBlock(pr, DEFAULT_POLICY)).toBe("ci-not-green");
  });
});
