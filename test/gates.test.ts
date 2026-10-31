/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { type MergeRefusal, REFUSAL_WORDS } from "../src/core/merge.js";
import { DEFAULT_POLICY } from "../src/core/types.js";
import {
  canRebase,
  canRerunCi,
  isFailing,
  mergeBlock,
  operatorMergeBlock,
  settledBlock,
  withinMergePolicy,
} from "../src/twiki/gates.js";
import { makeBump, makePr, makeRun } from "./fakes.js";

const minorOff = { ...DEFAULT_POLICY, autoMergeMinor: false };

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

describe("operatorMergeBlock", () => {
  const open = {
    state: "OPEN",
    isDraft: false,
    headSha: "a",
    reviewDecision: "APPROVED",
  } as const;

  it("settles MERGED and CLOSED without checks, and nothing else", () => {
    expect(settledBlock({ ...open, state: "MERGED" })).toBe("already-merged");
    expect(settledBlock({ ...open, state: "CLOSED" })).toBe("closed");
    expect(settledBlock(open)).toBeNull();
  });

  it("walks the whole table", () => {
    expect(operatorMergeBlock(open, "green")).toBeNull();
    expect(
      operatorMergeBlock({ ...open, reviewDecision: null }, "green"),
    ).toBeNull();
    expect(
      operatorMergeBlock(
        { ...open, reviewDecision: "CHANGES_REQUESTED" },
        "green",
      ),
    ).toBe("changes-requested");
    expect(
      operatorMergeBlock(
        { ...open, reviewDecision: "REVIEW_REQUIRED" },
        "green",
      ),
    ).toBe("review-required");
    expect(
      operatorMergeBlock({ ...open, reviewDecision: "unknown" }, "green"),
    ).toBe("review-required");
    expect(operatorMergeBlock({ ...open, isDraft: true }, "red")).toBe("draft");
    expect(
      operatorMergeBlock(
        { ...open, reviewDecision: "CHANGES_REQUESTED" },
        "red",
      ),
    ).toBe("ci-failed");
    expect(operatorMergeBlock(open, "red")).toBe("ci-failed");
    expect(operatorMergeBlock(open, "pending")).toBe("ci-running");
    expect(operatorMergeBlock(open, "none")).toBe("no-checks");
    expect(operatorMergeBlock({ ...open, isDraft: true }, "green")).toBe(
      "draft",
    );
    expect(operatorMergeBlock({ ...open, state: "CLOSED" }, "green")).toBe(
      "closed",
    );
    expect(operatorMergeBlock({ ...open, state: "MERGED" }, "red")).toBe(
      "already-merged",
    );
  });
});

describe("REFUSAL_WORDS", () => {
  it("names every refusal exactly", () => {
    expect(REFUSAL_WORDS).toEqual({
      "shadow-mode": "Shadow mode",
      "not-allowlisted": "Not in the allowlist",
      closed: "Closed",
      draft: "Draft",
      "ci-failed": "CI failed",
      "ci-running": "CI running",
      "no-checks": "Checks not observed",
      "changes-requested": "Changes requested",
      "review-required": "Review required",
      "head-changed": "New commits pushed",
      "not-mergeable": "GitHub refused the merge",
      unreachable: "twiki is not reachable",
    } satisfies Record<MergeRefusal, string>);
  });
});
