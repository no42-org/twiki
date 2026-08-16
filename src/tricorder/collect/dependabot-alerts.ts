/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { alertSubject } from "../../core/subject.js";
import type { GitHubReadPort, RawDependabotAlert } from "../../github/port.js";
import type { ObservationInput, RunScope, StorePort } from "../store/port.js";

// The REST org-level lane, for Dependabot alerts.
//
// REST rather than GraphQL, because EPSS ships on this payload and GraphQL's
// vulnerabilityAlerts does not carry it (AD-15). One call per organisation
// covers every repository in it, which is what makes twelve installations cost
// about 36 calls a cycle rather than one per repository.
//
// The pipeline is fetch, normalise, load. Ranking is a later story; this lane
// captures EPSS at ingest so the ranking has something honest to read (AD-18).

/** What we store about an alert. Keep it flat: the ranking chain reads it. */
export interface AlertObservation {
  number: number;
  repo: string;
  severity: string;
  ghsaId: string;
  cveId: string | null;
  packageName: string | null;
  ecosystem: string | null;
  /** Captured now, never re-read for this alert (AD-18). */
  epssPercentage: number | null;
  epssPercentile: number | null;
  relationship: string | null;
  scope: string | null;
  htmlUrl: string;
  createdAt: string;
}

export function normalise(alert: RawDependabotAlert): ObservationInput {
  const payload: AlertObservation = {
    number: alert.number,
    repo: `${alert.repo.owner}/${alert.repo.name}`,
    severity: alert.severity,
    ghsaId: alert.ghsaId,
    cveId: alert.cveId,
    packageName: alert.packageName,
    ecosystem: alert.ecosystem,
    epssPercentage: alert.epssPercentage,
    epssPercentile: alert.epssPercentile,
    relationship: alert.relationship,
    scope: alert.scope,
    htmlUrl: alert.htmlUrl,
    createdAt: alert.createdAt,
  };
  return {
    subject: alertSubject("dependabot_alert", alert.repo, alert.number),
    payload,
  };
}

export interface LaneDeps {
  github: GitHubReadPort;
  store: StorePort;
  now: () => string;
  log: (msg: string) => void;
}

export interface LaneResult {
  installation: string;
  outcome: "ok" | "failed";
  alerts: number;
}

export const LANE = "rest-org-dependabot";

/**
 * Collect one organisation's open Dependabot alerts.
 *
 * A failure here is recorded and returned, never thrown past this boundary: one
 * unreachable organisation must not abort the cycle for the other twelve
 * (AD-16). The run is opened before the fetch, so a crash mid-flight still
 * leaves a run row that reads `partial` rather than nothing at all.
 */
export async function collectOrgAlerts(
  deps: LaneDeps,
  installation: string,
  scope: RunScope,
): Promise<LaneResult> {
  const startedAt = deps.now();
  const run = deps.store.beginRun({
    lane: LANE,
    installation,
    scope,
    startedAt,
  });

  try {
    const alerts = await deps.github.listOrgDependabotAlerts(installation);
    const observations = alerts.map(normalise);
    // One transaction: every observation and its projection advance land
    // together, or none do (AD-3).
    deps.store.recordObservations(run, deps.now(), observations);
    deps.store.finishRun(run, "ok", deps.now());
    deps.log(`${LANE} ${installation}: ${observations.length} open alerts`);
    return { installation, outcome: "ok", alerts: observations.length };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.store.finishRun(run, "failed", deps.now(), detail);
    deps.log(`${LANE} ${installation}: failed, ${detail}`);
    return { installation, outcome: "failed", alerts: 0 };
  }
}

/**
 * Sweep several installations. Serial by design: GitHub advises serial requests
 * per installation, and fanning out is how a collector trips the secondary
 * limits it cannot see coming (AD-24).
 */
export async function collectAllOrgs(
  deps: LaneDeps,
  installations: readonly string[],
  scope: RunScope,
): Promise<LaneResult[]> {
  const results: LaneResult[] = [];
  for (const installation of installations) {
    results.push(await collectOrgAlerts(deps, installation, scope));
  }
  return results;
}
