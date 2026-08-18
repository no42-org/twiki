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
import type { UpdatePrObservation } from "../src/tricorder/collect/update-prs.js";
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

  it("counts a row with wrong-typed fields instead of throwing downstream", () => {
    // The confirmed 500: `cveId: 42` passed the two-field guard, kevSignal
    // called (42).trim(), and the whole page answered 500. The guard now
    // validates every field the queue consumes, so this is unreadable, and
    // "counted, not guessed at" is true rather than aspirational.
    seedAlerts([{ number: 1 }]);
    for (const [key, bad] of [
      [
        "no42-org/broken#2",
        {
          ...(normalise(makeAlert({ number: 2 })).payload as object),
          cveId: 42,
        },
      ],
      [
        "no42-org/broken#3",
        {
          ...(normalise(makeAlert({ number: 3 })).payload as object),
          severity: 5,
        },
      ],
      [
        "no42-org/broken#4",
        {
          ...(normalise(makeAlert({ number: 4 })).payload as object),
          epssPercentage: "high",
        },
      ],
    ] as const) {
      store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
        { subject: { type: "dependabot_alert", key }, payload: bad },
      ]);
    }

    const queue = buildQueue(store, NOW, DEPS);

    expect(queue.items.map((i) => i.number)).toEqual([1]);
    expect(queue.unreadable).toBe(3);
  });

  it("counts a row whose cveId key is missing entirely", () => {
    // Absent is not null: a missing key would have read as "no CVE to look
    // up", sinking the alert to n/a on the chain's top term when the honest
    // answer is that the row is unreadable.
    const p = normalise(makeAlert({ number: 5 })).payload as Record<
      string,
      unknown
    >;
    delete p.cveId;
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      {
        subject: { type: "dependabot_alert", key: "no42-org/broken#5" },
        payload: p,
      },
    ]);

    const queue = buildQueue(store, NOW, DEPS);
    expect(queue.items).toHaveLength(0);
    expect(queue.unreadable).toBe(1);
  });

  it("refuses to render a link with a non-https scheme", () => {
    // First store-derived href in the codebase, and hono/jsx renders
    // javascript: schemes verbatim. GitHub only hands out https, so anything
    // else is a corrupted or foreign row and loses its link, not its row.
    seedAlerts([
      { number: 1, htmlUrl: "javascript:alert(1)" },
      { number: 2, htmlUrl: "https://github.com/x/y/security/dependabot/2" },
    ]);

    const byNumber = new Map(
      buildQueue(store, NOW, DEPS).items.map((i) => [i.number, i]),
    );
    expect(byNumber.get(1)?.htmlUrl).toBeNull();
    expect(byNumber.get(2)?.htmlUrl).toContain("https://");
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

describe("update PRs in the queue (CAP-3)", () => {
  let dir: string;
  let store: SqliteStore;

  const run = () =>
    store.beginRun({
      lane: "graphql-update-prs",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-17T11:55:00.000Z",
    });

  const seedPr = (nodeId: string, over: Partial<UpdatePrObservation> = {}) => {
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      {
        subject: { type: "dependency_update_pr", key: nodeId },
        payload: {
          repo: "no42-org/twiki",
          number: 1,
          title: "Bump x from 1.0.0 to 1.0.1",
          author: "dependabot",
          htmlUrl: "https://github.com/no42-org/twiki/pull/1",
          createdAt: "2026-08-17T00:00:00.000Z",
          packageName: "x",
          bump: "patch",
          ...over,
        } satisfies UpdatePrObservation,
      },
    ]);
  };

  const seedAlert = (
    number: number,
    over: Partial<Parameters<typeof makeAlert>[0]> = {},
  ) => {
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number, ...over })),
    ]);
  };

  const seedKev = (cveIds: string[]) => {
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      {
        subject: KEV_SUBJECT,
        payload: { version: "v", released: "r", cveIds },
      },
    ]);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "queuepr-"));
    store = SqliteStore.openForWrite(join(dir, "qp.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sorts a PR fixing a KEV-listed CVE above one with a higher-EPSS advisory", () => {
    // CAP-3's acceptance criterion, word for word, through the local join: the
    // stored alerts carry package, CVE, EPSS and severity, so the PR inherits
    // the risk of what it fixes without any extra API call.
    seedKev(["CVE-2021-44228"]);
    seedAlert(1, {
      packageName: "log4j",
      cveId: "CVE-2021-44228",
      epssPercentage: 0.02,
    });
    seedAlert(2, {
      packageName: "lodash",
      cveId: "CVE-2025-0001",
      epssPercentage: 0.69,
    });
    seedPr("PR_kev", { number: 10, packageName: "log4j" });
    seedPr("PR_epss", { number: 11, packageName: "lodash" });

    const prs = buildQueue(store, NOW, DEPS).items.filter(
      (i) => i.kind === "update_pr",
    );

    expect(prs.map((i) => i.number)).toEqual([10, 11]);
    expect(prs[0]?.kevListed).toBe(true);
    expect(prs[0]?.advisory).toBe("CVE-2021-44228");
  });

  it("treats a PR with no matching open alert as a plain update", () => {
    // Facts of absence, not gaps: no open alert affects this package, so its
    // security terms are n/a. Calling them unknown would float every routine
    // bump above every alert we checked and found absent.
    seedKev(["CVE-0000-0000"]);
    seedAlert(1, { packageName: "unrelated", epssPercentage: 0.001 });
    seedPr("PR_plain", { number: 12, packageName: "left-pad" });

    const items = buildQueue(store, NOW, DEPS).items;
    const pr = items.find((i) => i.kind === "update_pr");
    const alert = items.find((i) => i.kind === "alert");

    expect(pr?.explanation).toContain("no CVE to check");
    // The measured alert, however dull, outranks the plain update on nothing:
    // they differ only where the chain says they differ.
    expect(alert).toBeDefined();
  });

  it("orders plain updates by bump size, with unknown between patch and minor", () => {
    seedKev(["CVE-0000-0000"]);
    seedPr("PR_major", { number: 1, bump: "major", packageName: "a" });
    seedPr("PR_unknown", { number: 2, bump: null, packageName: "b" });
    seedPr("PR_patch", { number: 3, bump: "patch", packageName: "c" });

    const prs = buildQueue(store, NOW, DEPS).items.filter(
      (i) => i.kind === "update_pr",
    );

    expect(prs.map((i) => i.number)).toEqual([1, 2, 3]);
    expect(prs[1]?.explanation).toContain("bump unknown");
  });

  it("judges a PR fixing two advisories by the more urgent one", () => {
    seedKev(["CVE-2021-44228"]);
    seedAlert(1, {
      packageName: "log4j",
      cveId: "CVE-2025-1111",
      epssPercentage: 0.001,
      severity: "low",
    });
    seedAlert(2, {
      packageName: "log4j",
      cveId: "CVE-2021-44228",
      epssPercentage: 0.02,
      severity: "critical",
    });
    seedPr("PR_two", { number: 20, packageName: "log4j" });

    const pr = buildQueue(store, NOW, DEPS).items.find(
      (i) => i.kind === "update_pr",
    );

    expect(pr?.advisory).toBe("CVE-2021-44228");
    expect(pr?.kevListed).toBe(true);
  });

  it("counts a malformed PR row instead of dropping or throwing", () => {
    seedPr("PR_ok", { number: 1 });
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      {
        subject: { type: "dependency_update_pr", key: "PR_bad" },
        payload: { repo: "no42-org/twiki", number: "seven" },
      },
    ]);

    const queue = buildQueue(store, NOW, DEPS);
    expect(queue.items.filter((i) => i.kind === "update_pr")).toHaveLength(1);
    expect(queue.unreadable).toBe(1);
  });

  it("drops a non-https PR link but keeps the row", () => {
    seedPr("PR_evil", { number: 1, htmlUrl: "javascript:alert(1)" });
    const pr = buildQueue(store, NOW, DEPS).items.find(
      (i) => i.kind === "update_pr",
    );
    expect(pr).toBeDefined();
    expect(pr?.htmlUrl).toBeNull();
  });
});

