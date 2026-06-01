/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { classifyBump, nextPatchTag } from "../src/semver.js";

describe("classifyBump", () => {
  it("classifies a patch bump", () => {
    expect(classifyBump("1.0.0", "1.0.1")).toMatchObject({
      level: "patch",
      indeterminate: false,
    });
  });

  it("classifies a minor bump", () => {
    expect(classifyBump("1.2.0", "1.3.0")).toMatchObject({ level: "minor" });
    expect(classifyBump("1", "1.1")).toMatchObject({ level: "minor" });
  });

  it("classifies a major bump", () => {
    expect(classifyBump("1.9.9", "2.0.0")).toMatchObject({ level: "major" });
    expect(classifyBump("3", "4")).toMatchObject({ level: "major" });
  });

  it("treats unparseable versions as indeterminate major", () => {
    expect(classifyBump("abc", "def")).toMatchObject({
      level: "major",
      indeterminate: true,
    });
    expect(classifyBump(undefined, "1.0.0")).toMatchObject({
      level: "major",
      indeterminate: true,
    });
  });

  it("treats a downgrade as indeterminate major", () => {
    expect(classifyBump("2.0.0", "1.0.0")).toMatchObject({
      level: "major",
      indeterminate: true,
    });
  });
});

describe("nextPatchTag", () => {
  it("bumps the patch, preserving a v prefix", () => {
    expect(nextPatchTag("v1.2.3")).toBe("v1.2.4");
  });
  it("bumps the patch without a v prefix", () => {
    expect(nextPatchTag("1.2.3")).toBe("1.2.4");
  });
  it("starts at v0.0.1 with no prior tag", () => {
    expect(nextPatchTag(null)).toBe("v0.0.1");
  });
  it("ignores prerelease/build metadata when bumping", () => {
    expect(nextPatchTag("v2.5.9-rc1")).toBe("v2.5.10");
  });
});
