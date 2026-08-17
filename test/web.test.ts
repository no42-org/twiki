/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alertSubject, coverageSubject } from "../src/core/subject.js";
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
import { parsePort } from "../src/tricorder.js";
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

  it("tombstones the alert and drops it out of the repository's count", () => {
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

    // The alert is gone as a subject, not merely absent from the count.
    expect(
      store.current(alertSubject("dependabot_alert", REPO, 1))?.state,
    ).toBe("resolved");
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

// A second review round found each of the following could break with the whole
// suite green. Every test here was checked by mutating the code it covers.
describe("issues found in review (round 2)", () => {
  let dir: string;
  let store: SqliteStore;
  let run: RunRef;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "web2-"));
    store = SqliteStore.openForWrite(join(dir, "s.db"));
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

  describe("repository rows", () => {
    it("does not render a tombstoned confirmation as live data", () => {
      const alerts = [
        makeAlert({ number: 1, repo: REPO, severity: "critical" }),
      ];
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        summariseRepo(REPO, alerts),
      ]);
      store.recordTombstones(run, "2026-08-16T11:56:00.000Z", [
        { type: "repository" as const, key: "no42-org/twiki" },
      ]);

      const rows = buildRepoRows(store, [REPO], NOW, POLICY);

      // A retracted assertion is not a zero and not a count. It is "we do not
      // know", which is what never-collected already means.
      expect(rows[0]?.openAlerts).toBeNull();
      expect(rows[0]?.freshness).toBe("unknown");
    });

    it("matches a mixed-case repos.yaml entry to its confirmation", () => {
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        summariseRepo(REPO, []),
      ]);

      // repos.yaml said No42-Org/TWiki; subject keys are case-folded (AD-22).
      const rows = buildRepoRows(
        store,
        [{ owner: "No42-Org", name: "TWiki" }],
        NOW,
        POLICY,
      );

      expect(rows[0]?.openAlerts).toBe(0);
      expect(rows[0]?.freshness).toBe("fresh");
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
    const render = async () =>
      (
        await createApp({
          store,
          watched: [REPO, OTHER, NEVER],
          policy: POLICY,
          now: () => NOW,
        }).request("/")
      ).text();

    it("renders a confirmed zero distinctly from a never-collected repository", async () => {
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        summariseRepo(OTHER, []),
      ]);

      const html = await render();

      // Three states, three renderings. Collapsing the first two is the lie
      // this dashboard exists to avoid, and nothing rendered them before.
      expect(html).toContain('<span class="none">0</span>');
      expect(html).toContain('<span class="never">not collected</span>');
    });

    it("renders the count and severity for a repository with alerts", async () => {
      const alerts = [
        makeAlert({ number: 1, repo: REPO, severity: "critical" }),
      ];
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        summariseRepo(REPO, alerts),
      ]);

      const html = await render();

      expect(html).toContain("crit");
      expect(html).toContain("critical");
    });

    it("does not paint a stale zero in the good-news green", async () => {
      store.recordObservations(run, "2026-08-16T09:00:00.000Z", [
        summariseRepo(OTHER, []),
      ]);

      const html = await render();

      expect(html).toContain("<span>0</span>");
      expect(html).not.toContain('<span class="none">0</span>');
    });

    it("refuses to be cached, so a stale copy cannot claim to be fresh", async () => {
      const res = await createApp({
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

  describe("coverage is a separate axis from freshness (AD-28)", () => {
    const cov = (repo: { owner: string; name: string }, state: string) => ({
      subject: coverageSubject(repo),
      payload: {
        repo: `${repo.owner}/${repo.name}`.toLowerCase(),
        state,
        archived: false,
      },
    });

    it("does not render a count for a repository nobody is watching", () => {
      // The defect the whole decision exists to remove. Measured on one real
      // organisation, 14 of 36 repositories were in exactly this state, and
      // every one of them would otherwise show a confident green zero.
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        summariseRepo(REPO, []),
        cov(REPO, "alerts_disabled"),
      ]);

      const rows = buildRepoRows(store, [REPO], NOW, POLICY);

      expect(rows[0]?.coverage).toBe("alerts_disabled");
      expect(
        rows[0]?.openAlerts,
        "a count here invites belief in it",
      ).toBeNull();
      expect(rows[0]?.coverageReason).toContain("switched off");
    });

    it("still renders a real zero for a repository that is watched", () => {
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        summariseRepo(REPO, []),
        cov(REPO, "covered"),
      ]);
      const rows = buildRepoRows(store, [REPO], NOW, POLICY);
      expect(rows[0]?.openAlerts).toBe(0);
      expect(rows[0]?.coverageReason).toBeNull();
    });

    it("leaves the count alone until the coverage lane has ever run", () => {
      // Absent coverage is not "not covered". Suppressing counts before the
      // lane exists would blank a page that was working.
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        summariseRepo(REPO, []),
      ]);
      const rows = buildRepoRows(store, [REPO], NOW, POLICY);
      expect(rows[0]?.coverage).toBeNull();
      expect(rows[0]?.openAlerts).toBe(0);
    });

    it("says not covered on the page, not not collected", async () => {
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        summariseRepo(REPO, []),
        cov(REPO, "archived"),
      ]);

      const html = await (
        await createApp({
          store,
          watched: [REPO],
          policy: POLICY,
          now: () => NOW,
        }).request("/")
      ).text();

      // "not collected" would blame the collector for GitHub's setting.
      expect(html).toContain("not covered");
      expect(html).toContain("archived");
      expect(html).not.toContain("not collected");
    });

    it("stops trusting coverage once its own attestation goes stale", () => {
      // The reason coverage is a separate subject at all. If the coverage lane
      // dies and somebody then switches Dependabot off, a cached `covered`
      // would keep the page showing a confident, freshly-badged zero.
      store.recordObservations(run, "2026-08-10T00:00:00.000Z", [
        cov(REPO, "covered"),
      ]);
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        summariseRepo(REPO, []),
      ]);

      const daily = { cadenceMs: 24 * 60 * 60_000 };
      const rows = buildRepoRows(store, [REPO], NOW, POLICY, daily);

      expect(rows[0]?.coverage, "a week old is not an attestation").toBe(
        "unknown",
      );
    });

    it("judges coverage on its own daily cadence, not the sweep cadence", () => {
      // Judged on the 15-minute sweep policy, every daily attestation would
      // read as stale within half an hour and coverage would never be trusted.
      store.recordObservations(run, "2026-08-16T09:00:00.000Z", [
        cov(REPO, "covered"),
        summariseRepo(REPO, []),
      ]);
      const daily = { cadenceMs: 24 * 60 * 60_000 };
      const rows = buildRepoRows(store, [REPO], NOW, POLICY, daily);
      expect(rows[0]?.coverage).toBe("covered");
    });

    it("does not blank a count merely because a probe failed", () => {
      // `unknown` is not positive evidence of non-coverage. Blanking on it
      // would let one rate-limited probe wipe correct numbers off the page.
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        summariseRepo(REPO, [makeAlert({ number: 1, repo: REPO })]),
        cov(REPO, "unknown"),
      ]);
      const rows = buildRepoRows(store, [REPO], NOW, POLICY, POLICY);
      expect(rows[0]?.openAlerts).toBe(1);
    });

    it("ignores a tombstoned coverage row rather than trusting it", () => {
      store.recordObservations(run, "2026-08-16T11:50:00.000Z", [
        summariseRepo(REPO, []),
        cov(REPO, "alerts_disabled"),
      ]);
      store.recordTombstones(run, "2026-08-16T11:55:00.000Z", [
        coverageSubject(REPO),
      ]);

      const rows = buildRepoRows(store, [REPO], NOW, POLICY);
      expect(rows[0]?.coverage).toBeNull();
    });
  });

  describe("per-lane cadences reach the rendered page", () => {
    it("does not show a daily lane as stale through createApp", async () => {
      // The unit test for this bypassed createApp, so deleting the argument at
      // its only wiring point left 401 tests green while the dashboard
      // permanently red-flagged two healthy lanes.
      const r = store.beginRun({
        lane: "kev",
        installation: "cisa",
        scope: "full",
        startedAt: "2026-08-16T06:00:00.000Z",
      });
      store.finishRun(r, "ok", "2026-08-16T06:00:00.000Z");

      const html = await (
        await createApp({
          store,
          watched: [REPO],
          policy: POLICY,
          lanePolicies: { kev: { cadenceMs: 24 * 60 * 60_000 } },
          now: () => NOW,
        }).request("/")
      ).text();

      const kevRow = html.slice(html.indexOf("kev"));
      expect(kevRow).toContain("fresh");
      expect(kevRow.slice(0, 200)).not.toContain("stale");
    });

    it("falls back to the sweep policy for a lane with no entry", async () => {
      const r = store.beginRun({
        lane: "rest-org-dependabot",
        installation: "no42-org",
        scope: "full",
        startedAt: "2026-08-16T06:00:00.000Z",
      });
      store.finishRun(r, "ok", "2026-08-16T06:00:00.000Z");

      const html = await (
        await createApp({
          store,
          watched: [REPO],
          policy: POLICY,
          lanePolicies: { kev: { cadenceMs: 24 * 60 * 60_000 } },
          now: () => NOW,
        }).request("/")
      ).text();

      expect(html).toContain("stale");
    });
  });
});
