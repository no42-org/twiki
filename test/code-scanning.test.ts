/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOT_APPLICABLE } from "../src/core/rank.js";
import { watchKey } from "../src/core/slug.js";
import { alertSubject, codeScanningSubject } from "../src/core/subject.js";
import { orgCodeScanningUrl } from "../src/github/port.js";
import type {
  CodeScanningAlertObservation,
  RepoCodeScanningObservation,
} from "../src/tricorder/collect/code-scanning.js";
import {
  collectAllOrgCodeScanning,
  collectOrgCodeScanning,
  LANE,
  normalise,
} from "../src/tricorder/collect/code-scanning.js";
import { collectOrgSecretScanning } from "../src/tricorder/collect/secret-scanning.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { FakeGitHubReadPort, makeCodeScanningAlert } from "./fakes.js";

// Story 3.3's collection matrix, asserted on whole rows and whole results.
//
// The lane is the Dependabot lane's sibling and deliberately differs in two
// places, which is where most of these cases sit: every open alert is stored
// regardless of ref, and a repository GitHub answered but gave no listing for
// is skipped rather than confirmed.

const REPO = { owner: "no42-org", name: "twiki" };

describe("code scanning lane", () => {
  let dir: string;
  let store: SqliteStore;
  let github: FakeGitHubReadPort;
  let logs: string[];
  let clock: number;
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
    now: () => new Date(Date.UTC(2026, 8, 9, 10, clock++)).toISOString(),
    log: (m: string) => logs.push(m),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scan-lane-"));
    store = SqliteStore.openForWrite(join(dir, "s.db"));
    github = new FakeGitHubReadPort(new Map());
    logs = [];
    clock = 0;
    watched = new Set(["no42-org/twiki", "no42-org/other"]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("normalise", () => {
    it("keys the subject on repo and alert number, under its own type", () => {
      const o = normalise(makeCodeScanningAlert({ number: 21 }));

      // The type discriminates: Dependabot alert 21 and code scanning alert
      // 21 in one repository are two subjects, not one contested row.
      expect(o.subject).toEqual(alertSubject("code_scanning_alert", REPO, 21));
      expect(o.subject.key).toBe("no42-org/twiki#21");
    });

    it("carries the whole payload the pages and the chain read", () => {
      const o = normalise(
        makeCodeScanningAlert({
          number: 21,
          securitySeverity: "critical",
          tool: "Trivy",
          ruleId: "CVE-2026-31789",
          ref: "refs/heads/main",
        }),
      );

      expect(o.payload).toEqual({
        number: 21,
        repo: "no42-org/twiki",
        state: "open",
        severity: "critical",
        tool: "Trivy",
        ruleId: "CVE-2026-31789",
        ref: "refs/heads/main",
        htmlUrl: "https://github.com/no42-org/twiki/security/code-scanning/21",
        createdAt: "2026-08-01T00:00:00.000Z",
      } satisfies CodeScanningAlertObservation);
    });
  });

  describe("the organisation listing", () => {
    it("retracts nothing, because it never skips a repository", async () => {
      // One listing covers the whole installation, so there is no such thing
      // as a repository this path answered but could not list. The skip set
      // is empty by construction and the retraction pass has nothing to
      // walk, however many sweeps run (#171).
      github.orgCodeScanningAlerts.set("no42-org", []);
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      // Seeded on the fan-out's knob, which the fake's org branch does not
      // read. Be honest about the reach of that: this half asserts the FAKE,
      // not the lane. What the lane genuinely owns here is the line below -
      // the retraction walks `page.skipped`, which the org path fills with
      // nothing, so deriving the skip set from anywhere else fails this.
      github.codeScanningSkipped.add("no42-org/other");

      const result = await collectOrgCodeScanning(deps(), "no42-org", "full");

      expect(result.skipped).toBe(0);
      expect(
        store
          .currentByTypeForOwner("repository_code_scanning", "no42-org")
          .map((c) => [c.subject.key, c.state]),
      ).toEqual([
        ["no42-org/other", "present"],
        ["no42-org/twiki", "present"],
      ]);
    });

    it("stores every alert and confirms every watched repository", async () => {
      github.orgCodeScanningAlerts.set("no42-org", [
        makeCodeScanningAlert({ number: 21 }),
        makeCodeScanningAlert({ number: 46, securitySeverity: "n/a" }),
      ]);

      const result = await collectOrgCodeScanning(deps(), "no42-org", "full");

      expect(result).toEqual({
        installation: "no42-org",
        outcome: "ok",
        alerts: 2,
        unreadable: 0,
        skipped: 0,
        retracted: 0,
      });
      expect(
        store.currentByType("code_scanning_alert").map((v) => v.subject.key),
      ).toEqual(["no42-org/twiki#21", "no42-org/twiki#46"]);
      // One confirmation per watched repository, including the one with
      // nothing to report: that is what makes a real zero expressible.
      expect(
        store
          .currentByType("repository_code_scanning")
          .map((v) => v.payload as RepoCodeScanningObservation),
      ).toEqual([
        { repo: "no42-org/other", openAlerts: 0, worstSeverity: null },
        // The `n/a` alert is counted and does not become an unrecognised
        // severity: the worst GRADED level is what this reports.
        { repo: "no42-org/twiki", openAlerts: 2, worstSeverity: "high" },
      ]);
      expect(store.latestRuns(1)[0]?.outcome).toBe("ok");
      expect(store.latestRuns(1)[0]?.lane).toBe(LANE);
    });

    it("reports no graded severity when the only tool grades nothing", async () => {
      // Never `unknown`: that would claim a level we failed to read, where
      // the truth is that the tool produces none.
      github.orgCodeScanningAlerts.set("no42-org", [
        makeCodeScanningAlert({ number: 46, securitySeverity: NOT_APPLICABLE }),
      ]);

      await collectOrgCodeScanning(deps(), "no42-org", "full");

      expect(
        store
          .currentByType("repository_code_scanning")
          .find((v) => v.subject.key === "no42-org/twiki")?.payload,
      ).toEqual({ repo: "no42-org/twiki", openAlerts: 1, worstSeverity: null });
    });

    it("stores an alert whatever ref it is on", async () => {
      // The lane deliberately does not filter. The queue builder applies the
      // default-branch condition, so the repository page can list what the
      // queue declines to rank.
      github.orgCodeScanningAlerts.set("no42-org", [
        makeCodeScanningAlert({ number: 7, ref: "refs/pull/7/merge" }),
      ]);

      await collectOrgCodeScanning(deps(), "no42-org", "full");

      const [row] = store.currentByType("code_scanning_alert");
      expect(
        (row?.payload as CodeScanningAlertObservation | undefined)?.ref,
      ).toBe("refs/pull/7/merge");
    });

    it("keeps alerts outside the allowlist out of the store", async () => {
      github.orgCodeScanningAlerts.set("no42-org", [
        makeCodeScanningAlert({ number: 1 }),
        makeCodeScanningAlert({
          number: 2,
          repo: { owner: "no42-org", name: "unwatched" },
        }),
      ]);

      const result = await collectOrgCodeScanning(deps(), "no42-org", "full");

      expect(result.alerts).toBe(1);
      expect(
        store.currentByType("code_scanning_alert").map((v) => v.subject.key),
      ).toEqual(["no42-org/twiki#1"]);
    });

    it("tombstones an alert the listing no longer carries", async () => {
      github.orgCodeScanningAlerts.set("no42-org", [
        makeCodeScanningAlert({ number: 1 }),
      ]);
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      github.orgCodeScanningAlerts.set("no42-org", []);

      await collectOrgCodeScanning(deps(), "no42-org", "full");

      expect(
        store.currentByType("code_scanning_alert").map((v) => v.state),
      ).toEqual(["resolved"]);
    });
  });

  describe("conditional requests (AD-25)", () => {
    it("sends no validator until every watched repository is confirmed", async () => {
      github.orgCodeScanningAlerts.set("no42-org", []);
      github.codeScanningValidators.set("no42-org", {
        etag: '"e1"',
        lastModified: null,
        tokenGen: "g1",
      });

      // First sweep: nothing confirmed, so nothing to revalidate against.
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      // Second: both watched repositories now carry a confirmation.
      await collectOrgCodeScanning(deps(), "no42-org", "full");

      expect(github.codeScanningCachedSeen).toEqual([
        null,
        { etag: '"e1"', lastModified: null, tokenGen: "g1" },
      ]);
      expect(logs[0]).toContain("conditional sweep off, unconfirmed");
    });

    it("sends no validator once a confirmation has been retracted", async () => {
      // The gate reads PRESENT confirmations only. A retracted one is a
      // withdrawn assertion, so the repository is unconfirmed again and the
      // cache must go off: revalidating would confirm stored rows for a
      // repository this lane no longer speaks for.
      //
      // The retraction that produces this state runs on the per-repository
      // fan-out, which caches no validator, so the store is seeded directly -
      // the gate's job is to react to the state, not to have produced it.
      github.orgCodeScanningAlerts.set("no42-org", []);
      github.codeScanningValidators.set("no42-org", {
        etag: '"e1"',
        lastModified: null,
        tokenGen: "g1",
      });
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      expect(github.codeScanningCachedSeen[1]).toEqual({
        etag: '"e1"',
        lastModified: null,
        tokenGen: "g1",
      });

      const r = store.beginRun({
        lane: "rest-org-code-scanning",
        installation: "no42-org",
        scope: "full",
        startedAt: "2026-09-09T10:30:00.000Z",
      });
      store.recordTombstones(r, "2026-09-09T10:30:00.000Z", [
        codeScanningSubject({ owner: "no42-org", name: "other" }),
      ]);
      await collectOrgCodeScanning(deps(), "no42-org", "full");

      expect(github.codeScanningCachedSeen[2]).toBeNull();
    });

    it("confirms its stored rows on a 304 rather than rewriting them", async () => {
      github.orgCodeScanningAlerts.set("no42-org", [
        makeCodeScanningAlert({ number: 1 }),
      ]);
      github.codeScanningValidators.set("no42-org", {
        etag: '"e1"',
        lastModified: null,
        tokenGen: "g1",
      });
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      const before = store.currentByType("code_scanning_alert")[0];
      github.codeScanningNotModified.add("no42-org");

      const result = await collectOrgCodeScanning(deps(), "no42-org", "full");

      expect(result).toEqual({
        installation: "no42-org",
        outcome: "ok",
        alerts: 1,
        unreadable: 0,
        skipped: 0,
        retracted: 0,
      });
      const after = store.currentByType("code_scanning_alert")[0];
      // Touched, not rewritten: the observation timestamp stands and only
      // the verification advances (AD-3's log stays change-only).
      expect(after?.observedAt).toBe(before?.observedAt);
      expect(after?.verifiedAt.localeCompare(before?.verifiedAt ?? "")).toBe(1);
      expect(store.latestRuns(1)[0]?.detail).toBe("not modified (304)");
    });

    it("uses its own validator key, not the Dependabot listing's", () => {
      // One cache entry per installation and request URL. Sharing a key with
      // the alert listing would have one lane's 304 confirm the other's rows.
      expect(orgCodeScanningUrl("No42-Org")).toBe(
        "/orgs/no42-org/code-scanning/alerts?state=open&per_page=100",
      );
    });
  });

  describe("incomplete sweeps", () => {
    it("degrades to partial and tombstones nothing when the listing is truncated", async () => {
      github.orgCodeScanningAlerts.set("no42-org", [
        makeCodeScanningAlert({ number: 1 }),
      ]);
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      github.orgCodeScanningAlerts.set("no42-org", []);
      github.codeScanningTruncated.add("no42-org");

      const result = await collectOrgCodeScanning(deps(), "no42-org", "full");

      expect(result.outcome).toBe("partial");
      expect(
        store.currentByType("code_scanning_alert").map((v) => v.state),
      ).toEqual(["present"]);
      // The lane's own name for what it read: a `rest-org-code-scanning` run
      // reporting an `alert listing` sends the reader to the wrong endpoint.
      expect(store.latestRuns(1)[0]?.detail).toBe(
        "code scanning listing truncated at the pagination cap;" +
          " nothing tombstoned",
      );
    });

    it("purges the cached validator after an incomplete sweep", async () => {
      // The validator describes a listing the incomplete sweep has already
      // overwritten rows from. Leaving it cached lets the next sweep answer
      // 304 against it, confirm every present row as the whole answer and
      // skip the tombstone pass, so a fixed finding renders current for ever
      // (AD-23). Deleting the arm that purges it failed nothing before this.
      github.orgCodeScanningAlerts.set("no42-org", [
        makeCodeScanningAlert({ number: 1 }),
      ]);
      github.codeScanningValidators.set("no42-org", {
        etag: '"e1"',
        lastModified: null,
        tokenGen: "g1",
      });
      // Two clean sweeps: the first confirms both repositories, the second
      // is the one that gets to send the cached validator.
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      github.codeScanningTruncated.add("no42-org");
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      github.codeScanningTruncated.delete("no42-org");

      await collectOrgCodeScanning(deps(), "no42-org", "full");

      const sent = { etag: '"e1"', lastModified: null, tokenGen: "g1" };
      expect(github.codeScanningCachedSeen).toEqual([
        // Nothing confirmed yet.
        null,
        // Confirmed, so the cached validator goes on the wire.
        sent,
        // Still cached from the second sweep; this one truncates.
        sent,
        // Purged by the truncated sweep.
        null,
      ]);
    });

    it("degrades to partial on an unreadable payload", async () => {
      github.orgCodeScanningAlerts.set("no42-org", []);
      github.codeScanningUnreadable.set("no42-org", 2);

      const result = await collectOrgCodeScanning(deps(), "no42-org", "full");

      expect(result).toEqual({
        installation: "no42-org",
        outcome: "partial",
        alerts: 0,
        unreadable: 2,
        skipped: 0,
        retracted: 0,
      });
      // A partial sweep confirms nothing: its zero would be a confident one.
      expect(store.currentByType("repository_code_scanning")).toEqual([]);
      expect(store.latestRuns(1)[0]?.detail).toContain(
        "2 alert payloads could not be read",
      );
    });

    it("contains a failure rather than aborting the cycle", async () => {
      github.codeScanningFailingOrgs.add("bad-org");
      watched.add("bad-org/x");

      const results = await collectAllOrgCodeScanning(
        deps(),
        ["bad-org", "no42-org"],
        "full",
      );

      expect(results.map((r) => [r.installation, r.outcome])).toEqual([
        ["bad-org", "failed"],
        ["no42-org", "ok"],
      ]);
    });
  });

  describe("a user account, which has no org-level endpoint", () => {
    beforeEach(() => {
      github.userAccounts.add("no42-org");
    });

    it("hands the port the watched repositories to fan out over", async () => {
      github.repoCodeScanningAlerts.set("no42-org/twiki", [
        makeCodeScanningAlert({ number: 1 }),
      ]);

      const result = await collectOrgCodeScanning(deps(), "no42-org", "full");

      expect(github.codeScanningQueries).toEqual([
        {
          org: "no42-org",
          repos: [
            { owner: "no42-org", name: "twiki" },
            { owner: "no42-org", name: "other" },
          ],
        },
      ]);
      expect(result.alerts).toBe(1);
    });

    it("costs nothing and fails nothing when the account watches no repository", async () => {
      // The bound is the ALLOWLIST, not the installation: an account
      // exposing 241 repositories and watching none fans out over none.
      watched.clear();

      const result = await collectOrgCodeScanning(deps(), "no42-org", "full");

      expect(result).toEqual({
        installation: "no42-org",
        outcome: "ok",
        alerts: 0,
        unreadable: 0,
        skipped: 0,
        retracted: 0,
      });
      expect(github.codeScanningQueries[0]?.repos).toEqual([]);
    });

    it("skips a repository GitHub gave no listing for, and confirms nothing about it", async () => {
      // GitHub answered; what it said is that there is nothing analysed to
      // list. The run stays ok - degrading would hold this lane partial for
      // as long as the repository exists - and the repository gets no
      // confirmation, so its Security section reads unconfirmed and never a
      // confident zero (AD-28).
      github.codeScanningSkipped.add("no42-org/other");
      github.repoCodeScanningAlerts.set("no42-org/twiki", [
        makeCodeScanningAlert({ number: 1 }),
      ]);

      const result = await collectOrgCodeScanning(deps(), "no42-org", "full");

      expect(result).toEqual({
        installation: "no42-org",
        outcome: "ok",
        alerts: 1,
        unreadable: 0,
        skipped: 1,
        retracted: 0,
      });
      expect(
        store
          .currentByType("repository_code_scanning")
          .map((v) => v.subject.key),
      ).toEqual(["no42-org/twiki"]);
      // Named, and quoting what GitHub actually answered: the refusals
      // differ, and a detail naming one of them for all of them would send
      // the operator to the wrong setting.
      expect(store.latestRuns(1)[0]?.detail).toBe(
        "skipped, no listing to read: no42-org/other (no analysis found)",
      );
    });

    it("never tombstones a skipped repository's rows", async () => {
      // Its alerts are unlisted, not absent. Tombstoning them would report a
      // live finding as fixed on the strength of a listing nobody read.
      github.repoCodeScanningAlerts.set("no42-org/other", [
        makeCodeScanningAlert({
          number: 4,
          repo: { owner: "no42-org", name: "other" },
        }),
      ]);
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      github.repoCodeScanningAlerts.delete("no42-org/other");
      github.codeScanningSkipped.add("no42-org/other");

      await collectOrgCodeScanning(deps(), "no42-org", "full");

      // BOTH subject types, as key/state pairs: this is the conjunction the
      // change is actually about, and a single-field assertion on either one
      // alone would hold while the other went wrong (#171).
      expect(
        store
          .currentByType("code_scanning_alert")
          .map((v) => [v.subject.key, v.state]),
      ).toEqual([["no42-org/other#4", "present"]]);
      expect(
        store
          .currentByTypeForOwner("repository_code_scanning", "no42-org")
          .map((c) => [c.subject.key, c.state]),
      ).toEqual([
        ["no42-org/other", "resolved"],
        ["no42-org/twiki", "present"],
      ]);
    });

    it("retracts the confirmation a skipped repository already had", async () => {
      // Withholding a new one is enough only for a repository never
      // confirmed. One confirmed last week keeps publishing that count,
      // attested and ageing, until the assertion behind it is retracted
      // (#171). Assert the whole pair: a key alone cannot tell a live
      // confirmation from a retracted one.
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      expect(
        store
          .currentByTypeForOwner("repository_code_scanning", "no42-org")
          .map((c) => [c.subject.key, c.state]),
      ).toEqual([
        ["no42-org/other", "present"],
        ["no42-org/twiki", "present"],
      ]);

      github.codeScanningSkipped.add("no42-org/other");
      await collectOrgCodeScanning(deps(), "no42-org", "full");

      expect(
        store
          .currentByTypeForOwner("repository_code_scanning", "no42-org")
          .map((c) => [c.subject.key, c.state]),
      ).toEqual([
        ["no42-org/other", "resolved"],
        ["no42-org/twiki", "present"],
      ]);
    });

    it("retracts once, however many sweeps keep skipping it", async () => {
      // `recordTombstones` TOUCHES an already-resolved subject rather than
      // skipping it, so the `state === "present"` filter is what stops a
      // permanently skipped repository being re-tombstoned and re-logged on
      // every sweep for ever. Without that filter this test still passes on
      // state alone, which is why it counts the log lines too.
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      github.codeScanningSkipped.add("no42-org/other");
      // The sweep that withdraws it REPORTS the withdrawal, and the sweeps
      // after it report none. Without this the `retracted` field could be
      // hard-wired to 0 and every other assertion in this suite would hold.
      const withdrawing = await collectOrgCodeScanning(
        deps(),
        "no42-org",
        "full",
      );
      const after = await collectOrgCodeScanning(deps(), "no42-org", "full");
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      expect([withdrawing.retracted, after.retracted]).toEqual([1, 0]);

      expect(
        store
          .currentByTypeForOwner("repository_code_scanning", "no42-org")
          .map((c) => [c.subject.key, c.state]),
      ).toEqual([
        ["no42-org/other", "resolved"],
        ["no42-org/twiki", "present"],
      ]);
      // Singular, and NAMED: the count alone cannot tell an operator which
      // attestation was withdrawn, and `1 confirmations` reads as a bug.
      expect(logs.filter((l) => l.includes("retracted:"))).toEqual([
        "rest-org-code-scanning no42-org: 1 confirmation retracted: no42-org/other",
      ]);
    });

    it("retracts nothing for a repository it never confirmed", async () => {
      // The common case, and the one withholding already covered: there is
      // no assertion to retract, so no tombstone is written for it either.
      github.codeScanningSkipped.add("no42-org/other");

      await collectOrgCodeScanning(deps(), "no42-org", "full");

      expect(
        store
          .currentByTypeForOwner("repository_code_scanning", "no42-org")
          .map((c) => [c.subject.key, c.state]),
      ).toEqual([["no42-org/twiki", "present"]]);
    });

    it("confirms it again when the listing comes back", async () => {
      // A retraction is not terminal. The repository reads its real count
      // again on the next sweep that covers it, which is what makes this a
      // retracted assertion rather than a permanent verdict.
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      github.codeScanningSkipped.add("no42-org/other");
      await collectOrgCodeScanning(deps(), "no42-org", "full");

      github.codeScanningSkipped.delete("no42-org/other");
      github.repoCodeScanningAlerts.set("no42-org/other", [
        makeCodeScanningAlert({
          number: 7,
          repo: { owner: "no42-org", name: "other" },
        }),
      ]);
      await collectOrgCodeScanning(deps(), "no42-org", "full");

      const back = store
        .currentByTypeForOwner("repository_code_scanning", "no42-org")
        .find((c) => c.subject.key === "no42-org/other");
      // The whole payload, not just the count: a retraction that came back
      // with a stale or empty summary would still read `present`.
      expect(back?.state).toBe("present");
      expect(back?.payload).toEqual({
        repo: "no42-org/other",
        openAlerts: 1,
        worstSeverity: "high",
      });
    });

    it("retracts nothing on a partial run", async () => {
      // The same guard the tombstone pass beside it uses. A run that could
      // not read everything must not retract on the strength of what it did
      // read.
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      github.codeScanningSkipped.add("no42-org/other");
      github.codeScanningUnreachable.add("no42-org/twiki");

      const result = await collectOrgCodeScanning(deps(), "no42-org", "full");

      expect(result.outcome).toBe("partial");
      expect(
        store
          .currentByTypeForOwner("repository_code_scanning", "no42-org")
          .map((c) => [c.subject.key, c.state]),
      ).toEqual([
        ["no42-org/other", "present"],
        ["no42-org/twiki", "present"],
      ]);
    });

    it("retracts nothing on a bounded scope", async () => {
      // A hot sweep speaks for no repository it did not reach, so it
      // withdraws nothing either.
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      github.codeScanningSkipped.add("no42-org/other");

      await collectOrgCodeScanning(deps(), "no42-org", "hot");

      expect(
        store
          .currentByTypeForOwner("repository_code_scanning", "no42-org")
          .map((c) => [c.subject.key, c.state]),
      ).toEqual([
        ["no42-org/other", "present"],
        ["no42-org/twiki", "present"],
      ]);
    });

    it("retracts only its own subject, never another lane's", async () => {
      // Three lanes with their own freshness, and the retraction is bound by
      // the same rule as the write: a skipped code scanning listing says
      // nothing about what the secret scanning lane saw.
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      // Skipped in BOTH lanes, which is the scenario the matrix row names:
      // with only one lane skipping, the other lane's rows are untouched
      // whether or not any retraction happens at all, and this test would
      // pass with the feature deleted.
      github.codeScanningSkipped.add("no42-org/other");
      github.secretScanningSkipped.add("no42-org/other");

      await collectOrgCodeScanning(deps(), "no42-org", "full");

      // The positive half: THIS lane retracted.
      expect(
        store
          .currentByTypeForOwner("repository_code_scanning", "no42-org")
          .map((c) => [c.subject.key, c.state]),
      ).toEqual([
        ["no42-org/other", "resolved"],
        ["no42-org/twiki", "present"],
      ]);
      // The negative half: the other lane's row is untouched, even though
      // the same repository is skipped there too. Only its own sweep may
      // withdraw its own attestation.
      expect(
        store
          .currentByTypeForOwner("repository_secret_scanning", "no42-org")
          .map((c) => [c.subject.key, c.state]),
      ).toEqual([
        ["no42-org/other", "present"],
        ["no42-org/twiki", "present"],
      ]);
    });

    it("degrades when a repository reached no answer at all", async () => {
      github.codeScanningUnreachable.add("no42-org/other");

      const result = await collectOrgCodeScanning(deps(), "no42-org", "full");

      expect(result.outcome).toBe("partial");
      expect(store.latestRuns(1)[0]?.detail).toBe(
        "1 repositories could not be read:" +
          " no42-org/other (no reason recorded)",
      );
    });
  });

  it("writes its confirmation under its own subject, never the alert lane's", async () => {
    // Two lanes with their own freshness. One vouching for the other is how
    // a fresh Dependabot sweep would badge a section nothing swept.
    github.orgCodeScanningAlerts.set("no42-org", []);

    await collectOrgCodeScanning(deps(), "no42-org", "full");

    expect(store.currentByType("repository")).toEqual([]);
    expect(
      store.currentByType("repository_code_scanning").map((v) => v.subject),
    ).toEqual([
      codeScanningSubject({ owner: "no42-org", name: "other" }),
      codeScanningSubject(REPO),
    ]);
  });
});
