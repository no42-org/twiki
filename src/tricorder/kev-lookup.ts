/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { CVE_ID } from "../core/cve.js";
import { NOT_APPLICABLE, type Signal } from "../core/rank.js";
import { KEV_SUBJECT } from "../core/subject.js";
import type { KevObservation } from "./collect/kev.js";
import type { StorePort } from "./store/port.js";
import { type FreshnessPolicy, freshness } from "./web/freshness.js";

// Turns the stored catalogue into the chain's first term.
//
// Three answers, and keeping them apart is the whole job (AD-20):
//
//   true   the CVE is listed, and we checked recently enough to say so
//   false  we checked recently enough, and it is not listed
//   n/a    there is no CVE to look up, which is a fact rather than a gap
//   null   we do not know: never fetched, or the catalogue has gone stale
//
// The one that must never leak is `false` when we cannot vouch for the
// catalogue. KEV is the chain's most significant term, so a confident "not
// exploited" on a stale catalogue outranks nothing and hides everything.

export interface KevIndex {
  has: (cve: string) => boolean;
  /** Whether there is a catalogue current enough to answer with at all. */
  usable: boolean;
  version: string | null;
  verifiedAt: string | null;
}

/**
 * Read the catalogue and judge whether it is current enough to answer with.
 *
 * Judged on the KEV lane's own daily cadence, not a sweep cadence: measuring a
 * daily fetch against fifteen minutes would report it stale within the hour
 * and the chain's top term would go permanently unknown.
 */
export function loadKevIndex(
  store: StorePort,
  now: Date,
  policy: FreshnessPolicy,
): KevIndex {
  const unusable: KevIndex = {
    has: () => false,
    usable: false,
    version: null,
    verifiedAt: null,
  };

  const row = store.current(KEV_SUBJECT);
  if (row?.state !== "present") return unusable;

  const payload = row.payload as KevObservation | undefined;
  // A row of an unexpected shape degrades to unknown rather than throwing.
  // Everything else in this module is built to answer "we do not know" when it
  // cannot answer; failing the request instead would be the one path that does
  // not.
  // An empty list would be a fresh, confident-looking index that answers
  // "not listed" for every CVE ever asked. parseKev refuses to produce one,
  // but a different port implementation or a hand-repaired row could.
  if (!payload || !Array.isArray(payload.cveIds)) return unusable;
  if (payload.cveIds.length === 0) return unusable;

  // Every id must be a CVE. A list holding anything else would be a fresh,
  // confident-looking index answering false for every real CVE asked.

  // Every id must be a CVE. A list holding anything else would be a fresh,
  // confident-looking index answering false for every real CVE asked.
  if (!payload.cveIds.every((c) => typeof c === "string" && CVE_ID.test(c))) {
    return unusable;
  }
  const ids = new Set(payload.cveIds.map((c) => c.toUpperCase()));

  return {
    has: (cve) => ids.has(cve.trim().toUpperCase()),
    usable: freshness(row.verifiedAt, now, policy) === "fresh",
    version: payload.version || null,
    verifiedAt: row.verifiedAt,
  };
}

/**
 * The chain's `kev` input for one alert.
 *
 * `cve` is null for an advisory GitHub carries with no CVE assigned, which is
 * common for ecosystem-specific advisories. That is `n/a`: there is nothing to
 * look up, and treating it as unknown would float every CVE-less alert above
 * every advisory we checked and found absent.
 */
export function kevSignal(
  index: KevIndex,
  cve: string | null,
): Signal<boolean> {
  // Before the usability check, deliberately. "There is nothing to look up"
  // needs no catalogue, and answering `unknown` here would rank every CVE-less
  // advisory ABOVE the ones we checked and found absent, because unknown sits
  // higher than n/a. On a stale catalogue that inverted the whole queue.
  if (!cve || cve.trim() === "") return NOT_APPLICABLE;
  // KEV is indexed by CVE alone. A GHSA id, or anything else GitHub attaches
  // to an advisory, is not absent from the catalogue: it is unlookupable, and
  // answering "not exploited" for it would be a confident negative on the
  // chain's most significant term.
  if (!CVE_ID.test(cve.trim())) return NOT_APPLICABLE;

  if (!index.usable) return null;
  // A stored catalogue is always one the lane could vouch for in full, so a
  // miss is a real miss. The lane writes nothing at all when it cannot read
  // every entry, which is what makes this answer safe to give.
  return index.has(cve);
}
