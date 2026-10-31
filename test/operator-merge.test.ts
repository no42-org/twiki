/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/core/config.js";
import type { MergeResponse } from "../src/core/merge.js";
import type { LivePullRequest } from "../src/github/port.js";
import type { AuditSink } from "../src/twiki/audit.js";
import { operatorMerge } from "../src/twiki/operator-merge.js";
import { FakeGitHub, type FakeRepoData } from "./fakes.js";

const SLUG = "no42-org/demo";
const SHA = "head-1";
const AT = "2026-10-31T12:00:00.000Z";

type Entry = Parameters<AuditSink["recordOperatorMerge"]>[0];

function setup(
  over: {
    mode?: "shadow" | "enforce";
    checks?: FakeRepoData["prChecks"][string];
    live?: Partial<LivePullRequest>;
  } = {},
) {
  const data: FakeRepoData = {
    rawPrs: [],
    prChecks: { [SHA]: over.checks ?? "green" },
    mainChecks: "green",
    latestTag: "v1.2.3",
    defaultSha: "main-sha",
  };
  const github = new FakeGitHub(new Map([[SLUG, data]]));
  github.live.set(`${SLUG}#7`, {
    state: "OPEN",
    isDraft: false,
    headSha: SHA,
    reviewDecision: null,
    ...over.live,
  });
  const calls: string[] = [];
  for (const m of ["livePullRequest", "prChecks", "mergePR"] as const) {
    const orig = github[m].bind(github) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    (github as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
      calls.push(m);
      return orig(...a);
    };
  }
  const audited: { entry: Entry; at: string }[] = [];
  const logs: string[] = [];
  const deps = {
    config: buildConfig({
      mode: over.mode ?? "enforce",
      repos: [{ repo: SLUG }],
    }),
    github,
    audit: {
      record: () => {},
      recordOperatorMerge: (entry: Entry, at: string) =>
        audited.push({ entry, at }),
    } satisfies AuditSink,
    now: () => AT,
    log: (m: string) => logs.push(m),
  };
  return { github, calls, audited, logs, deps };
}

const req = { repo: SLUG, number: 7 };
const httpError = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { status });
const refused = (refusal: string) => ({ outcome: "refused", refusal });

describe("operatorMerge", () => {
  it("shadow refuses and makes no GitHub call, reads included", async () => {
    const s = setup({ mode: "shadow" });
    expect(await operatorMerge(req, s.deps)).toEqual(refused("shadow-mode"));
    expect(s.calls).toEqual([]);
    expect(s.audited).toEqual([
      {
        entry: { ...req, response: refused("shadow-mode"), headSha: null },
        at: AT,
      },
    ]);
  });

  it.each([
    ["outside the allowlist", { repo: "other/thing", number: 7 }],
    ["malformed repo", { repo: "nonsense", number: 7 }],
    ["non-integer number", { repo: SLUG, number: 7.5 }],
    ["non-numeric number", { repo: SLUG, number: "7" as unknown as number }],
  ])("refuses %s with no GitHub call", async (_n, request) => {
    const s = setup();
    expect(await operatorMerge(request, s.deps)).toEqual(
      refused("not-allowlisted"),
    );
    expect(s.calls).toEqual([]);
    expect(s.audited).toHaveLength(1);
    expect(s.audited[0]?.entry.response).toEqual(refused("not-allowlisted"));
  });

  it("merges a green, approved pull request at the live head sha", async () => {
    const s = setup({ live: { reviewDecision: "APPROVED", headSha: SHA } });
    expect(await operatorMerge(req, s.deps)).toEqual({ outcome: "merged" });
    expect(s.github.merged).toEqual([{ repo: SLUG, number: 7 }]);
    expect(s.github.mergedAt).toEqual([SHA]);
    expect(s.audited).toEqual([
      {
        entry: { ...req, response: { outcome: "merged" }, headSha: SHA },
        at: AT,
      },
    ]);
  });

  it("never calls mergePR on red checks", async () => {
    const s = setup({ checks: "red" });
    expect(await operatorMerge(req, s.deps)).toEqual(refused("ci-failed"));
    expect(s.github.merged).toEqual([]);
    expect(s.calls).not.toContain("mergePR");
    expect(s.audited).toEqual([
      {
        entry: { ...req, response: refused("ci-failed"), headSha: SHA },
        at: AT,
      },
    ]);
  });

  it("does not apply the version rule: a major bump merges when green", async () => {
    // The request carries no title, and nothing here reads one.
    const s = setup();
    expect(await operatorMerge(req, s.deps)).toEqual({ outcome: "merged" });
  });

  it("maps a 409 to head-changed", async () => {
    const s = setup();
    s.github.failMergeOn.set(7, httpError(409));
    expect(await operatorMerge(req, s.deps)).toEqual(refused("head-changed"));
    expect(s.audited).toEqual([
      {
        entry: { ...req, response: refused("head-changed"), headSha: SHA },
        at: AT,
      },
    ]);
  });

  it("maps a 405 on a pull request that is now MERGED to already-merged", async () => {
    const s = setup();
    s.github.failMergeOn.set(7, httpError(405));
    const reads = [
      { state: "OPEN", isDraft: false, headSha: SHA, reviewDecision: null },
      { state: "MERGED", isDraft: false, headSha: SHA, reviewDecision: null },
    ] as const;
    let i = 0;
    s.github.livePullRequest = async () => ({ ...reads[i++ === 0 ? 0 : 1] });
    expect(await operatorMerge(req, s.deps)).toEqual({
      outcome: "already-merged",
    });
    expect(s.audited).toEqual([
      {
        entry: {
          ...req,
          response: { outcome: "already-merged" },
          headSha: SHA,
        },
        at: AT,
      },
    ]);
  });

  it("maps a 405 on a still-open pull request to not-mergeable", async () => {
    const s = setup();
    s.github.failMergeOn.set(7, httpError(405));
    expect(await operatorMerge(req, s.deps)).toEqual(refused("not-mergeable"));
    expect(s.audited).toEqual([
      {
        entry: { ...req, response: refused("not-mergeable"), headSha: SHA },
        at: AT,
      },
    ]);
  });

  it("returns already-merged when the live read says MERGED", async () => {
    const s = setup({ live: { state: "MERGED" } });
    expect(await operatorMerge(req, s.deps)).toEqual({
      outcome: "already-merged",
    });
    expect(s.calls).not.toContain("mergePR");
  });

  it("logs and rethrows any other error, auditing nothing", async () => {
    const s = setup();
    s.github.failMergeOn.set(7, httpError(500));
    await expect(operatorMerge(req, s.deps)).rejects.toThrow("HTTP 500");
    expect(s.logs).toEqual([`operator merge of ${SLUG}#7 failed: HTTP 500`]);
    expect(s.audited).toEqual([]);
    expect(s.github.merged).toEqual([]);
  });

  it("writes exactly one audit entry per outcome", async () => {
    const outcomes: MergeResponse[] = [];
    for (const over of [
      { checks: "red" as const },
      { checks: "green" as const },
      { live: { state: "CLOSED" as const } },
    ]) {
      const s = setup(over);
      outcomes.push(await operatorMerge(req, s.deps));
      expect(s.audited).toHaveLength(1);
    }
    expect(outcomes).toEqual([
      refused("ci-failed"),
      { outcome: "merged" },
      refused("closed"),
    ]);
  });
});
