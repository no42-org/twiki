/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { watchKey } from "../../core/slug.js";
import { alertSubject, secretScanningSubject } from "../../core/subject.js";
import type { RepoRef } from "../../core/types.js";
import {
  orgSecretScanningUrl,
  type RawSecretScanningAlert,
} from "../../github/port.js";
import type { ObservationInput, RunScope } from "../store/port.js";
import {
  collectAllOrgListings,
  collectOrgListing,
  type LaneDeps,
  type LaneResult,
  type LaneSpec,
} from "./org-listing-lane.js";

// The REST org-level lane, for secret scanning alerts (#158).
//
// The code scanning lane's sibling, rule for rule: one call covers the whole
// organisation, a user account fans out over its watched repositories, and a
// repository GitHub answers WITHOUT a listing is skipped rather than
// confirmed, so it reads `unconfirmed` and never a confident zero.
//
// What is deliberately different is what a stored row does NOT contain. The
// credential never enters our type at all (see RawSecretScanningAlert), so
// there is nothing here to redact, truncate or forget to redact later. And
// nothing carries a severity: GitHub grades no secret, so a lane inventing a
// grade would be putting a number on the one finding that needs none.
//
// Measured live on 2026-09-09 with the read-only App: the org listing answers
// 200 with an ETag, no `link` header and ZERO alerts in every state in all
// three installed organisations. So the empty page is the shape this lane was
// exercised against for real; every other shape is asserted from the schema.

/**
 * What we store about one secret scanning alert.
 *
 * Flat, and only what a page or the ranking chain reads. THE CREDENTIAL IS
 * NOT HERE and never will be: the adapter's mapper has no field for it, so
 * this payload cannot acquire one by an edit that forgets to redact.
 * `secretType` is `secret_type_display_name`, the only name of the finding
 * that may reach a reader.
 */
export interface SecretScanningAlertObservation {
  number: number;
  repo: string;
  /**
   * What GitHub said the alert's state is, or null where it said nothing.
   * Informational: the projection's own state carries the tombstone, and the
   * lane asks only for open alerts.
   */
  state: string | null;
  /** `secret_type_display_name`, or null where GitHub sent none. */
  secretType: string | null;
  /** `active`, `inactive`, or `unknown` for both absence and that literal. */
  validity: string;
  /** GitHub REPORTED a public leak. Null, false and absent are all false. */
  publiclyLeaked: boolean;
  htmlUrl: string | null;
  createdAt: string | null;
}

/**
 * Per-repository confirmation, written for every watched repository the sweep
 * covered, whether or not it had an alert.
 *
 * No worst severity, unlike its code scanning counterpart, and its absence is
 * the point: GitHub grades no secret, so there is no worst one to report. The
 * chips render `critical` for an open secret from the queue's display
 * severity, which is a word about the finding rather than a grade fed by
 * anything GitHub sent.
 */
export interface RepoSecretScanningObservation {
  repo: string;
  openAlerts: number;
}

export function normalise(alert: RawSecretScanningAlert): ObservationInput {
  const payload: SecretScanningAlertObservation = {
    number: alert.number,
    repo: `${alert.repo.owner}/${alert.repo.name}`,
    state: alert.state,
    secretType: alert.secretType,
    validity: alert.validity,
    publiclyLeaked: alert.publiclyLeaked,
    htmlUrl: alert.htmlUrl,
    createdAt: alert.createdAt,
  };
  return {
    subject: alertSubject("secret_scanning_alert", alert.repo, alert.number),
    payload,
  };
}

/** Summarise one repository's alerts into its confirmation row. */
export function summariseRepo(
  repo: RepoRef,
  alerts: readonly RawSecretScanningAlert[],
): ObservationInput {
  const slug = watchKey(repo);
  const mine = alerts.filter((a) => watchKey(a.repo) === slug);
  const payload: RepoSecretScanningObservation = {
    repo: slug,
    openAlerts: mine.length,
  };
  return { subject: secretScanningSubject(repo), payload };
}

export type { LaneDeps, LaneResult };

export const LANE = "rest-org-secret-scanning";

/** Everything this kind varies. Eight fields, and no ninth (#163). */
const SPEC: LaneSpec<RawSecretScanningAlert> = {
  lane: LANE,
  alertSubject: "secret_scanning_alert",
  confirmationSubject: "repository_secret_scanning",
  url: orgSecretScanningUrl,
  list: (github, installation, repos, cached) =>
    github.listSecretScanningAlerts(installation, repos, cached),
  normalise,
  summariseRepo,
  truncationNote:
    "secret scanning listing truncated at the pagination cap; nothing tombstoned",
};

/**
 * Collect one installation's open secret scanning alerts (#158).
 *
 * Nothing throws past this boundary, including a store failure: one
 * unreachable organisation must not abort the cycle for the others (AD-16).
 */
export async function collectOrgSecretScanning(
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
export async function collectAllOrgSecretScanning(
  deps: LaneDeps,
  installations: readonly string[],
  scope: RunScope,
): Promise<LaneResult[]> {
  return collectAllOrgListings(SPEC, deps, installations, scope);
}
