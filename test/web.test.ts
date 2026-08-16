/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alertSubject } from "../src/core/subject.js";
import {
  normalise,
  summariseRepo,
} from "../src/tricorder/collect/dependabot-alerts.js";
import type { RunRef } from "../src/tricorder/store/port.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { createApp } from "../src/tricorder/web/app.js";
import {
  ageLabel,
  DEFAULT_STALE_AFTER_CADENCES,
  freshness,
} from "../src/tricorder/web/freshness.js";
import { DEFAULT_HOST, startServer } from "../src/tricorder/web/server.js";
import {
  buildCollectionHealth,
  buildRepoRows,
} from "../src/tricorder/web/view.js";
import { makeAlert } from "./fakes.js";

const REPO = { owner: "no42-org", name: "twiki" };
const OTHER = { owner: "no42-org", name: "quiet" };
const NEVER = { owner: "no42-org", name: "unseen" };
const POLICY = { cadenceMs: 15 * 60_000 };
const NOW = new Date("2026-08-16T12:00:00.000Z");

describe("freshness (AD-11)", () => {
  it("is fresh inside the cadence budget", () => {
    const seen = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    expect(freshness(seen, NOW, POLICY)).toBe("fresh");
  });

  it("is stale beyond it", () => {
    const seen = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    expect(freshness(seen, NOW, POLICY)).toBe("stale");
  });

  it("treats never-collected as unknown, not stale", () => {
    expect(freshness(null, NOW, POLICY)).toBe("unknown");
    expect(freshness(undefined, NOW, POLICY)).toBe("unknown");
  });

  it("treats an unparseable stamp as unknown rather than ancient", () => {
    expect(freshness("last tuesday", NOW, POLICY)).toBe("unknown");
  });

  it("tolerates exactly the configured number of cadences", () => {
    const edge = new Date(
      NOW.getTime() - POLICY.cadenceMs * DEFAULT_STALE_AFTER_CADENCES,
    ).toISOString();
    expect(freshness(edge, NOW, POLICY)).toBe("fresh");

    const past = new Date(
      NOW.getTime() - POLICY.cadenceMs * DEFAULT_STALE_AFTER_CADENCES - 1000,
    ).toISOString();
    expect(freshness(past, NOW, POLICY)).toBe("stale");
  });

  it("labels ages readably", () => {
    expect(ageLabel(new Date(NOW.getTime() - 30_000).toISOString(), NOW)).toBe(
      "30s ago",
    );
    expect(
      ageLabel(new Date(NOW.getTime() - 20 * 60_000).toISOString(), NOW),
    ).toBe("20m ago");
    expect(ageLabel(null, NOW)).toBe("never collected");
  });
});

