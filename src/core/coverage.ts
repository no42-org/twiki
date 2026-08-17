/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// Whether GitHub is watching a repository at all (AD-28).
//
// Distinct from freshness. `fresh`/`stale`/`unknown` says how current a value
// is; coverage says whether we were ever entitled to a value. A repository
// nobody is watching has no alert count to be fresh or stale about, so the two
// render as separate columns rather than as one four-state badge.
//
// Measured 2026-08-17 on one real organisation: 14 of 36 repositories had
// Dependabot alerts disabled. Under an org-endpoint-only design all 14 would
// render as confident green zeros, indistinguishable from the 21 that were
// genuinely clean.

export const COVERAGE_STATES = [
  "covered",
  "alerts_disabled",
  "archived",
  "unreachable",
  "unknown",
] as const;

export type CoverageState = (typeof COVERAGE_STATES)[number];

/** May this repository's alert count be presented as a real number? */
export function isCovered(state: CoverageState): boolean {
  return state === "covered";
}

/**
 * Why a repository is not covered, for the reader.
 *
 * `unknown` is deliberately not phrased as a reason. It means the probe
 * returned something we have not seen before, and inventing an explanation for
 * it would be the same confident guess this module exists to prevent.
 */
export function coverageReason(state: CoverageState): string | null {
  switch (state) {
    case "covered":
      return null;
    case "alerts_disabled":
      return "Dependabot alerts are switched off for this repository";
    case "archived":
      return "the repository is archived, so nothing is updating it";
    case "unreachable":
      return "the App is not installed on this repository";
    case "unknown":
      return "GitHub's answer was not one we recognise";
  }
}
