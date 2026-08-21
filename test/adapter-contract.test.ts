/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { OctokitGitHub } from "../src/github/octokit-adapter.js";
import {
  makeAlert,
  makeUpdatePr,
  makeUpdateStatus,
  makeWorkflowRun,
} from "./fakes.js";

// The contract between the fakes and the real adapter.
//
// Every lane test in this suite runs against FakeGitHubReadPort, which is a
// second implementation of the port: it hands back domain objects that a
// human wrote, not payloads GitHub sent. So a lane test passing says the
// lane agrees with the fake, and nothing at all about whether the fake
// agrees with GitHub.
//
// That gap has cost real collection twice. The per-repository alert listing
// omits the `repository` key the org listing carries, so every alert failed
// to map and the lane reported 31 unreadable payloads and zero alerts for
// repositories that had 31 - with 613 tests green. Three mutations in the
// same slice survived for the same reason.
//
// These tests close it from both ends. Each recorded payload is real, kept
// verbatim (fields this build ignores included, because tomorrow's build
// may not ignore them), and is driven through the REAL adapter. Then the
// hand-written fixture is required to carry exactly the fields the adapter
// produced: a builder that grows a field the adapter cannot produce, or
// misses one the lanes now read, fails here rather than in production.

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(join(import.meta.dirname, "fixtures/github", name), "utf8"),
  );

/** An Octokit whose every REST read answers with one recorded payload. */
function restStub(data: unknown, headers: Record<string, string> = {}) {
  return {
    auth: async () => ({ token: "x", expiresAt: "2026-08-21T12:00:00Z" }),
    request: async () => ({ data, headers }),
    paginate: async () => (Array.isArray(data) ? data : [data]),
    // The listing endpoints are reached as method references rather than
    // route strings, so the stub has to offer them by name.
    repos: { listForOrg: "listForOrg", listForUser: "listForUser" },
    apps: {
      listReposAccessibleToInstallation: "listReposAccessibleToInstallation",
    },
  } as unknown as Octokit;
}

const adapterFor = (gh: Octokit, kind: "user" | "organization") =>
  new OctokitGitHub(
    async () => gh,
    () => true,
    async () => gh,
    () => kind,
  );

/**
 * The anti-drift assertion.
 *
 * Same key set, not same values: the fixture is allowed to say whatever it
 * likes about a package name, but it may not invent a field the adapter
 * never produces, nor omit one the lanes have started reading.
 */
function expectSameShape(fake: object, produced: object, what: string) {
  expect(Object.keys(fake).sort(), `${what}: fixture keys`).toEqual(
    Object.keys(produced).sort(),
  );
}

describe("the recorded payloads still map (Dependabot alerts)", () => {
  it("maps the org listing, which names the repository on every alert", async () => {
    const raw = fixture("alert-org.json");
    const adapter = adapterFor(restStub([raw]), "organization");

    const page = await adapter.listDependabotAlerts("no42-org", []);

    expect(page.unreadable, "a real payload must map").toBe(0);
    const alert = page.alerts[0];
    expect(alert).toBeDefined();
    // The fields the ranking chain and the pages actually read. Asserted
    // present rather than equal to a literal, so a re-recorded fixture does
    // not break the test for the wrong reason.
    expect(alert?.repo.owner).toBeTruthy();
    expect(alert?.repo.name).toBeTruthy();
    expect(typeof alert?.number).toBe("number");
    expect(alert?.severity).toBeTruthy();
    // EPSS at ingest is AD-18's whole basis; losing it silently would drop
    // the chain's second term to unknown for every alert.
    expect(typeof alert?.epssPercentage).toBe("number");
    expectSameShape(makeAlert(), alert as object, "RawDependabotAlert");
  });

  it("maps the per-repository listing, which names no repository at all", async () => {
    // The shape that broke: `repository` is absent here, because the URL
    // already said which repository it is.
    const raw = fixture("alert-repo.json") as Record<string, unknown>;
    expect(
      raw.repository,
      "fixture must be the per-repo shape",
    ).toBeUndefined();
    const adapter = adapterFor(restStub([raw]), "user");

    const page = await adapter.listDependabotAlerts("no42-org", [
      { owner: "no42-org", name: "docs.opennms.eu" },
    ]);

    expect(page.unreadable).toBe(0);
    const alert = page.alerts[0];
    // Attributed from the repository the caller asked about.
    expect(alert?.repo).toEqual({ owner: "no42-org", name: "docs.opennms.eu" });
    expect(typeof alert?.epssPercentage).toBe("number");
    expectSameShape(makeAlert(), alert as object, "RawDependabotAlert");
  });
});

