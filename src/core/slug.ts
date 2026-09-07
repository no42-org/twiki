/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { RepoRef } from "./types.js";

/**
 * Case-folded slug, matching how subject keys are derived (AD-22).
 *
 * In core so every layer folds a slug the same way (AD-33): the lanes key
 * their rows by it, the queue groups items by it, and the pages match a
 * typed path against it. Two foldings would let one repository be two.
 */
export function watchKey(repo: RepoRef): string {
  return foldSlug(`${repo.owner}/${repo.name}`);
}

/**
 * The same folding over an `owner/name` string a payload already carries,
 * so an item's repository and a watched repository compare on one rule.
 */
export function foldSlug(slug: string): string {
  return slug.toLowerCase();
}
