/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RANK_POLICY } from "../src/core/rank.js";
import { KEV_SUBJECT } from "../src/core/subject.js";
import { normalise } from "../src/tricorder/collect/dependabot-alerts.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { createApp } from "../src/tricorder/web/app.js";
import { buildQueue } from "../src/tricorder/web/queue.js";
import { makeAlert } from "./fakes.js";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const SWEEP = { cadenceMs: 15 * 60_000 };
const DAILY = { cadenceMs: 24 * 60 * 60_000 };
const DEPS = {
  policy: SWEEP,
  kevPolicy: DAILY,
  rankPolicy: DEFAULT_RANK_POLICY,
};

describe("the ranked queue (CAP-6)", () => {
  let dir: string;
  let store: SqliteStore;

  const run = () =>
    store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-17T11:55:00.000Z",
    });

  const seedAlerts = (
    alerts: Parameters<typeof makeAlert>[0][],
    at = "2026-08-17T11:55:00.000Z",
  ) => {
    store.recordObservations(
      run(),
      at,
      alerts.map((a) => normalise(makeAlert(a))),
    );
  };

  const seedKev = (cveIds: string[], at = "2026-08-17T11:00:00.000Z") => {
    store.recordObservations(run(), at, [
      {
        subject: KEV_SUBJECT,
        payload: { version: "2026.08.17", released: at, cveIds },
      },
    ]);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "queue-"));
    store = SqliteStore.openForWrite(join(dir, "q.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sorts a KEV-listed alert above a higher-EPSS one with no listing", () => {
    // Story 18's acceptance criterion, word for word. This is the ordering the
    // whole chain exists to produce, and until this page nothing asserted it
    // end to end against the store.
    seedKev(["CVE-2021-44228"]);
    seedAlerts([
      {
        number: 1,
        cveId: "CVE-2025-0001",
        epssPercentage: 0.69,
        severity: "high",
      },
      {
        number: 2,
        cveId: "CVE-2021-44228",
        epssPercentage: 0.02,
        severity: "critical",
      },
    ]);

    const queue = buildQueue(store, NOW, DEPS);

    expect(queue.items.map((i) => i.number)).toEqual([2, 1]);
    expect(queue.items[0]?.kevListed).toBe(true);
    expect(queue.items[0]?.explanation).toContain("listed in CISA KEV");
  });

  it("ranks an alert with no EPSS above one measured low, never below", () => {
    // AD-20: absent ranks as unknown, never as zero risk. 9 of the 67 alerts
    // measured on the live estate carried no EPSS, so this is a standing path.
    seedKev(["CVE-0000-0000"]);
    seedAlerts([
      { number: 1, epssPercentage: 0.001, severity: "high" },
      { number: 2, epssPercentage: null, severity: "high" },
    ]);

    const queue = buildQueue(store, NOW, DEPS);

    expect(queue.items.map((i) => i.number)).toEqual([2, 1]);
    expect(queue.items[0]?.explanation).toContain("EPSS unknown");
  });

  it("ranks every KEV verdict unknown when the catalogue was never fetched", () => {
    // The story's other acceptance criterion: a failed KEV fetch renders
    // unknown and ranks as unknown, never as "not listed".
    seedAlerts([{ number: 1, cveId: "CVE-2025-0001", epssPercentage: 0.02 }]);

    const queue = buildQueue(store, NOW, DEPS);

    expect(queue.kev.usable).toBe(false);
    expect(queue.items[0]?.explanation).toContain("KEV status unknown");
  });

  it("stops trusting KEV verdicts once the catalogue goes stale", () => {
    seedKev(["CVE-2025-0001"], "2026-08-10T00:00:00.000Z");
    seedAlerts([{ number: 1, cveId: "CVE-2025-0001" }]);

    const queue = buildQueue(store, NOW, DEPS);

    expect(queue.kev.usable).toBe(false);
    expect(queue.items[0]?.explanation).toContain("KEV status unknown");
  });

  it("says n/a rather than unknown for an advisory with no CVE", () => {
    seedKev(["CVE-0000-0000"]);
    seedAlerts([{ number: 1, cveId: null, ghsaId: "GHSA-xxxx-yyyy-zzzz" }]);

    const queue = buildQueue(store, NOW, DEPS);

    expect(queue.items[0]?.advisory).toBe("GHSA-xxxx-yyyy-zzzz");
    expect(queue.items[0]?.explanation).toContain("no CVE to check");
  });

  it("excludes a resolved alert from the queue", () => {
    seedAlerts([{ number: 1 }, { number: 2 }]);
    store.recordTombstones(run(), "2026-08-17T11:56:00.000Z", [
      { type: "dependabot_alert", key: "no42-org/twiki#1" },
    ]);

    const queue = buildQueue(store, NOW, DEPS);

    expect(queue.items.map((i) => i.number)).toEqual([2]);
  });

  it("counts an unreadable row instead of silently dropping it", () => {
    // A queue quietly missing items looks complete, which is the
    // confident-zero defect wearing a queue costume.
    seedAlerts([{ number: 1 }]);
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      {
        subject: { type: "dependabot_alert", key: "no42-org/broken#9" },
        payload: { nonsense: true },
      },
    ]);

    const queue = buildQueue(store, NOW, DEPS);

    expect(queue.items).toHaveLength(1);
    expect(queue.unreadable).toBe(1);
  });

  it("reorders when a configured threshold moves, and only then", () => {
    // CAP-6: changing a configured threshold changes the order; no
    // configuration path reorders the chain itself.
    seedKev(["CVE-0000-0000"]);
    seedAlerts([
      { number: 1, epssPercentage: 0.2, severity: "low" },
      { number: 2, epssPercentage: 0.05, severity: "critical" },
    ]);

    const coarse = buildQueue(store, NOW, {
      ...DEPS,
      rankPolicy: { epssBands: [0.5, 0.1, 0.01] },
    });
    const fine = buildQueue(store, NOW, {
      ...DEPS,
      rankPolicy: { epssBands: [0.5, 0.3, 0.01] },
    });

    expect(coarse.items.map((i) => i.number)).toEqual([1, 2]);
    expect(fine.items.map((i) => i.number)).toEqual([2, 1]);
  });

  it("gives every row its own freshness, judged on the sweep cadence", () => {
    seedKev(["CVE-0000-0000"]);
    seedAlerts([{ number: 1 }], "2026-08-17T09:00:00.000Z");
    seedAlerts([{ number: 2 }], "2026-08-17T11:55:00.000Z");

    const byNumber = new Map(
      buildQueue(store, NOW, DEPS).items.map((i) => [i.number, i]),
    );

    expect(byNumber.get(1)?.freshness).toBe("stale");
    expect(byNumber.get(2)?.freshness).toBe("fresh");
  });

  it("breaks rank ties deterministically so the page does not reshuffle", () => {
    seedKev(["CVE-0000-0000"]);
    seedAlerts([
      { number: 3, repo: { owner: "no42-org", name: "zzz" } },
      { number: 1, repo: { owner: "no42-org", name: "aaa" } },
    ]);

    const first = buildQueue(store, NOW, DEPS).items.map((i) => i.key);
    const second = buildQueue(store, NOW, DEPS).items.map((i) => i.key);

    expect(first).toEqual(["no42-org/aaa#1", "no42-org/zzz#3"]);
    expect(second).toEqual(first);
  });
});

