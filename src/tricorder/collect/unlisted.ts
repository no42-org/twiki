/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { repoSlug } from "../../core/types.js";
import type { UnlistedRepo } from "../../github/port.js";

/**
 * What a run detail says where the port supplied no reason at all.
 *
 * Says nothing about who was asked, on purpose. On the REST fan-outs GitHub
 * answered and sent no message; on the search lanes the repository was never
 * asked about, because its qualifier did not fit a query. One shared helper
 * must not blame GitHub for a repository it never saw.
 */
const NO_REASON = "no reason recorded";

/**
 * How many repositories one clause names before it stops counting them out.
 *
 * The detail is stored in `collection_run.detail` and rendered untruncated
 * into a health-table cell, and every one of these lists can in principle
 * hold the whole allowlist at once: a query base too long to carry any
 * repository puts every watched repository in `unsearchable` on the same
 * sweep. Naming ten and counting the rest keeps the cell readable while
 * still saying how big the problem is.
 */
const MAX_NAMED = 10;

/** `a, b, c and 4 more`, so one pathological sweep cannot fill the cell. */
function capped(parts: readonly string[]): string {
  if (parts.length <= MAX_NAMED) return parts.join(", ");
  return `${parts.slice(0, MAX_NAMED).join(", ")} and ${parts.length - MAX_NAMED} more`;
}

/**
 * The repositories a sweep could not speak for, each with what came back
 * from it, for a lane whose reasons differ per repository.
 *
 * One helper rather than one per lane: `code-scanning.ts` and
 * `secret-scanning.ts` each held an identical copy of these three lines,
 * and the two search lanes would otherwise have written a third and a
 * fourth.
 *
 * The reason is whatever the port put there and never one a lane invents.
 * The REST refusals differ per repository (`no analysis found`, `Resource
 * not accessible by integration`, an Advanced Security message), and a
 * detail that named one of them for all of them would send the operator to
 * the wrong setting - which is why each is quoted beside its own slug here
 * rather than stated once.
 *
 * The slug keeps GitHub's own casing (`repoSlug`, not `watchKey`): folded,
 * `no42-org/CoolModFiles` reads as a repository that does not exist, and an
 * operator following it goes looking for the wrong thing.
 */
export function named(repos: readonly UnlistedRepo[]): string {
  return capped(
    repos.map((r) => `${repoSlug(r.repo)} (${r.reason ?? NO_REASON})`),
  );
}

/**
 * One clause per distinct reason, with the cause stated ONCE and the
 * repositories listed after it.
 *
 * Unlike the REST fan-outs, a search has exactly one way to leave a
 * repository out - its own qualifier cannot share a query with the base -
 * so every entry carries the same ~95-character sentence. Repeating it per
 * repository would fill the health-table cell with one invariant sentence
 * and bury the slugs, which are the only part that differs and the only
 * part the operator can act on.
 */
function unsearchableNotes(repos: readonly UnlistedRepo[]): string[] {
  const byReason = new Map<string, string[]>();
  for (const r of repos) {
    const reason = r.reason ?? NO_REASON;
    const slugs = byReason.get(reason);
    if (slugs) slugs.push(repoSlug(r.repo));
    else byReason.set(reason, [repoSlug(r.repo)]);
  }
  return [...byReason].map(
    ([reason, slugs]) =>
      `repositories that could not be searched (${reason}): ${capped(slugs)}`,
  );
}

/** The parts of a search page a run detail is written from. */
interface SearchSweep {
  truncated: boolean;
  unreadable: number;
  /**
   * REQUIRED, deliberately, even though one lane always passes an empty
   * array.
   *
   * `update-prs.ts` and `issues.ts` degrade on an unsearchable repository,
   * so it belongs in the same sentence as the other two shortfalls and under
   * the same trailing "nothing tombstoned". `pull-requests.ts` treats it as
   * an answer about those repositories - no rows, no confirmation, no
   * tombstones, run still `ok` - so putting it here would make that clause
   * say the opposite of what happened, and it names them itself through
   * `named()` (#167).
   *
   * Making the field optional for that one lane was the obvious move and the
   * wrong one: it removes the compile-time demand that a search lane say
   * what it could not cover, and a future lane that simply forgot would then
   * be indistinguishable from this deliberate omission. It stays required,
   * and the one lane that reports them elsewhere passes `[]` at a call site
   * that says why.
   */
  unsearchable: readonly UnlistedRepo[];
}

/**
 * The run detail a search lane writes, given the word for what a node is in
 * that lane.
 *
 * Shared because the lanes wrote it identically: the same ways a search can
 * fall short, in the same order, differing only in `PR nodes` against `issue
 * nodes`. One clause per way, because they can happen together and an
 * operator reading only the first would act on half the problem.
 *
 * Every condition REPORTED HERE is one that makes the caller's outcome
 * partial, so a detail exists precisely when nothing may be tombstoned, and
 * the trailing clause is said once rather than per note. The lane for which
 * an unsearchable repository is an ANSWER rather than a failure therefore
 * passes an empty `unsearchable` and names those repositories beside this
 * sentence instead of inside it - explicitly, at a call site that says so,
 * because the field stays required.
 */
export function searchRunDetail(
  sweep: SearchSweep,
  node: string,
): string | undefined {
  const notes = [
    sweep.truncated ? "search results truncated at GitHub's ceiling" : null,
    ...unsearchableNotes(sweep.unsearchable),
    sweep.unreadable > 0
      ? `${sweep.unreadable} ${node} nodes could not be read`
      : null,
  ].filter((n): n is string => n !== null);
  return notes.length > 0
    ? `${notes.join("; ")}; nothing tombstoned`
    : undefined;
}
