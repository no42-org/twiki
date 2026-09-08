/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// What a tree says its version is, and whether that agrees with the version
// twiki computed from the tags (#145). Pure: the file text arrives from the
// caller, and nothing here reads GitHub or decides what to do about a
// disagreement.

/**
 * The longest pattern an operator may declare.
 *
 * A bound on the digest, not on regular expressions. A pattern that fails to
 * identify a version is quoted verbatim in the outcome, and a chat transport
 * drops a message over its own limit whole - so one very long pattern could
 * cost the entire digest, the merges reported in it included.
 */
export const MAX_PATTERN_CHARS = 200;

/**
 * The most file text this check will run an operator's pattern over.
 *
 * Stated rather than assumed. A pattern is the operator's, backtracking is
 * theirs to write, and the release path is not the place to discover how a
 * pathological one behaves on a megabyte of minified output. A file past this
 * is reported as unscanned, never as "the pattern found nothing", because the
 * two send a reader to different places.
 */
export const MAX_SCANNED_CHARS = 512 * 1024;

/** What a declared source said, or why it said nothing usable. */
export type VersionMatch =
  | { kind: "found"; version: string }
  /**
   * The file names no version: the pattern matched nowhere, or it matched
   * without capturing anything, or what it captured was blank.
   */
  | { kind: "none" }
  /**
   * The pattern matched in more than one place. NOT resolved to the first
   * match: more than one answer means the declaration does not identify the
   * version, and picking one would be a guess dressed as a check.
   */
  | { kind: "many" }
  /** The file is past `MAX_SCANNED_CHARS`, so nothing was scanned at all. */
  | { kind: "too-large"; chars: number; limit: number };

/**
 * Why a declared pattern cannot identify a version, or null when it can.
 *
 * Returned rather than thrown so the config parser can attach it to the field
 * the operator wrote, alongside every other problem in the document.
 */
export function versionPatternProblem(pattern: string): string | null {
  if (pattern.length > MAX_PATTERN_CHARS) {
    return (
      `must be at most ${MAX_PATTERN_CHARS} characters, but is ${pattern.length}` +
      " — a pattern that fails is quoted whole in the digest, and one long" +
      " enough to overrun the chat transport's limit would cost the whole" +
      " digest, not just its own line"
    );
  }
  let groups: number;
  try {
    // Compiled twice on purpose. The first proves the pattern itself is
    // valid; the second appends an empty alternative so that `exec("")`
    // always matches, which makes the result's length the group count.
    new RegExp(pattern);
    const probe = new RegExp(`${pattern}|`).exec("");
    groups = probe === null ? 0 : probe.length - 1;
  } catch (err) {
    return `is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`;
  }
  if (groups !== 1) {
    return (
      `must have exactly one capture group naming the version, but has ${groups}` +
      " — write `(...)` around the version and `(?:...)` around anything else"
    );
  }
  return null;
}

/**
 * The declared pattern, ready to scan a file.
 *
 * `g` so a second match can be found rather than only the first — whether one
 * exists is the whole question. `m` so `^` and `$` anchor to a line, which is
 * what somebody writing a pattern for a version line means by them.
 *
 * Throws on a pattern `versionPatternProblem` rejects. Unreachable from the
 * release path: `loadConfig` runs the same check at startup and refuses the
 * document, so a pattern only gets this far having already passed.
 */
export function compileVersionPattern(pattern: string): RegExp {
  const problem = versionPatternProblem(pattern);
  if (problem !== null) {
    throw new Error(`version source pattern ${problem}`);
  }
  return new RegExp(pattern, "gm");
}

/** What one declared pattern finds in one file's text. */
export function matchVersion(text: string, pattern: string): VersionMatch {
  if (text.length > MAX_SCANNED_CHARS) {
    return { kind: "too-large", chars: text.length, limit: MAX_SCANNED_CHARS };
  }
  const re = compileVersionPattern(pattern);
  const first = re.exec(text);
  if (first === null) return { kind: "none" };
  // A match of nothing at all leaves `lastIndex` where it was, so the next
  // call would return the same match and report it as a second one. Advance
  // past it, as `matchAll` does.
  if (first[0] === "") re.lastIndex += 1;
  // Whether a SECOND match exists is the whole question, so the scan stops
  // here rather than collecting every match in the file.
  if (re.exec(text) !== null) return { kind: "many" };
  // Undefined means the match took an alternative the group is not in, and
  // blank means the group is there and empty. Neither names a version, and
  // both would otherwise reach the digest as "says  at abc1234".
  const version = first[1]?.trim() ?? "";
  if (version === "") return { kind: "none" };
  return { kind: "found", version };
}

/**
 * Whether a tag and what a tree says are the same version.
 *
 * A STRING comparison, deliberately, and `parseVersion` in `semver.ts` must
 * not be used here however well it reads. It strips the leading `v` and then
 * splits on the first `-` or `+`, discarding the prerelease suffix, so it
 * parses `v0.6.2`, `0.6.2` and `0.6.2-rc` to the same numbers. Comparing
 * through it would pass on `0.6.2-rc` against `v0.6.2` — the exact case that
 * motivated this check — with a green suite. Two reviewers reached this
 * independently.
 *
 * One optional leading `v` comes off each side, and the remainder must match
 * exactly: `v0.6.2` agrees with `0.6.2`, and `0.6.2-rc` agrees with neither.
 */
export function versionsAgree(tag: string, declared: string): boolean {
  return stripLeadingV(tag) === stripLeadingV(declared);
}

function stripLeadingV(version: string): string {
  return version.trim().replace(/^v/i, "");
}
