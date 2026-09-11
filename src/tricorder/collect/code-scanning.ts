/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { NOT_APPLICABLE } from "../../core/rank.js";
import { worstSeverity } from "../../core/severity.js";
import { watchKey } from "../../core/slug.js";
import { alertSubject, codeScanningSubject } from "../../core/subject.js";
import type { RepoRef } from "../../core/types.js";
import {
  orgCodeScanningUrl,
  type RawCodeScanningAlert,
} from "../../github/port.js";
import type { ObservationInput, RunScope } from "../store/port.js";
import {
  collectAllOrgListings,
  collectOrgListing,
  type LaneDeps,
  type LaneResult,
  type LaneSpec,
} from "./org-listing-lane.js";

// The REST org-level lane, for code scanning alerts (#156).
//
// One call covers every repository in the organisation, exactly as the
// Dependabot lane's does, and for the same reason: a per-repository sweep
// would cost one call per repository per alert cadence. A user account has no
// org-level endpoint, so it fans out; the port owns that routing.
//
// One rule distinguishes this lane from its Dependabot sibling, and it is
// deliberate:
//
//   Every open alert is stored REGARDLESS OF REF. The default-branch
//   condition belongs to the queue builder, so the repository page can list
//   what the queue declines to rank rather than the row simply vanishing.
//
// Skipping used to be the second. It is not a distinction any more: #169 gave
// the Dependabot lane the same rule, so all three now answer a stable refusal
// with no rows and no confirmation, and the repository reads `unconfirmed`
// rather than a confident zero.

/**
 * What we store about one code scanning alert.
 *
 * Flat, and only what a page or the ranking chain reads. `rule.severity` is
 * deliberately absent: it carries the linting scale, on which a Scorecard
 * `error` outranks this estate's one Trivy `critical`, and a field nothing
 * stores cannot be ranked on by accident.
 */
export interface CodeScanningAlertObservation {
  number: number;
  repo: string;
  /**
   * What GitHub said the alert's state is, or null where it said nothing.
   * Informational: the projection's own state carries the tombstone, and the
   * lane asks only for open alerts.
   */
  state: string | null;
  /** `rule.security_severity_level`, or `n/a` when GitHub graded nothing. */
  severity: string;
  /** The scanner that found it, for the queue's rationale. */
  tool: string | null;
  /** `rule.id`, which is a CVE for Trivy and an audit name for zizmor. */
  ruleId: string | null;
  /** `most_recent_instance.ref`. The queue's default-branch condition reads it. */
  ref: string | null;
  htmlUrl: string | null;
  createdAt: string | null;
}

/**
 * Per-repository confirmation, written for every watched repository the sweep
 * covered, whether or not it had an alert.
 *
 * Its own subject type rather than a second writer on `repository`: the two
 * lanes have their own freshness, and one vouching for the other is how a
 * fresh Dependabot sweep would badge a code scanning section nothing swept.
 */
export interface RepoCodeScanningObservation {
  repo: string;
  openAlerts: number;
  /**
   * The worst GRADED severity among them, or null when none is graded.
   *
   * `n/a` values are filtered out rather than passed through: `worstSeverity`
   * would read the sentinel as a severity it does not recognise and answer
   * `unknown`, which claims a value we failed to read where the truth is that
   * the tool grades nothing.
   */
  worstSeverity: string | null;
}

export function normalise(alert: RawCodeScanningAlert): ObservationInput {
  const payload: CodeScanningAlertObservation = {
    number: alert.number,
    repo: `${alert.repo.owner}/${alert.repo.name}`,
    state: alert.state,
    severity: alert.securitySeverity,
    tool: alert.tool,
    ruleId: alert.ruleId,
    ref: alert.ref,
    htmlUrl: alert.htmlUrl,
    createdAt: alert.createdAt,
  };
  return {
    subject: alertSubject("code_scanning_alert", alert.repo, alert.number),
    payload,
  };
}

/** Summarise one repository's alerts into its confirmation row. */
export function summariseRepo(
  repo: RepoRef,
  alerts: readonly RawCodeScanningAlert[],
): ObservationInput {
  const slug = watchKey(repo);
  const mine = alerts.filter((a) => watchKey(a.repo) === slug);
  const payload: RepoCodeScanningObservation = {
    repo: slug,
    openAlerts: mine.length,
    worstSeverity: worstSeverity(
      mine
        .map((a) => a.securitySeverity)
        .filter((severity) => severity !== NOT_APPLICABLE),
    ),
  };
  return { subject: codeScanningSubject(repo), payload };
}

export type { LaneDeps, LaneResult };

export const LANE = "rest-org-code-scanning";

/** Everything this kind varies. Eight fields, and no ninth (#163). */
const SPEC: LaneSpec<RawCodeScanningAlert> = {
  lane: LANE,
  alertSubject: "code_scanning_alert",
  confirmationSubject: "repository_code_scanning",
  url: orgCodeScanningUrl,
  list: (github, installation, repos, cached) =>
    github.listCodeScanningAlerts(installation, repos, cached),
  normalise,
  summariseRepo,
  truncationNote:
    "code scanning listing truncated at the pagination cap; nothing tombstoned",
};

/**
 * Collect one installation's open code scanning alerts (#156).
 *
 * Nothing throws past this boundary, including a store failure: one
 * unreachable organisation must not abort the cycle for the others (AD-16).
 */
export async function collectOrgCodeScanning(
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
export async function collectAllOrgCodeScanning(
  deps: LaneDeps,
  installations: readonly string[],
  scope: RunScope,
): Promise<LaneResult[]> {
  return collectAllOrgListings(SPEC, deps, installations, scope);
}
