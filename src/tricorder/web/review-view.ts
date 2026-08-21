/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { RepoRef } from "../../core/types.js";
import { watchKey } from "../collect/dependabot-alerts.js";
import type { ReviewRequestObservation } from "../collect/review-requests.js";
import { LANE as REVIEWS_LANE } from "../collect/review-requests.js";
import type { StorePort } from "../store/port.js";
import {
  ageLabel,
  type Freshness,
  type FreshnessPolicy,
  freshness,
} from "./freshness.js";

// The review-request view (CAP-5).
//
// These rows are the one thing this dashboard collects WITHOUT the allowlist
// filter, because a review request is a claim on the maintainer's attention
// wherever it lands: 38 of 40 measured were in repositories nobody watches.
// That is why they render here rather than in the ranked queue, and why
// every row says whether its repository is watched: nothing behind an
// unwatched row has coverage or freshness discipline, and a reader must not
// take one for a row that does.

export interface ReviewRow {
  key: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  htmlUrl: string | null;
  /** Everyone asked, so "waiting on you" can be read against "and four others". */
  requestedReviewers: string[];
  /** In repos.yaml, and so covered by every other lane. */
  watched: boolean;
  freshness: Freshness;
  age: string;
}

export interface ReviewView {
  rows: ReviewRow[];
  /** Rows whose payload could not be read. Rendered, never dropped. */
  unreadable: number;
  /** Whether any sweep has vouched for this list at all (AD-28). */
  attested: boolean;
  attestedFreshness: Freshness;
  attestedAge: string;
}

function readRequest(payload: unknown): ReviewRequestObservation | null {
  const r = payload as ReviewRequestObservation | null | undefined;
  if (!r || typeof r !== "object") return null;
  if (typeof r.repo !== "string" || typeof r.number !== "number") return null;
  if (typeof r.title !== "string" || typeof r.author !== "string") return null;
  if (typeof r.htmlUrl !== "string") return null;
  if (!Array.isArray(r.requestedReviewers)) return null;
  return r;
}

export function buildReviewView(
  store: StorePort,
  watched: readonly RepoRef[],
  now: Date,
  policy: FreshnessPolicy,
): ReviewView {
  const watchedSlugs = new Set(watched.map(watchKey));
  const rows: ReviewRow[] = [];
  let unreadable = 0;

  for (const value of store.currentByType("review_request")) {
    if (value.state !== "present") continue;
    const request = readRequest(value.payload);
    if (request === null) {
      unreadable++;
      continue;
    }
    rows.push({
      key: value.subject.key,
      repo: request.repo,
      number: request.number,
      title: request.title,
      author: request.author,
      // GitHub only ever hands out https URLs, and hono/jsx renders a
      // `javascript:` scheme verbatim.
      htmlUrl: request.htmlUrl.startsWith("https://") ? request.htmlUrl : null,
      requestedReviewers: request.requestedReviewers,
      watched: watchedSlugs.has(request.repo.toLowerCase()),
      freshness: freshness(value.verifiedAt, now, policy),
      age: ageLabel(value.verifiedAt, now),
    });
  }

  // Oldest request first: the one that has been waiting longest is the one
  // most likely to be forgotten. Ties broken by key so the list does not
  // reshuffle between refreshes.
  rows.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);

  // The lane's own standing, read from its run rows rather than inferred
  // from the presence of data: an empty list means "none waiting" only if
  // a sweep said so (AD-28).
  const run = store
    .latestRunPerKey()
    .filter((r) => r.lane === REVIEWS_LANE)
    .sort((a, b) => b.verifiedAt.localeCompare(a.verifiedAt))[0];
  return {
    rows,
    unreadable,
    attested: run?.outcome === "ok",
    attestedFreshness: freshness(run?.verifiedAt ?? null, now, policy),
    attestedAge: ageLabel(run?.verifiedAt ?? null, now),
  };
}
