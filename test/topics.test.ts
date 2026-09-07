/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { KIND_REASONS, kevListedFor } from "../src/core/topics.js";

// AD-31: one owner for what each kind may say and shout about.

describe("kevListedFor", () => {
  it.each([
    ["alert", true],
    ["update_pr", true],
    ["issue", false],
  ] as const)("%s: %s", (kind, expected) => {
    expect(kevListedFor(kind)).toBe(expected);
  });
});

describe("KIND_REASONS", () => {
  it("has a table for every kind, and only the issue rewords the chain", () => {
    expect(Object.keys(KIND_REASONS).sort()).toEqual([
      "alert",
      "issue",
      "update_pr",
    ]);
    expect(KIND_REASONS.alert).toEqual({});
    expect(KIND_REASONS.update_pr).toEqual({});
  });
});
