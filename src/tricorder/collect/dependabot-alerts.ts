/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { worstSeverity } from "../../core/severity.js";
import { watchKey } from "../../core/slug.js";
import { alertSubject, repositorySubject } from "../../core/subject.js";
import type { RepoRef } from "../../core/types.js";
import { orgAlertsUrl, type RawDependabotAlert } from "../../github/port.js";
import type { ObservationInput, RunScope } from "../store/port.js";
import {
  collectAllOrgListings,
  collectOrgListing,
  type LaneDeps,
  type LaneResult,
  type LaneSpec,
} from "./org-listing-lane.js";

// The REST org-level lane, for Dependabot alerts.
//
// REST rather than GraphQL, because EPSS ships on this payload and GraphQL's
// vulnerabilityAlerts does not carry it (AD-15). One call covers every
// repository in the organisation, which is what makes twelve installations
// cost about 36 calls a cycle rather than one per repository.
//
// The pipeline is fetch, normalise, load. Ranking is a later story; this lane
// captures EPSS at ingest so the ranking has something honest to read (AD-18).

/** What we store about an alert. Keep it flat: the ranking chain reads it. */
/**
 * Per-repository confirmation. Written for every watched repository the sweep
 * COVERED, whether or not it had an alert.
 *
 * Without it, "we looked and there are none" is inexpressible: a healthy
 * repository has no alert rows, and absence of rows is indistinguishable from
 * absence of collection. It also keeps a repository that just became clean
 * from going permanently stale, because its alert rows stop being updated the
 * moment they are tombstoned.
 *
 * Covered is not the same as watched. On the per-repository fan-out GitHub
 * answers some repositories with a refusal instead of a listing; one of those
 * gets no row here and any row it already had is retracted, so it reads
 * `unconfirmed` rather than a zero, or a stale count, for a question nobody
 * asked it (#169).
 */
export interface RepoObservation {
  repo: string;
  openAlerts: number;
  worstSeverity: string | null;
}

export interface AlertObservation {
  number: number;
  repo: string;
  /**
   * open, fixed, dismissed or auto_dismissed, as GitHub reported it. The
   * projection's own `state` column carries the tombstone; this is what the
   * API said, kept so the two can be compared.
   */
  state: string;
  severity: string;
  ghsaId: string | null;
  cveId: string | null;
  packageName: string | null;
  ecosystem: string | null;
  /** Captured now, never re-read for this alert (AD-18). */
  epssPercentage: number | null;
  epssPercentile: number | null;
  relationship: string | null;
  scope: string | null;
  htmlUrl: string | null;
  createdAt: string | null;
}

export function normalise(alert: RawDependabotAlert): ObservationInput {
  const payload: AlertObservation = {
    number: alert.number,
    repo: `${alert.repo.owner}/${alert.repo.name}`,
    state: alert.state,
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

/** Summarise one repository's alerts into its confirmation row. */
export function summariseRepo(
  repo: RepoRef,
  alerts: readonly RawDependabotAlert[],
): ObservationInput {
  const slug = watchKey(repo);
  const mine = alerts.filter((a) => watchKey(a.repo) === slug);
  const payload: RepoObservation = {
    repo: slug,
    openAlerts: mine.length,
    worstSeverity: worstSeverity(mine.map((a) => a.severity)),
  };
  return { subject: repositorySubject(repo), payload };
}

export type { LaneDeps, LaneResult };

export const LANE = "rest-org-dependabot";

/** Everything this kind varies. Eight fields, and no ninth (#163). */
const SPEC: LaneSpec<RawDependabotAlert> = {
  lane: LANE,
  alertSubject: "dependabot_alert",
  confirmationSubject: "repository",
  url: orgAlertsUrl,
  list: (github, installation, repos, cached) =>
    github.listDependabotAlerts(installation, repos, cached),
  normalise,
  summariseRepo,
  truncationNote:
    "alert listing truncated at the pagination cap; nothing tombstoned",
};

/**
 * Collect one installation's open Dependabot alerts.
 *
 * Nothing throws past this boundary, including a store failure: one
 * unreachable organisation must not abort the cycle for the others (AD-16).
 */
export async function collectOrgAlerts(
  deps: LaneDeps,
  installation: string,
  scope: RunScope,
): Promise<LaneResult> {
  return collectOrgListing(SPEC, deps, installation, scope);
}

/**
 * Sweep several installations. Serial by design: GitHub advises serial
 * requests per installation, and fanning out is how a collector trips the
 * secondary limits it cannot see coming (AD-24).
 */
export async function collectAllOrgs(
  deps: LaneDeps,
  installations: readonly string[],
  scope: RunScope,
): Promise<LaneResult[]> {
  return collectAllOrgListings(SPEC, deps, installations, scope);
}
