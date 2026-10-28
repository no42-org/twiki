/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommitRef, ReleaseEvidence } from "../src/core/release-worthy.js";
import type { RepoRef } from "../src/core/types.js";
import {
  collectReleaseReadiness,
  LANE,
} from "../src/tricorder/collect/release-readiness.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { FakeGitHubReadPort, type FakeRepoData } from "./fakes.js";

function repoData(over: Partial<FakeRepoData> = {}): FakeRepoData {
  return {
    rawPrs: [],
    prChecks: {},
    mainChecks: "green",
    latestTag: null,
    unreleased: 0,
    hasWorkflow: true,
    defaultSha: "sha-main",
    ...over,
  };
}

const FEAT: CommitRef = {
  sha: "aaa111",
  subject: "feat(web): a release column",
  url: "https://github.com/no42-org/twiki/commit/aaa111",
};

const TWIKI_EVIDENCE: ReleaseEvidence = {
  tag: "v1.2.3",
  tagDate: "2026-10-01T10:00:00Z",
  commits: [
    FEAT,
    {
      sha: "bbb222",
      subject: "chore(deps): bump vitest",
      url: "https://github.com/no42-org/twiki/commit/bbb222",
    },
  ],
  truncated: false,
  fixedAlerts: [
    {
      number: 12,
      severity: "high",
      ghsaId: "GHSA-aaaa-bbbb-cccc",
      cveId: "CVE-2026-0001",
      packageName: "left-pad",
      scope: "runtime",
      htmlUrl: "https://github.com/no42-org/twiki/security/dependabot/12",
      fixedAt: "2026-10-05T10:00:00Z",
    },
  ],
};

function seeded(evidence: ReleaseEvidence): FakeRepoData {
  return repoData({
    latestTag: evidence.tag,
    unreleasedCommits: {
      tagDate: evidence.tagDate,
      commits: [...evidence.commits],
      truncated: evidence.truncated,
    },
    fixedAlerts: [...evidence.fixedAlerts],
  });
}

