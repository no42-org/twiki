/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { safeLog } from "../../core/log.js";
import { redact } from "../../core/redact.js";
import type {
  ReleaseEvidence,
  ReleaseReadFailure,
} from "../../core/release-worthy.js";
import { releaseSubject } from "../../core/subject.js";
import type { RepoRef } from "../../core/types.js";
import type { GitHubReadPort } from "../../github/port.js";
import type { ObservationInput, RunOutcome, RunScope } from "../store/port.js";
import { type LaneRunDeps, withLaneRun } from "./lifecycle.js";

// What each watched repository has shipped since its latest tag (#196).
//
// The lane stores the evidence and nothing else. Whether that evidence is
// worth a release is judged at read time by core/release-worthy.ts, so a rule
// change needs no recollection.

export const LANE = "rest-release-readiness";

export interface ReleaseReadinessDeps extends LaneRunDeps {
  github: GitHubReadPort;
  watchedIn: (installation: string) => readonly RepoRef[];
  /** False for a repository repos.yaml opted out with `release: false`. */
  releaseTracked: (repo: RepoRef) => boolean;
  defaultBranchOf: (repo: RepoRef) => string;
}

export interface ReleaseReadinessResult {
  installation: string;
  outcome: RunOutcome;
  repos: number;
}

/**
 * Collect release evidence for one installation's tracked repositories.
 * Nothing throws past this boundary (AD-16).
 */
export async function collectReleaseReadiness(
  deps: ReleaseReadinessDeps,
  installation: string,
  scope: RunScope,
): Promise<ReleaseReadinessResult> {
  const log = safeLog(deps.log);

  return withLaneRun<ReleaseReadinessResult>(
    deps,
    { lane: LANE, installation, scope, reach: "per-installation" },
    { installation, outcome: "failed", repos: 0 },
    async (run) => {
      const tracked = deps
        .watchedIn(installation)
        .filter((repo) => deps.releaseTracked(repo));
      const observations: ObservationInput[] = [];
      let failedRepos = 0;
      for (const repo of tracked) {
        try {
          const tag = await deps.github.latestTag(repo);
          const since = await deps.github.unreleasedCommits(
            repo,
            tag,
            deps.defaultBranchOf(repo),
          );
          const fixedAlerts = await deps.github.listFixedDependabotAlerts(repo);
          const payload: ReleaseEvidence = {
            tag,
            tagDate: since.tagDate,
            commits: since.commits,
            truncated: since.truncated,
            fixedAlerts,
          };
          observations.push({ subject: releaseSubject(repo), payload });
        } catch (err) {
          // One repository's failure degrades the run; it does not end it.
          // Its row says why, so it reads unconfirmed on its own and its
          // siblings keep their readings.
          failedRepos++;
          const reason = redact(
            err instanceof Error ? err.message : String(err),
          );
          const payload: ReleaseReadFailure = { readFailed: reason };
          observations.push({ subject: releaseSubject(repo), payload });
          log(
            `${LANE} ${installation}: ${repo.owner}/${repo.name} failed, ${reason}`,
          );
        }
      }

      deps.store.recordObservations(run, deps.now(), observations);

      // A row goes when its repository left the allowlist or opted out, and
      // only on a clean full sweep. A partial sweep also writes a row for
      // every tracked repository, a failed read included, but a retraction is
      // kept off any run that failed somewhere. On a clean sweep every
      // tracked repository was observed, so "not seen" is exactly "no longer
      // watched or no longer tracked".
      const outcome: RunOutcome = failedRepos > 0 ? "partial" : "ok";
      if (scope === "full" && outcome === "ok") {
        const seen = new Set(observations.map((o) => o.subject.key));
        const gone = deps.store
          .currentByTypeForOwner("release_readiness", installation)
          .filter((c) => c.state === "present")
          .filter((c) => !seen.has(c.subject.key))
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
      const read = observations.length - failedRepos;
      log(`${LANE} ${installation}: ${read} repositories`);
      return { installation, outcome, repos: read };
    },
  );
}
