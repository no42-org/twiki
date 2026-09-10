/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { SubjectType } from "./subject.js";

// Which kind one pull request is, decided once (AD-19, #167).
//
// Two lanes collect pull requests and they must partition them: a pull
// request the update-PR lane files under `dependency_update_pr` must not also
// reach the plain lane's `pull_request`, or one contributor's work appears
// twice in the queue under two headings. The partition is a single predicate
// here rather than two search qualifiers that happen to be complements,
// because search qualifiers are GitHub's semantics and this is ours.
//
// There is NO BOT LOGIN LITERAL in this file, and there must never be one.
// The actors are configuration: `bots:` in repos.yaml, passed through from
// the loaded config to both lanes. Adding Renovate to that list makes its
// pull requests classify as dependency updates with no code change here, and
// removing every entry makes every pull request a human one - which is the
// honest reading, because nothing is then configured to be a bot.

/**
 * One actor's login, reduced to what the three spellings have in common.
 *
 * The same bot appears under three names, none of which this system chose:
 *
 *   `app/dependabot`     what a search qualifier wants, and what repos.yaml
 *                        carries, because `bots:` is written for the search
 *   `dependabot`         GraphQL's `author { login }` on some payloads
 *   `dependabot[bot]`    the login REST and most GraphQL payloads carry
 *
 * Comparing any two of them raw answers "different actor", which would file
 * every Dependabot pull request under both kinds at once. Folded here, once,
 * so the config's spelling and the payload's spelling are one value.
 *
 * Case is folded too: GitHub logins are case-insensitive, and a config
 * saying `app/Dependabot` names the same actor as a payload saying
 * `dependabot[bot]`.
 */
export function normaliseActor(login: string): string {
  const trimmed = login.trim().toLowerCase();
  // The prefix, then the suffix, because one login can carry both: nothing
  // stops `app/dependabot[bot]` being written into repos.yaml, and it names
  // the actor the other two spellings name.
  const withoutApp = trimmed.startsWith("app/") ? trimmed.slice(4) : trimmed;
  return withoutApp.endsWith("[bot]")
    ? withoutApp.slice(0, -"[bot]".length)
    : withoutApp;
}

/**
 * Whether this author is one of the configured dependency-update actors.
 *
 * An empty `bots` answers false for everyone, and that is the whole of the
 * empty-configuration behaviour: no actor is a bot, so every pull request is
 * a human one. The entrypoint says so loudly, because "no update PRs" and
 * "nobody told us which actors are bots" must not be the same picture
 * (AD-19, AD-28).
 */
export function isConfiguredBot(
  author: string,
  bots: readonly string[],
): boolean {
  const actor = normaliseActor(author);
  // Folded on both sides, at every call: the config is user-authored and the
  // payload is GitHub's, and neither may be trusted to have used the other's
  // spelling.
  return bots.some((bot) => normaliseActor(bot) === actor);
}

/**
 * The subject type one pull request belongs under, given the configured bot
 * actors.
 *
 * A total function over two types, so the two lanes cannot both claim a pull
 * request and cannot both decline it. Each lane calls it and keeps what it
 * owns; the queue enforces the same partition a second time over the ROWS,
 * because a lane that stops running leaves its rows behind and nothing
 * tombstones them (#167).
 */
export function classifyPullRequest(
  author: string,
  bots: readonly string[],
): Extract<SubjectType, "dependency_update_pr" | "pull_request"> {
  return isConfiguredBot(author, bots)
    ? "dependency_update_pr"
    : "pull_request";
}
