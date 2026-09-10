/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeSubject, pullRequestsSubject } from "../src/core/subject.js";
import { OctokitGitHub } from "../src/github/octokit-adapter.js";
import {
  collectPullRequests,
  summarisePullRequests,
} from "../src/tricorder/collect/pull-requests.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { FakeGitHubReadPort, makeOpenPr } from "./fakes.js";

/**
 * A reason, not THE reason. The port's real sentence is pinned in the
 * contract test below; here it is data the test feeds the fake.
 */
const REASON = "slug too long";

describe("the plain pull-request lane (#167)", () => {
  let dir: string;
  let store: SqliteStore;
  let github: FakeGitHubReadPort;
  let logs: string[];
  let clock: number;
  let watched: Set<string>;

  /**
   * The configured actors, deliberately arbitrary (AD-19): nothing is
   * injected around whatever the operator writes, so an invented bot name
   * proves the wiring rather than a literal in source.
   */
  const deps = (bots: readonly string[] = ["app/custom-bot"]) => ({
    github,
    store,
    bots,
    watchedIn: (installation: string) =>
      [...watched]
        .map((slug) => {
          const [owner = "", name = ""] = slug.split("/");
          return { owner, name };
        })
        .filter((r) => r.owner.toLowerCase() === installation),
    isWatched: (repo: { owner: string; name: string }) =>
      watched.has(`${repo.owner}/${repo.name}`.toLowerCase()),
    now: () => new Date(Date.UTC(2026, 8, 10, 12, clock++)).toISOString(),
    log: (m: string) => logs.push(m),
  });

  const current = () =>
    store.currentByType("pull_request").filter((c) => c.state === "present");
  const confirmations = () =>
    store
      .currentByType("repository_pull_requests")
      .filter((c) => c.state === "present");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "plain-prs-"));
    store = SqliteStore.openForWrite(join(dir, "p.db"));
    github = new FakeGitHubReadPort(new Map());
    logs = [];
    clock = 0;
    watched = new Set(["no42-org/twiki"]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores a human pull request keyed by node id, with its head ref", async () => {
    github.pullRequests.set("no42-org", [makeOpenPr({ number: 7 })]);

    const r = await collectPullRequests(deps(), "no42-org", "full");

    expect(r).toMatchObject({ outcome: "ok", prs: 1, unsearchable: 0 });
    const [row] = current();
    expect(row?.subject.key).toBe("PR_7");
    // The whole payload, not one field of it: the head ref is what the
    // queue's stuck term looks a check row up by, and a test that read only
    // the number would not notice it going missing.
    expect(row?.payload).toEqual({
      repo: "no42-org/twiki",
      number: 7,
      title: "Fix the thing",
      author: "a-contributor",
      // Pull request 7's URL, not the builder's default: the fixture derives
      // it from the number, so a mapper that dropped or swapped the field
      // cannot pass this assertion.
      htmlUrl: "https://github.com/no42-org/twiki/pull/7",
      createdAt: "2026-09-10T00:00:00.000Z",
      headRef: "fix-the-thing",
    });
  });

  it("asks the search to EXCLUDE the configured actors, scoped to the allowlist", async () => {
    // AD-19's functional pin, in the negative: whatever the operator writes
    // is what the search excludes. Client-side filtering would spend the
    // 1000-result ceiling on the rows it discards - measured on this estate,
    // all 19 open pull requests are one bot's.
    watched.add("no42-org/second");

    await collectPullRequests(
      deps(["app/custom-bot", "some-user"]),
      "no42-org",
      "full",
    );

    expect(github.pullRequestQueries).toHaveLength(1);
    expect(github.pullRequestQueries[0]?.excludeAuthors).toEqual([
      "app/custom-bot",
      "some-user",
    ]);
    expect(
      github.pullRequestQueries[0]?.repos
        .map((r) => `${r.owner}/${r.name}`)
        .sort(),
    ).toEqual(["no42-org/second", "no42-org/twiki"]);
  });

  it("discards a configured bot's pull request the search returned anyway", async () => {
    // The write-path defence on the server-side negation. Both lanes call
    // one classifier, so a spelling GitHub's `-author:` qualifier let
    // through cannot become a second row for a pull request the update-PR
    // lane already owns.
    github.pullRequests.set("no42-org", [
      makeOpenPr({ number: 1 }),
      // The payload spelling of `app/custom-bot`.
      makeOpenPr({ number: 2, nodeId: "PR_2", author: "custom-bot[bot]" }),
    ]);

    const r = await collectPullRequests(deps(), "no42-org", "full");

    expect(r.prs).toBe(1);
    expect(current().map((c) => c.subject.key)).toEqual(["PR_1"]);
  });

  it("collects a bot's pull request as a human one when nothing is configured", async () => {
    // With no actor configured as a bot, every open pull request is a human
    // one. The update-PR lane does not run at all in this configuration, so
    // this is the only kind the pull request can reach - and it reaches
    // exactly one.
    github.pullRequests.set("no42-org", [
      makeOpenPr({ number: 1, author: "custom-bot[bot]" }),
    ]);

    const r = await collectPullRequests(deps([]), "no42-org", "full");

    expect(r.prs).toBe(1);
    expect(github.pullRequestQueries[0]?.excludeAuthors).toEqual([]);
  });

  it("drops pull requests outside the allowlist", async () => {
    github.pullRequests.set("no42-org", [
      makeOpenPr({ number: 1 }),
      makeOpenPr({
        number: 2,
        nodeId: "PR_2",
        repo: { owner: "no42-org", name: "unwatched" },
      }),
    ]);

    const r = await collectPullRequests(deps(), "no42-org", "full");

    expect(r.prs).toBe(1);
    expect(current()).toHaveLength(1);
  });

  describe("the per-repository confirmation", () => {
    it("confirms every watched repository the search covered, with its count", async () => {
      watched.add("no42-org/quiet");
      github.pullRequests.set("no42-org", [makeOpenPr({ number: 1 })]);

      await collectPullRequests(deps(), "no42-org", "full");

      expect(confirmations().map((c) => [c.subject.key, c.payload])).toEqual([
        // A repository with none: the confirmation is what makes its `0` a
        // measured zero rather than a confident one (AD-28).
        ["no42-org/quiet", { repo: "no42-org/quiet", openPullRequests: 0 }],
        ["no42-org/twiki", { repo: "no42-org/twiki", openPullRequests: 1 }],
      ]);
    });

    it("withholds only the unsearchable repository, and keeps the run ok", async () => {
      // The divergence from `update-prs.ts`, stated at both lanes: an
      // unsearchable repository is an ANSWER about that repository, not a
      // failure of the sweep. Degrading here would leave one oversized slug
      // withholding every confirmation in the installation, which is the
      // blunt behaviour per-repository confirmations exist to replace.
      watched.add("no42-org/longname");
      github.pullRequests.set("no42-org", [makeOpenPr({ number: 1 })]);
      github.pullRequestUnsearchable.set("no42-org", [
        { repo: { owner: "no42-org", name: "LongName" }, reason: REASON },
      ]);

      const r = await collectPullRequests(deps(), "no42-org", "full");

      expect(r).toMatchObject({ outcome: "ok", unsearchable: 1 });
      expect(confirmations().map((c) => c.subject.key)).toEqual([
        "no42-org/twiki",
      ]);
      // GitHub's own casing, not the folded watch key: `no42-org/longname`
      // is a repository that does not exist, and an operator following it
      // goes looking for the wrong thing.
      expect(store.latestRuns(1)[0]?.detail).toBe(
        `not searched, no rows and no confirmation: no42-org/LongName (${REASON})`,
      );
    });

    it("does not tombstone the rows of a repository it could not search", async () => {
      watched.add("no42-org/longname");
      github.pullRequests.set("no42-org", [
        makeOpenPr({
          number: 5,
          nodeId: "PR_5",
          repo: { owner: "no42-org", name: "LongName" },
        }),
      ]);
      await collectPullRequests(deps(), "no42-org", "full");
      expect(current()).toHaveLength(1);

      // Now its qualifier no longer fits, so the search never asked. The row
      // is unasked, not absent: tombstoning it would report a waiting
      // contributor as gone.
      github.pullRequests.set("no42-org", []);
      github.pullRequestUnsearchable.set("no42-org", [
        { repo: { owner: "no42-org", name: "LongName" }, reason: REASON },
      ]);
      const r = await collectPullRequests(deps(), "no42-org", "full");

      expect(r.outcome).toBe("ok");
      expect(current()).toHaveLength(1);
    });

    it("writes no confirmations on a hot sweep or a partial one", async () => {
      github.pullRequests.set("no42-org", [makeOpenPr({ number: 1 })]);
      await collectPullRequests(deps(), "no42-org", "hot");
      expect(confirmations()).toHaveLength(0);

      github.pullRequestUnreadable.set("no42-org", 1);
      const r = await collectPullRequests(deps(), "no42-org", "full");
      expect(r.outcome).toBe("partial");
      expect(confirmations()).toHaveLength(0);
    });
  });

  describe("the tombstone guards (AD-23)", () => {
    it("tombstones a pull request a clean full sweep no longer sees", async () => {
      github.pullRequests.set("no42-org", [makeOpenPr({ number: 1 })]);
      await collectPullRequests(deps(), "no42-org", "full");

      github.pullRequests.set("no42-org", []);
      await collectPullRequests(deps(), "no42-org", "full");

      expect(current()).toHaveLength(0);
    });

    it("does not tombstone on a hot sweep, which queried a subset", async () => {
      github.pullRequests.set("no42-org", [makeOpenPr({ number: 1 })]);
      await collectPullRequests(deps(), "no42-org", "full");

      github.pullRequests.set("no42-org", []);
      await collectPullRequests(deps(), "no42-org", "hot");

      expect(current()).toHaveLength(1);
    });

    it("does not tombstone when nodes were unreadable", async () => {
      github.pullRequests.set("no42-org", [makeOpenPr({ number: 1 })]);
      await collectPullRequests(deps(), "no42-org", "full");

      github.pullRequests.set("no42-org", []);
      github.pullRequestUnreadable.set("no42-org", 2);
      const r = await collectPullRequests(deps(), "no42-org", "full");

      expect(r.outcome).toBe("partial");
      expect(current()).toHaveLength(1);
      expect(store.latestRuns(1)[0]?.detail).toBe(
        "2 PR nodes could not be read; nothing tombstoned",
      );
    });

    it("does not tombstone when the search hit GitHub's result ceiling", async () => {
      // Search caps at 1000 results and reports it only through issueCount:
      // hasNextPage goes false exactly as at a genuine end. A capped sweep
      // that finished `ok` would conclude every pull request beyond the cap
      // was closed.
      github.pullRequests.set("no42-org", [makeOpenPr({ number: 1 })]);
      await collectPullRequests(deps(), "no42-org", "full");

      github.pullRequests.set("no42-org", []);
      github.pullRequestTruncated.add("no42-org");
      const r = await collectPullRequests(deps(), "no42-org", "full");

      expect(r.outcome).toBe("partial");
      expect(current()).toHaveLength(1);
      expect(store.latestRuns(1)[0]?.detail).toBe(
        "search results truncated at GitHub's ceiling; nothing tombstoned",
      );
    });

    it("does not tombstone another installation's pull requests", async () => {
      watched.add("other-org/thing");
      github.pullRequests.set("other-org", [
        makeOpenPr({
          number: 9,
          nodeId: "PR_9",
          repo: { owner: "other-org", name: "thing" },
        }),
      ]);
      await collectPullRequests(deps(), "other-org", "full");

      github.pullRequests.set("no42-org", []);
      await collectPullRequests(deps(), "no42-org", "full");

      expect(current()).toHaveLength(1);
    });
  });

  it("reports truncation and unsearchable repositories in one detail", async () => {
    // They can happen together, and an operator reading only the first would
    // act on half the problem. The trailing "nothing tombstoned" belongs to
    // the truncation clause; the unsearchable clause states its own
    // consequence, because on this lane it is a different one.
    github.pullRequestTruncated.add("no42-org");
    github.pullRequestUnsearchable.set("no42-org", [
      { repo: { owner: "no42-org", name: "LongName" }, reason: REASON },
    ]);

    const r = await collectPullRequests(deps(), "no42-org", "full");

    expect(r.outcome).toBe("partial");
    expect(store.latestRuns(1)[0]?.detail).toBe(
      "search results truncated at GitHub's ceiling; nothing tombstoned; " +
        `not searched, no rows and no confirmation: no42-org/LongName (${REASON})`,
    );
  });

  it("says nothing when the sweep fell short in no way at all", async () => {
    github.pullRequests.set("no42-org", [makeOpenPr({ number: 1 })]);

    const r = await collectPullRequests(deps(), "no42-org", "full");

    expect(r.outcome).toBe("ok");
    expect(store.latestRuns(1)[0]?.detail ?? null).toBeNull();
  });

  it("contains a search failure rather than throwing past the lane", async () => {
    github.listOpenPullRequests = async () => {
      throw new Error("GraphQL upstream 502");
    };

    const r = await collectPullRequests(deps(), "no42-org", "full");

    expect(r).toMatchObject({ outcome: "failed", prs: 0 });
    expect(store.latestRuns(1)[0]?.outcome).toBe("failed");
  });
});

