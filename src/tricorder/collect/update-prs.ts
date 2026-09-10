/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { safeLog } from "../../core/log.js";
import { classifyPullRequest } from "../../core/pr-classifier.js";
import { classifyBump, parseDependency } from "../../core/semver.js";
import { nodeSubject } from "../../core/subject.js";
import type { BumpLevel, RepoRef } from "../../core/types.js";
import type { GitHubReadPort, RawUpdatePr } from "../../github/port.js";
import type { RunScope } from "../store/port.js";
import { type LaneRunDeps, withLaneRun } from "./lifecycle.js";
import { nodeTombstones } from "./node-reconcile.js";
import { searchRunDetail } from "./unlisted.js";

// The dependency-update PR lane (CAP-3).
//
// Both bots in one list is the capability the research found nothing else in
// the field delivers. The bots are configuration (AD-19): the search runs on
// whatever logins repos.yaml names, no bot literal exists in this file, and
// adding Renovate to the config makes its PRs appear with no code change.

export const LANE = "graphql-update-prs";

export interface UpdatePrObservation {
  repo: string;
  number: number;
  title: string;
  author: string;
  htmlUrl: string;
  createdAt: string;
  /** From the title's package name, when the title parses. */
  packageName: string | null;
  /**
   * The semver bump the update applies, or null when the title does not say.
   *
   * Null, never a guess: Renovate's title format carries no from-version, and
   * classifying a bump we cannot see would put a confident size on every one
   * of its PRs. Unknown ranks above patch and below minor, which is honest.
   */
  bump: BumpLevel | null;
}

export interface UpdatePrDeps extends LaneRunDeps {
  github: GitHubReadPort;
  /** Search-qualifier logins from configuration. Never a literal (AD-19). */
  bots: readonly string[];
  /** The repositories the search is scoped to: exactly the watched set. */
  watchedIn: (installation: string) => readonly RepoRef[];
  isWatched: (repo: RepoRef) => boolean;
}

export interface UpdatePrResult {
  installation: string;
  outcome: "ok" | "partial" | "failed";
  prs: number;
  unreadable: number;
}

/** Title to bump level, only when the title actually carries both versions. */
export function bumpFromTitle(title: string): {
  packageName: string | null;
  bump: BumpLevel | null;
} {
  const dep = parseDependency(title);
  if (!dep?.name) {
    // Renovate's format: "chore(deps): update dependency esbuild to v0.21.0".
    // No from-version, so the bump stays unknown, but the package NAME is
    // right there, and dropping it silently severed the alert-risk join for
    // one of the two bots the README promises to cover.
    const renovate = title.match(/update (?:dependency\s+)?(\S+)\s+to\s+\S+/i);
    return { packageName: renovate?.[1] ?? null, bump: null };
  }
  if (!dep.from || !dep.to) return { packageName: dep.name, bump: null };
  const bump = classifyBump(dep.from, dep.to, dep.name);
  // Indeterminate means classifyBump could not read the versions. That is
  // unknown, not major: major is a claim the ranking chain acts on.
  return {
    packageName: dep.name,
    bump: bump.indeterminate ? null : bump.level,
  };
}

export function normalisePr(pr: RawUpdatePr) {
  const { packageName, bump } = bumpFromTitle(pr.title);
  const payload: UpdatePrObservation = {
    repo: `${pr.repo.owner}/${pr.repo.name}`.toLowerCase(),
    number: pr.number,
    title: pr.title,
    author: pr.author,
    htmlUrl: pr.htmlUrl,
    createdAt: pr.createdAt,
    packageName,
    bump,
  };
  return { subject: nodeSubject("dependency_update_pr", pr.nodeId), payload };
}

/**
 * Collect one organisation's open update PRs.
 *
 * Nothing throws past this boundary (AD-16), and the same tombstone guards as
 * the alert lane apply: only a full, ok sweep may conclude a PR is gone, and
 * only for repositories still on the allowlist.
 */
