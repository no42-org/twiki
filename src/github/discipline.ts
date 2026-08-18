/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { Octokit } from "@octokit/rest";

// Request discipline (AD-24). Requests already flow serially: lanes run one
// after another, installations are swept in order, and pagination is
// sequential, so nothing here adds queueing. What this module adds is the
// response side: honour retry-after once, and fail fast with a legible
// message when the primary budget is exhausted rather than pushing through.
//
// Budget numbers are never read off a 304: those headers are stale by
// GitHub's own documentation. The headers consulted here come from 403/429
// error responses, which are real responses; anything beyond that must ask
// GET /rate_limit, which is free.

/** The longest a retry-after is honoured before it stops being a retry. */
export const MAX_RETRY_AFTER_S = 120;

export type BackoffDecision =
  | { kind: "retry"; afterMs: number }
  | { kind: "exhausted"; detail: string }
  | { kind: "rethrow" };

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
): BackoffDecision {
  if (status !== 403 && status !== 429) return { kind: "rethrow" };
  const retryAfter = Number(headers["retry-after"]);
  if (
    !alreadyRetried &&
    Number.isFinite(retryAfter) &&
    retryAfter > 0 &&
    retryAfter <= MAX_RETRY_AFTER_S
  ) {
    return { kind: "retry", afterMs: retryAfter * 1000 };
  }
  if (headers["x-ratelimit-remaining"] === "0") {
    const reset = Number(headers["x-ratelimit-reset"]);
    const at = Number.isFinite(reset)
      ? new Date(reset * 1000).toISOString()
      : "unknown";
    return {
      kind: "exhausted",
      detail: `rate limit exhausted, resets at ${at}; run recorded and retried next cycle`,
    };
  }
  return { kind: "rethrow" };
}

/**
 * After a retry-after sleep, no further sleeps for this long. One sleep per
 * episode, not one per request: the coverage lane probes every watched
 * repository serially through one client, and without the cooldown a
 * sustained secondary-limit episode charges each probe its own 120s - the
 * exact whole-collector stall the fail-fast rule below exists to prevent,
 * paid in instalments.
 */
export const LIMIT_EPISODE_COOLDOWN_MS = 5 * 60_000;

/**
 * Wire the decision table into one Octokit instance. Retries at most once
 * per request, marked via a header rather than shared state, so concurrent
 * requests on the same client cannot consume each other's retry.
 */
export function withRequestDiscipline(
  octokit: Octokit,
  sleep: (ms: number) => Promise<void> = (ms) =>
    new Promise((r) => setTimeout(r, ms)),
  now: () => number = Date.now,
): Octokit {
  // Per client, which is per installation: the limit being backed off from
  // is scoped to the token, so the episode is too.
  let episodeUntil = 0;
  octokit.hook.error("request", async (error, options) => {
    const err = error as {
      status?: number;
      response?: { headers?: Record<string, string | undefined> };
    };
    const headers = err.response?.headers ?? {};
    const alreadyRetried =
      (options.headers as Record<string, unknown> | undefined)?.[
        "x-tricorder-retried"
      ] === "1";
    const decision = backoffDecision(err.status, headers, alreadyRetried);
    if (decision.kind === "retry") {
      if (now() < episodeUntil) {
        // This episode already had its sleep. Fail this request fast; the
        // lane degrades honestly (AD-16) and the cycle keeps moving.
        throw error;
      }
      episodeUntil = now() + decision.afterMs + LIMIT_EPISODE_COOLDOWN_MS;
      await sleep(decision.afterMs);
      return octokit.request({
        ...options,
        headers: { ...options.headers, "x-tricorder-retried": "1" },
      } as unknown as Parameters<Octokit["request"]>[0]);
    }
    if (decision.kind === "exhausted") {
      throw new Error(decision.detail);
    }
    throw error;
  });
  return octokit;
}

/**
 * The current installation-token generation for one client (AD-25).
 *
 * The token's expiry stamps the mint: octokit caches an installation token
 * until it expires, so two calls within the TTL see the same expiresAt, and a
 * re-mint changes it. The token itself is never used as the generation
 * because the generation is persisted, and a stored token is a leaked token.
 */
export async function installationTokenGen(gh: Octokit): Promise<string> {
  const auth = (await gh.auth({ type: "installation" })) as {
    expiresAt?: string;
  } | null;
  return auth?.expiresAt ?? "unknown";
}