describe("repository rows", () => {
  let dir: string;
  let store: SqliteStore;
  let run: RunRef;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "web-"));
    store = SqliteStore.openForWrite(join(dir, "w.db"));
    run = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-16T11:55:00.000Z",
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("distinguishes a real zero from never collected", () => {
    const alerts = [makeAlert({ number: 1, repo: REPO })];
    // REPO has an alert; OTHER was swept and had none; NEVER was not swept.
    store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
      ...alerts.map(normalise),
      summariseRepo(REPO, alerts),
      summariseRepo(OTHER, alerts),
    ]);

    const rows = buildRepoRows(store, [REPO, OTHER, NEVER], NOW, POLICY);

    expect(rows[0]?.openAlerts).toBe(1);
    // A swept repository with no alerts is a REAL ZERO and reads as fresh.
    // This is the case the first version of this test got wrong: its comment
    // said "collected and had none" while it asserted null.
    expect(rows[1]?.openAlerts).toBe(0);
    expect(rows[1]?.freshness).toBe("fresh");
    // Only a repository never swept is null and unknown.
    expect(rows[2]?.openAlerts).toBeNull();
    expect(rows[2]?.freshness).toBe("unknown");
  });

  it("keeps a newly-clean repository fresh, not permanently stale", () => {
    // It had an alert, the alert was fixed, and the sweep keeps confirming it.
    store.recordObservations(run, "2026-08-16T11:00:00.000Z", [
      normalise(makeAlert({ number: 1, repo: REPO })),
      summariseRepo(REPO, [makeAlert({ number: 1, repo: REPO })]),
    ]);
    store.recordTombstones(run, "2026-08-16T11:55:00.000Z", [
      alertSubject("dependabot_alert", REPO, 1),
    ]);
    store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
      summariseRepo(REPO, []),
    ]);

    const rows = buildRepoRows(store, [REPO], NOW, POLICY);

    expect(rows[0]?.openAlerts).toBe(0);
    // Without the repository confirmation this read "stale" forever, crying
    // wolf on precisely the repository that had just become healthy.
    expect(rows[0]?.freshness).toBe("fresh");
  });

  it("counts a resolved alert as closed but still counts as confirmation", () => {
    const alerts = [makeAlert({ number: 1, repo: REPO })];
    store.recordObservations(run, "2026-08-16T11:50:00.000Z", [
      ...alerts.map(normalise),
      summariseRepo(REPO, alerts),
    ]);
    store.recordTombstones(run, "2026-08-16T11:55:00.000Z", [
      alertSubject("dependabot_alert", REPO, 1),
    ]);
    store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
      summariseRepo(REPO, []),
    ]);

    const rows = buildRepoRows(store, [REPO], NOW, POLICY);

    expect(rows[0]?.openAlerts).toBe(0);
    // We did look, so it is a real zero and it is fresh.
    expect(rows[0]?.freshness).toBe("fresh");
  });

  it("goes stale when the collector stops rather than showing a stale count as current", () => {
    const alerts = [makeAlert({ number: 1, repo: REPO })];
    store.recordObservations(run, "2026-08-16T09:00:00.000Z", [
      ...alerts.map(normalise),
      summariseRepo(REPO, alerts),
    ]);

    const rows = buildRepoRows(store, [REPO], NOW, POLICY);

    expect(rows[0]?.openAlerts).toBe(1);
    expect(rows[0]?.freshness).toBe("stale");
  });

  it("reports the worst severity present", () => {
    const alerts = [
      makeAlert({ number: 1, repo: REPO, severity: "medium" }),
      makeAlert({ number: 2, repo: REPO, severity: "critical" }),
      makeAlert({ number: 3, repo: REPO, severity: "low" }),
    ];
    store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
      ...alerts.map(normalise),
      summariseRepo(REPO, alerts),
    ]);

    const rows = buildRepoRows(store, [REPO], NOW, POLICY);

    expect(rows[0]?.openAlerts).toBe(3);
    expect(rows[0]?.worstSeverity).toBe("critical");
  });

  it("lists every watched repository, so a missing row never means healthy", () => {
    const rows = buildRepoRows(store, [REPO, OTHER, NEVER], NOW, POLICY);
    expect(rows.map((r) => r.slug)).toEqual([
      "no42-org/twiki",
      "no42-org/quiet",
      "no42-org/unseen",
    ]);
  });
});

