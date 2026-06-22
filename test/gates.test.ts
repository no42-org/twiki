/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import {
  canMerge,
  canRebase,
  canRerunCi,
  isFailing,
  mergeBlock,
  withinMergePolicy,
} from "../src/gates.js";
import { DEFAULT_POLICY } from "../src/types.js";
import { makeBump, makePr, makeRun } from "./fakes.js";

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

describe("canRerunCi", () => {
  it("re-runs a completed-failing run below the attempt ceiling", () => {
    expect(canRerunCi(makeRun({ runAttempt: 1 }), 2)).toBe(true);
  });
  it("does not re-run once attempts reach the ceiling (boundary)", () => {
    expect(canRerunCi(makeRun({ runAttempt: 2 }), 2)).toBe(false);
    // The named value of 1 means a single attempt — i.e. no re-run at all.
    expect(canRerunCi(makeRun({ runAttempt: 1 }), 1)).toBe(false);
  });
  it("never re-runs an in-progress run", () => {
    expect(
      canRerunCi(makeRun({ status: "in_progress", conclusion: null }), 2),
    ).toBe(false);
    expect(canRerunCi(makeRun({ status: "queued", conclusion: null }), 2)).toBe(
      false,
    );
  });
  it("only re-runs failing conclusions", () => {
    expect(canRerunCi(makeRun({ conclusion: "success" }), 2)).toBe(false);
    for (const c of ["failure", "timed_out", "cancelled"]) {
      expect(isFailing(c)).toBe(true);
      expect(canRerunCi(makeRun({ conclusion: c }), 2)).toBe(true);
    }
    expect(isFailing("success")).toBe(false);
    expect(isFailing(null)).toBe(false);
  });
});

describe("canRebase", () => {
  it("is eligible when behind, within policy, and head not red", () => {
    expect(
      canRebase(makePr({ behindBy: 3, checks: "green" }), DEFAULT_POLICY),
    ).toBe(true);
    // pending (not red) is still eligible
    expect(
      canRebase(makePr({ behindBy: 1, checks: "pending" }), DEFAULT_POLICY),
    ).toBe(true);
  });
  it("is not eligible when level with base", () => {
    expect(
      canRebase(makePr({ behindBy: 0, checks: "green" }), DEFAULT_POLICY),
    ).toBe(false);
  });
  it("fail-closed when behindBy is unknown (null/undefined)", () => {
    expect(
      canRebase(makePr({ behindBy: null, checks: "green" }), DEFAULT_POLICY),
    ).toBe(false);
    expect(
      canRebase(
        makePr({ behindBy: undefined, checks: "green" }),
        DEFAULT_POLICY,
      ),
    ).toBe(false);
  });
  it("never rebases a PR red on its own merits (anti-thrash)", () => {
    expect(
      canRebase(makePr({ behindBy: 5, checks: "red" }), DEFAULT_POLICY),
    ).toBe(false);
  });
  it("never rebases an out-of-policy bump", () => {
    expect(
      canRebase(
        makePr({
          behindBy: 5,
          checks: "green",
          bump: makeBump({ level: "major" }),
        }),
        DEFAULT_POLICY,
      ),
    ).toBe(false);
    expect(
      canRebase(
        makePr({
          behindBy: 5,
          checks: "green",
          bump: makeBump({ level: "minor" }),
        }),
        minorOff,
      ),
    ).toBe(false);
  });
  it("never rebases a non-Dependabot PR", () => {
    expect(
      canRebase(
        makePr({ behindBy: 5, checks: "green", isDependabot: false }),
        DEFAULT_POLICY,
      ),
    ).toBe(false);
  });
});
