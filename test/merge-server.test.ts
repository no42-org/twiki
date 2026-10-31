/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { buildConfig } from "../src/core/config.js";
import {
  createMergeApp,
  mergeListenerFrom,
} from "../src/twiki/merge-server.js";
import { FakeGitHub, type FakeRepoData } from "./fakes.js";

const SLUG = "no42-org/demo";
const SHA = "head-1";

function setup(over: { throwOnRead?: boolean } = {}) {
  const data: FakeRepoData = {
    rawPrs: [],
    prChecks: { [SHA]: "green" },
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
  });
  const calls: string[] = [];
  for (const m of ["livePullRequest", "prChecks", "mergePR"] as const) {
    const orig = github[m].bind(github) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    (github as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => {
      calls.push(m);
      if (over.throwOnRead && m === "livePullRequest") {
        throw new Error("secret-token boom");
      }
      return orig(...a);
    };
  }
  const logs: string[] = [];
  const app = createMergeApp({
    config: buildConfig({ mode: "enforce", repos: [{ repo: SLUG }] }),
    github,
    audit: { record: () => {}, recordOperatorMerge: () => {} },
    now: () => "2026-10-31T12:00:00.000Z",
    log: (m) => logs.push(m),
  });
  return { app, calls, logs };
}

const post = (app: ReturnType<typeof setup>["app"], body: string) =>
  app.request("/merge", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });

describe("POST /merge", () => {
  it("returns the MergeResponse for a valid body", async () => {
    const s = setup();
    const res = await post(s.app, JSON.stringify({ repo: SLUG, number: 7 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ outcome: "merged" });
    expect(s.calls).toEqual(["livePullRequest", "prChecks", "mergePR"]);
  });

  it.each([
    ["invalid JSON", "{not json"],
    ["empty body", ""],
    ["a non-object", "7"],
    ["missing number", JSON.stringify({ repo: SLUG })],
    ["string number", JSON.stringify({ repo: SLUG, number: "7" })],
    ["fractional number", JSON.stringify({ repo: SLUG, number: 7.5 })],
    ["zero", JSON.stringify({ repo: SLUG, number: 0 })],
    ["non-string repo", JSON.stringify({ repo: 42, number: 7 })],
  ])("answers 400 for %s and never reaches GitHub", async (_n, body) => {
    const s = setup();
    const res = await post(s.app, body);
    expect(res.status).toBe(400);
    expect(s.calls).toEqual([]);
  });

  it("answers 500 with no detail when the merge throws", async () => {
    const s = setup({ throwOnRead: true });
    const res = await post(s.app, JSON.stringify({ repo: SLUG, number: 7 }));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: "merge failed" });
    expect(s.logs).toEqual([
      `operator merge of ${SLUG}#7 failed: secret-token boom`,
    ]);
  });

  it("serves nothing else", async () => {
    const s = setup();
    expect((await s.app.request("/merge")).status).toBe(404);
    expect(
      (await s.app.request("/merge", { method: "PUT", body: "{}" })).status,
    ).toBe(404);
    expect((await s.app.request("/")).status).toBe(404);
    expect(s.calls).toEqual([]);
  });
});

describe("mergeListenerFrom", () => {
  it("starts nothing without a port", () => {
    expect(mergeListenerFrom({})).toBeNull();
    expect(mergeListenerFrom({ TWIKI_MERGE_PORT: "" })).toBeNull();
    expect(mergeListenerFrom({ TWIKI_MERGE_HOST: "0.0.0.0" })).toBeNull();
  });

  it("defaults the host to loopback", () => {
    expect(mergeListenerFrom({ TWIKI_MERGE_PORT: "8788" })).toEqual({
      host: "127.0.0.1",
      port: 8788,
    });
  });

  it("takes the host from the environment", () => {
    expect(
      mergeListenerFrom({
        TWIKI_MERGE_PORT: "8788",
        TWIKI_MERGE_HOST: "0.0.0.0",
      }),
    ).toEqual({ host: "0.0.0.0", port: 8788 });
  });

  it.each(["abc", "87x", "0", "70000", "-1", "1.5"])(
    "throws naming TWIKI_MERGE_PORT for %s",
    (bad) => {
      expect(() => mergeListenerFrom({ TWIKI_MERGE_PORT: bad })).toThrow(
        /TWIKI_MERGE_PORT/,
      );
    },
  );
});
