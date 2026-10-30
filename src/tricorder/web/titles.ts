/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { Tier } from "../../core/tier.js";

// Document titles (EXPERIENCE.md, Document titles). A screen reader speaks
// the title before anything in the body, so each says where the reader is
// and what the page found, in the page's own words: `nothing pressing`,
// `nothing collected yet` and `unconfirmed` are different facts and stay
// different (AD-28). The grammar lives here and nowhere else; the pages
// pass the data they already hold.

const SITE = "gitricorder";

const join = (...parts: string[]): string => parts.join(" · ");

/** Each box's count, or `unconfirmed` where no sweep vouched for one. */
export function overviewTitle(
  counts: readonly { group: string; count: number | null }[],
): string {
  return join(
    ...counts.map(
      ({ group, count }) => `${count ?? "unconfirmed"} ${group.toLowerCase()}`,
    ),
    SITE,
  );
}

export function repoTitle(slug: string, tier: Tier): string {
  return join(slug, tier, SITE);
}

export function unknownRepoTitle(): string {
  return join("unknown repository", SITE);
}
