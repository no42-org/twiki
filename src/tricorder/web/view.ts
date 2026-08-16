/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { RepoRef } from "../../core/types.js";
import type { AlertObservation } from "../collect/dependabot-alerts.js";
import { watchKey } from "../collect/dependabot-alerts.js";
import type { StorePort } from "../store/port.js";
import {
  ageLabel,
  type Freshness,
  type FreshnessPolicy,
  freshness,
} from "./freshness.js";

// The view model. Kept separate from rendering so the interesting decisions,
// which are all about what we do and do not know, can be tested without a
// server or a DOM.

export interface RepoRow {
  slug: string;
  /**
   * Open alerts, or null when we have never collected this repository. Null is
   * not zero: zero means "we looked and there are none", null means "we have
   * not looked". Rendering them the same way is the lie this dashboard exists
   * to avoid.
   */
  openAlerts: number | null;
  /** Highest severity among the open alerts, if any. */
  worstSeverity: string | null;
  freshness: Freshness;
  age: string;
  verifiedAt: string | null;
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

function worst(severities: readonly string[]): string | null {
  for (const level of SEVERITY_ORDER) {
    if (severities.includes(level)) return level;
  }
  return severities[0] ?? null;
}

/**
 * Build one row per watched repository.
 *
 * Every watched repository appears, including ones with no alerts and ones
 * never collected: a repository missing from the page is indistinguishable
 * from a healthy one, and the reader cannot tell which they are looking at.
 */
export function buildRepoRows(
  store: StorePort,
  watched: readonly RepoRef[],
  now: Date,
  policy: FreshnessPolicy,
): RepoRow[] {
  const alerts = store.currentByType("dependabot_alert");

  // Group live alerts by repository, and track the newest confirmation we have
  // for each, whether or not it carried an alert.
  const byRepo = new Map<
    string,
    { open: AlertObservation[]; verifiedAt: string | null }
  >();

  for (const value of alerts) {
    const payload = value.payload as AlertObservation;
    const slug = payload.repo.toLowerCase();
    const entry = byRepo.get(slug) ?? { open: [], verifiedAt: null };
    // A resolved subject still tells us the repository was confirmed, it just
    // does not count towards the open total.
    if (value.state === "present") entry.open.push(payload);
    if (!entry.verifiedAt || value.verifiedAt > entry.verifiedAt) {
      entry.verifiedAt = value.verifiedAt;
    }
    byRepo.set(slug, entry);
  }

  return watched.map((repo) => {
    const slug = watchKey(repo);
    const entry = byRepo.get(slug);
    const verifiedAt = entry?.verifiedAt ?? null;
    return {
      slug,
      openAlerts: entry ? entry.open.length : null,
      worstSeverity: entry ? worst(entry.open.map((a) => a.severity)) : null,
      freshness: freshness(verifiedAt, now, policy),
      age: ageLabel(verifiedAt, now),
      verifiedAt,
    };
  });
}

export interface CollectionHealth {
  lane: string;
  installation: string;
  scope: string;
  outcome: string;
  detail: string | null;
  age: string;
  freshness: Freshness;
}

/** The most recent run per (lane, installation, scope), newest first. */
export function buildCollectionHealth(
  store: StorePort,
  now: Date,
  policy: FreshnessPolicy,
): CollectionHealth[] {
  const seen = new Set<string>();
  const out: CollectionHealth[] = [];

  for (const run of store.latestRuns(200)) {
    const key = `${run.lane}|${run.installation}|${run.scope}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      lane: run.lane,
      installation: run.installation,
      scope: run.scope,
      outcome: run.outcome,
      detail: run.detail,
      age: ageLabel(run.verifiedAt, now),
      freshness: freshness(run.verifiedAt, now, policy),
    });
  }
  return out;
}