describe("the recorded payloads still map (workflow runs)", () => {
  it("maps a run listing", async () => {
    const raw = fixture("workflow-run.json");
    const adapter = adapterFor(
      restStub({ workflow_runs: [raw] }),
      "organization",
    );

    const page = await adapter.listRepoWorkflowRuns({
      owner: "no42-org",
      name: "packyard",
    });

    expect(page.unreadable).toBe(0);
    const run = page.runs[0];
    expect(run?.workflowName).toBeTruthy();
    expect(typeof run?.runNumber).toBe("number");
    expect(run?.status).toBeTruthy();
    expect(run?.event).toBeTruthy();
    // Carried through, not merely present in the payload: head_branch is
    // the only branch information this lane has (the payload's own
    // repository object reports a null default_branch), and the
    // per-repository page renders it.
    expect(run?.headBranch).toBe(
      (fixture("workflow-run.json") as { head_branch: string }).head_branch,
    );
    expect(run?.conclusion).toBe(
      (fixture("workflow-run.json") as { conclusion: string | null })
        .conclusion,
    );
    expectSameShape(makeWorkflowRun(), run as object, "RawWorkflowRun");
  });

  it("keeps carrying the branch, which the payload's own repository does not", () => {
    // Measured 2026-08-18: the run payload's nested repository object has a
    // null default_branch, so head_branch is the only branch information
    // this lane has and the per-repository page renders it.
    const raw = fixture("workflow-run.json") as {
      head_branch?: unknown;
      repository?: { default_branch?: unknown };
    };
    expect(raw.head_branch).toBeTruthy();
    expect(raw.repository?.default_branch ?? null).toBeNull();
  });
});

describe("the recorded payloads still map (GraphQL nodes)", () => {
  it("maps a pull-request search node", async () => {
    const node = fixture("search-pr-node.json");
    const gh = {
      graphql: async () => ({
        search: {
          issueCount: 1,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [node],
        },
      }),
    } as unknown as Octokit;
    const adapter = adapterFor(gh, "organization");

    const page = await adapter.listOpenUpdatePRs(
      [{ owner: "no42-org", name: "blittermib" }],
      ["app/dependabot"],
    );

    expect(page.unreadable).toBe(0);
    const pr = page.prs[0];
    expect(pr?.nodeId).toBeTruthy();
    expect(pr?.title).toBeTruthy();
    expect(pr?.repo.owner).toBeTruthy();
    expectSameShape(makeUpdatePr(), pr as object, "RawUpdatePr");
  });

  it("maps a vulnerabilityAlert node, including the not-attempted shape", async () => {
    // dependabotUpdate is null on the recorded node, which is the state the
    // whole estate is in: GitHub is not attempting a fix. That is a fact
    // (n/a), not a gap, and collapsing it into "no error" would report an
    // update nobody is preparing as prepared normally.
    const node = fixture("update-status-node.json") as {
      dependabotUpdate: unknown;
    };
    expect(node.dependabotUpdate).toBeNull();
    const gh = {
      graphql: async () => ({
        repository: {
          vulnerabilityAlerts: {
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes: [node],
          },
        },
      }),
    } as unknown as Octokit;
    const adapter = adapterFor(gh, "organization");

    const statuses = await adapter.listDependabotUpdateStatuses({
      owner: "no42-org",
      name: "docs.opennms.eu",
    });

    expect(statuses[0]?.update).toBeNull();
    expectSameShape(
      makeUpdateStatus({ update: null }),
      statuses[0] as object,
      "RawUpdateStatus",
    );
  });
});

describe("the recorded payloads still map (repository metadata)", () => {
  it("maps an organisation repository listing", async () => {
    const raw = fixture("repo-meta.json");
    const adapter = adapterFor(restStub([raw]), "organization");

    const metas = await adapter.listOrgRepos("no42-org");

    expect(metas).toHaveLength(1);
    expect(metas[0]?.repo.owner).toBeTruthy();
    expect(metas[0]?.repo.name).toBeTruthy();
    // Booleans, never undefined: coverage reads these to decide whether a
    // repository can be vouched for at all.
    expect(typeof metas[0]?.archived).toBe("boolean");
    expect(typeof metas[0]?.disabled).toBe("boolean");
  });
});
