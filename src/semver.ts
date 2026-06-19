/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { Bump, BumpLevel } from "./types.js";

interface Parsed {
  major: number;
  minor: number;
  patch: number;
}

/** Parse a loose version string ("1", "1.2", "v1.2.3", "1.2.3-rc1") into parts. */
function parseVersion(raw: string): Parsed | null {
  const cleaned = raw.trim().replace(/^v/i, "");
  const core = cleaned.split(/[-+]/, 1)[0] ?? "";
  const parts = core.split(".");
  if (parts.length === 0 || parts[0] === "") return null;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0)) return null;
  return {
    major: nums[0] ?? 0,
    minor: nums[1] ?? 0,
    patch: nums[2] ?? 0,
  };
}

/**
 * Classify the bump implied by a from/to version pair.
 *
 * Per spec, an indeterminate bump (unparseable versions, or a downgrade) is
 * treated as `major` so it can never be auto-merged.
 */
export function classifyBump(
  from: string | undefined,
  to: string | undefined,
  name?: string,
): Bump {
  const base = { name, from, to };
  if (!from || !to) {
    return { ...base, level: "major", indeterminate: true };
  }
  const a = parseVersion(from);
  const b = parseVersion(to);
  if (!a || !b) {
    return { ...base, level: "major", indeterminate: true };
  }

  let level: BumpLevel;
  if (b.major !== a.major) level = "major";
  else if (b.minor !== a.minor) level = "minor";
  else if (b.patch !== a.patch) level = "patch";
  else level = "patch"; // no change — harmless, treat as patch

  // A downgrade is unexpected for Dependabot; treat conservatively as major.
  const downgrade =
    b.major < a.major ||
    (b.major === a.major && b.minor < a.minor) ||
    (b.major === a.major && b.minor === a.minor && b.patch < a.patch);
  if (downgrade) {
    return { ...base, level: "major", indeterminate: true };
  }

  return { ...base, level, indeterminate: false };
}

/**
 * Compute the next patch tag from the latest release tag, preserving a leading
 * "v" if present. With no prior tag, the first release is v0.0.1.
 */
export function nextPatchTag(latestTag: string | null): string {
  if (!latestTag) return "v0.0.1";
  const hasV = /^v/i.test(latestTag.trim());
  const parsed = parseVersion(latestTag);
  if (!parsed) {
    throw new Error(
      `Cannot compute next patch from unparseable tag: "${latestTag}"`,
    );
  }
  const next = `${parsed.major}.${parsed.minor}.${parsed.patch + 1}`;
  return hasV ? `v${next}` : next;
}

const STRICT_SEMVER_TAG = /^v?\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function stripV(tag: string): string {
  return tag.trim().replace(/^v/i, "");
}

/** Compare two versions by major.minor.patch (prerelease/build ignored). */
function compareCore(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) return 0;
  return pa.major - pb.major || pa.minor - pb.minor || pa.patch - pb.patch;
}

/** True if the version carries a prerelease segment (e.g. `-rc.1`, `-dev.5`). */
export function isPrerelease(version: string): boolean {
  const core = stripV(version).split("+", 1)[0] ?? "";
  return core.includes("-");
}

/** The highest non-prerelease tag from a list, or null if there is none. */
export function highestStableTag(tags: string[]): string | null {
  const stable = tags.filter((t) => parseVersion(t) && !isPrerelease(t));
  if (stable.length === 0) return null;
  return stable.reduce((hi, t) => (compareCore(t, hi) > 0 ? t : hi));
}

export interface ReleasePlan {
  channel: "stable" | "prerelease" | "edge";
  prerelease: boolean;
  /** Full version for the release title (edge includes `+build` metadata). */
  version: string;
  /** Docker tag suffixes; the caller prefixes the image name. */
  tagSuffixes: string[];
}

/**
 * Decide what a push publishes: a stable tag, a prerelease tag, or the rolling
 * `edge` prerelease from `main` (the next patch, `-dev.<n>`). Pure — git/env
 * I/O lives in the caller. Throws on an off-convention tag.
 */
export function planRelease(input: {
  refType: "tag" | "branch";
  refName: string;
  tags: string[];
  commitsSinceHighest: number;
  shortSha: string;
}): ReleasePlan {
  const { refType, refName, tags, commitsSinceHighest, shortSha } = input;

  if (refType === "tag") {
    if (!STRICT_SEMVER_TAG.test(refName.trim())) {
      throw new Error(
        `Release tag "${refName}" must be vX.Y.Z or vX.Y.Z-prerelease`,
      );
    }
    const ver = stripV(refName);
    if (isPrerelease(ver)) {
      return {
        channel: "prerelease",
        prerelease: true,
        version: ver,
        tagSuffixes: [ver],
      };
    }
    const p = parseVersion(ver);
    if (!p) throw new Error(`Unparseable release tag "${refName}"`);
    const suffixes = [ver, `${p.major}.${p.minor}`, `${p.major}`];
    // `:latest` only when this is the highest stable version (>= every other),
    // so a backport never moves it backward.
    const highest = highestStableTag(tags);
    if (highest === null || compareCore(ver, highest) >= 0) {
      suffixes.push("latest");
    }
    return {
      channel: "stable",
      prerelease: false,
      version: ver,
      tagSuffixes: suffixes,
    };
  }

  // main → next-patch `-dev` prerelease of the next version (design D2).
  const highest = highestStableTag(tags);
  const base = stripV(nextPatchTag(highest));
  const imageVersion = `${base}-dev.${commitsSinceHighest}`;
  return {
    channel: "edge",
    prerelease: true,
    version: `${imageVersion}+${shortSha}`,
    tagSuffixes: ["main", `sha-${shortSha}`, imageVersion],
  };
}
