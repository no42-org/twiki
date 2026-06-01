/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { isSettled } from "../src/gates.js";
import { DEFAULT_POLICY } from "../src/types.js";
import { makeBump, makeFacts, makePr } from "./fakes.js";

describe("isSettled", () => {
  it("is settled with no open mergeable PRs, green main, and unreleased changes", () => {
    expect(isSettled(makeFacts(), DEFAULT_POLICY)).toBe(true);
  });

  it("is not settled while a mergeable PR is still open", () => {
    const facts = makeFacts({ prs: [makePr({ checks: "green" })] });
    expect(isSettled(facts, DEFAULT_POLICY)).toBe(false);
  });

  it("a stuck red PR does not block release", () => {
    const facts = makeFacts({ prs: [makePr({ checks: "red" })] });
    expect(isSettled(facts, DEFAULT_POLICY)).toBe(true);
  });

  it("a green major does not count as mergeable, so it does not block", () => {
    const facts = makeFacts({
      prs: [makePr({ checks: "green", bump: makeBump({ level: "major" }) })],
    });
    expect(isSettled(facts, DEFAULT_POLICY)).toBe(true);
  });

  it("is not settled when main is red", () => {
    expect(isSettled(makeFacts({ mainChecks: "red" }), DEFAULT_POLICY)).toBe(false);
  });

  it("is not settled with no unreleased dependency changes", () => {
    expect(isSettled(makeFacts({ unreleasedDependencyCommits: 0 }), DEFAULT_POLICY)).toBe(false);
  });
});
