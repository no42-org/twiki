/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { CoverageState } from "../../core/coverage.js";
import { coverageSubject } from "../../core/subject.js";
import type { RepoRef } from "../../core/types.js";
import { repoSlug } from "../../core/types.js";
import type { GitHubReadPort } from "../../github/port.js";
import type { ObservationInput, RunScope, StorePort } from "../store/port.js";

// The coverage lane (AD-28).
//
// Absence from an org alert sweep is not evidence of health: the identical
// absence is produced by a clean repository, one with alerts switched off, one
// outside the installation, and one archived. Measured on one real
// organisation, 14 of 36 repositories were in the second category, so this is
// not an edge case.
//
// Cheap facts first. One call per 100 repositories gives `archived` and
// `disabled` for the whole organisation. Only what that cannot answer, whether
// Dependabot is actually watching, costs a call per repository, which is why
// this lane runs daily rather than on the sweep cadence (AD-15).

export const LANE = "coverage";

export interface CoverageObservation {
  repo: string;
  state: CoverageState;
}

export interface CoverageDeps {
  github: GitHubReadPort;
  store: StorePort;
  watchedIn: (installation: string) => readonly RepoRef[];
  now: () => string;
  log: (msg: string) => void;
}

export interface CoverageResult {
  installation: string;
  outcome: "ok" | "partial" | "failed";
  /** Repositories confirmed as genuinely watched. */
  covered: number;
  /** Repositories that cannot produce a real count, whatever the reason. */
  notCovered: number;
  /** Probes whose answer we did not recognise. Non-zero forces a partial run. */
  unknown: number;
}

/** Decide one repository's coverage from the cheap facts plus the probe. */
export function decideCoverage(
  meta: { archived: boolean; disabled: boolean } | undefined,
  probe:
    | CoverageState
    | "covered"
    | "alerts_disabled"
    | "unreachable"
    | "unknown",
): CoverageState {
  // Archived wins over everything the probe can say. An archived repository may
  // still answer 200 with old alerts, and reporting it as covered would promise
  // that something is watching a repository nothing can update.
  if (meta?.archived) return "archived";
  // GitHub's `disabled` is about the repository itself, for billing, DMCA or
  // abuse. It is not a missing installation and must not be reported as one.
  if (meta?.disabled) return "repo_disabled";
  return probe;
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
  let run: ReturnType<StorePort["beginRun"]> | null = null;

  try {
    run = deps.store.beginRun({
      lane: LANE,
      installation,
      scope,
      startedAt: deps.now(),
    });

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
      // The probe is the only thing that can tell us the feature is off, so it
      // is worth its call. Skipped when the cheap facts already settle it.
      const probe =
        meta?.archived || meta?.disabled
          ? "unknown"
          : await deps.github.probeDependabotAccess(repo);
      const state = decideCoverage(meta, probe);

      if (state === "covered") covered++;
      else notCovered++;

      if (state === "unknown") {
        unknown++;
        // Do not overwrite what we already knew with what we failed to learn.
        // A rate-limited probe returns an unrecognised 403, and persisting that
        // over a good `covered` would blank a correct alert count until the
        // next successful run. The alert lane already refuses to write a
        // confirmation it cannot back; this is the same rule.
        if (deps.store.current(coverageSubject(repo)) !== null) continue;
      }

      const payload: CoverageObservation = { repo: slug, state };
      observations.push({ subject: coverageSubject(repo), payload });
    }

    deps.store.recordObservations(run, deps.now(), observations);

    // An unrecognised probe answer means we do not know this repository's
    // coverage, and a lane that reports `ok` while holding unknowns would let
    // the page treat them as settled.
    const outcome = unknown > 0 ? "partial" : "ok";
    const detail =
      unknown > 0
        ? `${unknown} repositories returned an unrecognised answer`
        : undefined;
    deps.store.finishRun(run, outcome, deps.now(), detail);

    deps.log(
      `${LANE} ${installation}: ${covered} covered, ${notCovered} not covered` +
        (unknown > 0 ? `, ${unknown} unknown` : ""),
    );
    return { installation, outcome, covered, notCovered, unknown };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    if (run) {
      try {
        deps.store.finishRun(run, "failed", deps.now(), detail);
      } catch {
        // The store is what failed. Nothing further to record.
      }
    }
    deps.log(`${LANE} ${installation}: failed, ${detail}`);
    return {
      installation,
      outcome: "failed",
      covered: 0,
      notCovered: 0,
      unknown: 0,
    };
  }
}
