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
  missingReads,
  writablePermissions,
} from "../src/tricorder/doctor.js";

/** Exactly what AD-21 asks for, and nothing else. */
const READ_ONLY: Record<string, string> = {
  metadata: "read",
  vulnerability_alerts: "read",
  security_events: "read",
  secret_scanning_alerts: "read",
  actions: "read",
  pull_requests: "read",
  issues: "read",
};

function fakeApp(over: {
  permissions?: Record<string, string> | null;
  installations?: InstallationRef[];
  repos?: Record<number, RepoRef[]>;
}): GitHubAppPort {
  const identity: AppIdentity = {
    slug: "gitricorder",
    name: "gitricorder",
    permissions: over.permissions === undefined ? READ_ONLY : over.permissions,
  };
  return {
    identity: async () => identity,
    listInstallations: async () => over.installations ?? [],
    listInstallationRepos: async (id) => over.repos?.[id] ?? [],
  };
}

const inst = (
  id: number,
  account: string,
  selection = "selected",
  accountKind: "user" | "organization" | "unknown" = "organization",
) => ({
  id,
  account,
  repositorySelection: selection,
  accountKind,
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

  it("refuses when GitHub reported no permissions at all", async () => {
    // The one uncertain path. An absent permissions object is "we could not
    // tell", and reporting that as read-only would have this command certify
    // exactly the App it exists to reject.
    const report = await diagnose(fakeApp({ permissions: null }), []);
    expect(report.ok).toBe(false);
    expect(formatReport(report)).toContain("reported no permissions");
  });

  it("does not read an empty permission set as proof of read-only", async () => {
    const report = await diagnose(fakeApp({ permissions: {} }), []);
    expect(report.ok).toBe(false);
  });
});

describe("required read permissions", () => {
  it("accepts an App holding every read gitricorder needs", () => {
    expect(missingReads(READ_ONLY)).toEqual([]);
  });

  it("names the reads an App is missing", () => {
    // A metadata-only App passes every write check, reports OK, and then
    // collects nothing forever: the confident zero arriving through the
    // credential rather than through a lane.
    expect(missingReads({ metadata: "read" })).toEqual([
      "actions",
      "issues",
      "pull_requests",
      "secret_scanning_alerts",
      "security_events",
      "vulnerability_alerts",
    ]);
  });

  it("fails the report and explains what each missing read is for", async () => {
    const report = await diagnose(
      fakeApp({ permissions: { metadata: "read" } }),
      [],
    );
    expect(report.ok).toBe(false);
    const text = formatReport(report);
    expect(text).toContain("Missing 6 required read permissions");
    expect(text).toContain("the only EPSS-bearing endpoint");
  });

  it("prints what GitHub actually reported, so a renamed permission is visible", async () => {
    // If GitHub renames one, this must read as a name mismatch rather than as
    // "you did not grant something you did grant".
    const report = await diagnose(
      fakeApp({ permissions: { metadata: "read", renamed_alerts: "read" } }),
      [],
    );
    expect(formatReport(report)).toContain("renamed_alerts");
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

  it("does not invent a name for an installation GitHub did not name", async () => {
    // An enterprise installation carries a slug, not a login. A synthetic
    // fallback can never match a real owner, so it would orphan every
    // repository under that account and blame the allowlist.
    // Every watched repository is reachable through the named installation, so
    // the unnamed one is the ONLY thing wrong. Without that, this passes
    // because the repository was orphaned instead, and the check being tested
    // could be deleted without the test noticing.
    const report = await diagnose(
      fakeApp({
        installations: [
          inst(1, "no42-org"),
          {
            id: 7,
            account: null,
            repositorySelection: "all",
            accountKind: "unknown" as const,
          },
        ],
        repos: { 1: [twiki] },
      }),
      [twiki],
    );
    expect(report.orphaned).toEqual([]);
    expect(report.unnamed).toEqual([7]);
    expect(report.ok).toBe(false);
    expect(formatReport(report)).toContain("named no account");
  });

  it("does not enumerate repositories for an account nothing is watched on", async () => {
    // Each enumeration mints an installation token and pages a listing. An App
    // installed broadly to watch a few repositories should not pay for the rest.
    const asked: number[] = [];
    const app = fakeApp({
      installations: [inst(1, "no42-org"), inst(2, "unrelated-org")],
      repos: { 1: [twiki], 2: [{ owner: "unrelated-org", name: "thing" }] },
    });
    const counted: GitHubAppPort = {
      ...app,
      listInstallationRepos: async (id) => {
        asked.push(id);
        return app.listInstallationRepos(id);
      },
    };

    await diagnose(counted, [twiki]);
    expect(asked).toEqual([1]);
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