describe("the queue page", () => {
  let dir: string;
  let store: SqliteStore;

  const app = () =>
    createApp({
      store,
      watched: [{ owner: "no42-org", name: "twiki" }],
      policy: SWEEP,
      lanePolicies: { kev: DAILY },
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "queuep-"));
    store = SqliteStore.openForWrite(join(dir, "p.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the queue with reasons and per-row freshness", async () => {
    const r = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-17T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number: 7, severity: "critical" })),
      {
        subject: KEV_SUBJECT,
        payload: {
          version: "2026.08.17",
          released: "x",
          cveIds: ["CVE-2026-0001"],
        },
      },
    ]);

    const res = await app().request("/queue");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("no42-org/twiki#7");
    expect(html).toContain("severity critical");
    expect(html).toContain("fresh");
  });

  it("labels the ordering a local policy, never SSVC (AD-20)", async () => {
    const html = await (await app().request("/queue")).text();
    expect(html).toContain("local policy");
    expect(html).toContain("not SSVC");
  });

  it("says plainly when the KEV catalogue is unavailable", async () => {
    const html = await (await app().request("/queue")).text();
    expect(html).toContain("KEV status ranks as unknown");
  });

  it("links the two pages to each other", async () => {
    const queue = await (await app().request("/queue")).text();
    const home = await (await app().request("/")).text();
    expect(queue).toContain('href="/"');
    expect(home).toContain('href="/queue"');
  });
});
