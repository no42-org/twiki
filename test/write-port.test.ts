/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGitHubFromEnv } from "../src/github/octokit-adapter.js";
import type { GitHubReadPort } from "../src/github/port.js";

// The write side's port boundary.
//
// twiki acts on the repositories its allowlist names and never enumerates an
// account, so `createGitHubFromEnv` wires a per-repository resolver and
// nothing else. These tests pin that, because until this suite existed the
// factory had no coverage at all: every other adapter test constructs
// OctokitGitHub directly, so the factory's resolver, its cache and its
// allowlist guard were each deletable with a green suite.
//
// MEASURED 2026-08-22 against the live `indigo423` account (a User account
// carrying 240 repositories), which is what the boundary is drawn around:
//
//   GET /orgs/indigo423/installation        -> 404
//   GET /orgs/indigo423/repos               -> 404
//   GET /repos/indigo423/opennms-drools-sample/installation
//                                           -> 200, installation 154359759
//
// A GitHub App on a user account has no org-level endpoint. The per-repository
// endpoint does not care what kind of account owns the repository, which is
// why the whole write-side surface works on a personal account and why the
// account-scoped reads are off `GitHubPort` entirely.

// A throwaway key: never a real credential, generated fresh per run.
const TEST_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const ENV = {
  TWIKI_GITHUB_APP_ID: "1",
  TWIKI_GITHUB_APP_PRIVATE_KEY: TEST_KEY,
};

/** The live installation id measured for `indigo423`, used verbatim. */
const PERSONAL_INSTALLATION = 154359759;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A transport that records every URL and answers the calls this factory makes.
 * Anything unrecognised 404s, so a call the boundary should not be making
 * fails loudly rather than falling through to a friendly empty body.
 */
function recordingFetch() {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    if (u.includes("/access_tokens")) {
      return json(
        {
          token: "ghs_test",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: {},
          repository_selection: "all",
        },
        201,
      );
    }
    if (u.includes("/installation")) {
      return json({ id: PERSONAL_INSTALLATION });
    }
    if (u.includes("/branches/")) {
      return json({ commit: { sha: "deadbeef" } });
    }
    if (/\/repos\/[^/]+\/[^/]+$/.test(u)) {
      return json({ default_branch: "main" });
    }
    return json({ message: "Not Found" }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

describe("the write-side port exposes only what its factory can honour", () => {
  it("resolves an installation per repository, never per account", async () => {
    // The reason the whole surface works on a personal account. Measured
    // above: this endpoint answers for a User account exactly as for an
    // Organization, while the org one 404s.
    const { fetchImpl, urls } = recordingFetch();
    const gh = createGitHubFromEnv(() => true, ENV, fetchImpl);

    await gh.defaultBranchSha({ owner: "indigo423", name: "some-repo" });

    expect(
      urls.some((u) => u.includes("/repos/indigo423/some-repo/installation")),
    ).toBe(true);
    // The specific failure this change removes: an orgs call the write side
    // never needed, 404ing on a personal account and citing an endpoint the
    // caller did not ask for.
    expect(urls.filter((u) => u.includes("/orgs/"))).toEqual([]);
  });

  it("caches the installation client, but re-resolves the installation", async () => {
    // Two separate facts, and the second is the one a reader gets wrong.
    //
    // The client IS cached, so minting a token - which re-reads the private
    // key and costs a request - happens once however many repositories share
    // an installation.
    //
    // The installation id is NOT cached. `getRepoInstallation` runs on every
    // call, ahead of the cache lookup, so each port call spends one App-JWT
    // request: measured here, three calls on ONE repository issue three
    // resolutions. `gatherFacts` makes roughly eight repo-scoped calls per
    // repository per tick, so that is about eight extra requests per
    // repository per tick.
    //
    // Asserted rather than fixed, deliberately. Caching the id naively would
    // pin a stale one: installation ids change when an App is uninstalled
    // and reinstalled, which is why the read side re-resolves on a miss
    // instead of caching outright. Doing that here is its own change; this
    // pins the behaviour so it is visible rather than assumed away.
    const { fetchImpl, urls } = recordingFetch();
    const gh = createGitHubFromEnv(() => true, ENV, fetchImpl);
    const repo = { owner: "indigo423", name: "one" };

    await gh.defaultBranchSha(repo);
    await gh.defaultBranchSha(repo);
    await gh.defaultBranchSha({ owner: "indigo423", name: "two" });

    expect(urls.filter((u) => u.includes("/access_tokens"))).toHaveLength(1);
    expect(
      urls.filter((u) => /\/repos\/[^/]+\/[^/]+\/installation$/.test(u)),
    ).toHaveLength(3);
  });

  it("refuses a repository outside the allowlist before any request", async () => {
    // Defense in depth: run.ts only passes allowlisted repos, so this guard
    // is the second line. It must refuse without contacting GitHub at all -
    // a refusal that has already leaked the request is not a refusal.
    const { fetchImpl, urls } = recordingFetch();
    const gh = createGitHubFromEnv(() => false, ENV, fetchImpl);

    await expect(
      gh.defaultBranchSha({ owner: "indigo423", name: "not-allowed" }),
    ).rejects.toThrow(/indigo423\/not-allowed/);
    expect(urls).toEqual([]);
  });

  it("does not offer the account-scoped reads on its type", () => {
    const gh = createGitHubFromEnv(() => true, ENV);

    // Type-level only, and deliberately so: the six DO exist at runtime,
    // because OctokitGitHub is the one class both entrypoints share. What
    // this change removes is the type's promise that they can be called
    // here. `tsc --noEmit` covers test/ in `make verify`, so a directive
    // below that stops erroring fails the build - widening GitHubPort back
    // to the full read surface cannot pass silently.
    // @ts-expect-error listOrgRepos is account-scoped and off GitHubPort
    void gh.listOrgRepos;
    // @ts-expect-error listDependabotAlerts is account-scoped and off GitHubPort
    void gh.listDependabotAlerts;
    // @ts-expect-error listOpenUpdatePRs is account-scoped and off GitHubPort
    void gh.listOpenUpdatePRs;
    // @ts-expect-error listUntriagedIssues is account-scoped and off GitHubPort
    void gh.listUntriagedIssues;
    // @ts-expect-error listReviewRequests is account-scoped and off GitHubPort
    void gh.listReviewRequests;
    // @ts-expect-error rateLimit is account-scoped and off GitHubPort
    void gh.rateLimit;

    // The repo-scoped half is offered, and is the whole point: this is what
    // twiki calls, and it works whoever owns the repository.
    expect(typeof gh.defaultBranchSha).toBe("function");
    expect(typeof gh.mergePR).toBe("function");
  });

  it("names the missing wiring when a cast reaches an account-scoped read", async () => {
    // The runtime half, for callers who get past the type. Before this
    // change the same call reached GitHub and came back
    // "404 Not Found - https://docs.github.com/rest/apps/apps#get-an-organization",
    // blaming an orgs endpoint for a client that simply was not built with an
    // org resolver. Three of the six only ever wanted a token.
    const { fetchImpl, urls } = recordingFetch();
    const gh = createGitHubFromEnv(
      () => true,
      ENV,
      fetchImpl,
    ) as unknown as GitHubReadPort;

    await expect(gh.listOrgRepos("indigo423")).rejects.toThrow(
      /listOrgRepos needs an org resolver; this client was built without one/,
    );
    await expect(gh.rateLimit("indigo423")).rejects.toThrow(
      /rateLimit needs an org resolver/,
    );
    // And it refuses without asking GitHub, so no 404 is ever attributed to
    // an account that was never the problem.
    expect(urls).toEqual([]);
  });
});
