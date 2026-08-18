/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import {
  compareRankings,
  NOT_APPLICABLE,
  type Ranking,
  type RankPolicy,
  rank,
} from "../../core/rank.js";
import { normaliseSeverity } from "../../core/severity.js";
import type { AlertObservation } from "../collect/dependabot-alerts.js";
import { kevSignal, loadKevIndex } from "../kev-lookup.js";
import type { StorePort } from "../store/port.js";
import {
  ageLabel,
  type Freshness,
  type FreshnessPolicy,
  freshness,
} from "./freshness.js";

// The ranked queue (CAP-6): one cross-repository list answering "what should I
// deal with next, and why does it rank there".
//
// This is the first production caller of the ranking chain. Until it existed,
// rank() and the KEV lookup were deletable with a green suite, a gap three
// review rounds flagged in a row.

export interface QueueItem {
  /** `owner/name#number`, the alert's stable identity (AD-22). */
  key: string;
  repo: string;
  number: number;
  packageName: string | null;
  /** The advisory id shown to the reader: CVE when present, else GHSA. */
  advisory: string | null;
  severity: string;
  epss: number | null;
  htmlUrl: string | null;
  /** CAP-6's "why does it rank there", most significant term first. */
  explanation: string;
  /** Confirmed listed in CISA KEV. The one state the page shouts about. */
  kevListed: boolean;
  ranking: Ranking;
  freshness: Freshness;
  age: string;
  verifiedAt: string;
}

export interface Queue {
  items: QueueItem[];
  /**
   * Rows whose payload could not be read as an alert. Rendered, never silently
   * dropped: a queue quietly missing items looks complete, which is the
   * confident-zero defect wearing a queue costume.
   */
  unreadable: number;
  /** The KEV catalogue's own standing, because every KEV verdict derives from it. */
  kev: { usable: boolean; version: string | null; age: string };
}

export interface QueueDeps {
  /** Freshness budget for alert rows: the sweep cadence that confirms them. */
  policy: FreshnessPolicy;
  /** Freshness budget for the KEV catalogue: its own daily cadence (AD-11). */
  kevPolicy: FreshnessPolicy;
  /** Thresholds only. The chain order is code and nothing here reorders it (AD-20). */
  rankPolicy: RankPolicy;
}

/** Minimal shape check: a row that fails it is counted, not guessed at. */
function readAlert(payload: unknown): AlertObservation | null {
  const a = payload as AlertObservation | null | undefined;
  if (!a || typeof a !== "object") return null;
  if (typeof a.number !== "number" || typeof a.repo !== "string") return null;
  return a;
}

export function buildQueue(
  store: StorePort,
  now: Date,
  deps: QueueDeps,
): Queue {
  const index = loadKevIndex(store, now, deps.kevPolicy);

  const items: QueueItem[] = [];
  let unreadable = 0;

  for (const row of store.currentByType("dependabot_alert")) {
    if (row.state !== "present") continue;
    const alert = readAlert(row.payload);
    if (alert === null) {
      unreadable++;
      continue;
    }

    const kev = kevSignal(index, alert.cveId);
    const ranking = rank(
      {
        kev,
        // Explicit null stays null: absent EPSS ranks as unknown, never as
        // zero risk (AD-20), and 9 of the 67 alerts measured on the live
        // estate carried none, so this is a standing path, not a corner.
        epss: alert.epssPercentage,
        // An unrecognised severity becomes null and ranks as unknown, which is
        // what the adapter's own "unknown" value should do.
        severity: normaliseSeverity(alert.severity ?? ""),
        // An alert is not an update: nothing to bump, nothing to be stuck.
        bump: NOT_APPLICABLE,
        stuck: NOT_APPLICABLE,
      },
      deps.rankPolicy,
    );

    items.push({
      key: row.subject.key,
      repo: alert.repo,
      number: alert.number,
      packageName: alert.packageName ?? null,
      advisory: alert.cveId ?? alert.ghsaId ?? null,
      severity: alert.severity ?? "unknown",
      epss: alert.epssPercentage,
      htmlUrl: alert.htmlUrl ?? null,
      explanation: ranking.explanation,
      kevListed: kev === true,
      ranking,
      freshness: freshness(row.verifiedAt, now, deps.policy),
      age: ageLabel(row.verifiedAt, now),
      verifiedAt: row.verifiedAt,
    });
  }

  items.sort(
    (a, b) =>
      compareRankings(a.ranking, b.ranking) || a.key.localeCompare(b.key),
  );

  return {
    items,
    unreadable,
    kev: {
      usable: index.usable,
      version: index.version,
      age: ageLabel(index.verifiedAt, now),
    },
  };
}
