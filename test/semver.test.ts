/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import {
  classifyBump,
  highestStableTag,
  isPrerelease,
  nextPatchTag,
  planRelease,
} from "../src/semver.js";

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

describe("isPrerelease", () => {
  it("is false for plain releases (with or without v)", () => {
    expect(isPrerelease("2.3.1")).toBe(false);
    expect(isPrerelease("v2.3.1")).toBe(false);
  });
  it("ignores build metadata that has no prerelease", () => {
    expect(isPrerelease("2.3.1+abc1234")).toBe(false);
  });
  it("is true for prerelease segments", () => {
    expect(isPrerelease("2.4.0-rc.1")).toBe(true);
    expect(isPrerelease("2.3.2-dev.5")).toBe(true);
    expect(isPrerelease("2.3.2-dev.5+abc1234")).toBe(true);
  });
});

describe("highestStableTag", () => {
  it("picks the highest non-prerelease tag", () => {
    expect(highestStableTag(["v2.0.0", "v2.3.1", "v1.4.9"])).toBe("v2.3.1");
  });
  it("ignores prereleases", () => {
    expect(highestStableTag(["v2.3.1", "v2.4.0-rc.1"])).toBe("v2.3.1");
    expect(highestStableTag(["v2.4.0-rc.1"])).toBeNull();
  });
  it("is null when there are no tags", () => {
    expect(highestStableTag([])).toBeNull();
  });
});

describe("planRelease", () => {
  const sha = "abc1234";

  it("first-ever main build is the next patch of 0.0.0 as -dev", () => {
    expect(
      planRelease({
        refType: "branch",
        refName: "main",
        tags: [],
        commitsSinceHighest: 5,
        shortSha: sha,
      }),
    ).toEqual({
      channel: "edge",
      prerelease: true,
      version: "0.0.1-dev.5+abc1234",
      tagSuffixes: ["main", "sha-abc1234", "0.0.1-dev.5"],
    });
  });

  it("main build is the next patch of the highest tag as -dev", () => {
    expect(
      planRelease({
        refType: "branch",
        refName: "main",
        tags: ["v2.0.0", "v2.3.1"],
        commitsSinceHighest: 3,
        shortSha: sha,
      }),
    ).toMatchObject({
      channel: "edge",
      version: "2.3.2-dev.3+abc1234",
      tagSuffixes: ["main", "sha-abc1234", "2.3.2-dev.3"],
    });
  });

  it("highest stable tag gets :latest", () => {
    expect(
      planRelease({
        refType: "tag",
        refName: "v2.3.1",
        tags: ["v2.0.0", "v2.3.1"],
        commitsSinceHighest: 0,
        shortSha: sha,
      }),
    ).toEqual({
      channel: "stable",
      prerelease: false,
      version: "2.3.1",
      tagSuffixes: ["2.3.1", "2.3", "2", "latest"],
    });
  });

  it("a backport tag does NOT get :latest", () => {
    expect(
      planRelease({
        refType: "tag",
        refName: "v1.4.9",
        tags: ["v1.4.9", "v2.3.1"],
        commitsSinceHighest: 0,
        shortSha: sha,
      }).tagSuffixes,
    ).toEqual(["1.4.9", "1.4", "1"]);
  });

  it("a prerelease tag is exact-only", () => {
    expect(
      planRelease({
        refType: "tag",
        refName: "v2.4.0-rc.1",
        tags: ["v2.3.1"],
        commitsSinceHighest: 0,
        shortSha: sha,
      }),
    ).toEqual({
      channel: "prerelease",
      prerelease: true,
      version: "2.4.0-rc.1",
      tagSuffixes: ["2.4.0-rc.1"],
    });
  });

  it("rejects an off-convention tag", () => {
    for (const bad of ["v2.3", "v2", "v2.3.1.4", "vfoo"]) {
      expect(() =>
        planRelease({
          refType: "tag",
          refName: bad,
          tags: [],
          commitsSinceHighest: 0,
          shortSha: sha,
        }),
      ).toThrow();
    }
  });
});
