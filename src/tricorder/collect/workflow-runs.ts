/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { safeLog } from "../../core/log.js";
import { redact } from "../../core/redact.js";
import { nodeSubject } from "../../core/subject.js";
import type { RepoRef } from "../../core/types.js";
import {
  type GitHubReadPort,
  type RawWorkflowRun,
  workflowRunsUrl,
} from "../../github/port.js";
import type { ObservationInput, RunScope, StorePort } from "../store/port.js";

// The Actions lane (CAP: build failures), story 15's shape: one installation,
// one REST call per watched repository, and the real cost written down.
//
// This is the lane the spine prices at a hard per-repo floor (AD-15: no org
// variant of the endpoint exists, and GraphQL's WorkflowRun carries no
// status), which makes it the lane where the AD-25 validator cache matters
// most: a quiet repository answers 304, which is free.

export const LANE = "rest-actions-runs";

export interface WorkflowRunObservation {
  repo: string;
  workflowId: number;
  workflowName: string;
  runNumber: number;
  status: string;
  conclusion: string | null;
  headBranch: string | null;
  event: string;
  htmlUrl: string;
  createdAt: string;
}

export interface ActionsDeps {
  github: GitHubReadPort;
  store: StorePort;
  watchedIn: (installation: string) => readonly RepoRef[];
  now: () => string;
  log: (msg: string) => void;
}

export interface ActionsResult {
  installation: string;
  outcome: "ok" | "partial" | "failed";
  /** Latest runs stored or confirmed this sweep. */
  runs: number;
  unreadable: number;
  /** GitHub calls this sweep actually made, 304s included. The measurement. */
  calls: number;
}

/**
 * The newest run per workflow, from one newest-first page.
 *
 * The page is a 100-run window, so a workflow whose last run predates the
 * window simply does not appear; that is a fact about the window, not about
 * the workflow, and nothing downstream may treat its absence as "gone".
 */
export function latestPerWorkflow(
  runs: readonly RawWorkflowRun[],
): RawWorkflowRun[] {
  const seen = new Set<number>();
  const latest: RawWorkflowRun[] = [];
  for (const run of runs) {
    if (seen.has(run.workflowId)) continue;
    seen.add(run.workflowId);
    latest.push(run);
  }
  return latest;
}

export function normaliseRun(run: RawWorkflowRun): ObservationInput {
  const payload: WorkflowRunObservation = {
    repo: `${run.repo.owner}/${run.repo.name}`.toLowerCase(),
    workflowId: run.workflowId,
    workflowName: run.workflowName,
    runNumber: run.runNumber,
    status: run.status,
    conclusion: run.conclusion,
    headBranch: run.headBranch,
    event: run.event,
    htmlUrl: run.htmlUrl,
    createdAt: run.createdAt,
  };
  return { subject: nodeSubject("workflow_run", run.nodeId), payload };
}

/**
 * Collect the latest workflow run per workflow for one installation's
 * watched repositories. Nothing throws past this boundary (AD-16); one
 * repository's failure degrades the run to partial, never ends it.
 *
 * Tombstoning is by SUPERSESSION, not window absence (AD-23): a stored run
 * leaves current state only when a newer run of the same workflow in the
 * same repository was actually observed. A workflow absent from the 100-run
 * window is a fact about the window, and treating it as "gone" would
 * tombstone every dormant workflow's last known state.
 */
