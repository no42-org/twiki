/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OctokitGitHub } from "../src/github/octokit-adapter.js";
import type { RawUpdateStatus } from "../src/github/port.js";
import {
  collectUpdateStatuses,
  LANE,
} from "../src/tricorder/collect/update-status.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { FakeGitHubReadPort } from "./fakes.js";

const makeStatus = (over: Partial<RawUpdateStatus> = {}): RawUpdateStatus => ({
  repo: { owner: "no42-org", name: "twiki" },
  alertNumber: 1,
  update: { pullRequestNumber: 10, error: null },
  ...over,
});

describe("the update-status lane (CAP-3's stuck criterion)", () => {
  let dir: string;
  let store: SqliteStore;
  let github: FakeGitHubReadPort;
  let logs: string[];
  let clock: number;
  let watched: { owner: string; name: string }[];

  const deps = () => ({
    github,
    store,
    watchedIn: (installation: string) =>
      watched.filter((r) => r.owner.toLowerCase() === installation),
    now: () => new Date(Date.UTC(2026, 7, 18, 12, clock++)).toISOString(),
    log: (m: string) => logs.push(m),
  });

  const current = () =>
    store
      .currentByType("dependabot_update_status")
      .filter((c) => c.state === "present");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "status-"));
    store = SqliteStore.openForWrite(join(dir, "s.db"));
    github = new FakeGitHubReadPort(new Map());
    logs = [];
    clock = 0;
    watched = [{ owner: "no42-org", name: "twiki" }];
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores a status keyed like the alert it describes", async () => {
    github.updateStatuses.set("no42-org/twiki", [
      makeStatus({ alertNumber: 7 }),
      makeStatus({
        alertNumber: 8,
        update: {
          pullRequestNumber: null,
          error: "dependency_file_not_supported",
        },
      }),
      makeStatus({ alertNumber: 9, update: null }),
    ]);

    const r = await collectUpdateStatuses(deps(), "no42-org", "full");

    expect(r).toMatchObject({ outcome: "ok", statuses: 3 });
    const keys = current().map((c) => c.subject.key);
    expect(keys.sort()).toEqual([
      "no42-org/twiki#7",
      "no42-org/twiki#8",
      "no42-org/twiki#9",
    ]);
    const stuck = current().find((c) => c.subject.key === "no42-org/twiki#8");
    expect(stuck?.payload).toMatchObject({
      repo: "no42-org/twiki",
      alertNumber: 8,
      update: {
        pullRequestNumber: null,
        error: "dependency_file_not_supported",
      },
    });
    // "GitHub is not attempting a fix" survives the round trip as a fact.
    const idle = current().find((c) => c.subject.key === "no42-org/twiki#9");
    expect(idle?.payload).toMatchObject({ update: null });
  });

  it("degrades to partial when one repository fails, keeping the rest", async () => {
    // AD-16: one repository's failure must not end the run, and a partial
    // outcome must not let the reconciliation conclude anything.
    watched.push({ owner: "no42-org", name: "other" });
    github.updateStatuses.set("no42-org/twiki", [
      makeStatus({ alertNumber: 1 }),
    ]);
    github.updateStatusFailing.add("no42-org/other");

    const r = await collectUpdateStatuses(deps(), "no42-org", "full");

    expect(r.outcome).toBe("partial");
    expect(r.statuses).toBe(1);
    expect(current()).toHaveLength(1);
    expect(store.latestRuns(1)[0]?.detail).toContain("1 repositories failed");
  });

  it("reconciles away a status a clean full sweep no longer sees", async () => {
    // The alert closed, so its status row must go too: a stale "stuck" flag
    // on a fixed alert would keep shouting about a problem that is gone.
    github.updateStatuses.set("no42-org/twiki", [
      makeStatus({ alertNumber: 1 }),
    ]);
    await collectUpdateStatuses(deps(), "no42-org", "full");

    github.updateStatuses.set("no42-org/twiki", []);
    await collectUpdateStatuses(deps(), "no42-org", "full");

    expect(current()).toHaveLength(0);
  });

  it("does not reconcile on a partial sweep", async () => {
    watched.push({ owner: "no42-org", name: "other" });
    github.updateStatuses.set("no42-org/twiki", [
      makeStatus({ alertNumber: 1 }),
    ]);
    await collectUpdateStatuses(deps(), "no42-org", "full");

    github.updateStatuses.set("no42-org/twiki", []);
    github.updateStatusFailing.add("no42-org/other");
    const r = await collectUpdateStatuses(deps(), "no42-org", "full");

    expect(r.outcome).toBe("partial");
    expect(current()).toHaveLength(1);
  });

  it("does not reconcile on a hot sweep, which queried a subset", async () => {
    github.updateStatuses.set("no42-org/twiki", [
      makeStatus({ alertNumber: 1 }),
    ]);
    await collectUpdateStatuses(deps(), "no42-org", "full");

    github.updateStatuses.set("no42-org/twiki", []);
    await collectUpdateStatuses(deps(), "no42-org", "hot");

    expect(current()).toHaveLength(1);
  });

  it("does not touch another installation's statuses", async () => {
    // Status keys carry the owner, so the per-installation read bounds the
    // reconciliation by key prefix (AD-16).
    watched.push({ owner: "other-org", name: "thing" });
    github.updateStatuses.set("other-org/thing", [
      makeStatus({
        alertNumber: 9,
        repo: { owner: "other-org", name: "thing" },
      }),
    ]);
    await collectUpdateStatuses(deps(), "other-org", "full");

    github.updateStatuses.set("no42-org/twiki", []);
    await collectUpdateStatuses(deps(), "no42-org", "full");

    expect(current()).toHaveLength(1);
  });

  it("does not reconcile a repository dropped from the allowlist", async () => {
    github.updateStatuses.set("no42-org/twiki", [
      makeStatus({ alertNumber: 1 }),
    ]);
    await collectUpdateStatuses(deps(), "no42-org", "full");

    watched = [{ owner: "no42-org", name: "other" }];
    const r = await collectUpdateStatuses(deps(), "no42-org", "full");

    // Out of scope, not fixed: the row ages out rather than being concluded.
    expect(r.outcome).toBe("ok");
    expect(current()).toHaveLength(1);
  });

  it("contains a store failure rather than throwing past the lane", async () => {
    store.close();
    const r = await collectUpdateStatuses(deps(), "no42-org", "full");
    expect(r.outcome).toBe("failed");
    // Nothing to reopen for assertions; reaching here without a throw IS the
    // assertion (AD-16), and afterEach's close() tolerates a closed store.
    store = SqliteStore.openForWrite(join(dir, "s.db"));
  });

  it("a throwing logger cannot fail the lane", async () => {
    github.updateStatuses.set("no42-org/twiki", [
      makeStatus({ alertNumber: 1 }),
    ]);
    const r = await collectUpdateStatuses(
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
    await collectUpdateStatuses(deps(), "no42-org", "full");
    expect(store.latestRuns(1)[0]?.lane).toBe(LANE);
  });
});

