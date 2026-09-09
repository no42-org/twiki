/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type {
  CoverageFeatures,
  CoverageState,
  FeatureCoverage,
} from "../../core/coverage.js";
import {
  COVERAGE_FEATURES,
  COVERAGE_STATES,
  isCovered,
} from "../../core/coverage.js";
import { safeLog } from "../../core/log.js";
import { coverageSubject } from "../../core/subject.js";
import type { RepoRef } from "../../core/types.js";
import { repoSlug } from "../../core/types.js";
import type { GitHubReadPort } from "../../github/port.js";
import type { ObservationInput, RunScope } from "../store/port.js";
import { type LaneRunDeps, withLaneRun } from "./lifecycle.js";

// The coverage lane (AD-28).
//
// Absence from an org alert sweep is not evidence of health: the identical
// absence is produced by a clean repository, one with alerts switched off, one
// outside the installation, and one archived. Measured on one real
// organisation, 14 of 36 repositories were in the second category, so this is
// not an edge case.
//
// Cheap facts first. One call per 100 repositories gives `archived` and
// `disabled` for the whole organisation. Only what that cannot answer - whether
// Dependabot, code scanning and secret scanning are actually watching - costs
// three calls per repository, which is why this lane runs daily rather than on
// the sweep cadence (AD-15).
//
// Three features rather than one since #152. A repository with secret scanning
// switched off was indistinguishable from one with no leaked secrets, because
// nothing had asked GitHub. `security_and_analysis` on the repository payload
// names every feature's state and would answer all of this with no extra call,
// and it is deliberately NOT read: GitHub sends that block only to callers
// with admin rights, and this App is read-only by construction.

export const LANE = "coverage";

export interface CoverageObservation {
  repo: string;
  /**
   * Dependabot alerts.
   *
   * Unprefixed and alone at the top level because that is exactly the shape of
   * every row written before #152, and those rows keep reading correctly: this
   * field as stored, and the two below absent, which `coverageFeatures` reads
   * as `unknown` and never as off.
   */
  state: CoverageState;
  /** Present from #152 on. Absent means nobody has asked GitHub yet. */
  codeScanning?: FeatureCoverage;
  secretScanning?: FeatureCoverage;
}

/** A feature nobody has an answer for. Not evidence of anything. */
const UNKNOWN: FeatureCoverage = { state: "unknown", reason: null };

/**
 * One feature out of a stored payload, defaulting to `unknown`.
 *
 * Defensive about a shape this lane wrote, because the store hands back JSON
 * and a row may predate any given field. An absent, malformed or unrecognised
 * feature reads `unknown`: nobody asked GitHub, so nothing was said, and the
 * one reading it must not become `off` (#152).
 */
function readFeature(raw: unknown): FeatureCoverage {
  if (typeof raw !== "object" || raw === null) return UNKNOWN;
  const f = raw as { state?: unknown; reason?: unknown };
  const state = COVERAGE_STATES.find((s) => s === f.state);
  if (state === undefined) return UNKNOWN;
  return { state, reason: typeof f.reason === "string" ? f.reason : null };
}

/**
 * The three features of one stored coverage payload.
 *
 * The single reader for every consumer, so the overview and the repository
 * page cannot reach different conclusions from the same row. Dependabot's
 * probe carries no message of its own - its union says only which of the two
 * 403s it was - so its reason is null and `featureReason` supplies our own
 * sentence, exactly as before this story.
 */
export function coverageFeatures(
  payload: CoverageObservation,
): CoverageFeatures {
  return {
    dependabot: readFeature({ state: payload.state, reason: null }),
    code_scanning: readFeature(payload.codeScanning),
    secret_scanning: readFeature(payload.secretScanning),
  };
}

/**
 * One feature's new value, or the stored one when the probe reached no answer.
 *
 * Do not overwrite what we already knew with what we failed to learn. A
 * rate-limited probe answers nothing, and persisting that over a good
 * `covered` would blank a correct alert count until the next successful run.
 * The alert lane already refuses to write a confirmation it cannot back; this
 * is the same rule, applied per feature so the answers beside the failure
 * survive.
 */
function keep(
  probed: FeatureCoverage,
  answered: boolean,
  prior: FeatureCoverage | undefined,
): FeatureCoverage {
  return answered ? probed : (prior ?? probed);
}

export interface CoverageDeps extends LaneRunDeps {
  github: GitHubReadPort;
  watchedIn: (installation: string) => readonly RepoRef[];
}

export interface CoverageResult {
  installation: string;
  outcome: "ok" | "partial" | "failed";
  /** Repositories confirmed as genuinely watched. */
  covered: number;
  /** Repositories that cannot produce a real count, whatever the reason. */
  notCovered: number;
  /**
   * Repositories where at least one probe answered something we have not
   * measured. Non-zero forces a partial run. A measured body that MEANS
   * unknown, such as code scanning's `no analysis found`, is not counted here:
   * it is an answer, and counting it would leave this daily lane reporting
   * partial forever on a healthy estate.
   */
  unknown: number;
}

/**
 * The state that settles EVERY feature at once, or null when the probes decide.
 *
 * Both facts are about the repository rather than about any one feature, so
 * they win at write time for all three and no probe is spent on them.
 */