export async function collectWorkflowRuns(
  deps: ActionsDeps,
  installation: string,
  scope: RunScope,
): Promise<ActionsResult> {
  let run: ReturnType<StorePort["beginRun"]> | null = null;
  const log = safeLog(deps.log);

  try {
    run = deps.store.beginRun({
      lane: LANE,
      installation,
      scope,
      startedAt: deps.now(),
    });

    // Stored present runs for this installation, grouped by repo slug, read
    // once. Node keys carry no owner, so the payload answers (AD-23).
    const storedByRepo = new Map<
      string,
      { key: string; workflowId: number }[]
    >();
    for (const c of deps.store.currentByType("workflow_run")) {
      if (c.state !== "present") continue;
      const p = c.payload as WorkflowRunObservation | undefined;
      if (typeof p?.repo !== "string" || typeof p.workflowId !== "number") {
        continue;
      }
      const list = storedByRepo.get(p.repo) ?? [];
      list.push({ key: c.subject.key, workflowId: p.workflowId });
      storedByRepo.set(p.repo, list);
    }

    const observations: ObservationInput[] = [];
    const confirmed: { type: "workflow_run"; key: string }[] = [];
    const gone: { type: "workflow_run"; key: string }[] = [];
    let unreadable = 0;
    let calls = 0;
    let failedRepos = 0;

    for (const repo of deps.watchedIn(installation)) {
      const slug = `${repo.owner}/${repo.name}`.toLowerCase();
      const url = workflowRunsUrl(repo);
      try {
        calls++;
        const page = await deps.github.listRepoWorkflowRuns(
          repo,
          deps.store.loadValidator(installation, url),
        );

        if (page.notModified) {
          // Nothing changed since the sweep that stored these rows: the
          // stored latest runs are still the latest. Confirm, free.
          for (const s of storedByRepo.get(slug) ?? []) {
            confirmed.push({ type: "workflow_run", key: s.key });
          }
          if (page.validator) {
            deps.store.saveValidator(
              installation,
              url,
              page.validator,
              deps.now(),
            );
          }
          continue;
        }

        unreadable += page.unreadable;
        const latest = latestPerWorkflow(page.runs);
        observations.push(...latest.map(normaliseRun));

        // Supersession: a stored run of a workflow we just observed a
        // DIFFERENT latest run for has been replaced. Same-key rows are
        // updates, not replacements, and stay.
        const latestKeys = new Set(latest.map((r) => r.nodeId));
        const observedWorkflows = new Set(latest.map((r) => r.workflowId));
        if (page.unreadable === 0) {
          for (const s of storedByRepo.get(slug) ?? []) {
            if (observedWorkflows.has(s.workflowId) && !latestKeys.has(s.key)) {
              gone.push({ type: "workflow_run", key: s.key });
            }
          }
        }

        // Save-or-purge, exactly as the alert lane (AD-25): a 200 that
        // rewrote rows without earning a validator must not leave the old
        // one describing a listing that no longer matches stored state.
        if (page.unreadable === 0 && page.validator) {
          deps.store.saveValidator(
            installation,
            url,
            page.validator,
            deps.now(),
          );
        } else {
          deps.store.deleteValidator(installation, url);
        }
      } catch (err) {
        // The repository's stored rows were not rewritten, so its stored
        // validator still describes stored state: left alone, like the rows.
        failedRepos++;
        log(
          `${LANE} ${installation}: ${slug} failed, ${redact(
            err instanceof Error ? err.message : String(err),
          )}`,
        );
      }
    }

    deps.store.recordObservations(run, deps.now(), observations);
    if (confirmed.length > 0) {
      deps.store.touchVerified(confirmed, deps.now());
    }
    if (gone.length > 0) {
      deps.store.recordTombstones(run, deps.now(), gone);
    }

    const outcome = failedRepos > 0 || unreadable > 0 ? "partial" : "ok";
    const detail =
      failedRepos > 0
        ? `${failedRepos} repositories failed`
        : unreadable > 0
          ? `${unreadable} run payloads could not be read`
          : undefined;
    deps.store.finishRun(run, outcome, deps.now(), detail);

    const runsSeen = observations.length + confirmed.length;
    log(
      `${LANE} ${installation}: ${runsSeen} latest runs across ` +
        `${deps.watchedIn(installation).length} repositories, ${calls} calls` +
        (gone.length > 0 ? `, ${gone.length} superseded` : "") +
        (unreadable > 0 ? `, ${unreadable} unreadable` : ""),
    );
    return { installation, outcome, runs: runsSeen, unreadable, calls };
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
    return {
      installation,
      outcome: "failed",
      runs: 0,
      unreadable: 0,
      calls: 0,
    };
  }
}
