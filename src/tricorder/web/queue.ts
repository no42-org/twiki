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
import type { UpdateStatusObservation } from "../collect/update-status.js";
import { kevSignal, loadKevIndex } from "../kev-lookup.js";
import type { StorePort } from "../store/port.js";
import {
  ageLabel,
  type Freshness,
  type FreshnessPolicy,
  freshness,
} from "./freshness.js";
import { readAlert, readIssue, readPr, readStatus } from "./payloads.js";

// The ranked queue (CAP-6): one cross-repository list answering "what should I
// deal with next, and why does it rank there".
//
// This is the first production caller of the ranking chain. Until it existed,
// rank() and the KEV lookup were deletable with a green suite, a gap three
// review rounds flagged in a row.

export interface QueueItem {
  kind: "alert" | "update_pr" | "issue";
  /**
   * The subject key: `owner/name#number` for alerts, the node id for PRs and
   * issues.
   */
  key: string;
  repo: string;
  number: number;
  packageName: string | null;
  /** The issue title. Null for alerts and PRs, whose package says enough. */
  title: string | null;
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

export function buildQueue(
  store: StorePort,
  now: Date,
  deps: QueueDeps,
): Queue {
  const index = loadKevIndex(store, now, deps.kevPolicy);

  // What dependabotUpdate said, read before the alert pass because both later
  // passes consume it: the alert's stuck flag comes from the status keyed like
  // the alert itself, and a status naming a PR number is the precise
  // alert-to-PR link the package heuristic only approximates.
  const statusByAlertKey = new Map<string, UpdateStatusObservation>();
  const linksByPr = new Map<
    string,
    { alertKey: string; error: string | null }[]
  >();
  for (const row of store.currentByType("dependabot_update_status")) {
    if (row.state !== "present") continue;
    const status = readStatus(row.payload);
    if (status === null) continue;
    statusByAlertKey.set(row.subject.key, status);
    if (status.update?.pullRequestNumber != null) {
      const prKey = `${status.repo.toLowerCase()}|${status.update.pullRequestNumber}`;
      const list = linksByPr.get(prKey) ?? [];
      // The error rides along: a status can carry BOTH a PR and an error
      // (the PR opened, a later update attempt failed), and the PR row must
      // agree with the alert row about it rather than say "prepared
      // normally" one line away from "could not prepare".
      list.push({ alertKey: row.subject.key, error: status.update.error });
      linksByPr.set(prKey, list);
    }
  }

  const items: QueueItem[] = [];
  let unreadable = 0;

  // Filled during the alert pass, read during the PR pass. One derivation of
  // kev and severity per alert: two copy-parallel loops let the two drift, and
  // a PR could "inherit" a risk disagreeing with the alert row beside it.
  interface AlertTerms {
    kev: ReturnType<typeof kevSignal>;
    epss: number | null;
    severity: ReturnType<typeof normaliseSeverity>;
    advisory: string | null;
  }
  const alertsByPackage = new Map<string, AlertTerms[]>();
  // The same triples keyed by subject key, for the precise status-driven join.
  const alertsByKey = new Map<string, AlertTerms>();

  for (const row of store.currentByType("dependabot_alert")) {
    if (row.state !== "present") continue;
    const alert = readAlert(row.payload);
    if (alert === null) {
      unreadable++;
      continue;
    }

    const kev = kevSignal(index, alert.cveId);
    const severity = normaliseSeverity(alert.severity ?? "");
    const terms: AlertTerms = {
      kev,
      epss: alert.epssPercentage,
      severity,
      advisory: alert.cveId ?? alert.ghsaId ?? null,
    };
    alertsByKey.set(row.subject.key, terms);
    if (alert.packageName !== null) {
      const key = `${alert.repo.toLowerCase()}|${alert.packageName.toLowerCase()}`;
      const list = alertsByPackage.get(key) ?? [];
      list.push(terms);
      alertsByPackage.set(key, list);
    }
    // The stuck flag (CAP-3): a status naming an error means GitHub tried to
    // prepare the fix and could not, so nothing is coming automatically. No
    // status row means we have not looked yet, which is unknown, never "fine"
    // (AD-20); a status whose update is null means GitHub is not attempting a
    // fix at all, which is a fact of absence (n/a), not a gap.
    const status = statusByAlertKey.get(row.subject.key);
    const stuck =
      status === undefined
        ? null
        : status.update === null
          ? NOT_APPLICABLE
          : status.update.error !== null;
    const ranking = rank(
      {
        kev,
        // Explicit null stays null: absent EPSS ranks as unknown, never as
        // zero risk (AD-20), and 9 of the 67 alerts measured on the live
        // estate carried none, so this is a standing path, not a corner.
        epss: alert.epssPercentage,
        // An unrecognised severity becomes null and ranks as unknown, which is
        // what the adapter's own "unknown" value should do.
        severity,
        // An alert is not an update: nothing to bump.
        bump: NOT_APPLICABLE,
        stuck,
      },
      deps.rankPolicy,
    );

    items.push({
      kind: "alert",
      key: row.subject.key,
      repo: alert.repo,
      number: alert.number,
      packageName: alert.packageName ?? null,
      title: null,
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
  // The update PRs (CAP-3), ranked by the risk of what they fix. The join is
  // local: alertsByPackage was filled during the single pass over the alerts
  // above, so a PR bumping a package with an open alert inherits the
  // worst-ranking alert's top three terms. A PR whose package has no open
  // alert is a plain update, and its security terms are facts of absence
  // (n/a), not gaps (unknown): calling them unknown would float every routine
  // bump above every alert we checked and found absent.
  for (const row of store.currentByType("dependency_update_pr")) {
    if (row.state !== "present") continue;
    const pr = readPr(row.payload);
    if (pr === null) {
      unreadable++;
      continue;
    }

    // The precise join first: a status row naming this PR's number is
    // GitHub's own statement of which alert the PR fixes, so when one exists
    // it wins over the title-parsed package heuristic, INCLUDING when the
    // named alert row cannot be read: falling back to the heuristic there
    // would re-inherit a different alert's risk, the exact wrong-alert
    // inheritance the join exists to fix. The stuck term comes from the
    // linked statuses' own error fields, not from the PR's existence.
    const links = linksByPr.get(`${pr.repo.toLowerCase()}|${pr.number}`) ?? [];
    const linked = links
      .map((link) => alertsByKey.get(link.alertKey))
      .filter((terms): terms is AlertTerms => terms !== undefined);

    const candidates =
      links.length > 0
        ? linked
        : pr.packageName === null
          ? []
          : // Folded on both sides: the alert name comes from GitHub's
            // ecosystem-normalised advisory data (pip says django) while the PR
            // title carries manifest casing (Bump Django from ...), and a case
            // miss silently loses the CAP-3 risk inheritance.
            (alertsByPackage.get(
              `${pr.repo.toLowerCase()}|${pr.packageName.toLowerCase()}`,
            ) ?? []);
    const prStuck =
      links.length === 0
        ? NOT_APPLICABLE
        : links.some((link) => link.error !== null);

    // A PR with candidates takes its terms from them, even when a candidate
    // happens to tie the all-n/a baseline: seeding from the baseline and
    // comparing strictly lost the advisory on exactly that tie, and the row
    // said "no advisory" about a PR that fixes a real one.
    let best: Ranking;
    let advisory: string | null;
    let kevListed: boolean;
    if (candidates.length === 0) {
      // Two different absences (AD-20). A status names an alert we could not
      // read: there IS an advisory, we failed to see it, so the security
      // terms are unknown. No link and no package match: a plain update, and
      // its security terms are facts of absence.
      const linkedButUnreadable = links.length > 0;
      best = rank(
        {
          kev: linkedButUnreadable ? null : NOT_APPLICABLE,
          epss: linkedButUnreadable ? null : NOT_APPLICABLE,
          severity: linkedButUnreadable ? null : NOT_APPLICABLE,
          bump: pr.bump,
          stuck: prStuck,
        },
        deps.rankPolicy,
      );
      advisory = null;
      kevListed = false;
    } else {
      const ranked = candidates.map((c) => ({
        c,
        r: rank(
          {
            kev: c.kev,
            epss: c.epss,
            severity: c.severity,
            bump: pr.bump,
            stuck: prStuck,
          },
          deps.rankPolicy,
        ),
      }));
      // The worst-ranking alert wins: a PR fixing two advisories is judged by
      // the more urgent of them.
      ranked.sort((a, b) => compareRankings(a.r, b.r));
      const winner = ranked[0] as (typeof ranked)[number];
      best = winner.r;
      advisory = winner.c.advisory;
      kevListed = winner.c.kev === true;
    }

    items.push({
      kind: "update_pr",
      key: row.subject.key,
      repo: pr.repo,
      number: pr.number,
      packageName: pr.packageName,
      title: null,
      advisory,
      htmlUrl: pr.htmlUrl.startsWith("https://") ? pr.htmlUrl : null,
      explanation: best.explanation,
      kevListed,
      ranking: best,
      freshness: freshness(row.verifiedAt, now, deps.policy),
      age: ageLabel(row.verifiedAt, now),
    });
  }

  // Untriaged issues (CAP-2). Every security term is a fact of absence: an
  // issue carries no CVE, no advisory and no update, so all-n/a is the honest
  // ranking and it sinks below every alert we actually measured. The chain's
  // generated explanation would recite five absences, so the row says the one
  // thing that is true instead.
  for (const row of store.currentByType("issue")) {
    if (row.state !== "present") continue;
    const issue = readIssue(row.payload);
    if (issue === null) {
      unreadable++;
      continue;
    }

    const ranking = rank(
      {
        kev: NOT_APPLICABLE,
        epss: NOT_APPLICABLE,
        severity: NOT_APPLICABLE,
        bump: NOT_APPLICABLE,
        stuck: NOT_APPLICABLE,
      },
      deps.rankPolicy,
    );

    items.push({
      kind: "issue",
      key: row.subject.key,
      repo: issue.repo,
      number: issue.number,
      packageName: null,
      title: issue.title,
      advisory: null,
      htmlUrl: issue.htmlUrl.startsWith("https://") ? issue.htmlUrl : null,
      explanation: "untriaged issue, nobody assigned",
      kevListed: false,
      ranking,
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
