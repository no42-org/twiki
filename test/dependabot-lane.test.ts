/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alertSubject } from "../src/core/subject.js";
import { orgAlertsUrl } from "../src/github/port.js";
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
    watchedIn: (installation: string) =>
      [...watched]
        .filter((slug) => slug.startsWith(`${installation.toLowerCase()}/`))
        .map((slug) => {
          const [owner = "", name = ""] = slug.split("/");
          return { owner, name };
        }),
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

  describe("reconciliation (AD-23)", () => {
    const seed = async () => {
      github.orgAlerts.set("no42-org", [
        makeAlert({ number: 1 }),
        makeAlert({ number: 2 }),
      ]);
      await collectOrgAlerts(deps(), "no42-org", "full");
    };

    it("tombstones an alert that a clean full sweep no longer sees", async () => {
      await seed();
      // Alert 2 was fixed: the open-only endpoint stops returning it.
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);

      await collectOrgAlerts(deps(), "no42-org", "full");

      const two = store.current(alertSubject("dependabot_alert", REPO, 2));
      expect(two?.state).toBe("resolved");
      const one = store.current(alertSubject("dependabot_alert", REPO, 1));
      expect(one?.state).toBe("present");
    });

    it("does NOT tombstone on a hot sweep, which queried a subset", async () => {
      await seed();
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);

      await collectOrgAlerts(deps(), "no42-org", "hot");

      expect(
        store.current(alertSubject("dependabot_alert", REPO, 2))?.state,
      ).toBe("present");
    });

    it("does NOT tombstone when payloads were unreadable", async () => {
      await seed();
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      github.unreadableByOrg.set("no42-org", 1);

      const result = await collectOrgAlerts(deps(), "no42-org", "full");

      expect(result.outcome).toBe("partial");
      // Absence might have been a mapping failure, not a fix.
      expect(
        store.current(alertSubject("dependabot_alert", REPO, 2))?.state,
      ).toBe("present");
    });

    it("does NOT tombstone when the run failed", async () => {
      await seed();
      github.failingOrgs.add("no42-org");

      await collectOrgAlerts(deps(), "no42-org", "full");

      expect(
        store.current(alertSubject("dependabot_alert", REPO, 2))?.state,
      ).toBe("present");
    });

    it("does NOT tombstone a repository dropped from the watch list", async () => {
      await seed();
      // The repository leaves repos.yaml. Its alerts vanish from the watched
      // set, but they are out of scope, not fixed.
      watched = new Set(["other-org/x"]);
      github.orgAlerts.set("no42-org", []);

      await collectOrgAlerts(deps(), "no42-org", "full");

      expect(
        store.current(alertSubject("dependabot_alert", REPO, 2))?.state,
      ).toBe("present");
    });

    it("never reaches into another organisation's subjects", async () => {
      await seed();
      const otherRepo = { owner: "other-org", name: "x" };
      github.orgAlerts.set("other-org", [
        makeAlert({ number: 9, repo: otherRepo }),
      ]);
      await collectOrgAlerts(deps(), "other-org", "full");

      // A clean full sweep of no42-org that sees nothing must not touch
      // other-org's alert.
      github.orgAlerts.set("no42-org", []);
      await collectOrgAlerts(deps(), "no42-org", "full");

      expect(
        store.current(alertSubject("dependabot_alert", otherRepo, 9))?.state,
      ).toBe("present");
    });
  });

  describe("logging cannot take the lane down (AD-16)", () => {
    it("a throwing logger changes nothing", async () => {
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      const result = await collectOrgAlerts(
        {
          ...deps(),
          log: () => {
            throw new Error("EPIPE");
          },
        },
        "no42-org",
        "full",
      );
      expect(result.outcome).toBe("ok");
      expect(store.latestRuns(1)[0]?.outcome).toBe("ok");
    });
  });

  describe("scope (AD-16)", () => {
    it("records the scope it ran at", async () => {
      await collectOrgAlerts(deps(), "no42-org", "hot");
      expect(store.latestRuns(1)[0]?.scope).toBe("hot");
    });
  });

  // The confirmation row is what makes "we looked and there are none"
  // expressible. Every test below was written after a review found the lane
  // could stop writing it, or write it when it should not, with the whole
  // suite still green.
  describe("repository confirmations", () => {
    const confirmed = () =>
      store
        .currentByType("repository")
        .filter((c) => c.state === "present")
        .map((c) => c.subject.key)
        .sort();

    it("writes one per watched repository in the installation", async () => {
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      watched.add("no42-org/quiet");

      await collectOrgAlerts(deps(), "no42-org", "full");

      // Including no42-org/quiet, which had no alerts. That row IS the zero.
      expect(confirmed()).toEqual(["no42-org/quiet", "no42-org/twiki"]);
    });

    it("carries the count and worst severity", async () => {
      github.orgAlerts.set("no42-org", [
        makeAlert({ number: 1, severity: "low" }),
        makeAlert({ number: 2, severity: "medium" }),
      ]);

      await collectOrgAlerts(deps(), "no42-org", "full");

      const row = store.currentByType("repository")[0];
      expect(row?.payload).toMatchObject({
        repo: "no42-org/twiki",
        openAlerts: 2,
        worstSeverity: "medium",
      });
    });

    it("confirms a repository with no alerts as a real zero", async () => {
      github.orgAlerts.set("no42-org", []);

      await collectOrgAlerts(deps(), "no42-org", "full");

      expect(store.currentByType("repository")[0]?.payload).toMatchObject({
        openAlerts: 0,
        worstSeverity: null,
      });
    });

    it("writes none on a partial sweep, rather than publishing an undercount", async () => {
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      github.unreadableByOrg.set("no42-org", 3);

      const result = await collectOrgAlerts(deps(), "no42-org", "full");

      // Three payloads we could not read. The count we can compute is smaller
      // than the truth, and writing it would render as a confident number with
      // a fresh badge on exactly the repository that failed.
      expect(result.outcome).toBe("partial");
      expect(confirmed()).toEqual([]);
    });

    it("writes none on a hot sweep, which queried a subset", async () => {
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);

      await collectOrgAlerts(deps(), "no42-org", "hot");

      // Same reasoning the tombstone guard already uses: absence from a hot run
      // means nothing, so a count derived from it must not overwrite a full
      // sweep's real number with a smaller one.
      expect(confirmed()).toEqual([]);
    });

    it("stops confirming a repository dropped from the watched set", async () => {
      github.orgAlerts.set("no42-org", []);
      watched.add("no42-org/quiet");
      await collectOrgAlerts(deps(), "no42-org", "full");
      expect(confirmed()).toContain("no42-org/quiet");

      watched.delete("no42-org/quiet");
      const before = store.current({
        type: "repository",
        key: "no42-org/quiet",
      })?.verifiedAt;
      await collectOrgAlerts(deps(), "no42-org", "full");

      // Out of scope, not fixed: the row is left to go stale on its own rather
      // than being re-confirmed by a sweep that no longer looks at it.
      expect(
        store.current({ type: "repository", key: "no42-org/quiet" })
          ?.verifiedAt,
      ).toBe(before);
    });
  });

  describe("severity vocabulary", () => {
    it("ranks moderate above low", async () => {
      github.orgAlerts.set("no42-org", [
        makeAlert({ number: 1, severity: "low" }),
        makeAlert({ number: 2, severity: "medium" }),
      ]);
      await collectOrgAlerts(deps(), "no42-org", "full");
      expect(store.currentByType("repository")[0]?.payload).toMatchObject({
        worstSeverity: "medium",
      });
    });

    it("does not depend on the order the page happened to list them", async () => {
      github.orgAlerts.set("no42-org", [
        makeAlert({ number: 1, severity: "medium" }),
        makeAlert({ number: 2, severity: "low" }),
      ]);
      await collectOrgAlerts(deps(), "no42-org", "full");
      expect(store.currentByType("repository")[0]?.payload).toMatchObject({
        worstSeverity: "medium",
      });
    });

    it("accepts GraphQL's MODERATE as the same fact as REST's medium", async () => {
      // Measured 2026-08-17: the Dependabot REST payload says `medium`, and
      // GraphQL's SecurityAdvisory.severity says `MODERATE`. Both lanes feed
      // the same store, so a scale that knows only one spelling reports a
      // third of the other lane's alerts as unknown.
      github.orgAlerts.set("no42-org", [
        makeAlert({ number: 1, severity: "low" }),
        makeAlert({ number: 2, severity: "MODERATE" }),
      ]);
      await collectOrgAlerts(deps(), "no42-org", "full");
      expect(store.currentByType("repository")[0]?.payload).toMatchObject({
        worstSeverity: "medium",
      });
    });

    it("reports an unrecognised severity as unknown, not as the lowest known one", async () => {
      github.orgAlerts.set("no42-org", [
        makeAlert({ number: 1, severity: "low" }),
        // What the adapter stores when GitHub omits the advisory.
        makeAlert({ number: 2, severity: "unknown" }),
      ]);
      await collectOrgAlerts(deps(), "no42-org", "full");

      // AD-20: absent ranks as unknown, never as zero risk. Calling this "low"
      // is the confident-zero mistake at severity scale.
      expect(store.currentByType("repository")[0]?.payload).toMatchObject({
        worstSeverity: "unknown",
      });
    });

    it("still reports critical, which nothing can outrank", async () => {
      github.orgAlerts.set("no42-org", [
        makeAlert({ number: 1, severity: "critical" }),
        makeAlert({ number: 2, severity: "not-a-severity" }),
      ]);
      await collectOrgAlerts(deps(), "no42-org", "full");
      expect(store.currentByType("repository")[0]?.payload).toMatchObject({
        worstSeverity: "critical",
      });
    });
  });

  describe("the conditional sweep (AD-25)", () => {
    const VALIDATOR = {
      etag: 'W/"alerts-1"',
      lastModified: null,
      tokenGen: "2026-08-16T11:00:00Z",
    };

    it("saves the validator on a clean full sweep and sends it on the next", async () => {
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      github.orgAlertValidators.set("no42-org", VALIDATOR);
      await collectOrgAlerts(deps(), "no42-org", "full");

      expect(github.orgAlertCachedSeen[0]).toBeNull();
      await collectOrgAlerts(deps(), "no42-org", "full");
      expect(github.orgAlertCachedSeen[1]).toEqual(VALIDATOR);
    });

    it("a 304 confirms every watched row without rewriting it", async () => {
      // The story's acceptance line: a 304 produces no observation row but
      // does advance verified_at, so a quiet healthy repository renders
      // fresh rather than stale.
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      github.orgAlertValidators.set("no42-org", VALIDATOR);
      await collectOrgAlerts(deps(), "no42-org", "full");
      const alertBefore = store.currentByType("dependabot_alert")[0];
      const repoBefore = store.currentByType("repository")[0];

      github.orgAlertNotModified.add("no42-org");
      const r = await collectOrgAlerts(deps(), "no42-org", "full");

      expect(r).toMatchObject({ outcome: "ok", alerts: 1 });
      const alertAfter = store.currentByType("dependabot_alert")[0];
      const repoAfter = store.currentByType("repository")[0];
      // No observation row: observedAt stands. Confirmed: verifiedAt moved.
      expect(alertAfter?.observedAt).toBe(alertBefore?.observedAt);
      expect(alertAfter?.verifiedAt).not.toBe(alertBefore?.verifiedAt);
      // The repository confirmation row moves with it, or the repo page
      // would show a stale zero over a fresh alert list.
      expect(repoAfter?.observedAt).toBe(repoBefore?.observedAt);
      expect(repoAfter?.verifiedAt).not.toBe(repoBefore?.verifiedAt);
      expect(store.latestRuns(1)[0]?.detail).toContain("not modified");
    });

    it("a 304 tombstones nothing", async () => {
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      github.orgAlertValidators.set("no42-org", VALIDATOR);
      await collectOrgAlerts(deps(), "no42-org", "full");

      // The fake's 304 returns no alerts, which a broken lane would read as
      // "everything closed".
      github.orgAlertNotModified.add("no42-org");
      await collectOrgAlerts(deps(), "no42-org", "full");

      expect(
        store
          .currentByType("dependabot_alert")
          .filter((c) => c.state === "present"),
      ).toHaveLength(1);
    });

    it("a 304 does not confirm a repository dropped from the allowlist", async () => {
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      github.orgAlertValidators.set("no42-org", VALIDATOR);
      await collectOrgAlerts(deps(), "no42-org", "full");
      const before = store.currentByType("dependabot_alert")[0];

      watched.delete("no42-org/twiki");
      github.orgAlertNotModified.add("no42-org");
      await collectOrgAlerts(deps(), "no42-org", "full");

      // Out of scope, not confirmed: the row ages out on its own.
      const after = store.currentByType("dependabot_alert")[0];
      expect(after?.verifiedAt).toBe(before?.verifiedAt);
    });

    it("does not save a validator from a partial sweep", async () => {
      // A 304 against it would confirm rows the sweep knew were incomplete.
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      github.unreadableByOrg.set("no42-org", 2);
      github.orgAlertValidators.set("no42-org", VALIDATOR);
      await collectOrgAlerts(deps(), "no42-org", "full");

      await collectOrgAlerts(deps(), "no42-org", "full");
      expect(github.orgAlertCachedSeen[1]).toBeNull();
    });

    it("does not save a validator from a hot sweep", async () => {
      // The request is identical across scopes; what a hot sweep skips is
      // the tombstone reconciliation, so a 304 against its validator would
      // confirm rows it never reconciled.
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      github.orgAlertValidators.set("no42-org", VALIDATOR);
      await collectOrgAlerts(deps(), "no42-org", "hot");

      await collectOrgAlerts(deps(), "no42-org", "full");
      expect(github.orgAlertCachedSeen[1]).toBeNull();
    });

    it("fetches unconditionally until a newly-watched repo is confirmed", async () => {
      // The repo's alerts sat in the very listing the cached ETag describes,
      // filtered out by the old allowlist. A 304 confirms only stored rows,
      // so the new repo would stay invisible for as long as the rest of the
      // org stayed quiet.
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      github.orgAlertValidators.set("no42-org", VALIDATOR);
      await collectOrgAlerts(deps(), "no42-org", "full");

      watched.add("no42-org/fresh-repo");
      await collectOrgAlerts(deps(), "no42-org", "full");
      // Cold sweep: the validator was not sent.
      expect(github.orgAlertCachedSeen[1]).toBeNull();

      // That sweep confirmed the new repo, so the cache resumes.
      await collectOrgAlerts(deps(), "no42-org", "full");
      expect(github.orgAlertCachedSeen[2]).toEqual(VALIDATOR);
    });

    it("fetches unconditionally when the listing spanned pages", async () => {
      // No validator came back (multi-page listing), so nothing is cached
      // and the next sweep pays full price rather than guessing.
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      await collectOrgAlerts(deps(), "no42-org", "full");

      await collectOrgAlerts(deps(), "no42-org", "full");
      expect(github.orgAlertCachedSeen[1]).toBeNull();
    });

    it("purges a stored validator when a 200 rewrote rows without one", async () => {
      // The stored validator describes the pre-rewrite listing. If the
      // listing later reverts byte-identical to that old body (alert opened,
      // then fixed: A to B back to A), a 304 against the stale validator
      // would confirm every present row - including the alert B added -
      // and skip the tombstone pass a 200 would have run. The fixed alert
      // would render current forever (AD-23).
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      github.orgAlertValidators.set("no42-org", VALIDATOR);
      await collectOrgAlerts(deps(), "no42-org", "full");
      expect(
        store.loadValidator("no42-org", orgAlertsUrl("no42-org")),
      ).not.toBeNull();

      // The next 200 stores rows but earns no validator (multi-page).
      github.orgAlerts.set("no42-org", [
        makeAlert({ number: 1 }),
        makeAlert({ number: 2 }),
      ]);
      github.orgAlertValidators.delete("no42-org");
      await collectOrgAlerts(deps(), "no42-org", "full");

      expect(
        store.loadValidator("no42-org", orgAlertsUrl("no42-org")),
      ).toBeNull();
      // And a partial 200 purges it too: it also stored rows.
      github.orgAlertValidators.set("no42-org", VALIDATOR);
      await collectOrgAlerts(deps(), "no42-org", "full");
      github.orgAlertValidators.delete("no42-org");
      github.unreadableByOrg.set("no42-org", 1);
      await collectOrgAlerts(deps(), "no42-org", "full");
      expect(
        store.loadValidator("no42-org", orgAlertsUrl("no42-org")),
      ).toBeNull();
    });

    it("a truncated listing degrades to partial and tombstones nothing", async () => {
      // The pagination cap stops a self-linking proxy, but what came back is
      // real: it is ingested, the run says partial, and absence from an
      // incomplete set means nothing (AD-23).
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      await collectOrgAlerts(deps(), "no42-org", "full");

      github.orgAlerts.set("no42-org", []);
      github.orgAlertTruncated.add("no42-org");
      const r = await collectOrgAlerts(deps(), "no42-org", "full");

      expect(r.outcome).toBe("partial");
      expect(
        store
          .currentByType("dependabot_alert")
          .filter((c) => c.state === "present"),
      ).toHaveLength(1);
      expect(store.latestRuns(1)[0]?.detail).toContain("truncated");
    });

    it("a hot 200 purges the stored validator too", async () => {
      // A hot sweep stores rows like any other 200, so the stored validator
      // stops describing stored state the moment it runs. Folding the purge
      // into the full-only reconciliation block would leave it behind.
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      github.orgAlertValidators.set("no42-org", VALIDATOR);
      await collectOrgAlerts(deps(), "no42-org", "full");
      expect(
        store.loadValidator("no42-org", orgAlertsUrl("no42-org")),
      ).not.toBeNull();

      github.orgAlertNotModified.clear();
      await collectOrgAlerts(deps(), "no42-org", "hot");

      expect(
        store.loadValidator("no42-org", orgAlertsUrl("no42-org")),
      ).toBeNull();
    });

    it("says which repositories disabled the conditional sweep", async () => {
      // Normally a one-sweep window (the confirmation pass writes a row for
      // every watched repository), but if it ever persists the cache is
      // silently off for the whole org, and this line names the holdouts.
      github.orgAlerts.set("no42-org", [makeAlert({ number: 1 })]);
      watched.add("no42-org/ghost");
      await collectOrgAlerts(deps(), "no42-org", "full");

      expect(
        logs.some(
          (l) =>
            l.includes("conditional sweep off") && l.includes("no42-org/ghost"),
        ),
      ).toBe(true);
    });
  });
});
