/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// The advisory severity scale, shared by the collector and the ranking chain.
//
// It lives in core because two consumers need the same ordering: the lane that
// summarises a repository's worst alert, and AD-20's chain. Keeping a second
// copy is how the scale was once spelled `medium`, which is not a GHSA value,
// so every moderate alert fell through to an arbitrary fallback.

/** GitHub's advisory severity vocabulary, least urgent first. */
export const SEVERITY_SCALE = ["low", "moderate", "high", "critical"] as const;

export type Severity = (typeof SEVERITY_SCALE)[number];

/** What we report when a severity is present but not one we recognise. */
export const UNKNOWN_SEVERITY = "unknown";

export type SeverityReading = Severity | typeof UNKNOWN_SEVERITY;

export function isSeverity(value: string): value is Severity {
  return (SEVERITY_SCALE as readonly string[]).includes(value);
}

/**
 * The worst severity in a set.
 *
 * `null` for an empty set: nothing to report is a different answer from a
 * value we could not read, and the two must not collapse.
 *
 * `unknown` when any value is unrecognised and no `critical` is present. An
 * unrecognised severity could be anything, so reporting it as the lowest
 * severity we happen to know is a confident zero in miniature (AD-20: absent
 * ranks as unknown, never as zero risk). A `critical` outranks it because
 * nothing can outrank a critical.
 */
export function worstSeverity(
  values: readonly string[],
): SeverityReading | null {
  if (values.length === 0) return null;

  let best: Severity | null = null;
  let unrecognised = false;
  for (const value of values) {
    if (!isSeverity(value)) {
      unrecognised = true;
      continue;
    }
    if (
      best === null ||
      SEVERITY_SCALE.indexOf(value) > SEVERITY_SCALE.indexOf(best)
    ) {
      best = value;
    }
  }

  if (unrecognised && best !== "critical") return UNKNOWN_SEVERITY;
  return best;
}
