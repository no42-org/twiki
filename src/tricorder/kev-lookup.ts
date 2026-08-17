/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

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
  /** Null when there is no catalogue we can vouch for. */
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
  const row = store.current(KEV_SUBJECT);
  if (!row || row.state !== "present") {
    return { has: () => false, usable: false, version: null, verifiedAt: null };
  }

  const current = freshness(row.verifiedAt, now, policy) === "fresh";
  const payload = row.payload as KevObservation;
  const ids = new Set(payload.cveIds.map((c) => c.toUpperCase()));

  return {
    has: (cve) => ids.has(cve.trim().toUpperCase()),
    usable: current,
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
  if (!index.usable) return null;
  if (!cve || cve.trim() === "") return NOT_APPLICABLE;
  return index.has(cve);
}
