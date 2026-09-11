/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { watchKey } from "../src/core/slug.js";
import { alertSubject, secretScanningSubject } from "../src/core/subject.js";
import { OctokitGitHub } from "../src/github/octokit-adapter.js";
import { orgSecretScanningUrl } from "../src/github/port.js";
import { collectOrgCodeScanning } from "../src/tricorder/collect/code-scanning.js";
import type {
  RepoSecretScanningObservation,
  SecretScanningAlertObservation,
} from "../src/tricorder/collect/secret-scanning.js";
import {
  collectAllOrgSecretScanning,
  collectOrgSecretScanning,
  LANE,
  normalise,
} from "../src/tricorder/collect/secret-scanning.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { FakeGitHubReadPort, makeSecretScanningAlert } from "./fakes.js";

// Story 3.4's collection matrix, asserted on whole rows and whole results.
//
// The lane is the code scanning lane's sibling and mirrors it closely, so most
// of these cases are that suite's, one endpoint over. The two that are not are
// the ones this story exists for: nothing a secret scanning payload carries
// may put the credential in the store or the log, and an open secret must
// reach `now` without any surface claiming CISA listed it.

const REPO = { owner: "no42-org", name: "twiki" };

describe("secret scanning lane", () => {
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
    dir = mkdtempSync(join(tmpdir(), "secret-lane-"));
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
      const o = normalise(makeSecretScanningAlert({ number: 3 }));

      // The type discriminates: Dependabot alert 3, code scanning alert 3 and
      // secret scanning alert 3 in one repository are three subjects, not one
      // contested row.
      expect(o.subject).toEqual(alertSubject("secret_scanning_alert", REPO, 3));
      expect(o.subject.key).toBe("no42-org/twiki#3");
    });

    it("carries the whole payload the pages and the chain read", () => {
      const o = normalise(
        makeSecretScanningAlert({
          number: 3,
          secretType: "Amazon AWS Access Key ID",
          validity: "active",
        }),
      );

      // The whole object, so a field added to the observation without a
      // reason to exist fails here rather than rotting in the store.
      expect(o.payload).toEqual({
        number: 3,
        repo: "no42-org/twiki",
        state: "open",
        secretType: "Amazon AWS Access Key ID",
        validity: "active",
        publiclyLeaked: false,
        htmlUrl: "https://github.com/no42-org/twiki/security/secret-scanning/3",
        createdAt: "2026-08-01T00:00:00.000Z",
      } satisfies SecretScanningAlertObservation);
    });
  });

  describe("the organisation listing", () => {
    it("retracts nothing, because it never skips a repository", async () => {
      // One listing covers the whole installation, so there is no such thing
      // as a repository this path answered but could not list. The skip set
      // is empty by construction and the retraction pass has nothing to
      // walk, however many sweeps run (#171).
      github.orgSecretScanningAlerts.set("no42-org", []);
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      // Seeded on the fan-out's knob, which the fake's org branch does not
      // read. Be honest about the reach of that: this half asserts the FAKE,
      // not the lane. What the lane genuinely owns here is the line below -
      // the retraction walks `page.skipped`, which the org path fills with
      // nothing, so deriving the skip set from anywhere else fails this.
      github.secretScanningSkipped.add("no42-org/other");

      const result = await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(result.skipped).toBe(0);
      expect(
        store
          .currentByTypeForOwner("repository_secret_scanning", "no42-org")
          .map((c) => [c.subject.key, c.state]),
      ).toEqual([
        ["no42-org/other", "present"],
        ["no42-org/twiki", "present"],
      ]);
    });

    it("stores every alert and confirms every watched repository", async () => {
      github.orgSecretScanningAlerts.set("no42-org", [
        makeSecretScanningAlert({ number: 3 }),
        makeSecretScanningAlert({ number: 4, validity: "unknown" }),
      ]);

      const result = await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(result).toEqual({
        installation: "no42-org",
        outcome: "ok",
        alerts: 2,
        unreadable: 0,
        skipped: 0,
      });
      expect(
        store.currentByType("secret_scanning_alert").map((v) => v.subject.key),
      ).toEqual(["no42-org/twiki#3", "no42-org/twiki#4"]);
      // One confirmation per watched repository, including the one with
      // nothing to report: that is what makes a real zero expressible. No
      // worst severity on either, because GitHub grades no secret.
      expect(
        store
          .currentByType("repository_secret_scanning")
          .map((v) => v.payload as RepoSecretScanningObservation),
      ).toEqual([
        { repo: "no42-org/other", openAlerts: 0 },
        { repo: "no42-org/twiki", openAlerts: 2 },
      ]);
      expect(store.latestRuns(1)[0]?.outcome).toBe("ok");
      expect(store.latestRuns(1)[0]?.lane).toBe(LANE);
    });

    it("writes confirmations and no rows for the live shape of this estate", async () => {
      // Measured 2026-09-09: 200, an ETag, no `link` header and zero alerts in
      // every state in all three installed organisations. The section must
      // read `0` and mean zero, which needs the confirmations without any
      // alert row behind them.
      github.orgSecretScanningAlerts.set("no42-org", []);

      const result = await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(result.alerts).toBe(0);
      expect(store.currentByType("secret_scanning_alert")).toEqual([]);
      expect(
        store
          .currentByType("repository_secret_scanning")
          .map((v) => v.payload as RepoSecretScanningObservation),
      ).toEqual([
        { repo: "no42-org/other", openAlerts: 0 },
        { repo: "no42-org/twiki", openAlerts: 0 },
      ]);
    });

    it("keeps alerts outside the allowlist out of the store", async () => {
      github.orgSecretScanningAlerts.set("no42-org", [
        makeSecretScanningAlert({ number: 1 }),
        makeSecretScanningAlert({
          number: 2,
          repo: { owner: "no42-org", name: "unwatched" },
        }),
      ]);

      const result = await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(result.alerts).toBe(1);
      expect(
        store.currentByType("secret_scanning_alert").map((v) => v.subject.key),
      ).toEqual(["no42-org/twiki#1"]);
    });

    it("tombstones a secret the listing no longer carries", async () => {
      github.orgSecretScanningAlerts.set("no42-org", [
        makeSecretScanningAlert({ number: 1 }),
      ]);
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      github.orgSecretScanningAlerts.set("no42-org", []);

      await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(
        store.currentByType("secret_scanning_alert").map((v) => v.state),
      ).toEqual(["resolved"]);
    });
  });

  describe("conditional requests (AD-25)", () => {
    it("sends no validator until every watched repository is confirmed", async () => {
      github.orgSecretScanningAlerts.set("no42-org", []);
      github.secretScanningValidators.set("no42-org", {
        etag: '"e1"',
        lastModified: null,
        tokenGen: "g1",
      });

      // First sweep: nothing confirmed, so nothing to revalidate against.
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      // Second: both watched repositories now carry a confirmation.
      await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(github.secretScanningCachedSeen).toEqual([
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
      github.orgSecretScanningAlerts.set("no42-org", []);
      github.secretScanningValidators.set("no42-org", {
        etag: '"e1"',
        lastModified: null,
        tokenGen: "g1",
      });
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      expect(github.secretScanningCachedSeen[1]).toEqual({
        etag: '"e1"',
        lastModified: null,
        tokenGen: "g1",
      });

      const r = store.beginRun({
        lane: "rest-org-secret-scanning",
        installation: "no42-org",
        scope: "full",
        startedAt: "2026-09-09T10:30:00.000Z",
      });
      store.recordTombstones(r, "2026-09-09T10:30:00.000Z", [
        secretScanningSubject({ owner: "no42-org", name: "other" }),
      ]);
      await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(github.secretScanningCachedSeen[2]).toBeNull();
    });

    it("confirms its stored rows on a 304 rather than rewriting them", async () => {
      github.orgSecretScanningAlerts.set("no42-org", [
        makeSecretScanningAlert({ number: 1 }),
      ]);
      github.secretScanningValidators.set("no42-org", {
        etag: '"e1"',
        lastModified: null,
        tokenGen: "g1",
      });
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      const before = store.currentByType("secret_scanning_alert")[0];
      github.secretScanningNotModified.add("no42-org");

      const result = await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(result).toEqual({
        installation: "no42-org",
        outcome: "ok",
        alerts: 1,
        unreadable: 0,
        skipped: 0,
      });
      const after = store.currentByType("secret_scanning_alert")[0];
      // Touched, not rewritten: the observation timestamp stands and only
      // the verification advances (AD-3's log stays change-only).
      expect(after?.observedAt).toBe(before?.observedAt);
      expect(after?.verifiedAt.localeCompare(before?.verifiedAt ?? "")).toBe(1);
      expect(store.latestRuns(1)[0]?.detail).toBe("not modified (304)");
    });

    it("uses its own validator key, not either sibling listing's", () => {
      // One cache entry per installation and request URL. Sharing a key with
      // another listing would have one lane's 304 confirm the other's rows.
      expect(orgSecretScanningUrl("No42-Org")).toBe(
        "/orgs/no42-org/secret-scanning/alerts?state=open&per_page=100",
      );
    });
  });

  describe("incomplete sweeps", () => {
    it("degrades to partial and tombstones nothing when the listing is truncated", async () => {
      github.orgSecretScanningAlerts.set("no42-org", [
        makeSecretScanningAlert({ number: 1 }),
      ]);
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      github.orgSecretScanningAlerts.set("no42-org", []);
      github.secretScanningTruncated.add("no42-org");

      const result = await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(result.outcome).toBe("partial");
      expect(
        store.currentByType("secret_scanning_alert").map((v) => v.state),
      ).toEqual(["present"]);
      // The lane's own name for what it read: a `rest-org-secret-scanning`
      // run reporting a `code scanning listing` sends the reader to the wrong
      // endpoint.
      expect(store.latestRuns(1)[0]?.detail).toBe(
        "secret scanning listing truncated at the pagination cap;" +
          " nothing tombstoned",
      );
    });

    it("purges the cached validator after an incomplete sweep", async () => {
      // The validator describes a listing the incomplete sweep has already
      // overwritten rows from. Leaving it cached lets the next sweep answer
      // 304 against it, confirm every present row as the whole answer and
      // skip the tombstone pass, so a revoked credential renders live for
      // ever (AD-23).
      github.orgSecretScanningAlerts.set("no42-org", [
        makeSecretScanningAlert({ number: 1 }),
      ]);
      github.secretScanningValidators.set("no42-org", {
        etag: '"e1"',
        lastModified: null,
        tokenGen: "g1",
      });
      // Two clean sweeps: the first confirms both repositories, the second
      // is the one that gets to send the cached validator.
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      github.secretScanningTruncated.add("no42-org");
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      github.secretScanningTruncated.delete("no42-org");

      await collectOrgSecretScanning(deps(), "no42-org", "full");

      const sent = { etag: '"e1"', lastModified: null, tokenGen: "g1" };
      expect(github.secretScanningCachedSeen).toEqual([
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
      github.orgSecretScanningAlerts.set("no42-org", []);
      github.secretScanningUnreadable.set("no42-org", 2);

      const result = await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(result).toEqual({
        installation: "no42-org",
        outcome: "partial",
        alerts: 0,
        unreadable: 2,
        skipped: 0,
      });
      // A partial sweep confirms nothing: its zero would be a confident one.
      expect(store.currentByType("repository_secret_scanning")).toEqual([]);
      expect(store.latestRuns(1)[0]?.detail).toContain(
        "2 alert payloads could not be read",
      );
    });

    it("contains a failure rather than aborting the cycle", async () => {
      github.secretScanningFailingOrgs.add("bad-org");
      watched.add("bad-org/x");

      const results = await collectAllOrgSecretScanning(
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
      github.repoSecretScanningAlerts.set("no42-org/twiki", [
        makeSecretScanningAlert({ number: 1 }),
      ]);

      const result = await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(github.secretScanningQueries).toEqual([
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

      const result = await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(result).toEqual({
        installation: "no42-org",
        outcome: "ok",
        alerts: 0,
        unreadable: 0,
        skipped: 0,
      });
      expect(github.secretScanningQueries[0]?.repos).toEqual([]);
    });

    it("skips a repository whose secret scanning is confirmed off, and confirms nothing about it", async () => {
      // The one live `off` this epic has: `CoolModFiles` answered
      // `404 Secret scanning is disabled on this repository.` on 2026-09-09.
      // The run stays ok - degrading would hold this lane partial for as long
      // as that repository exists - and the repository gets no confirmation,
      // so its Security section reads unconfirmed and never a confident zero
      // (AD-28).
      github.secretScanningSkipped.add("no42-org/other");
      github.repoSecretScanningAlerts.set("no42-org/twiki", [
        makeSecretScanningAlert({ number: 1 }),
      ]);

      const result = await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(result).toEqual({
        installation: "no42-org",
        outcome: "ok",
        alerts: 1,
        unreadable: 0,
        skipped: 1,
      });
      expect(
        store
          .currentByType("repository_secret_scanning")
          .map((v) => v.subject.key),
      ).toEqual(["no42-org/twiki"]);
      // Quoting the MEASURED body, from the recorded fixture, rather than a
      // sentence anyone typed here.
      expect(store.latestRuns(1)[0]?.detail).toBe(
        "skipped, no listing to read: no42-org/other" +
          " (Secret scanning is disabled on this repository.)",
      );
    });

    it("never tombstones a skipped repository's rows", async () => {
      // Its alerts are unlisted, not absent. Tombstoning them would report a
      // live credential as revoked on the strength of a listing nobody read.
      github.repoSecretScanningAlerts.set("no42-org/other", [
        makeSecretScanningAlert({
          number: 4,
          repo: { owner: "no42-org", name: "other" },
        }),
      ]);
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      github.repoSecretScanningAlerts.delete("no42-org/other");
      github.secretScanningSkipped.add("no42-org/other");

      await collectOrgSecretScanning(deps(), "no42-org", "full");

      // BOTH subject types, as key/state pairs: this is the conjunction the
      // change is actually about, and a single-field assertion on either one
      // alone would hold while the other went wrong (#171).
      expect(
        store
          .currentByType("secret_scanning_alert")
          .map((v) => [v.subject.key, v.state]),
      ).toEqual([["no42-org/other#4", "present"]]);
      expect(
        store
          .currentByTypeForOwner("repository_secret_scanning", "no42-org")
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
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      expect(
        store
          .currentByTypeForOwner("repository_secret_scanning", "no42-org")
          .map((c) => [c.subject.key, c.state]),
      ).toEqual([
        ["no42-org/other", "present"],
        ["no42-org/twiki", "present"],
      ]);

      github.secretScanningSkipped.add("no42-org/other");
      await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(
        store
          .currentByTypeForOwner("repository_secret_scanning", "no42-org")
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
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      github.secretScanningSkipped.add("no42-org/other");
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(
        store
          .currentByTypeForOwner("repository_secret_scanning", "no42-org")
          .map((c) => [c.subject.key, c.state]),
      ).toEqual([
        ["no42-org/other", "resolved"],
        ["no42-org/twiki", "present"],
      ]);
      expect(logs.filter((l) => l.includes("confirmations retracted"))).toEqual(
        ["rest-org-secret-scanning no42-org: 1 confirmations retracted"],
      );
    });

    it("retracts nothing for a repository it never confirmed", async () => {
      // The common case, and the one withholding already covered: there is
      // no assertion to retract, so no tombstone is written for it either.
      github.secretScanningSkipped.add("no42-org/other");

      await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(
        store
          .currentByTypeForOwner("repository_secret_scanning", "no42-org")
          .map((c) => [c.subject.key, c.state]),
      ).toEqual([["no42-org/twiki", "present"]]);
    });

    it("confirms it again when the listing comes back", async () => {
      // A retraction is not terminal. The repository reads its real count
      // again on the next sweep that covers it, which is what makes this a
      // retracted assertion rather than a permanent verdict.
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      github.secretScanningSkipped.add("no42-org/other");
      await collectOrgSecretScanning(deps(), "no42-org", "full");

      github.secretScanningSkipped.delete("no42-org/other");
      github.repoSecretScanningAlerts.set("no42-org/other", [
        makeSecretScanningAlert({
          number: 7,
          repo: { owner: "no42-org", name: "other" },
        }),
      ]);
      await collectOrgSecretScanning(deps(), "no42-org", "full");

      const back = store
        .currentByTypeForOwner("repository_secret_scanning", "no42-org")
        .find((c) => c.subject.key === "no42-org/other");
      // The whole payload, not just the count: a retraction that came back
      // with a stale or empty summary would still read `present`.
      expect(back?.state).toBe("present");
      expect(back?.payload).toEqual({
        repo: "no42-org/other",
        openAlerts: 1,
      });
    });

    it("retracts nothing on a partial run", async () => {
      // The same guard the tombstone pass beside it uses. A run that could
      // not read everything must not retract on the strength of what it did
      // read.
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      github.secretScanningSkipped.add("no42-org/other");
      github.secretScanningUnreachable.add("no42-org/twiki");

      const result = await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(result.outcome).toBe("partial");
      expect(
        store
          .currentByTypeForOwner("repository_secret_scanning", "no42-org")
          .map((c) => [c.subject.key, c.state]),
      ).toEqual([
        ["no42-org/other", "present"],
        ["no42-org/twiki", "present"],
      ]);
    });

    it("retracts only its own subject, never another lane's", async () => {
      // The mirror of the code scanning case. Three lanes with their own
      // freshness, and the retraction is bound by the same rule as the
      // write: a skipped secret scanning listing says nothing about what the
      // code scanning lane saw.
      await collectOrgCodeScanning(deps(), "no42-org", "full");
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      // Skipped in BOTH lanes, which is the scenario the matrix row names:
      // with only one lane skipping, the other lane's rows are untouched
      // whether or not any retraction happens at all, and this test would
      // pass with the feature deleted.
      github.secretScanningSkipped.add("no42-org/other");
      github.codeScanningSkipped.add("no42-org/other");

      await collectOrgSecretScanning(deps(), "no42-org", "full");

      // The positive half: THIS lane retracted.
      expect(
        store
          .currentByTypeForOwner("repository_secret_scanning", "no42-org")
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
      await collectOrgSecretScanning(deps(), "no42-org", "full");
      github.secretScanningSkipped.add("no42-org/other");

      await collectOrgSecretScanning(deps(), "no42-org", "hot");

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
      github.secretScanningUnreachable.add("no42-org/other");

      const result = await collectOrgSecretScanning(deps(), "no42-org", "full");

      expect(result.outcome).toBe("partial");
      expect(store.latestRuns(1)[0]?.detail).toBe(
        "1 repositories could not be read:" +
          " no42-org/other (no reason recorded)",
      );
    });
  });

  it("writes its confirmation under its own subject, never another lane's", async () => {
    // Three lanes with their own freshness. One vouching for another is how a
    // fresh Dependabot sweep would badge a section nothing swept.
    github.orgSecretScanningAlerts.set("no42-org", []);

    await collectOrgSecretScanning(deps(), "no42-org", "full");

    expect(store.currentByType("repository")).toEqual([]);
    expect(store.currentByType("repository_code_scanning")).toEqual([]);
    expect(
      store.currentByType("repository_secret_scanning").map((v) => v.subject),
    ).toEqual([
      secretScanningSubject({ owner: "no42-org", name: "other" }),
      secretScanningSubject(REPO),
    ]);
  });

  describe("the credential, from the wire to the store", () => {
    /**
     * The real adapter over a stub that answers with the schema fixture,
     * which carries `secret`.
     *
     * The fake port cannot exercise this: its alerts are domain objects a
     * human wrote, and the type they are written to has no credential field
     * to put one in. Only the adapter ever sees the wire payload, so only a
     * test that goes through the adapter can prove the drop.
     */
    const realPort = (raw: unknown) => {
      const gh = {
        auth: async () => ({ token: "x", expiresAt: "2026-09-09T12:00:00Z" }),
        request: async () => ({ data: [raw], headers: {} }),
      } as unknown as Octokit;
      return new OctokitGitHub(
        async () => gh,
        () => true,
        async () => gh,
        () => "organization",
      );
    };

    it("never reaches the store or the log, from a payload that carried it", async () => {
      const raw = JSON.parse(
        readFileSync(
          join(
            import.meta.dirname,
            "fixtures/github/secret-scanning-alert-org.schema.json",
          ),
          "utf8",
        ),
      ) as { secret: string; secret_type_display_name: string };

      await collectOrgSecretScanning(
        { ...deps(), github: realPort(raw) },
        "no42-org",
        "full",
      );

      // The row landed, so this is not passing by collecting nothing.
      const rows = store.currentByType("secret_scanning_alert");
      expect(rows.map((v) => v.subject.key)).toEqual(["no42-org/twiki#3"]);
      expect(
        (rows[0]?.payload as SecretScanningAlertObservation | undefined)
          ?.secretType,
      ).toBe(raw.secret_type_display_name);

      // Every stored payload, serialised, and every line this lane logged.
      expect(JSON.stringify(rows)).not.toContain(raw.secret);
      expect(logs.join("\n")).not.toContain(raw.secret);
      // And the run detail, which is the other thing that persists text.
      expect(
        store
          .latestRuns(5)
          .map((r) => r.detail ?? "")
          .join("\n"),
      ).not.toContain(raw.secret);

      // The database FILE, not only what the store hands back: a column we
      // forgot to read would still be bytes on disk. WAL mode keeps recent
      // writes in the sidecar, so every file of the set is searched.
      store.close();
      const onDisk = readdirSync(dir)
        .map((f) => readFileSync(join(dir, f)).toString("latin1"))
        .join("");
      expect(onDisk).not.toContain(raw.secret);
      // The same bytes DO carry the display name, which is what proves the
      // search would have found the credential had it been written.
      expect(onDisk).toContain(raw.secret_type_display_name);
      // Reopened so the suite's afterEach can close it without throwing.
      store = SqliteStore.openForWrite(join(dir, "s.db"));
    });
  });
});
