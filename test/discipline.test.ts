/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { generateKeyPairSync } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vitest";
import {
  backoffDecision,
  installationTokenGen,
  MAX_RETRY_AFTER_S,
  withRequestDiscipline,
} from "../src/github/discipline.js";
import { OctokitGitHub } from "../src/github/octokit-adapter.js";

describe("the backoff decision table (AD-24)", () => {
  it("honours a sane retry-after once", () => {
    expect(backoffDecision(403, { "retry-after": "30" }, false)).toEqual({
      kind: "retry",
      afterMs: 30_000,
    });
    expect(backoffDecision(429, { "retry-after": "1" }, false)).toEqual({
      kind: "retry",
      afterMs: 1_000,
    });
  });

  it("retries at most once", () => {
    // A second retry-after on the retried request means GitHub is still
    // saying no; looping on it would stall the lane indefinitely.
    expect(backoffDecision(403, { "retry-after": "30" }, true).kind).not.toBe(
      "retry",
    );
  });

  it("does not sleep out an absurd retry-after", () => {
    expect(
      backoffDecision(
        403,
        { "retry-after": String(MAX_RETRY_AFTER_S + 1) },
        false,
      ).kind,
    ).not.toBe("retry");
  });

  it("fails fast and legibly on primary exhaustion", () => {
    const d = backoffDecision(
      403,
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1786775400" },
      false,
    );
    expect(d.kind).toBe("exhausted");
    if (d.kind === "exhausted") {
      // A reset instant a human can read, not an epoch integer.
      expect(d.detail).toContain("2026-08-15T");
      expect(d.detail).toContain("retried next cycle");
    }
  });

  it("leaves every other failure alone", () => {
    expect(backoffDecision(404, {}, false).kind).toBe("rethrow");
    expect(backoffDecision(500, {}, false).kind).toBe("rethrow");
    // A 403 with budget left and no retry-after is a permissions problem,
    // not a limit: retrying or sleeping would mask it.
    expect(
      backoffDecision(403, { "x-ratelimit-remaining": "42" }, false).kind,
    ).toBe("rethrow");
    expect(backoffDecision(undefined, {}, false).kind).toBe("rethrow");
    // Only 403/429 are limit signals. A 500 that happens to carry
    // retry-after is a server fault, and sleeping on it would dress an
    // outage up as throttling.
    expect(backoffDecision(500, { "retry-after": "5" }, false).kind).toBe(
      "rethrow",
    );
  });
});

describe("the discipline hook on a real Octokit", () => {
  const okJson = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  it("sleeps out retry-after once and succeeds", async () => {
    let calls = 0;
    const slept: number[] = [];
    const gh = withRequestDiscipline(
      new Octokit({
        request: {
          fetch: async () => {
            calls++;
            if (calls === 1) {
              return new Response("slow down", {
                status: 403,
                headers: { "retry-after": "1" },
              });
            }
            return okJson({ fine: true });
          },
        },
      }),
      async (ms) => {
        slept.push(ms);
      },
    );

    const res = await gh.request("GET /rate_limit");
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    expect(slept).toEqual([1000]);
  });

  it("translates primary exhaustion into the legible error", async () => {
    const gh = withRequestDiscipline(
      new Octokit({
        request: {
          fetch: async () =>
            new Response("limited", {
              status: 403,
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": "1786775400",
              },
            }),
        },
      }),
      async () => {},
    );

    await expect(gh.request("GET /rate_limit")).rejects.toThrow(
      /rate limit exhausted/,
    );
  });
});

// A throwaway key: never a real credential, generated fresh per run.
const TEST_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

/**
 * An Octokit authenticating as a fake App against a fetch stub that counts
 * token mints. What reaches GitHub in production reaches the stub here.
 */
