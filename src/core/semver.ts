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
 * Pick the newest stable semver tag out of a list of tag names, or null when
 * none qualifies. Order of the input is irrelevant: GitHub's tag listings
 * carry no defined order, so the maximum is computed here.
 *
 * Prerelease tags (`v1.0.0-rc1`) are skipped rather than compared: twiki only
 * cuts patch releases on the current stable line, and an rc is a human's
 * in-progress major or minor. Tags that do not parse are ignored, matching
 * what `nextPatchTag` would refuse anyway. The returned string is the tag
 * exactly as given, prefix included, so `nextPatchTag` keeps the scheme.
 */
export function newestStableTag(tags: readonly string[]): string | null {
  let best: { tag: string; v: Parsed } | null = null;
  for (const tag of tags) {
    const trimmed = tag.trim();
    if (/^v?\d[^-+]*[-+]/.test(trimmed)) continue; // prerelease or build metadata
    const v = parseVersion(trimmed);
    if (!v) continue;
    if (best === null || compareVersions(v, best.v) > 0) {
      best = { tag: trimmed, v };
    }
  }
  return best?.tag ?? null;
}

function compareVersions(a: Parsed, b: Parsed): number {
  return a.major - b.major || a.minor - b.minor || a.patch - b.patch;
}

/**
 * Compute the next patch tag from the newest tag, preserving a leading "v" if
 * present. With no prior tag, the first release is v0.0.1.
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

/**
 * Read package and versions out of a Dependabot PR title.
 *
 * In core because it is pure and two consumers need it: twiki's adapter and
 * the update-PR lane. Importing it from the adapter dragged the HTTP client
 * into a collector that never makes a per-repo REST call.
 */
export function parseDependency(
  title: string,
): { name?: string; from?: string; to?: string } | undefined {
  const m = title.match(/bump\s+(\S+)\s+from\s+(\S+)\s+to\s+(\S+)/i);
  if (!m) return undefined;
  return { name: m[1], from: m[2], to: m[3] };
}