export function wholeRepoCoverage(
  meta: { archived: boolean; disabled: boolean } | undefined,
): CoverageState | null {
  // Archived wins over everything the probe can say. An archived repository may
  // still answer 200 with old alerts, and reporting it as covered would promise
  // that something is watching a repository nothing can update.
  if (meta?.archived) return "archived";
  // GitHub's `disabled` is about the repository itself, for billing, DMCA or
  // abuse. It is not a missing installation and must not be reported as one.
  if (meta?.disabled) return "repo_disabled";
  return null;
}

/**
 * Collect coverage for one installation.
 *
 * Nothing throws past this boundary, matching the alert lane: one unreachable
 * organisation must not abort the cycle for the others (AD-16).
 */
export async function collectCoverage(
  deps: CoverageDeps,
  installation: string,
  scope: RunScope = "full",
): Promise<CoverageResult> {
  const log = safeLog(deps.log);

  return withLaneRun<CoverageResult>(
    deps,
    { lane: LANE, installation, scope, reach: "per-installation" },
    { installation, outcome: "failed", covered: 0, notCovered: 0, unknown: 0 },
    async (run) => {
      const watched = deps.watchedIn(installation);
      // One call per 100 repositories, for the two states the listing carries.
      const metaBySlug = new Map<
        string,
        { archived: boolean; disabled: boolean }
      >();
      for (const m of await deps.github.listOrgRepos(installation)) {
        metaBySlug.set(repoSlug(m.repo).toLowerCase(), m);
      }

      const observations: ObservationInput[] = [];
      let covered = 0;
      let notCovered = 0;
      let unknown = 0;

      for (const repo of watched) {
        const slug = repoSlug(repo).toLowerCase();
        const meta = metaBySlug.get(slug);
        const whole = wholeRepoCoverage(meta);
        // What the last run left, so a probe that reached no answer this time
        // can hand back the fact it cannot replace rather than blanking it.
        const stored = deps.store.current(coverageSubject(repo));
        const prior =
          stored === null
            ? null
            : coverageFeatures(stored.payload as CoverageObservation);
        let features: CoverageFeatures;
        // True when at least one probe reached no answer at all. NOT when
        // GitHub answered something we have not measured: that is a stable
        // answer, stored with its body, and retrying it hourly for ever would
        // return the same words - which is how one private repository without
        // Advanced Security would hold this daily lane permanently partial.
        let unanswered = false;

        if (whole !== null) {
          // Archived and disabled are facts about the repository, so all three
          // features read them and none of the three calls is spent.
          const all: FeatureCoverage = { state: whole, reason: null };
          features = {
            dependabot: all,
            code_scanning: all,
            secret_scanning: all,
          };
        } else {
          // The probes are the only things that can tell us a feature is off,
          // so they are worth their calls. Serial, as everywhere else: GitHub
          // advises serial requests per installation (AD-24).
          const dependabot = await deps.github.probeDependabotAccess(repo);
          const code = await deps.github.probeCodeScanning(repo);
          const secret = await deps.github.probeSecretScanning(repo);
          // Per feature, not per row. A code scanning probe that failed must
          // not discard the secret scanning answer beside it, or a feature
          // switched off today would go unrecorded for as long as an unrelated
          // probe keeps failing.
          features = {
            dependabot: keep(
              { state: dependabot, reason: null },
              // The Dependabot union carries no message and no separate
              // "answered", so its `unknown` still stands for both a body we
              // could not read and a client that failed. Changing that
              // translator is deferred; until then this is the honest reading.
              dependabot !== "unknown",
              prior?.dependabot,
            ),
            code_scanning: keep(
              { state: code.state, reason: code.reason },
              code.answered,
              prior?.code_scanning,
            ),
            secret_scanning: keep(
              { state: secret.state, reason: secret.reason },
              secret.answered,
              prior?.secret_scanning,
            ),
          };
          unanswered =
            dependabot === "unknown" || !code.answered || !secret.answered;
        }

        // Covered only when every feature is. A repository one feature was not
        // answered for cannot produce a real count either, whatever the reason,
        // which is what this pair has always counted.
        if (COVERAGE_FEATURES.every((f) => isCovered(features[f].state)))
          covered++;
        else notCovered++;

        // Counted, but the row is still written. Skipping the write held back
        // the two answers beside the failure AND froze `verifiedAt`, so a
        // repository whose probe kept failing aged out of freshness while the
        // lane went on knowing its other two features perfectly well.
        if (unanswered) unknown++;

        const payload: CoverageObservation = {
          repo: slug,
          state: features.dependabot.state,
          codeScanning: features.code_scanning,
          secretScanning: features.secret_scanning,
        };
        observations.push({ subject: coverageSubject(repo), payload });
      }

      deps.store.recordObservations(run, deps.now(), observations);

      // A probe that reached no answer means we do not know this repository's
      // coverage, and a lane that reports `ok` while holding those would let
      // the page treat them as settled. An answer we could not classify is NOT
      // one of these: it is stable, it is stored with its words, and retrying
      // it hourly would return the same words.
      const outcome = unknown > 0 ? "partial" : "ok";
      const detail =
        unknown > 0
          ? `${unknown} repositories had a probe reach no answer`
          : undefined;
      deps.store.finishRun(run, outcome, deps.now(), detail);

      log(
        `${LANE} ${installation}: ${covered} covered, ${notCovered} not covered` +
          (unknown > 0 ? `, ${unknown} unknown` : ""),
      );
      return { installation, outcome, covered, notCovered, unknown };
    },
  );
}
