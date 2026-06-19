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
