/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ageLabel,
  DEFAULT_STALE_AFTER_CADENCES,
  freshness,
} from "../src/tricorder/attention/freshness.js";
import { buildCollectionHealth } from "../src/tricorder/attention/health.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { createApp } from "../src/tricorder/web/app.js";
import { DEFAULT_HOST, startServer } from "../src/tricorder/web/server.js";
import { parsePort } from "../src/tricorder.js";

const REPO = { owner: "no42-org", name: "twiki" };
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
      defaultBranchOf: () => "main",
      store,
      watched: [REPO, NEVER],
      policy: POLICY,
      now: () => NOW,
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
      defaultBranchOf: () => "main",
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
        defaultBranchOf: () => "main",
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
          defaultBranchOf: () => "main",
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
        defaultBranchOf: () => "main",
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

// A second review round found each of the following could break with the whole
// suite green. Every test here was checked by mutating the code it covers.
describe("issues found in review (round 2)", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "web2-"));
    store = SqliteStore.openForWrite(join(dir, "s.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("clock skew", () => {
    const future = new Date(NOW.getTime() + 6 * 60 * 60_000).toISOString();

    it("does not read a future timestamp as maximally fresh", () => {
      // `now - seen <= budget` is satisfied trivially by any future stamp, so
      // the least trustworthy value on the page got the most reassuring badge.
      expect(freshness(future, NOW, POLICY)).toBe("stale");
    });

    it("says the clock is wrong rather than clamping to 0s ago", () => {
      expect(ageLabel(future, NOW)).toContain("clock skew");
    });

    it("still tolerates a few seconds of ordinary drift", () => {
      const drift = new Date(NOW.getTime() + 5_000).toISOString();
      expect(freshness(drift, NOW, POLICY)).toBe("fresh");
    });
  });

  describe("collection health", () => {
    it("shows a run still in flight as running", () => {
      store.beginRun({
        lane: "rest-org-dependabot",
        installation: "live",
        scope: "full",
        startedAt: "2026-08-16T11:59:00.000Z",
      });

      const h = buildCollectionHealth(store, NOW, POLICY).find(
        (r) => r.installation === "live",
      );
      expect(h?.outcome).toBe("running");
      expect(h?.freshness).toBe("fresh");
    });

    it("does not show a crashed collector as running and fresh forever", () => {
      store.beginRun({
        lane: "rest-org-dependabot",
        installation: "crashed",
        scope: "full",
        startedAt: "2026-06-01T00:00:00.000Z",
      });

      const h = buildCollectionHealth(store, NOW, POLICY).find(
        (r) => r.installation === "crashed",
      );

      // OOM, SIGKILL or eviction leaves exactly this row, and nothing will ever
      // finish it. Forcing it green hides the dead lane the table exists for.
      expect(h?.outcome).toBe("stalled");
      expect(h?.freshness).toBe("stale");
    });

    it("does not mistake a genuinely partial run for a running one", () => {
      const r = store.beginRun({
        lane: "rest-org-dependabot",
        installation: "same-stamp",
        scope: "full",
        startedAt: "2026-08-16T11:59:00.000Z",
      });
      // A fast lane can finish inside its own clock tick.
      store.finishRun(r, "partial", "2026-08-16T11:59:00.000Z", "3 unreadable");

      const h = buildCollectionHealth(store, NOW, POLICY).find(
        (x) => x.installation === "same-stamp",
      );
      // "running · 3 unreadable" is incoherent: it reports a detail only a
      // finished run can have.
      expect(h?.outcome).toBe("partial");
    });

    it("reports the newest run for a key, not the first one", () => {
      const key = {
        lane: "rest-org-dependabot",
        installation: "twice",
        scope: "full" as const,
      };
      const first = store.beginRun({
        ...key,
        startedAt: "2026-08-16T11:50:00.000Z",
      });
      store.finishRun(first, "ok", "2026-08-16T11:51:00.000Z");
      const second = store.beginRun({
        ...key,
        startedAt: "2026-08-16T11:56:00.000Z",
      });
      store.finishRun(second, "failed", "2026-08-16T11:57:00.000Z", "boom");

      const h = buildCollectionHealth(store, NOW, POLICY).find(
        (r) => r.installation === "twice",
      );

      // Returning the older row would report a stale success in place of the
      // current failure, which is the inverse of this table's job.
      expect(h?.outcome).toBe("failed");
      expect(h?.detail).toBe("boom");
    });
  });

  describe("the rendered page", () => {
    it("refuses to be cached, so a stale copy cannot claim to be fresh", async () => {
      const res = await createApp({
        defaultBranchOf: () => "main",
        store,
        watched: [REPO],
        policy: POLICY,
        now: () => NOW,
      }).request("/");

      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("bind address (AD-12)", () => {
    const serveOn = (host?: string) => {
      const logs: string[] = [];
      const server = startServer(
        createApp({
          defaultBranchOf: () => "main",
          store: {} as never,
          watched: [],
          policy: POLICY,
          now: () => NOW,
        }),
        { host, port: 0, log: (m) => logs.push(m) },
      );
      return { logs, server };
    };

    it("actually binds loopback by default, not merely logs that it did", async () => {
      const { server } = serveOn();
      await new Promise((r) => server.once("listening", r));

      // The warning is computed from the requested hostname, so dropping
      // hostname from serve() left every assertion about it still passing.
      const addr = server.address() as { address: string };
      expect(addr.address).toBe("127.0.0.1");
      server.close();
    });

    it("does not warn on loopback spellings beyond the obvious four", () => {
      for (const host of [
        "Localhost",
        "127.0.0.2",
        "::ffff:127.0.0.1",
        "0:0:0:0:0:0:0:1",
        "[::1]",
      ]) {
        const { logs, server } = serveOn(host);
        expect(
          logs.some((l) => l.includes("WARNING")),
          `${host} is loopback and must not warn`,
        ).toBe(false);
        server.close();
      }
    });
  });

  // Story 1.8 (#129): the title says what the page found, the primary nav
  // says where the reader is, and the skip links are the first Tab stops.
  // Each is asserted whole, never one attribute of it.

  describe("TRICORDER_PORT", () => {
    it("rejects 0, the arbitrary-port case the guard exists for", () => {
      expect(() => parsePort("0")).toThrow(/not a valid port/);
    });

    it("rejects values Number() would silently accept", () => {
      for (const raw of ["1e4", "0x1f", "8080.5", "abc", "-1", "70000"]) {
        expect(() => parsePort(raw), raw).toThrow(/not a valid port/);
      }
    });

    it("accepts a real port and treats unset as unset", () => {
      expect(parsePort("8787")).toBe(8787);
      expect(parsePort(undefined)).toBeUndefined();
      expect(parsePort("  ")).toBeUndefined();
    });
  });
});

// The web role's own wiring, asserted through the routes. Each of these
// could be unwired with the rest of the suite green, because every view-model
// test passes the value directly and only the app supplies it from a lane
// name or a guard.
