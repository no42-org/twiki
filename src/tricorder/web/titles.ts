/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { Tier } from "../../core/tier.js";
import type { QueueFilter } from "../attention/filter.js";

// Document titles (EXPERIENCE.md, Document titles). A screen reader speaks
// the title before anything in the body, so each says where the reader is
// and what the page found, in the page's own words: `nothing pressing`,
// `nothing collected yet` and `unconfirmed` are different facts and stay
// different (AD-28). The grammar lives here and nowhere else; the pages
// pass the data they already hold.

const SITE = "gitricorder";

const join = (...parts: string[]): string => parts.join(" · ");

/**
 * `2 now, 6 soon`, `nothing pressing`, or `nothing collected yet`.
 *
 * `nothing pressing` is said only when the board would say it: with a
 * repository nobody has confirmed, or a row nobody could read, the counts
 * are a lower bound and the title reads `0 now, 0 soon` instead.
 */
export function overviewTitle(
  summary: { now: number; soon: number; unconfirmed: number },
  collected: boolean,
  unreadable: number,
): string {
  if (!collected) return join("nothing collected yet", SITE);
  if (
    summary.now === 0 &&
    summary.soon === 0 &&
    summary.unconfirmed === 0 &&
    unreadable === 0
  ) {
    return join("nothing pressing", SITE);
  }
  return join(`${summary.now} now, ${summary.soon} soon`, SITE);
}

/**
 * `queue`, then the topic word and the repository slug when the filter
 * knows both of what it was given. A value the grammar does not know
 * renders the no-matches state, so the title names no filter at all rather
 * than the half it understood.
 */
export function queueTitle(filter: QueueFilter): string {
  if (filter.unknownTopic !== null || filter.unknownRepo !== null) {
    return join("queue", SITE);
  }
  const parts = ["queue"];
  if (filter.topic?.query) parts.push(filter.topic.query);
  if (filter.repo !== null) parts.push(filter.repo);
  return join(...parts, SITE);
}

export function repoTitle(slug: string, tier: Tier): string {
  return join(slug, tier, SITE);
}

/** `N waiting` once a sweep has confirmed the list; `unconfirmed` before. */
export function reviewsTitle(count: number, attested: boolean): string {
  return join("reviews", attested ? `${count} waiting` : "unconfirmed", SITE);
}

export function unknownRepoTitle(): string {
  return join("unknown repository", SITE);
}