describe("the plain pull-request search (port contract)", () => {
  /**
   * A stub standing in for one installation's Octokit GraphQL.
   *
   * It captures the DOCUMENT as well as the search string, and that is not
   * decoration: the stub answers with whatever fields the fixture carries
   * regardless of what the query asked for, so a sub-selection deleted from
   * the document is invisible to every assertion about the mapped result. In
   * production the node would come back without the field, the mapper's type
   * check would set `headRef: null` on every pull request, and every plain
   * PR would silently rank `n/a` and read `checks not observed` - with no
   * error and no unreadable count.
   */
  function stubGh(pages: { issueCount: number; nodes: unknown[] }[]) {
    const queries: string[] = [];
    const documents: string[] = [];
    let call = 0;
    const gh = {
      graphql: async (document: string, vars: { q: string }) => {
        queries.push(vars.q);
        documents.push(document);
        const page = pages[call++] ?? { issueCount: 0, nodes: [] };
        return {
          search: {
            issueCount: page.issueCount,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: page.nodes,
          },
        };
      },
    } as unknown as import("@octokit/rest").Octokit;
    return { gh, queries, documents };
  }

  const node = (n: number, over: Record<string, unknown> = {}) => ({
    id: `PR_${n}`,
    number: n,
    title: "Fix the thing",
    url: `https://github.com/no42-org/twiki/pull/${n}`,
    createdAt: "2026-09-10T00:00:00.000Z",
    author: { login: "a-contributor" },
    repository: { name: "twiki", owner: { login: "no42-org" } },
    headRefName: "fix-the-thing",
    ...over,
  });

  const adapterOn = (gh: import("@octokit/rest").Octokit) =>
    new OctokitGitHub(
      async () => gh,
      () => true,
      async () => gh,
    );

  it("negates every configured actor, and asks for the head ref", async () => {
    const { gh, queries, documents } = stubGh([
      { issueCount: 1, nodes: [node(1)] },
    ]);

    const page = await adapterOn(gh).listOpenPullRequests(
      [{ owner: "no42-org", name: "twiki" }],
      ["app/dependabot", "app/renovate"],
    );

    expect(queries).toEqual([
      "is:pr is:open -author:app/dependabot -author:app/renovate" +
        " repo:no42-org/twiki",
    ]);
    // The second half of this test's own title, and it has to be asserted on
    // the DOCUMENT: the stub hands back `headRefName` whether or not the
    // query asked for it, so every assertion below passes with the
    // sub-selection deleted. Losing it kills the only ranking term this kind
    // has, silently.
    expect(documents[0]).toContain("headRefName");
    expect(page.prs).toEqual([
      {
        nodeId: "PR_1",
        repo: { owner: "no42-org", name: "twiki" },
        number: 1,
        title: "Fix the thing",
        author: "a-contributor",
        htmlUrl: "https://github.com/no42-org/twiki/pull/1",
        createdAt: "2026-09-10T00:00:00.000Z",
        headRef: "fix-the-thing",
      },
    ]);
  });

  it("leaves the base unnegated when no actor is configured", async () => {
    const { gh, queries } = stubGh([{ issueCount: 0, nodes: [] }]);

    await adapterOn(gh).listOpenPullRequests(
      [{ owner: "no42-org", name: "twiki" }],
      [],
    );

    expect(queries).toEqual(["is:pr is:open repo:no42-org/twiki"]);
  });

  it("reads a node with no head ref as null rather than refusing it", async () => {
    // A boundary read: the schema says non-null, and a payload that
    // disagrees must leave the queue's term reading `checks not observed`
    // rather than looking a row up by `undefined`.
    const { gh } = stubGh([
      { issueCount: 1, nodes: [node(1, { headRefName: undefined })] },
    ]);

    const page = await adapterOn(gh).listOpenPullRequests(
      [{ owner: "no42-org", name: "twiki" }],
      [],
    );

    expect(page.prs[0]?.headRef).toBeNull();
    expect(page.unreadable).toBe(0);
  });

  it("refuses a base with no room for any repository at all", async () => {
    // Two decisions compose into this: server-side `-author:` negation grows
    // the base by ~23 characters per configured actor, and an unsearchable
    // repository is an ANSWER on this lane rather than a failure. Together,
    // at about eleven actors, EVERY repository becomes unsearchable and the
    // run would finish `ok` having collected nothing - honest pages over a
    // health table showing a healthy lane for a configuration error.
    //
    // Refused at the boundary, where the reason is legible, exactly as the
    // reviewer search refuses a login too long to share a query with its own
    // base. The lane contains the throw into a `failed` run.
    // Ten of these logins is 263 characters of base, past the 256 cap before
    // a single repository is named. The exact count depends on how long the
    // logins are - with `app/dependabot` it lands at eleven - so the test
    // pins the BOUNDARY rather than a number a reader would take for a rule.
    const { gh, queries } = stubGh([{ issueCount: 0, nodes: [] }]);
    const manyBots = Array.from(
      { length: 10 },
      (_, i) => `app/bot-number-${i}`,
    );

    await expect(
      adapterOn(gh).listOpenPullRequests([{ owner: "a", name: "b" }], manyBots),
    ).rejects.toThrow(/no room for a repo: qualifier/);
    // Nothing went to GitHub: this is a configuration error, not a sweep.
    expect(queries).toEqual([]);
  });

  it("still searches at a base that leaves room for the shortest slug", async () => {
    // The boundary is judged against the SHORTEST qualifier any repository
    // could have, so one oversized slug stays that repository's own problem
    // and is reported per repository rather than refusing the whole sweep.
    const { gh, queries } = stubGh([{ issueCount: 0, nodes: [] }]);
    // One fewer than the case above: 238 characters of base, which still
    // leaves room for ` repo:a/b`.
    const nineBots = Array.from({ length: 9 }, (_, i) => `app/bot-number-${i}`);

    await adapterOn(gh).listOpenPullRequests(
      [{ owner: "a", name: "b" }],
      nineBots,
    );

    expect(queries).toHaveLength(1);
  });

  it("names the repository whose qualifier does not fit the negated base", async () => {
    // The measured cost of the negation: the base grows from 13 to 57
    // characters with two configured bots, which is fewer repositories per
    // query. A slug too long for any of them is reported, never dropped.
    const { gh } = stubGh([{ issueCount: 0, nodes: [] }]);
    const huge = { owner: "no42-org", name: "x".repeat(240) };

    const page = await adapterOn(gh).listOpenPullRequests(
      [{ owner: "no42-org", name: "twiki" }, huge],
      ["app/dependabot", "app/renovate"],
    );

    expect(page.unsearchable.map((u) => u.repo)).toEqual([huge]);
    expect(page.unsearchable[0]?.reason).toContain("does not fit");
  });

  it("ORs truncation across chunks", async () => {
    // One capped chunk means the whole result set is incomplete. The capped
    // chunk is FIRST and a clean one follows: taking the last chunk's flag
    // would answer "complete" here.
    const { gh, queries } = stubGh([
      { issueCount: 5000, nodes: [node(1)] },
      { issueCount: 1, nodes: [node(2)] },
    ]);
    const manyRepos = Array.from({ length: 12 }, (_, i) => ({
      owner: "no42-org",
      name: `repository-number-${i}`,
    }));

    const page = await adapterOn(gh).listOpenPullRequests(manyRepos, [
      "app/dependabot",
      "app/renovate",
    ]);

    expect(queries.length).toBeGreaterThan(1);
    expect(page.truncated).toBe(true);
  });

  it("makes no call at all for an empty allowlist", async () => {
    const { gh, queries } = stubGh([]);

    const page = await adapterOn(gh).listOpenPullRequests([], []);

    expect(queries).toEqual([]);
    expect(page).toEqual({
      prs: [],
      unreadable: 0,
      truncated: false,
      unsearchable: [],
    });
  });
});

