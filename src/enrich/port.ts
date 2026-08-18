/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// The only non-GitHub HTTP in the system (AD-15).
//
// GitHub exposes no KEV flag, so without this the ranking chain's FIRST term
// can never evaluate: every item would rank `unknown` on KEV and the chain's
// headline promise, that an exploited-in-the-wild CVE outranks a merely
// severe one, would quietly not hold.

export interface KevCatalogue {
  /**
   * How many entries CISA said the catalogue holds.
   *
   * Kept as a free integrity cross-check: a body truncated in transit parses
   * cleanly, reports zero unreadable, and would otherwise be accepted as a
   * complete catalogue that happens to be smaller.
   */
  claimedCount: number | null;
  /** CISA's own version stamp, e.g. `2026.08.17`. */
  version: string;
  released: string;
  /** Every listed CVE id, upper-cased and sorted. Membership is all the chain needs. */
  cveIds: readonly string[];
  /**
   * Entries whose id could not be read.
   *
   * Part of the contract, not an implementation detail: a consumer that cannot
   * see this cannot tell a complete catalogue from one missing entries, and a
   * missing entry answers "not listed" for a CVE that is.
   */
  unreadable: number;
}

/**
 * HTTP validators for the conditional re-fetch (AD-25). No token generation:
 * the KEV feed is unauthenticated, so rotation cannot invalidate these.
 */
export interface CachedValidator {
  etag: string | null;
  lastModified: string | null;
}

/**
 * Either a full catalogue with the validators to cache, or the feed's own
 * statement that nothing changed since the cached validator was captured.
 *
 * `not_modified` is a positive confirmation from the origin, not a guess:
 * the caller may advance the stored catalogue's verified_at on it. It is the
 * only shape here that carries no catalogue, so a caller cannot read one out
 * of it by accident.
 */
export type KevFetchOutcome =
  | { kind: "fresh"; catalogue: KevCatalogue; validator: CachedValidator }
  | { kind: "not_modified"; validator: CachedValidator };

export interface EnrichmentPort {
  /** The URL fetchKev will call. The validator cache is keyed on it (AD-25). */
  endpoint(): string;
  /**
   * Throws rather than returning a catalogue it cannot vouch for.
   *
   * `cached` carries the validators from the previous successful fetch, or
   * null for an unconditional fetch. A conditional fetch answering 304 comes
   * back as `not_modified` and skips the 1.5MB download entirely.
   */
  fetchKev(cached: CachedValidator | null): Promise<KevFetchOutcome>;
}