describe("the adapter's null-container guard", () => {
  it("treats a missing vulnerabilityAlerts container as a failure, not an empty list", async () => {
    // GraphQL can resolve repository:null without throwing (access lost,
    // repository renamed mid-run). Returning [] there hands the lane a clean
    // "ok" sweep whose reconciliation tombstones every stored status for the
    // repository.
    const stub = {
      graphql: async () => ({ repository: null }),
    } as unknown as import("@octokit/rest").Octokit;
    const adapter = new OctokitGitHub(
      async () => stub,
      () => true,
    );

    await expect(
      adapter.listDependabotUpdateStatuses({ owner: "no42-org", name: "x" }),
    ).rejects.toThrow(/no container/);
  });

  it("treats a missing search container the same way", async () => {
    const stub = {
      graphql: async () => ({ search: null }),
    } as unknown as import("@octokit/rest").Octokit;
    const adapter = new OctokitGitHub(
      async () => stub,
      () => true,
      async () => stub,
    );

    await expect(
      adapter.listUntriagedIssues([{ owner: "no42-org", name: "x" }]),
    ).rejects.toThrow(/no result container/);
    await expect(
      adapter.listOpenUpdatePRs("no42-org", ["app/dependabot"]),
    ).rejects.toThrow(/no result container/);
  });
});
