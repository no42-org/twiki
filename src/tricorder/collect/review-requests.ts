/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { safeLog } from "../../core/log.js";
import { redact } from "../../core/redact.js";
import { nodeSubject } from "../../core/subject.js";
import type { GitHubReadPort, RawReviewRequest } from "../../github/port.js";
import type { ObservationInput, RunScope, StorePort } from "../store/port.js";

// The review-request lane (CAP-5): pull requests waiting on the maintainer.
//
// Two things make this lane unlike every other one.
//
// It is not per-installation. The search is global: measured 2026-08-21,
// all three installation tokens returned the identical 40 results, so
// running it once per installation would make the same call three times and
// have three runs reconcile the same set against each other. It runs on a
// pseudo-installation instead, exactly as the KEV lane does.
//
// It is not allowlist-scoped. A review request is a claim on the
// maintainer's attention wherever it lands, and 38 of those 40 were in
// repositories nobody watches. What that costs is coverage: nothing behind
// these rows has freshness or coverage discipline, which is why they are
// their own subject type and are rendered apart from the watched estate
// rather than mixed into the ranked queue.

export const LANE = "graphql-review-requests";

/**
 * The one label this lane runs under.
 *
 * A pseudo-installation like KEV's, because the thing being swept is not an
 * installation at all: it is one global search on behalf of the configured
 * reviewers.
 */
export const REVIEWS_INSTALLATION = "reviews";

export interface ReviewRequestObservation {
  repo: string;
  number: number;
  title: string;
  author: string;
  htmlUrl: string;
  createdAt: string;
  requestedReviewers: string[];
}

export interface ReviewDeps {
  github: GitHubReadPort;
  store: StorePort;
  /** Logins to collect requests for. Never a literal in source (AD-19). */
  reviewers: readonly string[];
  /** Whose token authenticates the call. The search itself is global. */
  viaInstallation: string;
  now: () => string;
  log: (msg: string) => void;
}

export interface ReviewResult {
  outcome: "ok" | "partial" | "failed";
  requests: number;
  unreadable: number;
}

export function normaliseReviewRequest(pr: RawReviewRequest): ObservationInput {
  const payload: ReviewRequestObservation = {
    repo: `${pr.repo.owner}/${pr.repo.name}`.toLowerCase(),
    number: pr.number,
    title: pr.title,
    author: pr.author,
    htmlUrl: pr.htmlUrl,
    createdAt: pr.createdAt,
    requestedReviewers: pr.requestedReviewers,
  };
  return { subject: nodeSubject("review_request", pr.nodeId), payload };
}

/**
 * Collect the pull requests awaiting review.
 *
 * Nothing throws past this boundary (AD-16). Reconciliation is simpler than
 * the other node-keyed lanes': there is no allowlist to bound it by, because
 * the sweep is global, so a clean full sweep is authoritative over every
 * stored request and absence means the review was given or withdrawn.
 */
export async function collectReviewRequests(
  deps: ReviewDeps,
  scope: RunScope = "full",
): Promise<ReviewResult> {
  let run: ReturnType<StorePort["beginRun"]> | null = null;
  const log = safeLog(deps.log);

  try {
    run = deps.store.beginRun({
      lane: LANE,
      installation: REVIEWS_INSTALLATION,
      scope,
      startedAt: deps.now(),
    });

    const page = await deps.github.listReviewRequests(
      deps.viaInstallation,
      deps.reviewers,
    );
    const observations = page.requests.map(normaliseReviewRequest);

    // Truncation degrades exactly as unreadable nodes do: an incomplete
    // result set cannot support concluding that anything is gone.
    const outcome = page.unreadable > 0 || page.truncated ? "partial" : "ok";
    // Composed, not chosen: a degraded sweep can hit the ceiling AND fail to
    // read nodes, and reporting only the ceiling attributes the whole
    // degradation to one cause in the row an operator actually reads.
    const notes = [
      page.truncated
        ? "search results truncated at GitHub's ceiling; nothing tombstoned"
        : null,
      page.unreadable > 0
        ? `${page.unreadable} review-request nodes could not be read`
        : null,
    ].filter((n): n is string => n !== null);
    const detail = notes.length > 0 ? notes.join("; ") : undefined;

    deps.store.recordObservations(run, deps.now(), observations);

    if (scope === "full" && outcome === "ok") {
      const seen = new Set(observations.map((o) => o.subject.key));
      const gone = deps.store
        .currentByType("review_request")
        .filter((c) => c.state === "present")
        .filter((c) => !seen.has(c.subject.key))
        .map((c) => c.subject);
      if (gone.length > 0) {
        deps.store.recordTombstones(run, deps.now(), gone);
        log(`${LANE}: ${gone.length} review requests answered or withdrawn`);
      }
    }

    deps.store.finishRun(run, outcome, deps.now(), detail);
    log(
      `${LANE}: ${observations.length} awaiting review` +
        (page.unreadable > 0 ? `, ${page.unreadable} unreadable` : ""),
    );
    return {
      outcome,
      requests: observations.length,
      unreadable: page.unreadable,
    };
  } catch (err) {
    const detail = redact(err instanceof Error ? err.message : String(err));
    if (run) {
      try {
        deps.store.finishRun(run, "failed", deps.now(), detail);
      } catch {
        // The store is what failed. Nothing further to record.
      }
    }
    log(`${LANE}: failed, ${detail}`);
    return { outcome: "failed", requests: 0, unreadable: 0 };
  }
}
