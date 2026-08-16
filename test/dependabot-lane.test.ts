/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alertSubject } from "../src/core/subject.js";
import type { AlertObservation } from "../src/tricorder/collect/dependabot-alerts.js";
import {
  collectAllOrgs,
  collectOrgAlerts,
  LANE,
  normalise,
  watchKey,
} from "../src/tricorder/collect/dependabot-alerts.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { FakeGitHubReadPort, makeAlert } from "./fakes.js";

const REPO = { owner: "no42-org", name: "twiki" };

describe("Dependabot alerts lane", () => {
  let dir: string;
  let store: SqliteStore;
  let github: FakeGitHubReadPort;
  let logs: string[];
  let clock: number;

  /** Watched set, case-folded, standing in for repos.yaml (AD-10). */
  let watched: Set<string>;

  const deps = () => ({
    github,
    store,
    isWatched: (repo: { owner: string; name: string }) =>
      watched.has(watchKey(repo)),
    now: () => new Date(Date.UTC(2026, 7, 16, 10, clock++)).toISOString(),
    log: (m: string) => logs.push(m),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lane-"));
    store = SqliteStore.openForWrite(join(dir, "s.db"));
    github = new FakeGitHubReadPort(new Map());
    logs = [];
    clock = 0;
    watched = new Set(["no42-org/twiki", "good-org/x", "other-org/x"]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("normalise", () => {
    it("keys the subject on repo and alert number, not a node id", () => {
      const o = normalise(makeAlert({ number: 7 }));
      expect(o.subject).toEqual(alertSubject("dependabot_alert", REPO, 7));
      expect(o.subject.key).toBe("no42-org/twiki#7");
    });

    it("carries EPSS through so it is captured at ingest", () => {
      const o = normalise(
        makeAlert({ epssPercentage: 0.42, epssPercentile: 0.91 }),
      );
      const payload = o.payload as AlertObservation;
      expect(payload.epssPercentage).toBe(0.42);
      expect(payload.epssPercentile).toBe(0.91);
    });

    it("tolerates an alert with no EPSS rather than inventing zero", () => {
      const o = normalise(
        makeAlert({ epssPercentage: null, epssPercentile: null }),
      );
      const payload = o.payload as AlertObservation;
      // Absent must stay absent: ranking treats null as unknown, and zero
      // would read as "no exploitation risk".
      expect(payload.epssPercentage).toBeNull();
    });
  });

  describe("collecting one organisation", () => {
    it("stores an alert per subject and records an ok run", async () => {
      github.orgAlerts.set("no42-org", [
        makeAlert({ number: 1 }),
        makeAlert({ number: 2, severity: "critical" }),
      ]);

      const result = await collectOrgAlerts(deps(), "no42-org", "full");

      expect(result).toEqual({
        installation: "no42-org",
        outcome: "ok",
        alerts: 2,
        unreadable: 0,
      });
      expect(store.currentByType("dependabot_alert")).toHaveLength(2);
      expect(store.latestRuns(1)[0]?.outcome).toBe("ok");
      expect(store.latestRuns(1)[0]?.lane).toBe(LANE);
    });

    it("gives every stored alert its freshness", async () => {
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      await collectOrgAlerts(deps(), "no42-org", "full");

      const [alert] = store.currentByType("dependabot_alert");
      expect(alert?.verifiedAt).toMatch(/^2026-08-16T/);
      expect(alert?.observedAt).toBe(alert?.verifiedAt);
    });

    it("records an empty organisation as ok, not as a failure", async () => {
      const result = await collectOrgAlerts(deps(), "empty-org", "full");

      expect(result.outcome).toBe("ok");
      expect(result.alerts).toBe(0);
      expect(store.latestRuns(1)[0]?.outcome).toBe("ok");
      // Zero alerts is a real answer, and must not read as stale later.
    });

    it("re-collecting the same alert confirms it without changing it", async () => {
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      await collectOrgAlerts(deps(), "no42-org", "full");
      const first = store.currentByType("dependabot_alert")[0];

      await collectOrgAlerts(deps(), "no42-org", "full");
      const second = store.currentByType("dependabot_alert")[0];

      expect(second?.observedAt).toBe(first?.observedAt);
      expect(second?.verifiedAt).not.toBe(first?.verifiedAt);
    });

    it("notices when an alert's severity changes", async () => {
      github.orgAlerts.set("no42-org", [
        makeAlert({ number: 1, severity: "medium" }),
      ]);
      await collectOrgAlerts(deps(), "no42-org", "full");
      const before = store.currentByType("dependabot_alert")[0];

      github.orgAlerts.set("no42-org", [
        makeAlert({ number: 1, severity: "critical" }),
      ]);
      await collectOrgAlerts(deps(), "no42-org", "full");
      const after = store.currentByType("dependabot_alert")[0];

      expect((after?.payload as AlertObservation | undefined)?.severity).toBe(
        "critical",
      );
      expect(after?.observedAt).not.toBe(before?.observedAt);
    });
  });

  describe("failure isolation (AD-16)", () => {
    it("records a failed run and does not throw", async () => {
      github.failingOrgs.add("broken-org");

      const result = await collectOrgAlerts(deps(), "broken-org", "full");

      expect(result.outcome).toBe("failed");
      const run = store.latestRuns(1)[0];
      expect(run?.outcome).toBe("failed");
      expect(run?.detail).toMatch(/unreachable/);
    });

    it("one broken organisation does not stop the others", async () => {
      github.orgAlerts.set("good-org", [
        makeAlert({ number: 1, repo: { owner: "good-org", name: "x" } }),
      ]);
      github.failingOrgs.add("broken-org");
      github.orgAlerts.set("other-org", [
        makeAlert({ number: 2, repo: { owner: "other-org", name: "x" } }),
      ]);

      const results = await collectAllOrgs(
        deps(),
        ["good-org", "broken-org", "other-org"],
        "full",
      );

      expect(results.map((r) => r.outcome)).toEqual(["ok", "failed", "ok"]);
      // The two healthy organisations' data still landed.
      expect(store.currentByType("dependabot_alert")).toHaveLength(2);
    });

    it("a failed run writes nothing, so nothing is silently blanked", async () => {
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      await collectOrgAlerts(deps(), "no42-org", "full");

      github.failingOrgs.add("no42-org");
      await collectOrgAlerts(deps(), "no42-org", "full");

      // The previous value survives, and its freshness stops advancing, which
      // is what makes it render stale rather than as a confident zero.
      const alerts = store.currentByType("dependabot_alert");
      expect(alerts).toHaveLength(1);
    });
  });

  describe("issues found in review", () => {
    it("matches the watched set case-insensitively", async () => {
      // repos.yaml said No42-Org; GitHub returns its own canonical casing.
      watched = new Set(["no42-org/twiki"]);
      github.orgAlerts.set("no42-org", [
        makeAlert({ number: 1, repo: { owner: "No42-Org", name: "TWiki" } }),
      ]);

      const result = await collectOrgAlerts(deps(), "no42-org", "full");

      expect(result.alerts).toBe(1);
    });

    it("drops alerts outside the watched set without failing", async () => {
      watched = new Set(["no42-org/twiki"]);
      github.orgAlerts.set("no42-org", [
        makeAlert({ number: 1 }),
        makeAlert({ number: 2, repo: { owner: "no42-org", name: "other" } }),
      ]);

      const result = await collectOrgAlerts(deps(), "no42-org", "full");

      expect(result.alerts).toBe(1);
      expect(result.outcome).toBe("ok");
    });

    it("reports partial when payloads could not be read", async () => {
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      github.unreadableByOrg.set("no42-org", 3);

      const result = await collectOrgAlerts(deps(), "no42-org", "full");

      // A confident zero is the failure this avoids: if the endpoint's shape
      // shifts, the run must not read as a clean empty result.
      expect(result.outcome).toBe("partial");
      expect(result.unreadable).toBe(3);
      expect(store.latestRuns(1)[0]?.detail).toMatch(/could not be read/);
    });

    it("stores the alert state so a live alert is distinguishable", async () => {
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      await collectOrgAlerts(deps(), "no42-org", "full");

      const [alert] = store.currentByType("dependabot_alert");
      expect((alert?.payload as AlertObservation | undefined)?.state).toBe(
        "open",
      );
    });

    it("does not abort the sweep when the store itself fails", async () => {
      github.orgAlerts.set("good-org", [
        makeAlert({ number: 1, repo: { owner: "good-org", name: "x" } }),
      ]);
      const brokenStore = {
        ...store,
        beginRun: () => {
          throw new Error("database is locked");
        },
      } as unknown as typeof store;

      const results = await collectAllOrgs(
        { ...deps(), store: brokenStore },
        ["good-org", "other-org"],
        "full",
      );

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.outcome === "failed")).toBe(true);
    });
  });

  describe("scope (AD-16)", () => {
    it("records the scope it ran at", async () => {
      await collectOrgAlerts(deps(), "no42-org", "hot");
      expect(store.latestRuns(1)[0]?.scope).toBe("hot");
    });
  });
});
