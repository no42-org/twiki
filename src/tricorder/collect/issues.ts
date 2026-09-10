/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { safeLog } from "../../core/log.js";
import { nodeSubject } from "../../core/subject.js";
import type { RepoRef } from "../../core/types.js";
import type { GitHubReadPort, RawIssue } from "../../github/port.js";
import type { RunScope } from "../store/port.js";
import { type LaneRunDeps, withLaneRun } from "./lifecycle.js";
import { nodeTombstones } from "./node-reconcile.js";
import { searchRunDetail } from "./unlisted.js";

// The untriaged-issue lane (CAP-2): open issues nobody has picked up.
//
// "Untriaged" is one observable fact, no:assignee, not a judgement: labels and
// milestones vary per repository, but an issue with an assignee has by
// definition been looked at, and one without has not.

export const LANE = "graphql-issues";

export interface IssueObservation {
  repo: string;
  number: number;
  title: string;
  author: string;
  htmlUrl: string;
  createdAt: string;
}

export interface IssueDeps extends LaneRunDeps {
  github: GitHubReadPort;
  /** The repositories the search is scoped to: exactly the watched set. */
  watchedIn: (installation: string) => readonly RepoRef[];
  isWatched: (repo: RepoRef) => boolean;
}

export interface IssueResult {
  installation: string;
  outcome: "ok" | "partial" | "failed";
  issues: number;
  unreadable: number;
}

export function normaliseIssue(issue: RawIssue) {
  const payload: IssueObservation = {
    repo: `${issue.repo.owner}/${issue.repo.name}`.toLowerCase(),
    number: issue.number,
    title: issue.title,
    author: issue.author,
    htmlUrl: issue.htmlUrl,
    createdAt: issue.createdAt,
  };
  return { subject: nodeSubject("issue", issue.nodeId), payload };
}

/**
 * Collect one organisation's untriaged issues.
 *
 * Nothing throws past this boundary (AD-16), and the same tombstone guards as
 * the PR lane apply: only a full, ok sweep may conclude an issue is triaged or
 * closed, and only for repositories still on the allowlist.
 */
export async function collectIssues(
  deps: IssueDeps,
  installation: string,
  scope: RunScope,
): Promise<IssueResult> {
  const log = safeLog(deps.log);

  return withLaneRun<IssueResult>(
    deps,
    { lane: LANE, installation, scope, reach: "per-installation" },
    { installation, outcome: "failed", issues: 0, unreadable: 0 },
    async (run) => {
      const page = await deps.github.listUntriagedIssues(
        deps.watchedIn(installation),
      );
      // The search already asks only for watched repositories; this second
      // filter is the write-path defence, so a renamed or transferred repo the
      // search echoes back under another name cannot slip into the store.
      const watched = page.issues.filter((issue) => deps.isWatched(issue.repo));
      const observations = watched.map(normaliseIssue);

      // Truncation degrades the run exactly as unreadable nodes do: both mean
      // the result set is incomplete, and a tombstone pass over an incomplete
      // set concludes that every issue it did not see was dealt with.
      // Three ways the result set can be incomplete, all of which must stop
      // the tombstone pass: unreadable nodes, GitHub's search ceiling, and a
      // repository whose qualifier could not fit in any query at all.
      const outcome =
        page.unreadable > 0 || page.truncated || page.unsearchable.length > 0
          ? "partial"
          : "ok";
      // Which repositories went unasked, not how many: the slug is the whole
      // of what the operator can act on. Written by the shared helper both
      // search lanes use, which spells the three clauses identically.
      const detail = searchRunDetail(page, "issue");

      deps.store.recordObservations(run, deps.now(), observations);

      if (scope === "full" && outcome === "ok") {
        const seen = new Set(observations.map((o) => o.subject.key));
        const gone = nodeTombstones(
          deps.store,
          "issue",
          seen,
          installation,
          deps.isWatched,
        );
        if (gone.length > 0) {
          deps.store.recordTombstones(run, deps.now(), gone);
          log(`${LANE} ${installation}: ${gone.length} issues dealt with`);
        }
      }

      deps.store.finishRun(run, outcome, deps.now(), detail);
      log(
        `${LANE} ${installation}: ${observations.length} untriaged issues` +
          `, ${page.issues.length - watched.length} outside the allowlist` +
          (page.unreadable > 0 ? `, ${page.unreadable} unreadable` : ""),
      );
      return {
        installation,
        outcome,
        issues: observations.length,
        unreadable: page.unreadable,
      };
    },
  );
}
