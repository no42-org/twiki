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
import type { UpdatePrObservation } from "../collect/update-prs.js";
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
  kind: "alert" | "update_pr";
  /** The subject key: `owner/name#number` for alerts, the node id for PRs. */
  key: string;
  repo: string;
  number: number;
  packageName: string | null;
  /** The advisory id shown to the reader: CVE when present, else GHSA. */
  advisory: string | null;
  htmlUrl: string | null;
  /** CAP-6's "why does it rank there", most significant term first. */
  explanation: string;
  /** Confirmed listed in CISA KEV. The one state the page shouts about. */
  kevListed: boolean;
  ranking: Ranking;
  freshness: Freshness;
  age: string;
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

/** A field that must be a string or an explicit null, never anything else. */
function stringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/**
 * The shape check behind "counted, not guessed at".
 *
 * Every field the queue consumes is validated, because the first version
 * checked two and let the rest detonate downstream: a row with `cveId: 42`
 * passed the guard, kevSignal called `(42).trim()`, and the whole page
 * answered 500. A guard that forwards a row it has not actually checked is
 * the thing this function's own comment promised it was not.
 */
function readAlert(payload: unknown): AlertObservation | null {
  const a = payload as AlertObservation | null | undefined;
  if (!a || typeof a !== "object") return null;
  if (typeof a.number !== "number" || typeof a.repo !== "string") return null;
  if (typeof a.severity !== "string") return null;
  if (!stringOrNull(a.cveId)) return null;
  if (!stringOrNull(a.ghsaId)) return null;
  if (!stringOrNull(a.packageName)) return null;
  if (!stringOrNull(a.htmlUrl)) return null;
  if (a.epssPercentage !== null && typeof a.epssPercentage !== "number") {
    return null;
  }
  return a;
}

/**
 * The PR shape check, same posture as readAlert: counted, not guessed at.
 */
function readPr(payload: unknown): UpdatePrObservation | null {
  const p = payload as UpdatePrObservation | null | undefined;
  if (!p || typeof p !== "object") return null;
  if (typeof p.number !== "number" || typeof p.repo !== "string") return null;
  if (typeof p.title !== "string" || typeof p.author !== "string") return null;
  if (typeof p.htmlUrl !== "string") return null;
  if (p.packageName !== null && typeof p.packageName !== "string") return null;
  if (
    p.bump !== null &&
    p.bump !== "patch" &&
    p.bump !== "minor" &&
    p.bump !== "major"
  ) {
    return null;
  }
  return p;
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
      kind: "alert",
      key: row.subject.key,
      repo: alert.repo,
      number: alert.number,
      packageName: alert.packageName ?? null,
      advisory: alert.cveId ?? alert.ghsaId ?? null,
      // GitHub only ever hands out https URLs, so anything else in this field
      // is a corrupted or foreign row, and this is the first store-derived
      // href in the codebase: hono/jsx renders `javascript:` schemes verbatim.
      htmlUrl: alert.htmlUrl?.startsWith("https://") ? alert.htmlUrl : null,
      explanation: ranking.explanation,
      kevListed: kev === true,
      ranking,
      freshness: freshness(row.verifiedAt, now, deps.policy),
      age: ageLabel(row.verifiedAt, now),
    });
  }

  // The key tiebreak cannot be observed through the store today, because
  // currentByType already returns rows ORDER BY subject_key and this sort is
  // stable. It stays as defence: that SQL clause is one edit away from
  // disappearing, and a queue that reshuffles between refreshes on rank ties
  // would look broken in a way no test of ordering-by-rank catches.
  // The update PRs (CAP-3), ranked by the risk of what they fix. The join to
  // that risk is local: the stored alerts already carry package, CVE, EPSS and
  // severity, so a PR bumping a package with an open alert inherits the
  // worst-ranking alert's top three terms. A PR whose package has no open
  // alert is a plain update, and its security terms are facts of absence
  // (n/a), not gaps (unknown): calling them unknown would float every routine
  // bump above every alert we checked and found absent.
  const alertsByPackage = new Map<
    string,
    {
      kev: ReturnType<typeof kevSignal>;
      epss: number | null;
      severity: ReturnType<typeof normaliseSeverity>;
      advisory: string | null;
    }[]
  >();
  for (const row of store.currentByType("dependabot_alert")) {
    if (row.state !== "present") continue;
    const alert = readAlert(row.payload);
    if (alert === null || alert.packageName === null) continue;
    const key = `${alert.repo.toLowerCase()}|${alert.packageName}`;
    const list = alertsByPackage.get(key) ?? [];
    list.push({
      kev: kevSignal(index, alert.cveId),
      epss: alert.epssPercentage,
      severity: normaliseSeverity(alert.severity ?? ""),
      advisory: alert.cveId ?? alert.ghsaId ?? null,
    });
    alertsByPackage.set(key, list);
  }

  for (const row of store.currentByType("dependency_update_pr")) {
    if (row.state !== "present") continue;
    const pr = readPr(row.payload);
    if (pr === null) {
      unreadable++;
      continue;
    }

    const candidates =
      pr.packageName === null
        ? []
        : (alertsByPackage.get(`${pr.repo.toLowerCase()}|${pr.packageName}`) ??
          []);

    // No open alert for the package: a plain update.
    let best = rank(
      {
        kev: NOT_APPLICABLE,
        epss: NOT_APPLICABLE,
        severity: NOT_APPLICABLE,
        bump: pr.bump,
        stuck: NOT_APPLICABLE,
      },
      deps.rankPolicy,
    );
    let advisory: string | null = null;
    let kevListed = false;
    for (const c of candidates) {
      const r = rank(
        {
          kev: c.kev,
          epss: c.epss,
          severity: c.severity,
          bump: pr.bump,
          stuck: NOT_APPLICABLE,
        },
        deps.rankPolicy,
      );
      // The worst-ranking alert wins: a PR fixing two advisories is judged by
      // the more urgent of them.
      if (compareRankings(r, best) < 0) {
        best = r;
        advisory = c.advisory;
        kevListed = c.kev === true;
      }
    }

    items.push({
      kind: "update_pr",
      key: row.subject.key,
      repo: pr.repo,
      number: pr.number,
      packageName: pr.packageName,
      advisory,
      htmlUrl: pr.htmlUrl.startsWith("https://") ? pr.htmlUrl : null,
      explanation: best.explanation,
      kevListed,
      ranking: best,
      freshness: freshness(row.verifiedAt, now, deps.policy),
      age: ageLabel(row.verifiedAt, now),
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