export async function collectUpdatePRs(
  deps: UpdatePrDeps,
  installation: string,
  scope: RunScope,
): Promise<UpdatePrResult> {
  const log = safeLog(deps.log);

  return withLaneRun<UpdatePrResult>(
    deps,
    { lane: LANE, installation, scope, reach: "per-installation" },
    { installation, outcome: "failed", prs: 0, unreadable: 0 },
    async (run) => {
      const page = await deps.github.listOpenUpdatePRs(
        deps.watchedIn(installation),
        deps.bots,
      );
      // The search already asks only for watched repositories; this second
      // filter is the write-path defence, so a renamed or transferred repo the
      // search echoes back under another name cannot slip into the store.
      const watched = page.prs.filter((pr) => deps.isWatched(pr.repo));
      // The classifier, which is NEW behaviour for this lane (#167): it used
      // to pass `bots` to the search as `author:` qualifiers and never look
      // at an author again. It looks now because the plain pull-request lane
      // beside it collects the complement, and the two searches must
      // partition the open pull requests rather than each deciding for
      // itself what a bot is. One function, called by both, so GitHub's
      // reading of a configured login and ours cannot drift apart silently.
      //
      // It rejects nothing GitHub's own `author:` qualifier accepted, on
      // every spelling measured on this estate: `app/dependabot` in config
      // against `dependabot[bot]` in the payload folds to one actor. A
      // rejection here is therefore a disagreement worth logging, not a
      // routine filter.
      const bots = watched.filter(
        (pr) =>
          classifyPullRequest(pr.author, deps.bots) === "dependency_update_pr",
      );
      const observations = bots.map(normalisePr);

      // Truncation degrades the run exactly as unreadable nodes do: both mean
      // the result set is incomplete, and a tombstone pass over an incomplete
      // set concludes that every PR it did not see was closed.
      // Three ways the result set can be incomplete, all of which must stop
      // the tombstone pass: unreadable nodes, GitHub's search ceiling, and a
      // repository whose qualifier could not fit in any query at all.
      //
      // The third is where this lane DIVERGES from `pull-requests.ts`, which
      // shares its search shape and its `unsearchable` field (#167). That
      // lane treats an unsearchable repository as an answer about that
      // repository - no rows, no confirmation, no tombstones - and keeps the
      // run `ok`, because it writes a per-repository confirmation and can
      // therefore withhold one. This lane writes none: it has nothing
      // per-repository to withhold, so the only honest way to say "the
      // answer is incomplete" is to degrade the whole run. The divergence is
      // deliberate and is stated at both lanes rather than looking like one
      // of them forgot.
      const outcome =
        page.unreadable > 0 || page.truncated || page.unsearchable.length > 0
          ? "partial"
          : "ok";
      // Which repositories went unasked, not how many: the slug is the whole
      // of what the operator can act on. Written by the shared helper both
      // search lanes use, which spells the three clauses identically.
      const detail = searchRunDetail(page, "PR");

      deps.store.recordObservations(run, deps.now(), observations);

      if (scope === "full" && outcome === "ok") {
        const seen = new Set(observations.map((o) => o.subject.key));
        const gone = nodeTombstones(
          deps.store,
          "dependency_update_pr",
          seen,
          installation,
          deps.isWatched,
        );
        if (gone.length > 0) {
          deps.store.recordTombstones(run, deps.now(), gone);
          log(`${LANE} ${installation}: ${gone.length} PRs closed`);
        }
      }

      deps.store.finishRun(run, outcome, deps.now(), detail);
      log(
        `${LANE} ${installation}: ${observations.length} update PRs` +
          `, ${page.prs.length - watched.length} outside the allowlist` +
          (watched.length - bots.length > 0
            ? `, ${watched.length - bots.length} whose author is not a configured bot`
            : "") +
          (page.unreadable > 0 ? `, ${page.unreadable} unreadable` : ""),
      );
      return {
        installation,
        outcome,
        prs: observations.length,
        unreadable: page.unreadable,
      };
    },
  );
}
