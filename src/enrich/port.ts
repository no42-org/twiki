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
  /** CISA's own version stamp, e.g. `2026.08.17`. */
  version: string;
  released: string;
  /** Every listed CVE id, upper-cased and sorted. Membership is all the chain needs. */
  cveIds: readonly string[];
}

export interface EnrichmentPort {
  /** Throws rather than returning a catalogue it cannot vouch for. */
  fetchKev(): Promise<KevCatalogue>;
}
