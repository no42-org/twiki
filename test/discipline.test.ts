/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { generateKeyPairSync } from "node:crypto";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { describe, expect, it, vi } from "vitest";
import {
  backoffDecision,
  installationTokenGen,
  LIMIT_EPISODE_COOLDOWN_MS,
  MAX_RETRY_AFTER_S,
  withRequestDiscipline,
} from "../src/github/discipline.js";
import {
  createTricorderAppFromEnv,
  createTricorderReadPort,
  MAX_ALERT_PAGES,
  nextLink,
  OctokitGitHub,
} from "../src/github/octokit-adapter.js";

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
    // The cap itself is inclusive: exactly MAX retries. An off-by-one in
    // the comparison would otherwise stay green.
    expect(
      backoffDecision(403, { "retry-after": String(MAX_RETRY_AFTER_S) }, false),
    ).toEqual({ kind: "retry", afterMs: MAX_RETRY_AFTER_S * 1000 });
  });

  it("ignores an HTTP-date retry-after, by documented choice", () => {
    // RFC 9110 allows the date form; GitHub sends delta-seconds. The table
    // owns no clock, so a date parses as NaN and falls through to rethrow.
    expect(
      backoffDecision(
        429,
        { "retry-after": "Fri, 21 Aug 2026 07:28:00 GMT" },
        false,
      ).kind,
    ).toBe("rethrow");
  });

  it("fails fast and legibly on primary exhaustion", () => {
    const d = backoffDecision(
      403,
      { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1786775400" },
      false,
    );
    expect(d.kind).toBe("exhausted");
    if (d.kind === "exhausted") {
      // A reset instant a human can read, not an epoch integer. And no
      // promise about what the caller does next: the table also serves the
      // App-level client, where no run is recorded and nothing retries.
      expect(d.detail).toContain("2026-08-15T");
      expect(d.detail).toContain("failing fast");
    }

    // A garbage reset from a proxy must degrade to "unknown", never replace
    // the legible message with toISOString's RangeError.
    const garbage = backoffDecision(
      403,
      {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "99999999999999",
      },
      false,
    );
    expect(garbage.kind).toBe("exhausted");
    if (garbage.kind === "exhausted") {
      expect(garbage.detail).toContain("unknown");
    }
  });

  it("retries a secondary limit that arrives without retry-after", () => {
    // GitHub documents this shape and says to wait at least a minute. The
    // message is the only signal distinguishing it from a permissions 403.
    const d = backoffDecision(
      403,
      { "x-ratelimit-remaining": "42" },
      false,
      "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
    );
    expect(d).toEqual({ kind: "retry", afterMs: 60_000 });
    // But only once: the retried request hitting it again fails through.
    expect(
      backoffDecision(403, {}, true, "secondary rate limit").kind,
    ).not.toBe("retry");
  });

  it("does not undercut a retry-after it deliberately refused", () => {
    // 300s named by GitHub, refused as above the ceiling. The secondary-limit
    // message must not then pull the wait down to 60s: retrying 240 seconds
    // early guarantees another 403 and, per GitHub's guidance, risks an
    // extended block. The fallback is for when NO wait was named.
    expect(
      backoffDecision(
        403,
        { "retry-after": "300" },
        false,
        "You have exceeded a secondary rate limit.",
      ).kind,
    ).toBe("rethrow");
    // With no retry-after at all, the fallback still applies.
    expect(
      backoffDecision(
        403,
        {},
        false,
        "You have exceeded a secondary rate limit.",
      ),
    ).toEqual({ kind: "retry", afterMs: 60_000 });
  });

  it("honours retry-after zero as an immediate retry", () => {
    // Spec-valid "retry immediately"; the episode cooldown still bounds how
    // often the branch fires.
    expect(backoffDecision(429, { "retry-after": "0" }, false)).toEqual({
      kind: "retry",
      afterMs: 0,
    });
    // An empty header is absence, not zero: Number("") is 0, and treating a
    // blank header as an immediate-retry instruction would retry on noise.
    expect(backoffDecision(429, { "retry-after": " " }, false).kind).toBe(
      "rethrow",
    );
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

  it("sleeps once per episode, not once per request", async () => {
    // The coverage lane probes every watched repository serially through one
    // client. Without the cooldown, a sustained secondary-limit episode
    // charges each probe its own sleep: 36 repos at 120s is a 72-minute
    // stalled collector.
    const slept: number[] = [];
    let clock = 0;
    const gh = withRequestDiscipline(
      new Octokit({
        request: {
          fetch: async () =>
            new Response("slow down", {
              status: 403,
              headers: { "retry-after": "1" },
            }),
        },
      }),
      async (ms) => {
        slept.push(ms);
      },
      () => clock,
    );

    // First request: sleeps once, retries, still limited, fails.
    await expect(gh.request("GET /rate_limit")).rejects.toThrow();
    // Second request inside the cooldown: fails fast, no sleep.
    clock += 1000;
    await expect(gh.request("GET /rate_limit")).rejects.toThrow();
    expect(slept).toEqual([1000]);

    // A new episode after the cooldown gets its sleep back.
    clock += LIMIT_EPISODE_COOLDOWN_MS + 2000;
    await expect(gh.request("GET /rate_limit")).rejects.toThrow();
    expect(slept).toEqual([1000, 1000]);
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
    // Legible message, evidence intact: the original status rides along for
    // any caller that branches on it.
    await expect(gh.request("GET /rate_limit")).rejects.toMatchObject({
      status: 403,
    });
  });

  it("passes a 304 through untouched", async () => {
    // The adapter's whole conditional path depends on catching octokit's
    // 304 rejection with its status intact; a hook that swallowed or
    // rewrote it would turn every cache hit into a mystery.
    const gh = withRequestDiscipline(
      new Octokit({
        request: {
          fetch: async () => new Response(null, { status: 304 }),
        },
      }),
      async () => {},
    );

    await expect(
      gh.request("GET /orgs/x/dependabot/alerts"),
    ).rejects.toMatchObject({
      status: 304,
    });
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

    // Three pages: each carries its own ETag, and a 304 on page one says
    // nothing about the pages behind it, so nothing is cacheable.
    let call = 0;
    const multi = stubGh(() => {
      call++;
      const headers: Record<string, string> =
        call < 3
          ? {
              etag: `W/"page${call}"`,
              link: `<https://api.github.com/x?page=${call + 1}>; rel="next"`,
            }
          : { etag: 'W/"page3"' };
      return { data: [alertItem], headers };
    });
    const adapter2 = new OctokitGitHub(
      async () => multi.gh,
      () => true,
      async () => multi.gh,
    );
    const two = await adapter2.listOrgDependabotAlerts("no42-org");
    // EVERY page's items arrive, exactly. The old assertion (> 0) was
    // satisfied by page one alone: a mutation dropping all later pages kept
    // the suite green, and the next full-ok sweep would have tombstoned
    // every alert past page one as resolved.
    expect(two.alerts.length + two.unreadable).toBe(3);
    expect(two.validator).toBeNull();
  });

  it("walks a link header whose rel is not the first parameter", async () => {
    // A proxy may reorder link-value parameters; missing the next link ends
    // pagination early, and page one alone then reads as the whole listing -
    // with a validator cached for it.
    let call = 0;
    const { gh } = stubGh(() => {
      call++;
      const headers: Record<string, string> =
        call === 1
          ? {
              link: '<https://api.github.com/x?page=2>; type="a"; rel="next", <https://api.github.com/x?page=2>; rel="last"',
            }
          : {};
      return { data: [alertItem], headers };
    });
    const adapter = new OctokitGitHub(
      async () => gh,
      () => true,
      async () => gh,
    );
    const page = await adapter.listOrgDependabotAlerts("no42-org");
    expect(page.alerts.length + page.unreadable).toBe(2);
  });

  it("truncates rather than looping forever on a self-referential link", async () => {
    // The cap bounds a broken proxy, but what was read is real: truncating
    // ingests it and flags the set incomplete, where throwing would ingest
    // nothing at all on every sweep. A legitimately huge organisation is the
    // same shape as the proxy from here, and it must not lose its alerts.
    const { gh } = stubGh(() => ({
      data: [alertItem],
      headers: { link: '<https://api.github.com/x?page=1>; rel="next"' },
    }));
    const adapter = new OctokitGitHub(
      async () => gh,
      () => true,
      async () => gh,
    );

    const page = await adapter.listOrgDependabotAlerts("no42-org");

    expect(page.truncated).toBe(true);
    expect(page.alerts.length + page.unreadable).toBe(MAX_ALERT_PAGES);
    // An incomplete listing may never be revalidated against: a later 304
    // would confirm the truncated set as the whole answer.
    expect(page.validator).toBeNull();
  });

  it("serves a listing that genuinely ends at the page cap", async () => {
    // The cap is judged on the CLAIM of more pages, not the page count: a
    // real listing of exactly MAX pages is in-bounds by the constant's own
    // doc, and rejecting it would fail a legitimate 5,000-alert org.
    let call = 0;
    const { gh } = stubGh(() => {
      call++;
      const headers: Record<string, string> =
        call < MAX_ALERT_PAGES
          ? {
              link: `<https://api.github.com/x?page=${call + 1}>; rel="next"`,
            }
          : {};
      return { data: [alertItem], headers };
    });
    const adapter = new OctokitGitHub(
      async () => gh,
      () => true,
      async () => gh,
    );

    const page = await adapter.listOrgDependabotAlerts("no42-org");
    expect(page.alerts.length + page.unreadable).toBe(MAX_ALERT_PAGES);
    expect(page.truncated).toBe(false);
  });

  it("refuses to follow a cross-origin next link", async () => {
    // The next URL is followed with the installation token attached. A
    // proxy-injected Link header must not be able to point the
    // Authorization header at another host.
    const { gh } = stubGh(() => ({
      data: [alertItem],
      headers: { link: '<https://evil.example/steal?page=2>; rel="next"' },
    }));
    const adapter = new OctokitGitHub(
      async () => gh,
      () => true,
      async () => gh,
    );
    await expect(adapter.listOrgDependabotAlerts("no42-org")).rejects.toThrow(
      /cross-origin/,
    );
  });

  it("treats a null token generation as cold on both sides", async () => {
    // auth without an expiry cannot be compared across rotations; a stable
    // sentinel would compare equal to itself and fail open. Nothing is sent
    // and nothing is cached.
    const seen: Record<string, unknown>[] = [];
    const gh = {
      auth: async () => ({ token: "ghs_x" }),
      request: async (route: string, options: Record<string, unknown> = {}) => {
        seen.push({ route, ...options });
        return { data: [alertItem], headers: { etag: 'W/"a"' } };
      },
    } as unknown as Octokit;
    const adapter = new OctokitGitHub(
      async () => gh,
      () => true,
      async () => gh,
    );

    const page = await adapter.listOrgDependabotAlerts("no42-org", {
      etag: 'W/"a"',
      lastModified: null,
      tokenGen: "2026-08-18T08:00:00Z",
    });

    const headers =
      (seen[0] as { headers?: Record<string, string> }).headers ?? {};
    expect(headers["if-none-match"]).toBeUndefined();
    expect(page.validator).toBeNull();
  });

  it("sends if-modified-since alongside the etag, and alone", async () => {
    const { gh, seen } = stubGh(() => ({ data: [alertItem], headers: {} }));
    const adapter = new OctokitGitHub(
      async () => gh,
      () => true,
      async () => gh,
    );

    await adapter.listOrgDependabotAlerts("no42-org", {
      etag: 'W/"a"',
      lastModified: "Tue, 22 Jul 2025 05:46:32 GMT",
      tokenGen: EXPIRES,
    });
    // A validator with only Last-Modified still conditions the request:
    // discarding it wastes a cached 304 for no reason.
    await adapter.listOrgDependabotAlerts("no42-org", {
      etag: null,
      lastModified: "Tue, 22 Jul 2025 05:46:32 GMT",
      tokenGen: EXPIRES,
    });

    const headersOf = (i: number) =>
      (seen[i] as { headers?: Record<string, string> }).headers ?? {};
    expect(headersOf(0)["if-none-match"]).toBe('W/"a"');
    expect(headersOf(0)["if-modified-since"]).toBe(
      "Tue, 22 Jul 2025 05:46:32 GMT",
    );
    expect(headersOf(1)["if-none-match"]).toBeUndefined();
    expect(headersOf(1)["if-modified-since"]).toBe(
      "Tue, 22 Jul 2025 05:46:32 GMT",
    );
  });

  it("does not treat an all-null validator as conditional", async () => {
    const { gh } = stubGh(() => {
      throw Object.assign(new Error("Not modified"), { status: 304 });
    });
    const adapter = new OctokitGitHub(
      async () => gh,
      () => true,
      async () => gh,
    );
    // No header went on the wire, so the 304 is unsolicited and must not be
    // honoured as notModified.
    await expect(
      adapter.listOrgDependabotAlerts("no42-org", {
        etag: null,
        lastModified: null,
        tokenGen: EXPIRES,
      }),
    ).rejects.toThrow();
  });

  it("refuses a non-array listing body legibly", async () => {
    // A proxy error page: spreading it would throw an illegible TypeError,
    // and a string body would spread character by character into a nonsense
    // unreadable count.
    const { gh } = stubGh(() => ({
      data: { message: "upstream error" } as unknown as unknown[],
      headers: {},
    }));
    const adapter = new OctokitGitHub(
      async () => gh,
      () => true,
      async () => gh,
    );
    await expect(adapter.listOrgDependabotAlerts("no42-org")).rejects.toThrow(
      /non-array body/,
    );
  });

  it("a 304 without a sent validator is a legible error, not an empty page", async () => {
    // Only a conditional request may be answered 304; getting one on an
    // unconditional fetch means something upstream is broken, and treating
    // it as notModified would confirm rows against a validator never sent.
    // The message names the cause, like the KEV path: octokit's raw "Not
    // modified" gives an operator nothing to act on.
    const { gh } = stubGh(() => {
      throw Object.assign(new Error("Not modified"), { status: 304 });
    });
    const adapter = new OctokitGitHub(
      async () => gh,
      () => true,
      async () => gh,
    );
    await expect(adapter.listOrgDependabotAlerts("no42-org")).rejects.toThrow(
      /unconditional/,
    );
  });
});

describe("parsing the Link header's next target", () => {
  it("handles the shapes a naive split gets wrong", () => {
    // GitHub's own emission: quoted rel, first parameter.
    expect(
      nextLink(
        '<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"',
      ),
    ).toBe("https://api.github.com/x?page=2");
    // A comma inside the bracketed URL is legal in query strings; splitting
    // the header on commas severs the URL and drops the link.
    expect(
      nextLink('<https://api.github.com/x?fields=a,b&page=2>; rel="next"'),
    ).toBe("https://api.github.com/x?fields=a,b&page=2");
    // Unquoted and list-valued rel are both spec-valid proxy rewrites, and
    // missing either truncates the listing at the current page.
    expect(nextLink("<https://api.github.com/x?page=2>; rel=next")).toBe(
      "https://api.github.com/x?page=2",
    );
    expect(nextLink('<https://api.github.com/x?page=2>; rel="next last"')).toBe(
      "https://api.github.com/x?page=2",
    );
    // rel is not required to be the first parameter.
    expect(
      nextLink('<https://api.github.com/x?page=2>; type="a"; rel="next"'),
    ).toBe("https://api.github.com/x?page=2");
    // And plain absences answer null.
    expect(
      nextLink('<https://api.github.com/x?page=9>; rel="last"'),
    ).toBeNull();
    expect(nextLink("")).toBeNull();
  });
});

describe("the installation token across its TTL", () => {
  it("is reused up to expiry and rotates the generation after it", async () => {
    // Story 14's AC verbatim: reused for its FULL one-hour TTL, never
    // refreshed early. The mint-once test covers reuse at t0; this one
    // drives the clock to just short of expiry (still the same token, same
    // generation) and past it (new mint, new generation), because an early
    // refresh silently invalidates every cached validator.
    vi.useFakeTimers();
    try {
      let mintCount = 0;
      const { gh, minted } = appOctokit(() => {
        mintCount++;
        return new Date(Date.now() + 60 * 60_000).toISOString();
      });

      const gen1 = await installationTokenGen(gh);
      // 58 minutes in: within the TTL (auth-app renews inside its final
      // minute), so no new mint and the generation holds.
      vi.advanceTimersByTime(58 * 60_000);
      const gen2 = await installationTokenGen(gh);
      expect(minted()).toBe(1);
      expect(gen2).toBe(gen1);

      // Past expiry: a new mint, and with it a new generation, which is
      // what turns every cached validator cold (AD-25).
      vi.advanceTimersByTime(3 * 60_000);
      const gen3 = await installationTokenGen(gh);
      expect(minted()).toBe(2);
      expect(gen3).not.toBe(gen1);
      expect(mintCount).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the discipline hook rides the factory's clients", () => {
  it("createTricorderReadPort's clients retry a limited request", async () => {
    // The wrapper's one production attachment was deletable with a green
    // suite: every discipline test built its own client. This goes through
    // the real factory, so removing the wrapping now breaks a test.
    let apiCalls = 0;
    const fetchImpl = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "ghs_wired",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: {},
            repository_selection: "all",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      apiCalls++;
      if (apiCalls === 1) {
        return new Response("slow down", {
          status: 403,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const appPort = {
      identity: async () => ({ slug: "t", name: "t", permissions: {} }),
      listInstallations: async () => [
        { id: 7, account: "no42-org", repositorySelection: "all" },
      ],
      listInstallationRepos: async () => [],
    };
    const port = await createTricorderReadPort(
      appPort,
      () => true,
      {
        TRICORDER_GITHUB_APP_ID: "1",
        TRICORDER_GITHUB_APP_PRIVATE_KEY: TEST_KEY,
      } as NodeJS.ProcessEnv,
      fetchImpl as typeof fetch,
    );

    const page = await port.listOrgDependabotAlerts("no42-org");

    // One 403 with retry-after, then success: only a disciplined client
    // retries. An unwrapped one would have thrown the 403.
    expect(apiCalls).toBe(2);
    expect(page.alerts).toEqual([]);
  });

  it("createTricorderAppFromEnv's App client retries a limited request", async () => {
    // The same deletable-wrapper hole the read-port test closes, one
    // factory over: the App-JWT client serves startup listInstallations and
    // every resolver miss, and its wrap was removable with a green suite.
    let apiCalls = 0;
    const fetchImpl = async () => {
      apiCalls++;
      if (apiCalls === 1) {
        return new Response("slow down", {
          status: 403,
          headers: { "retry-after": "0" },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const appPort = createTricorderAppFromEnv(
      {
        TRICORDER_GITHUB_APP_ID: "1",
        TRICORDER_GITHUB_APP_PRIVATE_KEY: TEST_KEY,
      } as NodeJS.ProcessEnv,
      fetchImpl as typeof fetch,
    );

    const installations = await appPort.listInstallations();

    expect(apiCalls).toBe(2);
    expect(installations).toEqual([]);
  });

  it("the App port's per-installation clients are disciplined too", async () => {
    // listInstallationRepos builds its own clients; leaving those bare
    // would make the doctor's requests the only ones in the system with no
    // retry-after handling, behind a comment claiming otherwise.
    let repoCalls = 0;
    const fetchImpl = async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/access_tokens")) {
        return new Response(
          JSON.stringify({
            token: "ghs_app",
            expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            permissions: {},
            repository_selection: "all",
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        );
      }
      repoCalls++;
      if (repoCalls === 1) {
        return new Response("slow down", {
          status: 403,
          headers: { "retry-after": "0" },
        });
      }
      const res = new Response(
        JSON.stringify({ total_count: 0, repositories: [] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
      // A hand-built Response has an empty url, and octokit's paginate
      // calls new URL(response.url) on envelope endpoints.
      Object.defineProperty(res, "url", { value: u });
      return res;
    };
    const appPort = createTricorderAppFromEnv(
      {
        TRICORDER_GITHUB_APP_ID: "1",
        TRICORDER_GITHUB_APP_PRIVATE_KEY: TEST_KEY,
      } as NodeJS.ProcessEnv,
      fetchImpl as typeof fetch,
    );

    const repos = await appPort.listInstallationRepos(7);

    expect(repoCalls).toBe(2);
    expect(repos).toEqual([]);
  });
});
