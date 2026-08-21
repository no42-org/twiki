/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import { DEFAULT_RANK_POLICY } from "../src/core/rank.js";
import {
  collectReviewRequests,
  LANE,
  REVIEWS_INSTALLATION,
} from "../src/tricorder/collect/review-requests.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { createApp } from "../src/tricorder/web/app.js";
import { buildReviewView } from "../src/tricorder/web/review-view.js";
import { FakeGitHubReadPort, makeReviewRequest } from "./fakes.js";

const NOW = new Date("2026-08-21T12:00:00.000Z");
const SWEEP = { cadenceMs: 15 * 60_000 };

describe("the review-request lane (CAP-5)", () => {
  let dir: string;
  let store: SqliteStore;
  let github: FakeGitHubReadPort;
  let logs: string[];
  let clock: number;

  const deps = (reviewers: readonly string[] = ["indigo423"]) => ({
    github,
    store,
    reviewers,
    viaInstallation: "no42-org",
    now: () => new Date(Date.UTC(2026, 7, 21, 12, clock++)).toISOString(),
    log: (m: string) => logs.push(m),
  });

  const current = () =>
    store.currentByType("review_request").filter((c) => c.state === "present");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reviews-"));
    store = SqliteStore.openForWrite(join(dir, "r.db"));
    github = new FakeGitHubReadPort(new Map());
    logs = [];
    clock = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores a request keyed by node id, whoever owns the repository", async () => {
    // The point of the lane: 38 of 40 measured requests were in
    // repositories nobody watches, and scoping to the allowlist would have
    // made the capability almost empty.
    github.reviewRequests = [
      makeReviewRequest({ number: 8803 }),
      makeReviewRequest({
        number: 41,
        nodeId: "RR_41",
        repo: { owner: "no42-org", name: "packyard" },
      }),
    ];

    const r = await collectReviewRequests(deps());

    expect(r).toMatchObject({ outcome: "ok", requests: 2 });
    const payloads = current().map((c) => c.payload as { repo: string });
    expect(payloads.map((p) => p.repo).sort()).toEqual([
      "no42-org/packyard",
      "opennms/opennms",
    ]);
  });

  it("passes the configured reviewers to the search verbatim", async () => {
    // AD-19's rule again: an installation token has no user identity, so
    // the logins are configuration and nothing is assumed around them.
    await collectReviewRequests(deps(["indigo423", "someone-else"]));

    expect(github.reviewRequestQueries).toEqual([
      {
        viaInstallation: "no42-org",
        reviewers: ["indigo423", "someone-else"],
      },
    ]);
  });

  it("keeps the other reviewers, so waiting-on-you can be read honestly", async () => {
    github.reviewRequests = [
      makeReviewRequest({ requestedReviewers: ["indigo423", "a", "b"] }),
    ];

    await collectReviewRequests(deps());

    expect(current()[0]?.payload).toMatchObject({
      requestedReviewers: ["indigo423", "a", "b"],
    });
  });

  it("tombstones a request once the review is given or withdrawn", async () => {
    github.reviewRequests = [makeReviewRequest()];
    await collectReviewRequests(deps());
    expect(current()).toHaveLength(1);

    github.reviewRequests = [];
    await collectReviewRequests(deps());

    expect(current()).toHaveLength(0);
  });

  it("does not tombstone when the search hit GitHub's ceiling", async () => {
    github.reviewRequests = [makeReviewRequest()];
    await collectReviewRequests(deps());

    github.reviewRequests = [];
    github.reviewRequestTruncated = true;
    const r = await collectReviewRequests(deps());

    expect(r.outcome).toBe("partial");
    expect(current()).toHaveLength(1);
    expect(store.latestRuns(1)[0]?.detail).toContain("truncated");
  });

  it("does not tombstone when nodes were unreadable", async () => {
    github.reviewRequests = [makeReviewRequest()];
    await collectReviewRequests(deps());

    github.reviewRequests = [];
    github.reviewRequestUnreadable = 2;
    const r = await collectReviewRequests(deps());

    expect(r.outcome).toBe("partial");
    expect(current()).toHaveLength(1);
  });

  it("runs under its own pseudo-installation", async () => {
    // The search is global, so this lane sweeps nothing that is an
    // installation: running it per installation would repeat one call and
    // have the runs reconcile against each other.
    await collectReviewRequests(deps());
    expect(store.latestRuns(1)[0]).toMatchObject({
      lane: LANE,
      installation: REVIEWS_INSTALLATION,
    });
  });

  it("contains a search failure rather than throwing past the lane", async () => {
    github.listReviewRequests = async () => {
      throw new Error("GraphQL upstream 502");
    };
    const r = await collectReviewRequests(deps());
    expect(r.outcome).toBe("failed");
    expect(store.latestRuns(1)[0]?.outcome).toBe("failed");
  });

  it("a throwing logger cannot fail the lane", async () => {
    github.reviewRequests = [makeReviewRequest()];
    const r = await collectReviewRequests({
      ...deps(),
      log: () => {
        throw new Error("EPIPE");
      },
    });
    expect(r.outcome).toBe("ok");
  });
});

