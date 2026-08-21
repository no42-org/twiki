/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import { OctokitGitHub } from "../src/github/octokit-adapter.js";

// The contract between the fakes and the real adapter.
//
// Every lane test in this suite runs against FakeGitHubReadPort, which is a
// second implementation of the port: it hands back domain objects a human
// wrote, not payloads GitHub sent. A passing lane test therefore says the
// lane agrees with the fake, and nothing about whether the fake agrees with
// GitHub. That gap let the per-repository alert listing ship broken - every
// alert failed to map, 31 unreadable payloads, zero alerts, 613 tests green.
//
// EVERY ASSERTION HERE COMPARES A MAPPED VALUE AGAINST THE RECORDED PAYLOAD.
// The first version of this file mostly checked that fields were truthy or
// of the right type, which the mappers guarantee by construction: their
// fallbacks (`workflow ${id}`, "unknown", `r.archived === true`) mean a
// mis-keyed or inverted field still yields a truthy string or a boolean. A
// review measured it: inverting `archived`, mis-keying the workflow name,
// nulling htmlUrl and mis-keying the PR author each survived the whole
// 624-test suite. A test that cannot fail is worse than no test, because it
// gets counted as cover.

const FIXTURES = join(import.meta.dirname, "fixtures/github");

/** A payload recorded verbatim from the live API. */
const recorded = <T = Record<string, unknown>>(name: string): T =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as T;

/**
 * A payload DERIVED from a recorded one, for a state this estate does not
 * contain and so cannot be recorded from: no repository on it is archived,
 * and no alert anywhere carries a non-null `dependabotUpdate`, because
 * GitHub is not attempting a fix on any of them. Each starts from a real
 * payload and changes only documented fields. That is weaker evidence than
 * a recording, and is named so nobody mistakes one for the other.
 */
const derived = <T = Record<string, unknown>>(name: string): T =>
  recorded<T>(name);

/** An Octokit whose every REST read answers with one payload. */
function restStub(data: unknown, headers: Record<string, string> = {}) {
  return {
    auth: async () => ({ token: "x", expiresAt: "2026-08-21T12:00:00Z" }),
    request: async () => ({ data, headers }),
    paginate: async () => (Array.isArray(data) ? data : [data]),
    repos: { listForOrg: "listForOrg", listForUser: "listForUser" },
    apps: {
      listReposAccessibleToInstallation: "listReposAccessibleToInstallation",
    },
  } as unknown as Octokit;
}

const graphqlStub = (answer: unknown) =>
  ({ graphql: async () => answer }) as unknown as Octokit;

const adapterFor = (gh: Octokit, kind: "user" | "organization") =>
  new OctokitGitHub(
    async () => gh,
    () => true,
    async () => gh,
    () => kind,
  );

describe("Dependabot alerts map field for field", () => {
  it("maps the org listing, which names the repository on every alert", async () => {
    const raw = recorded<{
      number: number;
      state: string;
      html_url: string;
      created_at: string;
      repository: { name: string; owner: { login: string } };
      dependency: {
        package: { name: string; ecosystem: string };
        relationship?: string;
        scope?: string;
      };
      security_advisory: {
        ghsa_id: string;
        cve_id: string | null;
        severity: string;
        epss: { percentage: number; percentile: number };
      };
    }>("alert-org.json");
    const adapter = adapterFor(restStub([raw]), "organization");

    const page = await adapter.listDependabotAlerts("no42-org", []);

    expect(page.unreadable, "a real payload must map").toBe(0);
    // Every field the lanes store or the pages read, compared against the
    // payload rather than merely typechecked.
    expect(page.alerts[0]).toEqual({
      number: raw.number,
      repo: { owner: raw.repository.owner.login, name: raw.repository.name },
      state: raw.state,
      severity: raw.security_advisory.severity,
      ghsaId: raw.security_advisory.ghsa_id,
      cveId: raw.security_advisory.cve_id,
      packageName: raw.dependency.package.name,
      ecosystem: raw.dependency.package.ecosystem,
      // AD-18's whole basis: captured at ingest, never re-read.
      epssPercentage: raw.security_advisory.epss.percentage,
      epssPercentile: raw.security_advisory.epss.percentile,
      relationship: raw.dependency.relationship ?? null,
      scope: raw.dependency.scope ?? null,
      htmlUrl: raw.html_url,
      createdAt: raw.created_at,
    });
  });

  it("maps the per-repository listing, which names no repository at all", async () => {
    // The shape that shipped broken: `repository` is absent here, because
    // the URL already said which repository it is.
    const raw = recorded("alert-repo.json");
    expect(
      raw.repository,
      "fixture must be the per-repo shape",
    ).toBeUndefined();
    const adapter = adapterFor(restStub([raw]), "user");

    const page = await adapter.listDependabotAlerts("no42-org", [
      { owner: "no42-org", name: "docs.opennms.eu" },
    ]);
    const alert = page.alerts[0];
    const advisory = raw.security_advisory as {
      severity: string;
      cve_id: string | null;
      epss: { percentage: number };
    };

    expect(page.unreadable).toBe(0);
    // Attributed from the repository the caller asked about, since the
    // payload cannot say.
    expect(alert?.repo).toEqual({ owner: "no42-org", name: "docs.opennms.eu" });
    expect(alert?.number).toBe(raw.number);
    expect(alert?.severity).toBe(advisory.severity);
    expect(alert?.cveId).toBe(advisory.cve_id);
    expect(alert?.epssPercentage).toBe(advisory.epss.percentage);
    expect(alert?.htmlUrl).toBe(raw.html_url);
  });
});

