/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import type { RawUpdatePr } from "../src/github/port.js";
import {
  bumpFromTitle,
  collectUpdatePRs,
  LANE,
} from "../src/tricorder/collect/update-prs.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { FakeGitHubReadPort } from "./fakes.js";

const makePr = (over: Partial<RawUpdatePr> = {}): RawUpdatePr => ({
  nodeId: `PR_${over.number ?? 1}`,
  repo: { owner: "no42-org", name: "twiki" },
  number: 1,
  title: "Bump left-pad from 1.0.0 to 1.0.1",
  author: "dependabot",
  htmlUrl: "https://github.com/no42-org/twiki/pull/1",
  createdAt: "2026-08-17T00:00:00.000Z",
  ...over,
});

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
    github.updatePrs.set("no42-org", [makePr({ number: 7 })]);

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
    await collectUpdatePRs(
      deps(["app/custom-bot", "some-user"]),
      "no42-org",
      "full",
    );

    expect(github.updatePrQueries).toEqual([
      { org: "no42-org", authors: ["app/custom-bot", "some-user"] },
    ]);
  });

  it("drops PRs outside the allowlist", async () => {
    github.updatePrs.set("no42-org", [
      makePr({ number: 1 }),
      makePr({
        number: 2,
        nodeId: "PR_2",
        repo: { owner: "no42-org", name: "unwatched" },
      }),
    ]);

    const r = await collectUpdatePRs(deps(), "no42-org", "full");

    expect(r.prs).toBe(1);
    expect(current()).toHaveLength(1);
  });

  it("tombstones a PR a clean full sweep no longer sees", async () => {
    github.updatePrs.set("no42-org", [makePr({ number: 1 })]);
    await collectUpdatePRs(deps(), "no42-org", "full");

    github.updatePrs.set("no42-org", []);
    await collectUpdatePRs(deps(), "no42-org", "full");

    expect(current()).toHaveLength(0);
  });

  it("does not tombstone on a hot sweep, which queried a subset", async () => {
    github.updatePrs.set("no42-org", [makePr({ number: 1 })]);
    await collectUpdatePRs(deps(), "no42-org", "full");

    github.updatePrs.set("no42-org", []);
    await collectUpdatePRs(deps(), "no42-org", "hot");

    expect(current()).toHaveLength(1);
  });

  it("does not tombstone when nodes were unreadable", async () => {
    github.updatePrs.set("no42-org", [makePr({ number: 1 })]);
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
      makePr({
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
    github.updatePrs.set("no42-org", [makePr({ number: 1 })]);
    await collectUpdatePRs(deps(), "no42-org", "full");

    watched.delete("no42-org/twiki");
    github.updatePrs.set("no42-org", []);
    await collectUpdatePRs(deps(), "no42-org", "full");

    // Out of scope, not merged: the row ages out rather than being concluded.
    expect(current()).toHaveLength(1);
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
    github.updatePrs.set("no42-org", [makePr({ number: 1 })]);
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
    // No default in source: an unset list means the lane does not run, and the
    // entrypoint says so, rather than a bot login living in code.
    expect(loadConfig(without).bots).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
  });
});
