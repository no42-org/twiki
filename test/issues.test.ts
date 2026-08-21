/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  issueSearchQueries,
  SEARCH_QUERY_MAX,
  searchQueries,
} from "../src/github/octokit-adapter.js";
import { collectIssues, LANE } from "../src/tricorder/collect/issues.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { FakeGitHubReadPort, makeRawIssue } from "./fakes.js";

describe("the untriaged-issue lane (CAP-2)", () => {
  let dir: string;
  let store: SqliteStore;
  let github: FakeGitHubReadPort;
  let logs: string[];
  let clock: number;
  let watched: Set<string>;

  const deps = () => ({
    github,
    store,
    watchedIn: (installation: string) =>
      [...watched]
        .map((slug) => {
          const [owner = "", name = ""] = slug.split("/");
          return { owner, name };
        })
        .filter((r) => r.owner.toLowerCase() === installation),
    isWatched: (repo: { owner: string; name: string }) =>
      watched.has(`${repo.owner}/${repo.name}`.toLowerCase()),
    now: () => new Date(Date.UTC(2026, 7, 18, 12, clock++)).toISOString(),
    log: (m: string) => logs.push(m),
  });

  const current = () =>
    store.currentByType("issue").filter((c) => c.state === "present");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "issues-"));
    store = SqliteStore.openForWrite(join(dir, "i.db"));
    github = new FakeGitHubReadPort(new Map());
    logs = [];
    clock = 0;
    watched = new Set(["no42-org/twiki"]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores an issue keyed by node id", async () => {
    github.issues.set("no42-org", [makeRawIssue({ number: 7 })]);

    const r = await collectIssues(deps(), "no42-org", "full");

    expect(r).toMatchObject({ outcome: "ok", issues: 1 });
    const [row] = current();
    expect(row?.subject.key).toBe("I_7");
    expect(row?.payload).toMatchObject({
      repo: "no42-org/twiki",
      number: 7,
      title: "Crash on startup",
    });
  });

  it("drops issues outside the allowlist", async () => {
    github.issues.set("no42-org", [
      makeRawIssue({ number: 1 }),
      makeRawIssue({
        number: 2,
        nodeId: "I_2",
        repo: { owner: "no42-org", name: "unwatched" },
      }),
    ]);

    const r = await collectIssues(deps(), "no42-org", "full");

    expect(r.issues).toBe(1);
    expect(current()).toHaveLength(1);
  });

  it("tombstones an issue a clean full sweep no longer sees", async () => {
    // Assigned or closed, either way it left the untriaged set.
    github.issues.set("no42-org", [makeRawIssue({ number: 1 })]);
    await collectIssues(deps(), "no42-org", "full");

    github.issues.set("no42-org", []);
    await collectIssues(deps(), "no42-org", "full");

    expect(current()).toHaveLength(0);
  });

  it("does not tombstone on a hot sweep, which queried a subset", async () => {
    github.issues.set("no42-org", [makeRawIssue({ number: 1 })]);
    await collectIssues(deps(), "no42-org", "full");

    github.issues.set("no42-org", []);
    await collectIssues(deps(), "no42-org", "hot");

    expect(current()).toHaveLength(1);
  });

  it("does not tombstone when nodes were unreadable", async () => {
    github.issues.set("no42-org", [makeRawIssue({ number: 1 })]);
    await collectIssues(deps(), "no42-org", "full");

    github.issues.set("no42-org", []);
    github.issueUnreadable.set("no42-org", 2);
    const r = await collectIssues(deps(), "no42-org", "full");

    expect(r.outcome).toBe("partial");
    expect(current()).toHaveLength(1);
  });

  it("does not tombstone when the search hit GitHub's result ceiling", async () => {
    // Same trap as the PR search: 1000 results, hasNextPage false, and only
    // issueCount says the set is incomplete. A capped "ok" sweep would
    // conclude every issue beyond the cap had been dealt with.
    github.issues.set("no42-org", [makeRawIssue({ number: 1 })]);
    await collectIssues(deps(), "no42-org", "full");

    github.issues.set("no42-org", []);
    github.issueTruncated.add("no42-org");
    const r = await collectIssues(deps(), "no42-org", "full");

    expect(r.outcome).toBe("partial");
    expect(current()).toHaveLength(1);
    expect(store.latestRuns(1)[0]?.detail).toContain("truncated");
  });

  it("does not tombstone another installation's issues", async () => {
    watched.add("other-org/thing");
    github.issues.set("other-org", [
      makeRawIssue({
        number: 9,
        nodeId: "I_9",
        repo: { owner: "other-org", name: "thing" },
      }),
    ]);
    await collectIssues(deps(), "other-org", "full");

    github.issues.set("no42-org", []);
    await collectIssues(deps(), "no42-org", "full");

    expect(current()).toHaveLength(1);
  });

  it("does not tombstone a repository dropped from the allowlist", async () => {
    github.issues.set("no42-org", [makeRawIssue({ number: 1 })]);
    await collectIssues(deps(), "no42-org", "full");

    watched.delete("no42-org/twiki");
    github.issues.set("no42-org", []);
    await collectIssues(deps(), "no42-org", "full");

    expect(current()).toHaveLength(1);
  });

  it("contains a search failure rather than throwing past the lane", async () => {
    github.listUntriagedIssues = async () => {
      throw new Error("GraphQL upstream 502");
    };
    const r = await collectIssues(deps(), "no42-org", "full");
    expect(r.outcome).toBe("failed");
    expect(store.latestRuns(1)[0]?.outcome).toBe("failed");
  });

  it("a throwing logger cannot fail the lane", async () => {
    github.issues.set("no42-org", [makeRawIssue({ number: 1 })]);
    const r = await collectIssues(
      {
        ...deps(),
        log: () => {
          throw new Error("EPIPE");
        },
      },
      "no42-org",
      "full",
    );
    expect(r.outcome).toBe("ok");
    expect(store.latestRuns(1)[0]?.outcome).toBe("ok");
  });

  it("writes run rows under its own lane name", async () => {
    await collectIssues(deps(), "no42-org", "full");
    expect(store.latestRuns(1)[0]?.lane).toBe(LANE);
  });

  it("scopes the search to the watched repositories, not the whole org", async () => {
    // Not because `org:` fails on a personal account: measured 2026-08-19,
    // `org:<user>` and `user:<user>` return identical results. The reason
    // is the 1000-result ceiling, which an org-wide query spends on
    // repositories nobody is watching.
    watched.add("no42-org/other");
    await collectIssues(deps(), "no42-org", "full");

    expect(github.issueQueries).toHaveLength(1);
    expect(
      github.issueQueries[0]?.repos.map((r) => `${r.owner}/${r.name}`).sort(),
    ).toEqual(["no42-org/other", "no42-org/twiki"]);
  });
});