describe("workflow runs map field for field", () => {
  it("maps a run listing", async () => {
    const raw = recorded<{
      node_id: string;
      workflow_id: number;
      name: string;
      run_number: number;
      status: string;
      conclusion: string | null;
      head_branch: string;
      event: string;
      html_url: string;
      created_at: string;
    }>("workflow-run.json");
    const adapter = adapterFor(
      restStub({ workflow_runs: [raw] }),
      "organization",
    );

    const page = await adapter.listRepoWorkflowRuns({
      owner: "no42-org",
      name: "packyard",
    });

    expect(page.unreadable).toBe(0);
    expect(page.runs[0]).toEqual({
      nodeId: raw.node_id,
      repo: { owner: "no42-org", name: "packyard" },
      workflowId: raw.workflow_id,
      // Compared against the payload's own name: the mapper falls back to
      // `workflow ${id}`, so a mis-keyed name still produces a truthy
      // string and every run would render as "workflow 254360755".
      workflowName: raw.name,
      runNumber: raw.run_number,
      status: raw.status,
      conclusion: raw.conclusion,
      headBranch: raw.head_branch,
      event: raw.event,
      htmlUrl: raw.html_url,
      createdAt: raw.created_at,
    });
  });

  it("has no default_branch to filter by, which is why head_branch is kept", () => {
    // The key is ABSENT, not null. The original measurement read it through
    // jq, which prints null for both, and the comment it produced said the
    // payload "carries a null default_branch" - a claim the payload never
    // makes. Asserting `?? null` would have passed either way.
    const raw = recorded<{ repository: Record<string, unknown> }>(
      "workflow-run.json",
    );
    expect("default_branch" in raw.repository).toBe(false);
  });
});

