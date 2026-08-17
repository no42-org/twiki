/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import type { RepoRef } from "../src/core/types.js";
import type {
  AppIdentity,
  GitHubAppPort,
  InstallationRef,
} from "../src/github/port.js";
import {
  diagnose,
  formatReport,
  writablePermissions,
} from "../src/tricorder/doctor.js";

const READ_ONLY: Record<string, string> = {
  metadata: "read",
  vulnerability_alerts: "read",
  actions: "read",
  pull_requests: "read",
  issues: "read",
};

function fakeApp(over: {
  permissions?: Record<string, string>;
  installations?: InstallationRef[];
  repos?: Record<number, RepoRef[]>;
}): GitHubAppPort {
  const identity: AppIdentity = {
    slug: "gitricorder",
    name: "gitricorder",
    permissions: over.permissions ?? READ_ONLY,
  };
  return {
    identity: async () => identity,
    listInstallations: async () => over.installations ?? [],
    listInstallationRepos: async (id) => over.repos?.[id] ?? [],
  };
}

const inst = (id: number, account: string, selection = "selected") => ({
  id,
  account,
  repositorySelection: selection,
});

describe("App permissions (AD-21)", () => {
  it("accepts an App that can only read", () => {
    expect(writablePermissions(READ_ONLY)).toEqual([]);
  });

  it("names every permission that is not read", () => {
    expect(
      writablePermissions({ ...READ_ONLY, contents: "write", checks: "write" }),
    ).toEqual(["checks=write", "contents=write"]);
  });

  it("treats admin as writable, not as a kind of read", () => {
    expect(writablePermissions({ administration: "admin" })).toEqual([
      "administration=admin",
    ]);
  });

  it("fails the whole report when the App can write anything at all", async () => {
    // The one thing gitricorder's design rules out. A credential that can merge
    // is not a dashboard credential, however read-only the code happens to be.
    const report = await diagnose(
      fakeApp({ permissions: { ...READ_ONLY, contents: "write" } }),
      [],
    );
    expect(report.ok).toBe(false);
    expect(report.writable).toEqual(["contents=write"]);
    expect(formatReport(report)).toContain("REFUSING");
  });
});

describe("reachability of the watched set", () => {
  const twiki = { owner: "no42-org", name: "twiki" };
  const other = { owner: "no42-org", name: "quiet" };
  const elsewhere = { owner: "other-org", name: "thing" };

  it("reports a watched repository the installation can see", async () => {
    const report = await diagnose(
      fakeApp({
        installations: [inst(1, "no42-org")],
        repos: { 1: [twiki, other] },
      }),
      [twiki],
    );
    expect(report.ok).toBe(true);
    expect(report.installations[0]?.reachable).toEqual(["no42-org/twiki"]);
    expect(report.orphaned).toEqual([]);
  });

  it("reports a watched repository the installation cannot see", async () => {
    const report = await diagnose(
      fakeApp({ installations: [inst(1, "no42-org")], repos: { 1: [other] } }),
      [twiki, other],
    );
    expect(report.installations[0]?.unreachable).toEqual(["no42-org/twiki"]);
    expect(report.ok).toBe(false);
  });

  it("reports a watched repository with no installation at all", async () => {
    // The App was never installed on that account. Nothing will ever collect
    // for it, and AD-28 says that must not read as a healthy zero.
    const report = await diagnose(
      fakeApp({ installations: [inst(1, "no42-org")], repos: { 1: [twiki] } }),
      [twiki, elsewhere],
    );
    expect(report.orphaned).toEqual(["other-org/thing"]);
    expect(report.ok).toBe(false);
    expect(formatReport(report)).toContain("no installation can see");
  });

  it("matches a mixed-case repos.yaml entry to what GitHub reports", async () => {
    // Both sides carry their own casing and neither is authoritative: repos.yaml
    // is hand-written, and GitHub reports whatever the repository was created
    // as. Folding only one side still reports a reachable repository as
    // missing, so the fixture disagrees in both directions (AD-22).
    const report = await diagnose(
      fakeApp({
        installations: [inst(1, "No42-Org")],
        repos: { 1: [{ owner: "No42-Org", name: "TWiki" }] },
      }),
      [{ owner: "no42-org", name: "twiki" }],
    );
    expect(report.orphaned).toEqual([]);
    expect(report.installations[0]?.reachable).toEqual(["no42-org/twiki"]);

    // And the other way round, because folding only the side the first fixture
    // happens to exercise leaves the other one free to regress.
    const reversed = await diagnose(
      fakeApp({
        installations: [inst(1, "no42-org")],
        repos: { 1: [{ owner: "no42-org", name: "twiki" }] },
      }),
      [{ owner: "No42-Org", name: "TWiki" }],
    );
    expect(reversed.orphaned).toEqual([]);
    expect(reversed.installations[0]?.reachable).toEqual(["no42-org/twiki"]);
  });

  it("is not fooled by a repository visible under a different account", async () => {
    const report = await diagnose(
      fakeApp({
        installations: [inst(1, "other-org")],
        repos: { 1: [{ owner: "other-org", name: "twiki" }] },
      }),
      [twiki],
    );
    expect(report.orphaned).toEqual(["no42-org/twiki"]);
  });

  it("says OK only when nothing is wrong", async () => {
    const clean = await diagnose(
      fakeApp({ installations: [inst(1, "no42-org")], repos: { 1: [twiki] } }),
      [twiki],
    );
    expect(formatReport(clean)).toContain("OK");
    expect(formatReport(clean)).not.toContain("NOT OK");
  });

  it("writes nothing, so it is safe against a live installation", async () => {
    // The port it depends on exposes no write method at all. If that ever
    // changes, this fails to compile rather than quietly gaining the ability.
    const app = fakeApp({});
    expect(Object.keys(app).sort()).toEqual([
      "identity",
      "listInstallationRepos",
      "listInstallations",
    ]);
  });
});