function appOctokit(onMint: () => string) {
  let mints = 0;
  const fetchImpl = async (url: string | URL | Request) => {
    const u = String(url);
    if (u.includes("/access_tokens")) {
      mints++;
      return new Response(
        JSON.stringify({
          token: `ghs_test_${mints}`,
          expires_at: onMint(),
          permissions: {},
          repository_selection: "all",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  const gh = new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: 1, privateKey: TEST_KEY, installationId: 7 },
    request: { fetch: fetchImpl },
  });
  return { gh, minted: () => mints };
}

describe("the installation token is reused for its full TTL", () => {
  it("two auths within the TTL mint once, and the generation is stable", async () => {
    // The story's assertion, verbatim: ETags key on the literal Authorization
    // header (undocumented by GitHub, which is exactly why it needs the
    // pin), so an early refresh would silently invalidate every cached
    // validator. octokit caches the token until expiry; this pins that our
    // dependency actually does what AD-25's generation scheme assumes.
    const expires = new Date(Date.now() + 60 * 60_000).toISOString();
    const { gh, minted } = appOctokit(() => expires);

    const gen1 = await installationTokenGen(gh);
    const gen2 = await installationTokenGen(gh);

    expect(minted()).toBe(1);
    expect(gen1).toBe(expires);
    expect(gen2).toBe(gen1);
  });
});

describe("the conditional alert listing", () => {
  const EXPIRES = "2026-08-18T08:00:00Z";

  /** A stub standing in for one installation's Octokit. */
  function stubGh(
    handler: (
      route: string,
      options: Record<string, unknown>,
    ) => { data: unknown; headers: Record<string, string> },
  ) {
    const seen: Record<string, unknown>[] = [];
    const gh = {
      auth: async () => ({ token: "ghs_x", expiresAt: EXPIRES }),
      request: async (route: string, options: Record<string, unknown> = {}) => {
        seen.push({ route, ...options });
        return handler(route, options);
      },
    };
    return { gh: gh as unknown as Octokit, seen };
  }

  const alertItem = { number: 1, state: "open", security_advisory: {} };

  it("sends the validator only when the token generation still matches", async () => {
    const { gh, seen } = stubGh(() => ({ data: [alertItem], headers: {} }));
    const adapter = new OctokitGitHub(
      async () => gh,
      () => true,
      async () => gh,
    );

    await adapter.listOrgDependabotAlerts("no42-org", {
      etag: 'W/"a"',
      lastModified: null,
      tokenGen: EXPIRES,
    });
    await adapter.listOrgDependabotAlerts("no42-org", {
      etag: 'W/"a"',
      lastModified: null,
      tokenGen: "some-older-token",
    });

    const headersOf = (i: number) =>
      (seen[i] as { headers?: Record<string, string> }).headers ?? {};
    expect(headersOf(0)["if-none-match"]).toBe('W/"a"');
    // Cold: a validator from another token is a guaranteed miss.
    expect(headersOf(1)["if-none-match"]).toBeUndefined();
  });

  it("returns notModified on a 304", async () => {
    const { gh } = stubGh(() => {
      throw Object.assign(new Error("Not modified"), { status: 304 });
    });
    const adapter = new OctokitGitHub(
      async () => gh,
      () => true,
      async () => gh,
    );

    const page = await adapter.listOrgDependabotAlerts("no42-org", {
      etag: 'W/"a"',
      lastModified: null,
      tokenGen: EXPIRES,
    });

    expect(page.notModified).toBe(true);
    expect(page.alerts).toEqual([]);
    expect(page.validator?.etag).toBe('W/"a"');
  });

  it("caches a validator only for a single-page listing", async () => {
    const single = stubGh(() => ({
      data: [alertItem],
      headers: { etag: 'W/"page1"' },
    }));
    const adapter1 = new OctokitGitHub(
      async () => single.gh,
      () => true,
      async () => single.gh,
    );
    const one = await adapter1.listOrgDependabotAlerts("no42-org");
    expect(one.validator).toEqual({
      etag: 'W/"page1"',
      lastModified: null,
      tokenGen: EXPIRES,
    });

    // Two pages: each carries its own ETag, and a 304 on page one says
    // nothing about page two, so nothing is cacheable.
    let call = 0;
    const multi = stubGh(() => {
      call++;
      const headers: Record<string, string> =
        call === 1
          ? {
              etag: 'W/"page1"',
              link: '<https://api.github.com/x?page=2>; rel="next"',
            }
          : { etag: 'W/"page2"' };
      return { data: [alertItem], headers };
    });
    const adapter2 = new OctokitGitHub(
      async () => multi.gh,
      () => true,
      async () => multi.gh,
    );
    const two = await adapter2.listOrgDependabotAlerts("no42-org");
    expect(two.alerts.length + two.unreadable).toBeGreaterThan(0);
    expect(two.validator).toBeNull();
  });

  it("a 304 without a sent validator is an error, not an empty page", async () => {
    // Only a conditional request may be answered 304; getting one on an
    // unconditional fetch means something upstream is broken, and treating
    // it as notModified would confirm rows against a validator never sent.
    const { gh } = stubGh(() => {
      throw Object.assign(new Error("Not modified"), { status: 304 });
    });
    const adapter = new OctokitGitHub(
      async () => gh,
      () => true,
      async () => gh,
    );
    await expect(adapter.listOrgDependabotAlerts("no42-org")).rejects.toThrow();
  });
});