describe("the page", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "page-"));
    store = SqliteStore.openForWrite(join(dir, "p.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const app = () =>
    createApp({
      store,
      watched: [REPO, NEVER],
      policy: POLICY,
      now: () => NOW,
    });

  it("renders the watched repositories", async () => {
    const res = await app().request("/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("no42-org/twiki");
    expect(html).toContain("no42-org/unseen");
  });

  it("shows a never-collected repository as not collected, not as zero", async () => {
    const html = await (await app().request("/")).text();
    expect(html).toContain("not collected");
    expect(html).toContain("never collected");
  });

  it("says plainly when no collection has ever run", async () => {
    const html = await (await app().request("/")).text();
    expect(html).toContain("No collection has run yet");
  });

  it("surfaces a failed run on the page, not only in the logs", async () => {
    const run = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-16T11:55:00.000Z",
    });
    store.finishRun(run, "failed", "2026-08-16T11:56:00.000Z", "token expired");

    const html = await (await app().request("/")).text();

    expect(html).toContain("failed");
    expect(html).toContain("token expired");
  });

  it("answers liveness separately from collection health", async () => {
    const res = await app().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("issues found in review", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rev-"));
    store = SqliteStore.openForWrite(join(dir, "r.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows a lane that stopped running, rather than losing it to a window", () => {
    const dead = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "abandoned",
      scope: "full",
      startedAt: "2026-08-16T06:00:00.000Z",
    });
    store.finishRun(dead, "ok", "2026-08-16T06:01:00.000Z");
    // Plenty of newer runs from healthy lanes.
    for (let i = 0; i < 50; i++) {
      const r = store.beginRun({
        lane: "rest-org-dependabot",
        installation: `live-${i % 5}`,
        scope: "full",
        startedAt: "2026-08-16T11:55:00.000Z",
      });
      store.finishRun(r, "ok", "2026-08-16T11:56:00.000Z");
    }

    const health = buildCollectionHealth(store, NOW, POLICY);
    const abandoned = health.find((h) => h.installation === "abandoned");

    expect(abandoned).toBeDefined();
    expect(abandoned?.freshness).toBe("stale");
  });

  it("shows an in-flight run as running, not as partial", () => {
    store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-16T11:59:00.000Z",
    });

    const health = buildCollectionHealth(store, NOW, POLICY);

    // A running lane in amber "something is wrong" styling trains the reader
    // to ignore the real thing.
    expect(health[0]?.outcome).toBe("running");
  });

  it("still shows a genuinely partial run as partial", () => {
    const run = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-16T11:55:00.000Z",
    });
    store.finishRun(run, "partial", "2026-08-16T11:56:00.000Z", "3 unreadable");

    const health = buildCollectionHealth(store, NOW, POLICY);

    expect(health[0]?.outcome).toBe("partial");
    expect(health[0]?.detail).toBe("3 unreadable");
  });

  it("emits a doctype so browsers do not fall into quirks mode", async () => {
    const res = await createApp({
      store,
      watched: [REPO],
      policy: POLICY,
      now: () => NOW,
    }).request("/");

    expect((await res.text()).startsWith("<!DOCTYPE html>")).toBe(true);
  });
});

describe("bind address (AD-12)", () => {
  it("defaults to loopback", () => {
    expect(DEFAULT_HOST).toBe("127.0.0.1");
  });

  it("warns loudly when bound anywhere else", () => {
    const logs: string[] = [];
    const server = startServer(
      createApp({
        store: {} as never,
        watched: [],
        policy: POLICY,
        now: () => NOW,
      }),
      { host: "0.0.0.0", port: 0, log: (m) => logs.push(m) },
    );

    expect(logs.some((l) => l.includes("WARNING"))).toBe(true);
    expect(logs.some((l) => l.includes("no UI authentication"))).toBe(true);
    server.close();
  });

  it("does not warn on any loopback spelling", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      const logs: string[] = [];
      const server = startServer(
        createApp({
          store: {} as never,
          watched: [],
          policy: POLICY,
          now: () => NOW,
        }),
        { host, port: 0, log: (m) => logs.push(m) },
      );
      expect(logs.some((l) => l.includes("WARNING"))).toBe(false);
      server.close();
    }
  });

  it("does not warn on the default", () => {
    const logs: string[] = [];
    const server = startServer(
      createApp({
        store: {} as never,
        watched: [],
        policy: POLICY,
        now: () => NOW,
      }),
      { port: 0, log: (m) => logs.push(m) },
    );

    expect(logs.some((l) => l.includes("WARNING"))).toBe(false);
    server.close();
  });
});
