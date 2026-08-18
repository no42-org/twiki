/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { safeLog } from "../../core/log.js";
import { redact } from "../../core/redact.js";
import { updateStatusSubject } from "../../core/subject.js";
import type { RepoRef } from "../../core/types.js";
import type { GitHubReadPort } from "../../github/port.js";
import type { ObservationInput, RunScope, StorePort } from "../store/port.js";

// What dependabotUpdate says per open alert (CAP-3's stuck criterion).
//
// Its own lane, deliberately not part of the update-PR lane: that lane is
// disabled when no bot actors are configured, and a STUCK update is exactly
// one with no PR to search for. Tying the two together would hide the stuck
// state from anyone who had not configured bots, which is the "silently
// absent" this data exists to prevent.

export const LANE = "graphql-update-status";

export interface UpdateStatusObservation {
  repo: string;
  alertNumber: number;
  /** Null when GitHub is not attempting a fix at all. A fact, not a gap. */
  update: {
    pullRequestNumber: number | null;
    /** Why GitHub could not prepare the update. Null when it could. */
    error: string | null;
  } | null;
}

export interface UpdateStatusDeps {
  github: GitHubReadPort;
  store: StorePort;
  watchedIn: (installation: string) => readonly RepoRef[];
  now: () => string;
  log: (msg: string) => void;
}

export interface UpdateStatusResult {
  installation: string;
  outcome: "ok" | "partial" | "failed";
  statuses: number;
}

/**
 * Collect update statuses for one installation, one GraphQL call per watched
 * repository. Nothing throws past this boundary (AD-16).
 */
export async function collectUpdateStatuses(
  deps: UpdateStatusDeps,
  installation: string,
  scope: RunScope,
): Promise<UpdateStatusResult> {
  let run: ReturnType<StorePort["beginRun"]> | null = null;
  const log = safeLog(deps.log);

  try {
    run = deps.store.beginRun({
      lane: LANE,
      installation,
      scope,
      startedAt: deps.now(),
    });

    const observations: ObservationInput[] = [];
    let failedRepos = 0;
    for (const repo of deps.watchedIn(installation)) {
      try {
        for (const status of await deps.github.listDependabotUpdateStatuses(
          repo,
        )) {
          const payload: UpdateStatusObservation = {
            repo: `${repo.owner}/${repo.name}`.toLowerCase(),
            alertNumber: status.alertNumber,
            update: status.update,
          };
          observations.push({
            subject: updateStatusSubject(repo, status.alertNumber),
            payload,
          });
        }
      } catch (err) {
        // One repository's failure degrades the run; it does not end it.
        failedRepos++;
        log(
          `${LANE} ${installation}: ${repo.owner}/${repo.name} failed, ${redact(
            err instanceof Error ? err.message : String(err),
          )}`,
        );
      }
    }

    deps.store.recordObservations(run, deps.now(), observations);

    // Reconcile closed alerts' statuses away, under the same guards as every
    // other lane: full scope, clean outcome, and only rows this sweep was
    // authoritative for. Status keys are owner/name#number, so the
    // per-installation read works by key prefix. That read looks redundant
    // with the watchedSlugs filter below, whose slugs are owner-prefixed by
    // construction, and today it is: it stays as the store-level bound AD-16
    // asks for, so a future change to watchedIn cannot silently widen what
    // one installation's sweep may conclude about another's rows.
    const outcome = failedRepos > 0 ? "partial" : "ok";
    if (scope === "full" && outcome === "ok") {
      const seen = new Set(observations.map((o) => o.subject.key));
      const watchedSlugs = new Set(
        deps
          .watchedIn(installation)
          .map((r) => `${r.owner}/${r.name}`.toLowerCase()),
      );
      const gone = deps.store
        .currentByTypeForOwner("dependabot_update_status", installation)
        .filter((c) => c.state === "present")
        .filter((c) => !seen.has(c.subject.key))
        .filter((c) => watchedSlugs.has(c.subject.key.split("#")[0] ?? ""))
        .map((c) => c.subject);
      if (gone.length > 0) {
        deps.store.recordTombstones(run, deps.now(), gone);
      }
    }

    deps.store.finishRun(
      run,
      outcome,
      deps.now(),
      failedRepos > 0 ? `${failedRepos} repositories failed` : undefined,
    );
    log(`${LANE} ${installation}: ${observations.length} update statuses`);
    return { installation, outcome, statuses: observations.length };
  } catch (err) {
    const detail = redact(err instanceof Error ? err.message : String(err));
    if (run) {
      try {
        deps.store.finishRun(run, "failed", deps.now(), detail);
      } catch {
        // The store is what failed. Nothing further to record.
      }
    }
    log(`${LANE} ${installation}: failed, ${detail}`);
    return { installation, outcome: "failed", statuses: 0 };
  }
}
