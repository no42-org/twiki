/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { safeLog } from "../../core/log.js";
import { classifyPullRequest } from "../../core/pr-classifier.js";
import { watchKey } from "../../core/slug.js";
import { nodeSubject, pullRequestsSubject } from "../../core/subject.js";
import type { RepoRef } from "../../core/types.js";
import type { GitHubReadPort, RawOpenPullRequest } from "../../github/port.js";
import type { ObservationInput, RunScope } from "../store/port.js";
import { type LaneRunDeps, withLaneRun } from "./lifecycle.js";
import { nodeTombstones } from "./node-reconcile.js";
import { named, searchRunDetail } from "./unlisted.js";

// The plain pull-request lane (#167).
//
// A blocked contributor was invisible: every pull request gitricorder
// collected was a dependency update, so a human waiting on review appeared on
// no page. This lane collects the complement - open pull requests no
// configured bot actor opened - in one search per installation.
//
// Two rules distinguish it from the update-PR lane beside it, and both are
// deliberate:
//
//   The bot actors are EXCLUDED, server-side, with `-author:` qualifiers, so
//   the two searches partition the open pull requests rather than overlapping
//   on them. The classifier below is the write-path defence on that.
//
//   An UNSEARCHABLE repository is an answer rather than a failure. It gets no
//   rows and no confirmation, the run stays `ok`, and every repository the
//   search did cover is confirmed - exactly as the code scanning lane treats
//   a repository GitHub gave it no listing for. `update-prs.ts` and
//   `issues.ts` keep today's behaviour, where an unsearchable repository
//   degrades the whole run; the divergence is stated at all three lanes.
//   Without it, one oversized slug would write no confirmations at all and
//   the whole installation would read `unconfirmed`, which is the blunt
//   behaviour the per-repository confirmations exist to replace.

export const LANE = "graphql-pull-requests";

export interface PullRequestObservation {
  repo: string;
  number: number;
  title: string;
  author: string;
  htmlUrl: string;
  createdAt: string;
  /**
   * The branch the pull request is from, or null where the node carried
   * none.
   *
   * Read by exactly one thing: the queue's `stuck` term, which looks up the
   * retained `pull_request_workflow_run` row for this ref (#161). Null there
   * reads as `checks not observed`, which is the honest answer for a pull
   * request whose head ref we cannot name.
   */
  headRef: string | null;
}

/**
 * Per-repository confirmation: the search covered this repository, and this
 * is what it had.
 *
 * Its own subject type rather than a field on `repository`, for the reason
 * the three security confirmations state: four lanes have four freshnesses
 * and none may vouch for another. Written only for a repository the search
 * actually covered.
 */
export interface RepoPullRequestObservation {
  repo: string;
  openPullRequests: number;
}

export interface PullRequestDeps extends LaneRunDeps {
  github: GitHubReadPort;
  /**
   * The configured bot actors, EXCLUDED from this search rather than
   * required (AD-19). Never a literal, and legitimately empty: with no actor
   * configured as a bot, every open pull request is a human one and this
   * lane collects all of them.
   */
  bots: readonly string[];
  /** The repositories the search is scoped to: exactly the watched set. */
  watchedIn: (installation: string) => readonly RepoRef[];
  isWatched: (repo: RepoRef) => boolean;
}

export interface PullRequestResult {
  installation: string;
  outcome: "ok" | "partial" | "failed";
  prs: number;
  unreadable: number;
  /** Repositories the search could not cover. Never degrades this run. */
  unsearchable: number;
}

export function normalisePullRequest(pr: RawOpenPullRequest): ObservationInput {
  const payload: PullRequestObservation = {
    repo: watchKey(pr.repo),
    number: pr.number,
    title: pr.title,
    author: pr.author,
    htmlUrl: pr.htmlUrl,
    createdAt: pr.createdAt,
    headRef: pr.headRef,
  };
  return { subject: nodeSubject("pull_request", pr.nodeId), payload };
}

/** Summarise one repository's pull requests into its confirmation row. */
export function summarisePullRequests(
  repo: RepoRef,
  prs: readonly RawOpenPullRequest[],
): ObservationInput {
  const slug = watchKey(repo);
  const payload: RepoPullRequestObservation = {
    repo: slug,
    openPullRequests: prs.filter((pr) => watchKey(pr.repo) === slug).length,
  };
  return { subject: pullRequestsSubject(repo), payload };
}

/**
 * Collect one installation's open, non-bot pull requests.
 *
 * Nothing throws past this boundary (AD-16), and the AD-23 tombstone guards
 * apply: only a full, `ok` sweep may conclude a pull request is gone, only
 * for repositories still on the allowlist, and never for a repository the
 * search could not cover.
 */
