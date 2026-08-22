/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// The rate-limit decision table (AD-24). Pure: a status, some headers and a
// message in, a decision out. No Octokit, no clock, no transport.
//
// It lives in core/ because AD-5 makes github/ and enrich/ peers that may not
// import each other, and BOTH need this. The semantics are HTTP's, not
// GitHub's - 429, 403, retry-after, x-ratelimit-remaining - so core is where
// it belongs rather than a duplicate in each leaf, which is exactly the
// drift this codebase keeps having to undo.

/** The longest a retry-after is honoured before it stops being a retry. */
export const MAX_RETRY_AFTER_S = 120;

export type BackoffDecision =
  | { kind: "retry"; afterMs: number }
  | { kind: "exhausted"; detail: string }
  | { kind: "rethrow" };

/**
 * A secondary limit sometimes arrives with NO retry-after at all; GitHub's
 * docs say to wait at least a minute in that case. The message is the only
 * signal that distinguishes it from a permissions 403.
 */
export const SECONDARY_LIMIT_FALLBACK_MS = 60_000;
const SECONDARY_LIMIT_MESSAGE = /secondary rate limit/i;

/**
 * Decide what to do with a failed request. Pure, so the whole table is
 * testable without an Octokit or a clock.
 *
 * Order matters: a secondary-limit 403 carries retry-after AND often
 * x-ratelimit-remaining above zero, while a primary exhaustion carries
 * remaining 0 and no retry-after. retry-after wins when present and sane,
 * because GitHub is naming the exact wait; exhaustion fails fast, because
 * sleeping out a primary window (up to an hour) inside a lane would stall
 * the whole cycle, and the scheduler retries next tick anyway (AD-16).
 */
export function backoffDecision(
  status: number | undefined,
  headers: Record<string, string | undefined>,
  alreadyRetried: boolean,
  message = "",
): BackoffDecision {
  // 503 belongs here as much as 403 and 429 do - more canonically, in fact:
  // a service naming a wait it wants honoured is what Retry-After is for, and
  // the KEV catalogue sits behind a CDN that says exactly that under load.
  // Excluding it meant a request carrying an explicit wait was treated as a
  // hard failure, and for that lane a hard failure costs a day of KEV answers.
  //
  // A 503 with NO usable wait still falls through to rethrow below: the
  // secondary-limit fallback is gated on GitHub's message, and inventing a
  // minute for an unexplained server error is not honouring anything.
  if (status !== 403 && status !== 429 && status !== 503) {
    return { kind: "rethrow" };
  }
  // Delta-seconds only, deliberately: GitHub sends seconds, and RFC 9110's
  // HTTP-date form would need a clock this table refuses to own. A date here
  // parses as NaN and falls through.
  const rawRetryAfter = headers["retry-after"];
  const retryAfter =
    rawRetryAfter === undefined || rawRetryAfter.trim() === ""
      ? Number.NaN
      : Number(rawRetryAfter);
  if (
    !alreadyRetried &&
    Number.isFinite(retryAfter) &&
    // Zero is spec-valid ("retry immediately") and safe to honour: the
    // episode cooldown still bounds how often this branch fires.
    retryAfter >= 0 &&
    retryAfter <= MAX_RETRY_AFTER_S
  ) {
    return { kind: "retry", afterMs: retryAfter * 1000 };
  }
  // Only when GitHub named NO usable wait. A retry-after we deliberately
  // refused as too long (300s against a 120s ceiling) must not fall through
  // to a 60s retry: that fires 240 seconds before the wait GitHub asked for,
  // burning the one retry and, per GitHub's own secondary-limit guidance,
  // risking an extended block.
  const namedAWait = Number.isFinite(retryAfter) && retryAfter >= 0;
  if (!alreadyRetried && !namedAWait && SECONDARY_LIMIT_MESSAGE.test(message)) {
    return { kind: "retry", afterMs: SECONDARY_LIMIT_FALLBACK_MS };
  }
  if (headers["x-ratelimit-remaining"] === "0") {
    // toISOString throws on a date outside its representable range, and a
    // garbage reset header from a proxy must not replace the legible
    // exhaustion message with the crash it was built to avoid.
    const reset = new Date(Number(headers["x-ratelimit-reset"]) * 1000);
    const at = Number.isNaN(reset.getTime()) ? "unknown" : reset.toISOString();
    return {
      kind: "exhausted",
      // No promise about what the caller does next: this table also serves
      // the App-level client, where no run is recorded and nothing retries.
      detail: `rate limit exhausted, resets at ${at}; failing fast rather than sleeping out the window`,
    };
  }
  return { kind: "rethrow" };
}