describe("packing repositories into search queries", () => {
  it("keeps every query under GitHub's length cap with the base qualifiers", () => {
    const repos = Array.from({ length: 30 }, (_, i) => ({
      owner: "no42-org",
      name: `repository-with-a-long-name-${i}`,
    }));
    const { queries, unsearchable } = issueSearchQueries(repos);

    expect(queries.length).toBeGreaterThan(1);
    expect(unsearchable).toEqual([]);
    for (const q of queries) {
      expect(q.length).toBeLessThanOrEqual(SEARCH_QUERY_MAX);
      expect(q).toContain("is:issue is:open no:assignee");
    }
    // Every repository lands in exactly one query: a dropped repo is a
    // confident zero for that repo, a doubled one double-counts.
    const mentions = queries.join(" ").match(/repo:\S+/g) ?? [];
    expect(mentions.sort()).toEqual(
      repos.map((r) => `repo:${r.owner}/${r.name}`).sort(),
    );
  });

  it("answers no queries for no repositories", () => {
    expect(issueSearchQueries([])).toEqual({ queries: [], unsearchable: [] });
  });
});

describe("packing repositories under a caller's own base", () => {
  const repos = Array.from({ length: 12 }, (_, i) => ({
    owner: "no42-org",
    name: `repository-number-${i}`,
  }));

  it("carries the base on every chunk and each repo exactly once", () => {
    // The PR search's base grows with the configured bot list, so unlike
    // the issue search it is not a constant: every chunk must still carry
    // the full base or that chunk searches for the wrong thing.
    const base = "is:pr is:open author:app/dependabot author:app/renovate";
    const { queries, unsearchable } = searchQueries(base, repos);

    expect(queries.length).toBeGreaterThan(1);
    expect(unsearchable).toEqual([]);
    for (const q of queries) {
      expect(q.length).toBeLessThanOrEqual(SEARCH_QUERY_MAX);
      expect(q.startsWith(base)).toBe(true);
    }
    const mentions = queries.join(" ").match(/repo:\S+/g) ?? [];
    expect(mentions.sort()).toEqual(
      repos.map((r) => `repo:${r.owner}/${r.name}`).sort(),
    );
  });

  it("sets aside only the repositories that cannot fit, and keeps the rest", () => {
    // The case that matters is MIXED lengths: one 100-character repository
    // name (GitHub's maximum) against a base grown by many configured bot
    // logins. Judging against the longest qualifier refused the whole
    // sweep, so one unlucky slug stopped the other nine from being
    // collected at all; judged per repository, nine are still searched and
    // the tenth is counted rather than silently dropped.
    const base = `is:pr is:open ${Array.from(
      { length: 8 },
      (_, i) => `author:app/bot-number-${i}`,
    ).join(" ")}`;
    const huge = { owner: "no42-org", name: "x".repeat(100) };
    const plan = searchQueries(base, [...repos, huge]);

    expect(plan.unsearchable).toEqual([huge]);
    expect(plan.queries.length).toBeGreaterThan(0);
    for (const q of plan.queries) {
      expect(q.length).toBeLessThanOrEqual(SEARCH_QUERY_MAX);
    }
    const mentions = plan.queries.join(" ").match(/repo:\S+/g) ?? [];
    expect(mentions.sort()).toEqual(
      repos.map((r) => `repo:${r.owner}/${r.name}`).sort(),
    );
  });

  it("searches nothing when the base cannot carry any repository", () => {
    // Every repository set aside, no query built: the caller reports a
    // partial sweep with nothing tombstoned rather than a confident zero.
    const base = `is:pr is:open ${"author:a-very-long-bot-login ".repeat(10)}`;
    const plan = searchQueries(base, repos);
    expect(plan.queries).toEqual([]);
    expect(plan.unsearchable).toEqual(repos);
  });
});