describe("GraphQL nodes map field for field", () => {
  const searchAnswer = (node: unknown) => ({
    search: {
      issueCount: 1,
      pageInfo: { hasNextPage: false, endCursor: null },
      nodes: [node],
    },
  });

  interface SearchNode {
    id: string;
    number: number;
    title: string;
    url: string;
    createdAt: string;
    author: { login: string };
    repository: { name: string; owner: { login: string } };
  }

  it("maps a pull-request search node", async () => {
    const node = recorded<SearchNode>("search-pr-node.json");
    const adapter = adapterFor(graphqlStub(searchAnswer(node)), "organization");

    const page = await adapter.listOpenUpdatePRs(
      [{ owner: "no42-org", name: "blittermib" }],
      ["app/dependabot"],
    );

    expect(page.unreadable).toBe(0);
    expect(page.prs[0]).toEqual({
      nodeId: node.id,
      repo: { owner: node.repository.owner.login, name: node.repository.name },
      number: node.number,
      title: node.title,
      // The mapper falls back to "unknown", so a mis-keyed author is still a
      // truthy string, which the queue would render as the PR's author.
      author: node.author.login,
      htmlUrl: node.url,
      createdAt: node.createdAt,
    });
  });

  it("maps an issue search node", async () => {
    // CAP-2's lane, which had no contract case at all while fakes.ts
    // claimed every builder there was pinned against a recorded payload.
    const node = recorded<SearchNode>("search-issue-node.json");
    const adapter = adapterFor(graphqlStub(searchAnswer(node)), "organization");

    const page = await adapter.listUntriagedIssues([
      { owner: "no42-org", name: "CoolModFiles" },
    ]);

    expect(page.unreadable).toBe(0);
    expect(page.issues[0]).toEqual({
      nodeId: node.id,
      repo: { owner: node.repository.owner.login, name: node.repository.name },
      number: node.number,
      title: node.title,
      author: node.author.login,
      htmlUrl: node.url,
      createdAt: node.createdAt,
    });
  });

  const alertsAnswer = (node: unknown) => ({
    repository: {
      vulnerabilityAlerts: {
        pageInfo: { hasNextPage: false, endCursor: null },
        nodes: [node],
      },
    },
  });

  it("maps an alert GitHub is not attempting a fix for", async () => {
    // The state this whole estate is in. Null is a FACT (n/a), distinct
    // from an attempted update carrying no error, and collapsing the two
    // reports an update nobody is preparing as prepared normally.
    const node = recorded<{ number: number; dependabotUpdate: null }>(
      "update-status-node.json",
    );
    expect(node.dependabotUpdate).toBeNull();
    const adapter = adapterFor(graphqlStub(alertsAnswer(node)), "organization");

    const statuses = await adapter.listDependabotUpdateStatuses({
      owner: "no42-org",
      name: "docs.opennms.eu",
    });

    expect(statuses).toEqual([
      {
        repo: { owner: "no42-org", name: "docs.opennms.eu" },
        alertNumber: node.number,
        update: null,
      },
    ]);
  });

  it("maps an attempted update, PR number and error alike", async () => {
    // CAP-3's stuck criterion, and the branch no recording can cover: no
    // alert on this estate has a non-null dependabotUpdate. Derived from
    // the recorded node by populating the documented fields.
    const node = derived<{
      number: number;
      dependabotUpdate: {
        pullRequest: { number: number };
        error: { title: string; errorType: string };
      };
    }>("update-status-attempted.derived.json");
    const adapter = adapterFor(graphqlStub(alertsAnswer(node)), "organization");

    const statuses = await adapter.listDependabotUpdateStatuses({
      owner: "no42-org",
      name: "docs.opennms.eu",
    });

    expect(statuses[0]?.update).toEqual({
      // Mis-keying this reports every prepared update as having no PR,
      // which the queue then renders as stuck.
      pullRequestNumber: node.dependabotUpdate.pullRequest.number,
      error: node.dependabotUpdate.error.title,
    });
  });
});

describe("repository metadata maps field for field", () => {
  interface RepoMeta {
    name: string;
    owner: { login: string };
    archived: boolean;
    disabled: boolean;
  }

  it("maps a live repository, which is neither archived nor disabled", async () => {
    const raw = recorded<RepoMeta>("repo-meta.json");
    expect([raw.archived, raw.disabled]).toEqual([false, false]);
    const adapter = adapterFor(restStub([raw]), "organization");

    const metas = await adapter.listOrgRepos("no42-org");

    expect(metas).toEqual([
      {
        repo: { owner: raw.owner.login, name: raw.name },
        archived: raw.archived,
        disabled: raw.disabled,
      },
    ]);
  });

  it("maps an archived, disabled repository", async () => {
    // Both flags true, which nothing on this estate is, so the recorded
    // payload cannot exercise it - and without this case an INVERTED
    // mapping passes, because `r.archived === true` yields a boolean
    // whatever the input and false is exactly what an inversion produces
    // from the live fixture. Coverage reads these to decide whether a
    // repository can be vouched for at all, so an inversion would report
    // the entire estate archived and stop it vouching for anything.
    const raw = derived<RepoMeta>("repo-meta-archived.derived.json");
    expect([raw.archived, raw.disabled]).toEqual([true, true]);
    const adapter = adapterFor(restStub([raw]), "organization");

    const metas = await adapter.listOrgRepos("no42-org");

    expect(metas[0]?.archived).toBe(true);
    expect(metas[0]?.disabled).toBe(true);
  });
});
