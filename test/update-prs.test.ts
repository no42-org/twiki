/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import {
  OctokitGitHub,
  SEARCH_QUERY_MAX,
} from "../src/github/octokit-adapter.js";
import {
  bumpFromTitle,
  collectUpdatePRs,
} from "../src/tricorder/collect/update-prs.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { FakeGitHubReadPort, makeUpdatePr } from "./fakes.js";

describe("bump from the PR title", () => {
  it("classifies a Dependabot title", () => {
    expect(bumpFromTitle("Bump left-pad from 1.0.0 to 1.0.1")).toEqual({
      packageName: "left-pad",
      bump: "patch",
    });
    expect(bumpFromTitle("Bump hono from 4.2.0 to 4.3.0").bump).toBe("minor");
    expect(bumpFromTitle("Bump esbuild from 0.19.0 to 1.0.0").bump).toBe(
      "major",
    );
  });

  it("answers unknown for a title that does not carry both versions", () => {
    // Renovate's format has no from-version. Classifying a bump we cannot see
    // would put a confident size on every one of its PRs; unknown ranks above
    // patch and below minor, which is the honest slot.
    expect(
      bumpFromTitle("chore(deps): update dependency esbuild to v0.21.0").bump,
    ).toBeNull();
    expect(bumpFromTitle("Update README").bump).toBeNull();
  });

  it("answers unknown when the versions do not read as versions", () => {
    // classifyBump reports these as indeterminate-major so twiki can refuse to
    // auto-merge them. For ranking, major is a claim the chain acts on, and a
    // bump we could not read is unknown, not the largest possible size.
    expect(bumpFromTitle("Bump x from twenty to thirty")).toEqual({
      packageName: "x",
      bump: null,
    });
  });
});

/**
 * A reason, not THE reason. The port's real sentence is pinned once, in the
 * contract test; here it is data the test feeds the fake, and coupling these
 * suites to the adapter's wording would make a change to the search cap break
 * four files at once.
 */
const REASON = "slug too long";