describe("reviewers are configuration (AD-19)", () => {
  it("reads reviewers from repos.yaml and defaults to none", () => {
    const dir = mkdtempSync(join(tmpdir(), "revcfg-"));
    const withReviewers = join(dir, "with.yaml");
    writeFileSync(
      withReviewers,
      "repos:\n  - repo: no42-org/twiki\nreviewers:\n  - indigo423\n",
    );
    expect(loadConfig(withReviewers).reviewers).toEqual(["indigo423"]);

    // A value carrying search syntax would silently rewrite the query.
    const injected = join(dir, "injected.yaml");
    writeFileSync(
      injected,
      "repos:\n  - repo: no42-org/twiki\nreviewers:\n  - indigo423 org:evil\n",
    );
    expect(() => loadConfig(injected)).toThrow(/one login per entry/);

    // No default in source: unset means the lane does not run.
    const without = join(dir, "without.yaml");
    writeFileSync(without, "repos:\n  - repo: no42-org/twiki\n");
    expect(loadConfig(without).reviewers).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the reviews page", () => {
  let dir: string;
  let store: SqliteStore;

  const seed = (payloads: { subject: never; payload: never }[]) => {
    const r = store.beginRun({
      lane: LANE,
      installation: REVIEWS_INSTALLATION,
      scope: "full",
      startedAt: "2026-08-21T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-21T11:55:00.000Z", payloads);
    store.finishRun(r, "ok", "2026-08-21T11:55:00.000Z");
  };

  const request = (over: Record<string, unknown> = {}) => ({
    subject: { type: "review_request", key: `RR_${over.number ?? 1}` },
    payload: {
      repo: "opennms/opennms",
      number: 8803,
      title: "Topology Preview UI",
      author: "someone-else",
      htmlUrl: "https://github.com/OpenNMS/opennms/pull/8803",
      createdAt: "2026-08-19T17:48:49Z",
      requestedReviewers: ["indigo423", "other"],
      ...over,
    },
  });

  const app = () =>
    createApp({
      store,
      watched: [{ owner: "no42-org", name: "packyard" }],
      policy: SWEEP,
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "revpage-"));
    store = SqliteStore.openForWrite(join(dir, "p.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("marks the rows whose repository nothing else covers", () => {
    // The honesty this page turns on: an unwatched row carries no alerts,
    // no coverage and no build status, and must not be mistaken for one
    // that does.
    seed([
      request(),
      request({ number: 41, repo: "no42-org/packyard" }),
    ] as never[]);

    const view = buildReviewView(
      store,
      [{ owner: "no42-org", name: "packyard" }],
      NOW,
      SWEEP,
    );

    const byRepo = Object.fromEntries(
      view.rows.map((r) => [r.repo, r.watched]),
    );
    expect(byRepo).toEqual({
      "opennms/opennms": false,
      "no42-org/packyard": true,
    });
  });

  it("does not call an empty list none-waiting until a sweep says so", () => {
    // AD-28 again: nothing collected and nothing waiting are different
    // facts, and the page says which.
    const empty = buildReviewView(store, [], NOW, SWEEP);
    expect(empty.attested).toBe(false);

    seed([]);
    const swept = buildReviewView(store, [], NOW, SWEEP);
    expect(swept.attested).toBe(true);
    expect(swept.rows).toEqual([]);
  });

  it("serves the page, saying which rows are unwatched", async () => {
    seed([
      request(),
      request({ number: 41, repo: "no42-org/packyard" }),
    ] as never[]);

    const res = await app().request("/reviews");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("opennms/opennms#8803");
    expect(html).toContain("not watched");
    expect(html).toContain("Waiting on your review");
    // And says plainly what an unwatched row does not carry.
    expect(html).toContain("no alerts, no coverage, no build status");
  });

  it("lists the oldest request first, and says how long it has waited", () => {
    // The column the page turns on. An earlier version sorted by repository
    // name while its comment claimed otherwise, so a request left for
    // months in a late-alphabet repository sorted last and nothing showed
    // how long anything had been waiting.
    seed([
      request({ number: 1, createdAt: "2026-08-20T00:00:00Z" }),
      request({ number: 2, createdAt: "2026-02-01T00:00:00Z" }),
    ] as never[]);

    const view = buildReviewView(store, [], NOW, SWEEP);

    expect(view.rows.map((r) => r.number)).toEqual([2, 1]);
    // And the wait is rendered from the request's own age, not the sweep's.
    expect(view.rows[0]?.waiting).not.toBe(view.rows[0]?.age);
  });

  it("names the reviewers rather than counting them", async () => {
    // GraphQL reports a TEAM request by its slug, so counting produced
    // "just you" for a pull request nobody had asked the reader for
    // personally.
    seed([request({ requestedReviewers: ["maintainers"] })] as never[]);

    const html = await (await app().request("/reviews")).text();

    expect(html).toContain("maintainers");
    expect(html).not.toContain("just you");
  });

  it("counts a malformed row instead of dropping it", () => {
    seed([
      request(),
      {
        subject: { type: "review_request", key: "RR_bad" },
        payload: { repo: 42 },
      },
    ] as never[]);

    const view = buildReviewView(store, [], NOW, SWEEP);

    expect(view.rows).toHaveLength(1);
    expect(view.unreadable).toBe(1);
  });

  it("drops a non-https link but keeps the row", () => {
    seed([request({ htmlUrl: "javascript:alert(1)" })] as never[]);

    const view = buildReviewView(store, [], NOW, SWEEP);

    expect(view.rows).toHaveLength(1);
    expect(view.rows[0]?.htmlUrl).toBeNull();
  });

  it("links the reviews page from the nav", async () => {
    const html = await (await app().request("/queue")).text();
    expect(html).toContain('href="/reviews"');
  });
});