describe("the queue page", () => {
  let dir: string;
  let store: SqliteStore;

  const run = () =>
    store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-17T11:55:00.000Z",
    });

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
    const r = run();
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

  it("answers 200 with the readable rows when a stored row is malformed", async () => {
    const r = run();
    store.recordObservations(r, "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number: 1 })),
      {
        subject: { type: "dependabot_alert", key: "no42-org/broken#2" },
        payload: { number: 2, repo: "no42-org/broken", cveId: 42 },
      },
    ]);

    const res = await app().request("/queue");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("no42-org/twiki#1");
    expect(html).toContain("could not be read");
    expect(html).toContain("incomplete");
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

  it("judges the KEV index on its own daily cadence, not the sweep's", async () => {
    // The view-model tests pass kevPolicy directly, so unwiring the fallback
    // in createApp was invisible: a one-hour-old catalogue is stale on the
    // sweep budget and fresh on the daily one, and only the page exercises the
    // wiring.
    const r = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-17T11:00:00.000Z",
    });
    store.recordObservations(r, "2026-08-17T11:00:00.000Z", [
      {
        subject: KEV_SUBJECT,
        payload: { version: "v", released: "x", cveIds: ["CVE-2026-0001"] },
      },
    ]);
    const r2 = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-17T11:55:00.000Z",
    });
    store.recordObservations(r2, "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number: 1, cveId: "CVE-2026-0001" })),
    ]);

    const html = await (await app().request("/queue")).text();

    expect(html).toContain("listed in CISA KEV");
    expect(html).not.toContain("KEV status ranks as unknown");
  });

  it("applies the configured thresholds, not the defaults", async () => {
    // Under the custom bands both items share an EPSS band and severity
    // decides; under the defaults EPSS decides the other way. Unwiring
    // rankPolicy in createApp silently reverts to the defaults.
    const r = run();
    store.recordObservations(r, "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number: 1, epssPercentage: 0.2, severity: "low" })),
      normalise(
        makeAlert({ number: 2, epssPercentage: 0.05, severity: "critical" }),
      ),
    ]);

    const custom = createApp({
      store,
      watched: [{ owner: "no42-org", name: "twiki" }],
      policy: SWEEP,
      lanePolicies: { kev: DAILY },
      rankPolicy: { epssBands: [0.5, 0.3, 0.01] },
      now: () => NOW,
    });
    const html = await (await custom.request("/queue")).text();

    const first = html.indexOf("no42-org/twiki#2");
    const second = html.indexOf("no42-org/twiki#1");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(-1);
    expect(first, "critical leads under the custom bands").toBeLessThan(second);
  });

  it("links the two pages to each other", async () => {
    const queue = await (await app().request("/queue")).text();
    const home = await (await app().request("/")).text();
    expect(queue).toContain('href="/"');
    expect(home).toContain('href="/queue"');
  });
});