describe("the release-readiness lane", () => {
  let dir: string;
  let store: SqliteStore;
  let data: Map<string, FakeRepoData>;
  let github: FakeGitHubReadPort;
  let logs: string[];
  let clock: number;
  let watched: RepoRef[];
  let untracked: Set<string>;

  const deps = () => ({
    github,
    store,
    watchedIn: (installation: string) =>
      watched.filter((r) => r.owner.toLowerCase() === installation),
    releaseTracked: (repo: RepoRef) =>
      !untracked.has(`${repo.owner}/${repo.name}`),
    defaultBranchOf: (repo: RepoRef) =>
      repo.name === "legacy" ? "master" : "main",
    now: () => new Date(Date.UTC(2026, 9, 28, 12, clock++)).toISOString(),
    log: (m: string) => logs.push(m),
  });

  const current = () =>
    store
      .currentByType("release_readiness")
      .filter((c) => c.state === "present")
      .map((c) => ({ key: c.subject.key, payload: c.payload }))
      .sort((a, b) => a.key.localeCompare(b.key));

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "release-"));
    store = SqliteStore.openForWrite(join(dir, "s.db"));
    data = new Map();
    github = new FakeGitHubReadPort(data);
    logs = [];
    clock = 0;
    watched = [{ owner: "no42-org", name: "twiki" }];
    untracked = new Set();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores the whole evidence for a tracked repository", async () => {
    data.set("no42-org/twiki", seeded(TWIKI_EVIDENCE));
    const commits = vi.spyOn(github, "unreleasedCommits");

    const r = await collectReleaseReadiness(deps(), "no42-org", "full");

    expect(r).toEqual({ installation: "no42-org", outcome: "ok", repos: 1 });
    expect(current()).toEqual([
      { key: "no42-org/twiki", payload: TWIKI_EVIDENCE },
    ]);
    // The tag the lane read is the tag it asked commits since, on the
    // repository's own default branch.
    expect(commits.mock.calls).toEqual([
      [{ owner: "no42-org", name: "twiki" }, "v1.2.3", "main"],
    ]);
    expect(store.latestRuns(1)[0]).toMatchObject({
      lane: LANE,
      outcome: "ok",
    });
  });

  it("asks a configured default branch, not main", async () => {
    watched = [{ owner: "no42-org", name: "legacy" }];
    data.set("no42-org/legacy", seeded(TWIKI_EVIDENCE));
    const commits = vi.spyOn(github, "unreleasedCommits");

    await collectReleaseReadiness(deps(), "no42-org", "full");

    expect(commits.mock.calls).toEqual([
      [{ owner: "no42-org", name: "legacy" }, "v1.2.3", "master"],
    ]);
  });

  it("makes no GitHub call and stores nothing for an untracked repository", async () => {
    watched.push({ owner: "no42-org", name: "quiet" });
    untracked.add("no42-org/quiet");
    data.set("no42-org/twiki", seeded(TWIKI_EVIDENCE));
    // No fake data for quiet: any read of it would throw and turn the run
    // partial. The spies say so directly as well.
    const tag = vi.spyOn(github, "latestTag");
    const commits = vi.spyOn(github, "unreleasedCommits");
    const alerts = vi.spyOn(github, "listFixedDependabotAlerts");

    const r = await collectReleaseReadiness(deps(), "no42-org", "full");

    expect(r).toEqual({ installation: "no42-org", outcome: "ok", repos: 1 });
    const twiki = { owner: "no42-org", name: "twiki" };
    expect(tag.mock.calls).toEqual([[twiki]]);
    expect(commits.mock.calls).toEqual([[twiki, "v1.2.3", "main"]]);
    expect(alerts.mock.calls).toEqual([[twiki]]);
    expect(current()).toEqual([
      { key: "no42-org/twiki", payload: TWIKI_EVIDENCE },
    ]);
  });

  it("asks for every commit when there is no tag, and stores a null tag date", async () => {
    // Review Focus 1: no tag means evaluate everything, not skip the repo.
    data.set(
      "no42-org/twiki",
      repoData({
        latestTag: null,
        unreleasedCommits: {
          tagDate: null,
          commits: [FEAT],
          truncated: true,
        },
        fixedAlerts: [],
      }),
    );
    const commits = vi.spyOn(github, "unreleasedCommits");

    const r = await collectReleaseReadiness(deps(), "no42-org", "full");

    expect(r.outcome).toBe("ok");
    expect(commits.mock.calls).toEqual([
      [{ owner: "no42-org", name: "twiki" }, null, "main"],
    ]);
    expect(current()).toEqual([
      {
        key: "no42-org/twiki",
        payload: {
          tag: null,
          tagDate: null,
          commits: [FEAT],
          truncated: true,
          fixedAlerts: [],
        } satisfies ReleaseEvidence,
      },
    ]);
  });

  it("degrades to partial when one repository fails, keeps the other, and tombstones nothing", async () => {
    watched.push({ owner: "no42-org", name: "other" });
    data.set("no42-org/twiki", seeded(TWIKI_EVIDENCE));
    data.set("no42-org/other", seeded(TWIKI_EVIDENCE));
    await collectReleaseReadiness(deps(), "no42-org", "full");

    // other's row exists; its read now fails, and twiki's evidence changes.
    github.failUnreleasedCommitsWith(
      "no42-org/other",
      Object.assign(new Error("Not Found"), { status: 404 }),
    );
    const changed: ReleaseEvidence = { ...TWIKI_EVIDENCE, fixedAlerts: [] };
    data.set("no42-org/twiki", seeded(changed));

    const r = await collectReleaseReadiness(deps(), "no42-org", "full");

    expect(r).toEqual({
      installation: "no42-org",
      outcome: "partial",
      repos: 1,
    });
    expect(current()).toEqual([
      { key: "no42-org/other", payload: TWIKI_EVIDENCE },
      { key: "no42-org/twiki", payload: changed },
    ]);
    expect(store.latestRuns(1)[0]).toMatchObject({
      outcome: "partial",
      detail: "1 repositories failed",
    });
    expect(logs.some((l) => l.includes("no42-org/other failed"))).toBe(true);
  });

  describe("reconciliation (Review Focus 5)", () => {
    beforeEach(async () => {
      watched.push({ owner: "no42-org", name: "other" });
      data.set("no42-org/twiki", seeded(TWIKI_EVIDENCE));
      data.set("no42-org/other", seeded(TWIKI_EVIDENCE));
      await collectReleaseReadiness(deps(), "no42-org", "full");
      expect(current().map((c) => c.key)).toEqual([
        "no42-org/other",
        "no42-org/twiki",
      ]);
    });

    it("tombstones a repository that left the allowlist on a clean full run", async () => {
      watched = [{ owner: "no42-org", name: "twiki" }];

      const r = await collectReleaseReadiness(deps(), "no42-org", "full");

      expect(r.outcome).toBe("ok");
      expect(current()).toEqual([
        { key: "no42-org/twiki", payload: TWIKI_EVIDENCE },
      ]);
    });

    it("tombstones a repository that opted out on a clean full run", async () => {
      untracked.add("no42-org/other");

      const r = await collectReleaseReadiness(deps(), "no42-org", "full");

      expect(r.outcome).toBe("ok");
      expect(current()).toEqual([
        { key: "no42-org/twiki", payload: TWIKI_EVIDENCE },
      ]);
    });

    it("does not tombstone on a hot run", async () => {
      untracked.add("no42-org/other");

      await collectReleaseReadiness(deps(), "no42-org", "hot");

      expect(current().map((c) => c.key)).toEqual([
        "no42-org/other",
        "no42-org/twiki",
      ]);
    });

    it("does not tombstone on a partial run", async () => {
      untracked.add("no42-org/other");
      github.failUnreleasedCommitsWith("no42-org/twiki", new Error("boom"));

      const r = await collectReleaseReadiness(deps(), "no42-org", "full");

      expect(r.outcome).toBe("partial");
      expect(current().map((c) => c.key)).toEqual([
        "no42-org/other",
        "no42-org/twiki",
      ]);
    });

    it("does not touch another installation's rows", async () => {
      watched.push({ owner: "other-org", name: "thing" });
      data.set("other-org/thing", seeded(TWIKI_EVIDENCE));
      await collectReleaseReadiness(deps(), "other-org", "full");

      watched = [];
      await collectReleaseReadiness(deps(), "no42-org", "full");

      expect(current().map((c) => c.key)).toEqual(["other-org/thing"]);
    });
  });

  it("contains a store failure rather than throwing past the lane", async () => {
    store.close();
    const r = await collectReleaseReadiness(deps(), "no42-org", "full");
    expect(r).toEqual({
      installation: "no42-org",
      outcome: "failed",
      repos: 0,
    });
    store = SqliteStore.openForWrite(join(dir, "s.db"));
  });
});
