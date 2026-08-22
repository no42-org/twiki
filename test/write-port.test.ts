/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGitHubFromEnv,
  INSTALLATION_CACHE_TTL_MS,
} from "../src/github/octokit-adapter.js";
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

  it("resolves an installation once per repository, then reuses it", async () => {
    // This test used to pin the opposite, and said why: caching the id naively
    // pins a stale one, because installation ids change when an App is
    // uninstalled and reinstalled. The answer was a bounded TTL rather than
    // no cache - `getRepoInstallation` ran ahead of the client-cache lookup on
    // EVERY call, so the cache could never be consulted first, and one tick on
    // a 15-pull-request repository spent 54 requests re-asking a question
    // whose answer had not changed.
    const { fetchImpl, urls } = recordingFetch();
    const gh = createGitHubFromEnv(() => true, ENV, fetchImpl);
    const repo = { owner: "indigo423", name: "one" };

    await gh.defaultBranchSha(repo);
    await gh.defaultBranchSha(repo);
    await gh.defaultBranchSha({ owner: "indigo423", name: "two" });

    // One token for the installation both repositories share.
    expect(urls.filter((u) => u.includes("/access_tokens"))).toHaveLength(1);
    // One lookup per repository, not one per call.
    expect(
      urls.filter((u) => /\/repos\/[^/]+\/[^/]+\/installation$/.test(u)),
    ).toHaveLength(2);
  });

  it("re-resolves once the cached installation is older than the TTL", async () => {
    // The half that makes caching safe: an operator who uninstalls and
    // reinstalls the App changes the id, and a process-lifetime cache would
    // fail that repository until somebody restarted the container.
    const { fetchImpl, urls } = recordingFetch();
    let clock = 0;
    const gh = createGitHubFromEnv(
      () => true,
      ENV,
      fetchImpl,
      () => clock,
    );
    const repo = { owner: "indigo423", name: "one" };
    const lookups = () =>
      urls.filter((u) => /\/repos\/[^/]+\/[^/]+\/installation$/.test(u)).length;

    await gh.defaultBranchSha(repo);
    clock += INSTALLATION_CACHE_TTL_MS - 1;
    await gh.defaultBranchSha(repo);
    expect(lookups()).toBe(1);

    clock += 2;
    await gh.defaultBranchSha(repo);
    expect(lookups()).toBe(2);
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

describe("the write side flows through the request discipline (AD-24)", () => {
  // These exist because the wrapper was deletable with a green suite: a
  // mutation removing `withRequestDiscipline` from the installation client
  // passed every test. That is the same gap the tricorder factory's own
  // fetchImpl seam was added to close - every other discipline test builds
  // its own Octokit, so none of them prove what THIS factory wires.

  /** Answers `attempts` throttled responses, then succeeds. */
  function throttling(times: number, retryAfter = "0") {
    const attempts: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
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
      if (u.includes("/installation"))
        return json({ id: PERSONAL_INSTALLATION });
      if (u.includes("/merge")) {
        attempts.push(u);
        if (attempts.length <= times) {
          return new Response(
            JSON.stringify({
              message: "You have exceeded a secondary rate limit",
            }),
            {
              status: 403,
              headers: {
                "content-type": "application/json",
                "retry-after": retryAfter,
                "x-ratelimit-remaining": "12",
              },
            },
          );
        }
        return json({ merged: true });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;
    return { fetchImpl, attempts };
  }

  it("honours a retry-after once, and the write then lands", async () => {
    const { fetchImpl, attempts } = throttling(1);
    const gh = createGitHubFromEnv(() => true, ENV, fetchImpl);

    await gh.mergePR({ owner: "indigo423", name: "one" }, 7);

    // Replaying a merge is safe precisely because 403 means GitHub REFUSED
    // it. There is no double-merge here: the first attempt did nothing.
    expect(attempts).toHaveLength(2);
  });

  it("retries at most once", async () => {
    const { fetchImpl, attempts } = throttling(2);
    const gh = createGitHubFromEnv(() => true, ENV, fetchImpl);

    await expect(
      gh.mergePR({ owner: "indigo423", name: "one" }, 7),
    ).rejects.toThrow();
    expect(attempts).toHaveLength(2);
  });

  it("does not retry a permissions 403", async () => {
    // The boundary that makes replaying a mutating request safe at all: only
    // a rate-limit refusal is retried, never an authorisation failure.
    const attempts: string[] = [];
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/access_tokens")) {
        return json(
          {
            token: "t",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: {},
            repository_selection: "all",
          },
          201,
        );
      }
      if (u.includes("/installation"))
        return json({ id: PERSONAL_INSTALLATION });
      if (u.includes("/merge")) {
        attempts.push(u);
        return new Response(
          JSON.stringify({ message: "Resource not accessible by integration" }),
          { status: 403, headers: { "content-type": "application/json" } },
        );
      }
      return json({}, 404);
    }) as unknown as typeof fetch;
    const gh = createGitHubFromEnv(() => true, ENV, fetchImpl);

    await expect(
      gh.mergePR({ owner: "indigo423", name: "one" }, 7),
    ).rejects.toThrow(/not accessible/);
    expect(attempts).toHaveLength(1);
  });

  it("fails fast on primary exhaustion rather than sleeping out the window", async () => {
    const fetchImpl = (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/access_tokens")) {
        return json(
          {
            token: "t",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: {},
            repository_selection: "all",
          },
          201,
        );
      }
      if (u.includes("/installation"))
        return json({ id: PERSONAL_INSTALLATION });
      return new Response(
        JSON.stringify({ message: "API rate limit exceeded" }),
        {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-ratelimit-remaining": "0",
            "x-ratelimit-reset": "1790000000",
          },
        },
      );
    }) as unknown as typeof fetch;
    const gh = createGitHubFromEnv(() => true, ENV, fetchImpl);

    await expect(
      gh.mergePR({ owner: "indigo423", name: "one" }, 7),
    ).rejects.toThrow(/rate limit exhausted, resets at/);
  });
});
