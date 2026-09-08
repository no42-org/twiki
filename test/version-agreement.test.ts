/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import {
  compileVersionPattern,
  MAX_PATTERN_CHARS,
  MAX_SCANNED_CHARS,
  matchVersion,
  versionPatternProblem,
  versionsAgree,
} from "../src/core/version-agreement.js";

// The pure half of the tree-version check (#145), tested directly rather than
// only through the config parser and the executor. Each of these decides
// whether a release is blocked, and reaching them through two layers meant a
// wrong answer here could only ever be seen as a wrong sentence over there.

describe("a declared pattern is judged where it is written", () => {
  it("accepts a pattern with exactly one capture group", () => {
    expect(versionPatternProblem('const version = "([^"]+)"')).toBeNull();
  });

  it("names the count when there is not exactly one group", () => {
    expect(versionPatternProblem("version = .*")).toMatch(
      /exactly one capture group.*has 0/,
    );
    expect(versionPatternProblem("(\\d+)\\.(\\d+)")).toMatch(
      /exactly one capture group.*has 2/,
    );
    // A non-capturing group is not one, and a named group is.
    expect(versionPatternProblem("(?:v)(\\d+)")).toBeNull();
    expect(versionPatternProblem("(?<version>\\d+)")).toBeNull();
  });

  it("says why a pattern will not compile", () => {
    expect(versionPatternProblem("version = ([0-9")).toMatch(
      /not a valid regular expression/,
    );
  });

  it("refuses a pattern long enough to cost the whole digest", () => {
    // A pattern that fails is quoted verbatim in the outcome, and a chat
    // transport drops an over-long message whole - merges reported in it
    // included.
    const long = `(${"a".repeat(MAX_PATTERN_CHARS)})`;
    expect(long.length).toBeGreaterThan(MAX_PATTERN_CHARS);
    expect(versionPatternProblem(long)).toMatch(/at most 200 characters/);
    expect(versionPatternProblem(`(${"a".repeat(100)})`)).toBeNull();
  });

  it("throws only on a pattern the same check rejects", () => {
    expect(() => compileVersionPattern("version = .*")).toThrow(
      /exactly one capture group/,
    );
    expect(compileVersionPattern("(\\d+)").flags).toBe("gm");
  });
});

describe("what a pattern finds in a file", () => {
  const go = (v: string) => `package version\n\nconst version = "${v}"\n`;

  it("returns the captured version, trimmed", () => {
    expect(matchVersion(go("0.6.2"), 'const version = "([^"]+)"')).toEqual({
      kind: "found",
      version: "0.6.2",
    });
    expect(matchVersion("version:  0.6.2  \n", "version:(.*)")).toEqual({
      kind: "found",
      version: "0.6.2",
    });
  });

  it("anchors ^ and $ to a line, as the `m` flag promises", () => {
    // The example config documents this. Without `m` the pattern below
    // matches nothing at all, because `^` would only be the file's start.
    const file = "# a comment\nversion = 0.6.2\n# another\n";
    expect(matchVersion(file, "^version = (.*)$")).toEqual({
      kind: "found",
      version: "0.6.2",
    });
  });

  it("sees a second match anywhere in the file, not just the first line", () => {
    // The `g` flag. Without it `exec` restarts from the top and the second
    // call returns the first match forever.
    expect(
      matchVersion(`${go("0.6.2")}${go("0.6.2")}`, 'version = "(.*)"'),
    ).toEqual({ kind: "many" });
  });

  it("reports no version when the pattern matches nowhere", () => {
    expect(matchVersion("package version\n", 'version = "(.*)"')).toEqual({
      kind: "none",
    });
  });

  it("reports no version when the match captured nothing", () => {
    // The group sits in an alternative the match did not take. Something
    // matched and no version came of it.
    expect(matchVersion("unreleased\n", "unreleased|version = (.*)")).toEqual({
      kind: "none",
    });
  });

  it("reports no version when the capture is blank", () => {
    // Otherwise the digest reads `says  at abc1234`, with a hole where the
    // version should be.
    expect(matchVersion(go(""), 'const version = "(.*)"')).toEqual({
      kind: "none",
    });
    expect(matchVersion("version =    \n", "version =(.*)")).toEqual({
      kind: "none",
    });
  });

  it("does not count one zero-length match as two", () => {
    // A match of nothing leaves `lastIndex` where it was, so a second look
    // finds the SAME match again. Reported as "more than one place" it would
    // send an operator hunting a duplicate that is not in the file. An empty
    // file is the case with nowhere else for a second match to be.
    expect(matchVersion("", "(x?)")).toEqual({ kind: "none" });
  });

  it("refuses to scan a file past the stated size, and says so", () => {
    // Not "the pattern found nothing": the pattern is the operator's, the
    // backtracking is theirs, and the release path is no place to discover
    // how a pathological one behaves on a megabyte of minified output.
    const huge = `x\n`.repeat(MAX_SCANNED_CHARS);
    expect(huge.length).toBeGreaterThan(MAX_SCANNED_CHARS);
    expect(matchVersion(huge, 'version = "(.*)"')).toEqual({
      kind: "too-large",
      chars: huge.length,
      limit: MAX_SCANNED_CHARS,
    });
  });
});

describe("the comparison itself", () => {
  it("accepts an optional leading v on either side and nothing else", () => {
    // `semver.ts`'s `parseVersion` reads exactly right for this and is wrong:
    // it discards the prerelease suffix, so `0.6.2-rc` and `v0.6.2` parse to
    // the same numbers and the packyard case would pass. This is a string
    // comparison for that reason.
    expect(versionsAgree("v0.6.2", "0.6.2")).toBe(true);
    expect(versionsAgree("0.6.2", "v0.6.2")).toBe(true);
    expect(versionsAgree("v0.6.2", "v0.6.2")).toBe(true);
    expect(versionsAgree("v0.6.2", "0.6.2-rc")).toBe(false);
    expect(versionsAgree("v0.6.2", "0.6.2+build")).toBe(false);
    expect(versionsAgree("v0.6.2", "0.6.20")).toBe(false);
    expect(versionsAgree("v0.6.2", "vv0.6.2")).toBe(false);
  });
});
