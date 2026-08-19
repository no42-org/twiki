/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { safeLog } from "../../core/log.js";
import { redact } from "../../core/redact.js";
import { classifyBump, parseDependency } from "../../core/semver.js";
import { nodeSubject } from "../../core/subject.js";
import type { BumpLevel, RepoRef } from "../../core/types.js";
import type { GitHubReadPort, RawUpdatePr } from "../../github/port.js";
import type { RunScope, StorePort } from "../store/port.js";
import { nodeTombstones } from "./node-reconcile.js";

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

export interface UpdatePrDeps {
  github: GitHubReadPort;
  store: StorePort;
  /** Search-qualifier logins from configuration. Never a literal (AD-19). */
  bots: readonly string[];
  /** The repositories the search is scoped to: exactly the watched set. */
  watchedIn: (installation: string) => readonly RepoRef[];
  isWatched: (repo: RepoRef) => boolean;
  now: () => string;
  log: (msg: string) => void;
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
  let run: ReturnType<StorePort["beginRun"]> | null = null;
  const log = safeLog(deps.log);

  try {
    run = deps.store.beginRun({
      lane: LANE,
      installation,
      scope,
      startedAt: deps.now(),
    });

    const page = await deps.github.listOpenUpdatePRs(
      deps.watchedIn(installation),
      deps.bots,
    );
    // The search already asks only for watched repositories; this second
    // filter is the write-path defence, so a renamed or transferred repo the
    // search echoes back under another name cannot slip into the store.
    const watched = page.prs.filter((pr) => deps.isWatched(pr.repo));
    const observations = watched.map(normalisePr);

    // Truncation degrades the run exactly as unreadable nodes do: both mean
    // the result set is incomplete, and a tombstone pass over an incomplete
    // set concludes that every PR it did not see was closed.
    // Three ways the result set can be incomplete, all of which must stop
    // the tombstone pass: unreadable nodes, GitHub's search ceiling, and a
    // repository whose qualifier could not fit in any query at all.
    const outcome =
      page.unreadable > 0 || page.truncated || page.unsearchable > 0
        ? "partial"
        : "ok";
    const detail = page.truncated
      ? "search results truncated at GitHub's ceiling; nothing tombstoned"
      : page.unsearchable > 0
        ? `${page.unsearchable} repositories could not be searched under the configured query; nothing tombstoned`
        : page.unreadable > 0
          ? `${page.unreadable} PR nodes could not be read`
          : undefined;

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
        (page.unreadable > 0 ? `, ${page.unreadable} unreadable` : ""),
    );
    return {
      installation,
      outcome,
      prs: observations.length,
      unreadable: page.unreadable,
    };
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
    return { installation, outcome: "failed", prs: 0, unreadable: 0 };
  }
}
