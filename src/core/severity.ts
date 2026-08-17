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

/**
 * The severity vocabulary, least urgent first.
 *
 * `medium`, because that is what the Dependabot alerts REST endpoint actually
 * returns. Measured 2026-08-17 against a live installation: 67 open alerts
 * spelled critical, high, medium and low, with no `moderate` among them.
 *
 * This has now been wrong in both directions. It first said `medium` by
 * accident, was "corrected" to `moderate` on the reasoning that GHSA uses that
 * word, and the correction was the error: the GHSA advisory database does say
 * `moderate`, but this payload does not. Story 18's rule covers exactly this,
 * and it applies to vocabularies as much as to status codes: translate on what
 * GitHub is OBSERVED to send, never on what a sibling API documents.
 */
export const SEVERITY_SCALE = ["low", "medium", "high", "critical"] as const;

export type Severity = (typeof SEVERITY_SCALE)[number];

/**
 * Fold a raw severity onto the scale.
 *
 * GraphQL's `SecurityAdvisory.severity` is upper case and says `MODERATE`
 * where this REST payload says `medium`. Both are the same fact, and the
 * GraphQL lane lands in story 17, so accepting both now costs nothing and
 * stops a second lane silently reporting a third of its alerts as unknown.
 */
export function normaliseSeverity(raw: string): Severity | null {
  const value = raw.trim().toLowerCase();
  const folded = value === "moderate" ? "medium" : value;
  return isSeverity(folded) ? folded : null;
}

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
  for (const raw of values) {
    const value = normaliseSeverity(raw);
    if (value === null) {
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