export async function collectPullRequests(
  deps: PullRequestDeps,
  installation: string,
  scope: RunScope,
): Promise<PullRequestResult> {
  const log = safeLog(deps.log);

  return withLaneRun<PullRequestResult>(
    deps,
    { lane: LANE, installation, scope, reach: "per-installation" },
    {
      installation,
      outcome: "failed",
      prs: 0,
      unreadable: 0,
      unsearchable: 0,
    },
    async (run) => {
      const page = await deps.github.listOpenPullRequests(
        deps.watchedIn(installation),
        deps.bots,
      );
      // The search already asks only for watched repositories; this second
      // filter is the write-path defence, so a renamed or transferred repo
      // the search echoes back under another name cannot slip into the store.
      const watched = page.prs.filter((pr) => deps.isWatched(pr.repo));
      // The classifier is the OTHER write-path defence, and it is the same
      // function the update-PR lane calls (#167). The `-author:` negation is
      // GitHub's reading of the configured logins; this is ours, and the two
      // must not be allowed to disagree silently: a spelling GitHub's
      // qualifier does not match would otherwise file a Dependabot pull
      // request under `pull_request` while the other lane files it under
      // `dependency_update_pr`, which is the "never twice" this story is
      // named for, broken at the collection end.
      const human = watched.filter(
        (pr) => classifyPullRequest(pr.author, deps.bots) === "pull_request",
      );
      const observations = human.map(normalisePullRequest);

      // TWO ways the result set can be incomplete, not the three the other
      // search lanes count: unreadable nodes and GitHub's search ceiling. A
      // repository whose qualifier could not fit any query is handled per
      // repository below - it gets no rows, no confirmation and no
      // tombstones - rather than by holding the whole installation partial.
      const outcome = page.unreadable > 0 || page.truncated ? "partial" : "ok";

      // The unsearchable repositories, by folded slug: the one set that
      // gates both the confirmations and the tombstones below.
      const unsearchable = new Set(
        page.unsearchable.map((u) => watchKey(u.repo)),
      );

      // Two clauses, written separately because they mean different things
      // here. The shared builder reports the conditions that DEGRADE a
      // search run and closes with "nothing tombstoned", which is true of
      // what it reports; the unsearchable repositories are not among them on
      // this lane, so they are named beside it in the shape the REST
      // fan-outs use for a repository they could not speak for.
      const notes = [
        searchRunDetail(
          {
            truncated: page.truncated,
            unreadable: page.unreadable,
            // Empty ON PURPOSE, not forgotten. The shared builder closes
            // with "nothing tombstoned", which is true of the two conditions
            // above and false of an unsearchable repository here: this lane
            // tombstones the rest of the installation normally. They are
            // named in the clause below instead.
            unsearchable: [],
          },
          "PR",
        ),
        page.unsearchable.length > 0
          ? `not searched, no rows and no confirmation: ${named(page.unsearchable)}`
          : null,
      ].filter((n): n is string => n !== undefined && n !== null);
      const detail = notes.length > 0 ? notes.join("; ") : undefined;

      // One confirmation per watched repository the search actually covered,
      // under the same two guards as the tombstone pass - a hot run queried a
      // subset, a partial run could not read everything - plus this lane's
      // own third: a repository nobody could search was never asked, so
      // confirming it would publish a zero for exactly the repository we have
      // no answer for.
      const confirmations =
        scope === "full" && outcome === "ok"
          ? deps
              .watchedIn(installation)
              .filter((repo) => !unsearchable.has(watchKey(repo)))
              .map((repo) => summarisePullRequests(repo, human))
          : [];

      // One transaction: every observation and its projection advance land
      // together, or none do (AD-3).
      deps.store.recordObservations(run, deps.now(), [
        ...observations,
        ...confirmations,
      ]);

      if (scope === "full" && outcome === "ok") {
        const seen = new Set(observations.map((o) => o.subject.key));
        const gone = nodeTombstones(
          deps.store,
          "pull_request",
          seen,
          installation,
          // The allowlist guard, narrowed by this lane's fourth: a row of an
          // unsearchable repository is not absent, it is unasked, and
          // tombstoning it would report a waiting contributor as gone.
          (repo) => deps.isWatched(repo) && !unsearchable.has(watchKey(repo)),
        );
        if (gone.length > 0) {
          deps.store.recordTombstones(run, deps.now(), gone);
          log(`${LANE} ${installation}: ${gone.length} pull requests closed`);
        }
      }

      deps.store.finishRun(run, outcome, deps.now(), detail);
      log(
        `${LANE} ${installation}: ${observations.length} pull requests` +
          `, ${page.prs.length - watched.length} outside the allowlist` +
          `, ${watched.length - human.length} from configured bots` +
          (page.unreadable > 0 ? `, ${page.unreadable} unreadable` : "") +
          (unsearchable.size > 0 ? `, ${unsearchable.size} unsearchable` : ""),
      );
      return {
        installation,
        outcome,
        prs: observations.length,
        unreadable: page.unreadable,
        unsearchable: unsearchable.size,
      };
    },
  );
}