describe("the pull_request subject type (#167)", () => {
  // Deliberate coverage, because nothing else will catch it. `SUBJECT_TYPES`
  // is enumerated by no test and validated by no store column, so a new
  // subject type compiles and the suite stays green - exactly as
  // `pull_request_workflow_run` did.

  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pr-subject-"));
    store = SqliteStore.openForWrite(join(dir, "s.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("keys a pull request by its node id, through the one function for it", () => {
    // Never composed at a call site (AD-22): two lanes writing one real-world
    // thing under different keys silently fork the projection.
    expect(nodeSubject("pull_request", "PR_7")).toEqual({
      type: "pull_request",
      key: "PR_7",
    });
  });

  it("keys the confirmation by the folded slug, like every repository subject", () => {
    // Folded, because `No42-Org/Twiki` from repos.yaml and `no42-org/twiki`
    // from an API path are one repository.
    expect(pullRequestsSubject({ owner: "No42-Org", name: "TWiki" })).toEqual({
      type: "repository_pull_requests",
      key: "no42-org/twiki",
    });
  });

  it("is a DIFFERENT subject from the dependency-update row sharing its key", () => {
    // The pair the exclusivity rule is about. They are distinct subjects,
    // both storable, and the store keeps them apart: which is precisely why
    // the "one item per pull request" rule has to live where the items are
    // emitted rather than where the rows are stored.
    const r = store.beginRun({
      lane: "graphql-pull-requests",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-09-10T12:00:00.000Z",
    });
    store.recordObservations(r, "2026-09-10T12:00:00.000Z", [
      { subject: nodeSubject("pull_request", "PR_7"), payload: { n: 1 } },
      {
        subject: nodeSubject("dependency_update_pr", "PR_7"),
        payload: { n: 2 },
      },
    ]);
    store.finishRun(r, "ok", "2026-09-10T12:00:00.000Z");

    expect(store.currentByType("pull_request").map((c) => c.payload)).toEqual([
      { n: 1 },
    ]);
    expect(
      store.currentByType("dependency_update_pr").map((c) => c.payload),
    ).toEqual([{ n: 2 }]);
  });

  it("stores and reads back the confirmation row", () => {
    const repo = { owner: "no42-org", name: "twiki" };
    const r = store.beginRun({
      lane: "graphql-pull-requests",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-09-10T12:00:00.000Z",
    });
    store.recordObservations(r, "2026-09-10T12:00:00.000Z", [
      summarisePullRequests(repo, [makeOpenPr({ number: 1 })]),
    ]);
    store.finishRun(r, "ok", "2026-09-10T12:00:00.000Z");

    expect(
      store.currentByType("repository_pull_requests").map((c) => c.payload),
    ).toEqual([{ repo: "no42-org/twiki", openPullRequests: 1 }]);
  });
});