describe("the update-PR lane (CAP-3, AD-19)", () => {
  let dir: string;
  let store: SqliteStore;
  let github: FakeGitHubReadPort;
  let logs: string[];
  let clock: number;
  let watched: Set<string>;

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
    now: () => new Date(Date.UTC(2026, 7, 17, 12, clock++)).toISOString(),
    log: (m: string) => logs.push(m),
  });

  const current = () =>
    store
      .currentByType("dependency_update_pr")
      .filter((c) => c.state === "present");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prs-"));
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

  it("stores a PR keyed by node id, with the bump parsed at ingest", async () => {
    github.updatePrs.set("no42-org", [makeUpdatePr({ number: 7 })]);

    const r = await collectUpdatePRs(deps(), "no42-org", "full");

    expect(r).toMatchObject({ outcome: "ok", prs: 1 });
    const [row] = current();
    expect(row?.subject.key).toBe("PR_7");
    expect(row?.payload).toMatchObject({
      repo: "no42-org/twiki",
      number: 7,
      packageName: "left-pad",
      bump: "patch",
    });
  });

  it("passes the configured actors to the search verbatim, and nothing else", async () => {
    // AD-19's functional pin: whatever the operator writes is what the search
    // asks for. No default exists in source, so an arbitrary actor working
    // proves nothing is injected around it.
    // Two watched repositories, so a lane that passed only the first would
    // be visible: with one, any truncation of the list looks identical.
    watched.add("no42-org/second");
    await collectUpdatePRs(
      deps(["app/custom-bot", "some-user"]),
      "no42-org",
      "full",
    );

    expect(github.updatePrQueries).toHaveLength(1);
    expect(github.updatePrQueries[0]?.authors).toEqual([
      "app/custom-bot",
      "some-user",
    ]);
    // And the search is scoped to the watched repositories, not the org,
    // so the 1000-result ceiling is spent on repositories somebody watches.
    // (Measured: an org-wide query on a live personal account returned 37
    // bot PRs against 3 in the allowlist.)
    expect(
      github.updatePrQueries[0]?.repos
        .map((r) => `${r.owner}/${r.name}`)
        .sort(),
    ).toEqual(["no42-org/second", "no42-org/twiki"]);
  });

  it("drops PRs outside the allowlist", async () => {
    github.updatePrs.set("no42-org", [
      makeUpdatePr({ number: 1 }),
      makeUpdatePr({
        number: 2,
        nodeId: "PR_2",
        repo: { owner: "no42-org", name: "unwatched" },
      }),
    ]);

    const r = await collectUpdatePRs(deps(), "no42-org", "full");

    expect(r.prs).toBe(1);
    expect(current()).toHaveLength(1);
  });

  it("discards a PR whose author no configured actor matches", async () => {
    // NEW behaviour (#167): this lane used to pass `bots` to the search as
    // `author:` qualifiers and never look at an author again. It classifies
    // now, because the plain pull-request lane collects the complement and
    // the two must partition the open pull requests rather than each
    // deciding for itself what a bot is.
    //
    // It should discard NOTHING in production - GitHub's `author:` qualifier
    // and `classifyPullRequest` agree on every spelling measured on this
    // estate - so this pins the direction the filter actually points.
    github.updatePrs.set("no42-org", [
      makeUpdatePr({ number: 1 }),
      makeUpdatePr({ number: 2, nodeId: "PR_2", author: "a-contributor" }),
    ]);

    const r = await collectUpdatePRs(deps(), "no42-org", "full");

    expect(r.prs).toBe(1);
    expect(current().map((c) => c.subject.key)).toEqual(["PR_1"]);
    expect(
      logs.some((l) => l.includes("1 whose author is not a configured bot")),
    ).toBe(true);
  });

  it("TOMBSTONES a stored PR whose author stops matching, which is the risk", async () => {
    // The failure mode worth writing down, because it is a disappearance
    // rather than an error. `seen` is built from the survivors of the
    // classifier, so a PR this filter drops is also one the tombstone pass
    // concludes is gone - and the plain lane's `-author:` excludes the same
    // PR server-side, so it would then appear on no page at all.
    //
    // Reachable only if `normaliseActor` ever fails to fold a spelling
    // GitHub's `author:` qualifier does match. Driven here by renaming the
    // configured actor, which is the same shape from the lane's side.
    github.updatePrs.set("no42-org", [makeUpdatePr({ number: 1 })]);
    await collectUpdatePRs(deps(), "no42-org", "full");
    expect(current()).toHaveLength(1);

    const r = await collectUpdatePRs(
      deps(["app/other-bot"]),
      "no42-org",
      "full",
    );

    expect(r.outcome).toBe("ok");
    expect(current()).toHaveLength(0);
  });

  it("tombstones a PR a clean full sweep no longer sees", async () => {
    github.updatePrs.set("no42-org", [makeUpdatePr({ number: 1 })]);
    await collectUpdatePRs(deps(), "no42-org", "full");

    github.updatePrs.set("no42-org", []);
    await collectUpdatePRs(deps(), "no42-org", "full");

    expect(current()).toHaveLength(0);
  });

  it("does not tombstone on a hot sweep, which queried a subset", async () => {
    github.updatePrs.set("no42-org", [makeUpdatePr({ number: 1 })]);
    await collectUpdatePRs(deps(), "no42-org", "full");

    github.updatePrs.set("no42-org", []);
    await collectUpdatePRs(deps(), "no42-org", "hot");

    expect(current()).toHaveLength(1);
  });

  it("does not tombstone when nodes were unreadable", async () => {
    github.updatePrs.set("no42-org", [makeUpdatePr({ number: 1 })]);
    await collectUpdatePRs(deps(), "no42-org", "full");

    github.updatePrs.set("no42-org", []);
    github.updatePrUnreadable.set("no42-org", 2);
    const r = await collectUpdatePRs(deps(), "no42-org", "full");

    expect(r.outcome).toBe("partial");
    expect(current()).toHaveLength(1);
  });

  it("does not tombstone another installation's PRs", async () => {
    // Node-id keys carry no owner, so the guard reads the payload. A sweep of
    // one org concluding a PR in another org is gone would wipe real state.
    watched.add("other-org/thing");
    github.updatePrs.set("other-org", [
      makeUpdatePr({
        number: 9,
        nodeId: "PR_9",
        repo: { owner: "other-org", name: "thing" },
      }),
    ]);
    await collectUpdatePRs(deps(), "other-org", "full");

    github.updatePrs.set("no42-org", []);
    await collectUpdatePRs(deps(), "no42-org", "full");

    expect(current()).toHaveLength(1);
  });

  it("does not tombstone a repository dropped from the allowlist", async () => {
    github.updatePrs.set("no42-org", [makeUpdatePr({ number: 1 })]);
    await collectUpdatePRs(deps(), "no42-org", "full");

    watched.delete("no42-org/twiki");
    github.updatePrs.set("no42-org", []);
    await collectUpdatePRs(deps(), "no42-org", "full");

    // Out of scope, not merged: the row ages out rather than being concluded.
    expect(current()).toHaveLength(1);
  });

  it("names the repository it could not search, and tombstones nothing", async () => {
    // Its qualifier did not fit in any query, so nothing was learned about
    // it. Absence from a sweep that never asked means nothing (AD-23), and
    // WHICH repository went unasked is the whole of what the operator can
    // act on: a count sends them to look through the allowlist themselves.
    github.updatePrs.set("no42-org", [makeUpdatePr({ number: 1 })]);
    await collectUpdatePRs(deps(), "no42-org", "full");

    github.updatePrs.set("no42-org", []);
    github.updatePrUnsearchable.set("no42-org", [
      { repo: { owner: "no42-org", name: "LongName" }, reason: REASON },
    ]);
    const r = await collectUpdatePRs(deps(), "no42-org", "full");

    expect(r.outcome).toBe("partial");
    expect(current()).toHaveLength(1);
    // GitHub's own casing, not the folded watch key: `no42-org/longname` is
    // a repository that does not exist, and an operator following it goes
    // looking for the wrong thing.
    expect(store.latestRuns(1)[0]?.detail).toBe(
      `repositories that could not be searched (${REASON}): ` +
        "no42-org/LongName; nothing tombstoned",
    );
  });

  it("names every repository it could not search, never a count of them", async () => {
    // Two of them, which is where a count and a list stop agreeing: "2
    // repositories" names neither, and the operator has to shorten both.
    github.updatePrUnsearchable.set("no42-org", [
      { repo: { owner: "no42-org", name: "long-one" }, reason: REASON },
      { repo: { owner: "no42-org", name: "long-two" }, reason: REASON },
    ]);

    const r = await collectUpdatePRs(deps(), "no42-org", "full");

    expect(r.outcome).toBe("partial");
    const detail = store.latestRuns(1)[0]?.detail ?? "";
    // The cause once, the slugs after it: the reason is invariant across the
    // set and repeating it per repository buries the only part that differs.
    expect(detail).toBe(
      `repositories that could not be searched (${REASON}): ` +
        "no42-org/long-one, no42-org/long-two; nothing tombstoned",
    );
    // The shape a count would leave behind, in either grammar.
    expect(detail).not.toMatch(/\b2 repositories\b/);
  });

  it("names ten and counts the rest when a whole allowlist goes unasked", async () => {
    // The pathological case the field exists for: a base too long to carry
    // any repository puts every watched one in the list on the same sweep.
    // The detail is stored and rendered untruncated into a health-table
    // cell, so it names enough to act on and says how many more there are.
    github.updatePrUnsearchable.set(
      "no42-org",
      Array.from({ length: 13 }, (_, i) => ({
        repo: { owner: "no42-org", name: `repo-${i}` },
        reason: REASON,
      })),
    );

    await collectUpdatePRs(deps(), "no42-org", "full");

    const detail = store.latestRuns(1)[0]?.detail ?? "";
    expect(detail).toBe(
      `repositories that could not be searched (${REASON}): ` +
        "no42-org/repo-0, no42-org/repo-1, no42-org/repo-2, no42-org/repo-3, " +
        "no42-org/repo-4, no42-org/repo-5, no42-org/repo-6, no42-org/repo-7, " +
        "no42-org/repo-8, no42-org/repo-9 and 3 more; nothing tombstoned",
    );
  });

  it("reports an unsearchable repository and an unreadable node in their own clauses", async () => {
    // Both can happen in one sweep, and they are different problems with
    // different fixes. An either/or detail reported the first and buried
    // the second.
    github.updatePrUnreadable.set("no42-org", 3);
    github.updatePrUnsearchable.set("no42-org", [
      { repo: { owner: "no42-org", name: "long-one" }, reason: REASON },
    ]);

    await collectUpdatePRs(deps(), "no42-org", "full");

    expect(store.latestRuns(1)[0]?.detail).toBe(
      `repositories that could not be searched (${REASON}): no42-org/long-one` +
        "; 3 PR nodes could not be read; nothing tombstoned",
    );
  });

  it("tells an unreadable-only sweep that nothing was tombstoned", async () => {
    // The clause used to be spelled per note, so this sweep - partial, with
    // the tombstone pass skipped exactly as on the other two - said only
    // that some nodes could not be read and left the operator to infer the
    // rest. It is one sentence now, said once, on all three.
    github.updatePrUnreadable.set("no42-org", 2);

    const r = await collectUpdatePRs(deps(), "no42-org", "full");

    expect(r.outcome).toBe("partial");
    expect(store.latestRuns(1)[0]?.detail).toBe(
      "2 PR nodes could not be read; nothing tombstoned",
    );
  });

  it("says nothing about unsearchable repositories when every one fit", async () => {
    github.updatePrs.set("no42-org", [makeUpdatePr({ number: 1 })]);

    const r = await collectUpdatePRs(deps(), "no42-org", "full");

    expect(r.outcome).toBe("ok");
    expect(store.latestRuns(1)[0]?.detail ?? null).toBeNull();
  });

  it("does not tombstone when the search hit GitHub's result ceiling", async () => {
    // Search caps at 1000 results and reports it only through issueCount:
    // hasNextPage goes false exactly as at a genuine end. A capped sweep that
    // finished "ok" would conclude every PR beyond the cap was closed.
    github.updatePrs.set("no42-org", [makeUpdatePr({ number: 1 })]);
    await collectUpdatePRs(deps(), "no42-org", "full");

    github.updatePrs.set("no42-org", []);
    github.updatePrTruncated.add("no42-org");
    const r = await collectUpdatePRs(deps(), "no42-org", "full");

    expect(r.outcome).toBe("partial");
    expect(current()).toHaveLength(1);
    expect(store.latestRuns(1)[0]?.detail).toContain("truncated");
  });

  it("parses the package name out of a Renovate title", () => {
    // The bump stays unknown, but severing the name silently severed the
    // alert-risk join for one of the two bots the README promises to cover.
    expect(
      bumpFromTitle("chore(deps): update dependency esbuild to v0.21.0"),
    ).toEqual({ packageName: "esbuild", bump: null });
    expect(bumpFromTitle("Update react to v19").packageName).toBe("react");
    expect(bumpFromTitle("Update README").packageName).toBeNull();
  });

  it("contains a search failure rather than throwing past the lane", async () => {
    github.listOpenUpdatePRs = async () => {
      throw new Error("GraphQL upstream 502");
    };
    const r = await collectUpdatePRs(deps(), "no42-org", "full");
    expect(r.outcome).toBe("failed");
    expect(store.latestRuns(1)[0]?.outcome).toBe("failed");
  });

  it("a throwing logger cannot fail the lane", async () => {
    github.updatePrs.set("no42-org", [makeUpdatePr({ number: 1 })]);
    const r = await collectUpdatePRs(
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
});

describe("the PR search across chunks", () => {
  /** A stub standing in for one installation's Octokit GraphQL. */
  function stubGh(pages: { issueCount: number; nodes: unknown[] }[]) {
    const queries: string[] = [];
    let call = 0;
    const gh = {
      graphql: async (_q: string, vars: { q: string }) => {
        queries.push(vars.q);
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
    return { gh, queries };
  }

  const node = (n: number) => ({
    id: `PR_${n}`,
    number: n,
    title: "Bump x from 1.0.0 to 1.0.1",
    url: `https://github.com/no42-org/twiki/pull/${n}`,
    createdAt: "2026-08-19T00:00:00.000Z",
    author: { login: "dependabot" },
    repository: { name: "twiki", owner: { login: "no42-org" } },
  });

  const manyRepos = Array.from({ length: 12 }, (_, i) => ({
    owner: "no42-org",
    name: `repository-number-${i}`,
  }));

  it("merges every chunk's results and ORs their truncation", async () => {
    // One capped chunk means the whole result set is incomplete. Reporting
    // the merge as complete would let the lane tombstone every PR the
    // capped chunk could not return.
    // The capped chunk is FIRST and a clean chunk follows it: taking the
    // last chunk's flag (rather than OR-ing) would answer "complete" here,
    // which a truncated-chunk-last fixture cannot catch.
    const { gh, queries } = stubGh([
      // First chunk hit the 1000-result ceiling: fewer nodes than matched.
      { issueCount: 5000, nodes: [node(1)] },
      { issueCount: 1, nodes: [node(2)] },
    ]);
    const adapter = new OctokitGitHub(
      async () => gh,
      () => true,
      async () => gh,
    );

    const page = await adapter.listOpenUpdatePRs(manyRepos, ["app/dependabot"]);

    expect(queries.length).toBeGreaterThan(1);
    expect(page.prs.map((p) => p.number).sort()).toEqual([1, 2]);
    expect(page.truncated).toBe(true);
  });

  it("reports the repositories it could not search onto the page", async () => {
    // The list has to reach the lane through the page, not just exist in
    // the plan: it is what degrades the sweep to partial, stops the
    // tombstone pass, and names the repository in the run detail.
    const { gh, queries } = stubGh([{ issueCount: 1, nodes: [node(1)] }]);
    const adapter = new OctokitGitHub(
      async () => gh,
      () => true,
      async () => gh,
    );
    const huge = { owner: "no42-org", name: "x".repeat(100) };
    const bots = Array.from({ length: 8 }, (_, i) => `app/bot-number-${i}`);

    const page = await adapter.listOpenUpdatePRs(
      [{ owner: "no42-org", name: "twiki" }, huge],
      bots,
    );

    // The whole entry, not its length: the slug is what the operator acts
    // on, and the reason names the cap that set it aside. The sentence
    // itself is pinned once, in the contract test.
    expect(page.unsearchable).toEqual([
      {
        repo: huge,
        reason: expect.stringContaining(`${SEARCH_QUERY_MAX}-character`),
      },
    ]);
    // The searchable one was still collected: setting a repository aside
    // must not cost the others.
    expect(queries.join(" ")).toContain("repo:no42-org/twiki");
    expect(page.prs.map((p) => p.number)).toEqual([1]);
  });

  it("resolves no client at all when no repositories are watched", async () => {
    // Not merely "asks nothing": resolving a client needs an owner, and the
    // only owner available is repos[0], which does not exist. The real
    // resolver would fail with "the App is not installed on ", blaming an
    // account nobody named.
    const adapter = new OctokitGitHub(
      async () => {
        throw new Error("resolver must not be called");
      },
      () => true,
      async () => {
        throw new Error("resolver must not be called");
      },
    );

    const page = await adapter.listOpenUpdatePRs([], ["app/dependabot"]);

    expect(page).toEqual({
      prs: [],
      unreadable: 0,
      truncated: false,
      unsearchable: [],
    });
  });
});

describe("the actor set is configuration (AD-19)", () => {
  it("reads bots from repos.yaml and defaults to none", () => {
    const dir = mkdtempSync(join(tmpdir(), "cfg-"));
    const withBots = join(dir, "with.yaml");
    writeFileSync(
      withBots,
      "repos:\n  - repo: no42-org/twiki\nbots:\n  - app/custom-bot\n",
    );
    const without = join(dir, "without.yaml");
    writeFileSync(without, "repos:\n  - repo: no42-org/twiki\n");

    expect(loadConfig(withBots).bots).toEqual(["app/custom-bot"]);

    // A value with whitespace or search syntax silently rewrites the query,
    // and the narrowed "ok" sweep then tombstones everything it filtered out.
    const injected = join(dir, "injected.yaml");
    writeFileSync(
      injected,
      "repos:\n  - repo: no42-org/twiki\nbots:\n  - app/dependabot app/renovate\n",
    );
    expect(() => loadConfig(injected)).toThrow(/one login per entry/);
    // No default in source: an unset list means the lane does not run, and the
    // entrypoint says so, rather than a bot login living in code.
    expect(loadConfig(without).bots).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
  });
});
