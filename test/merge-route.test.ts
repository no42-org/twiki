/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { modeFromEnv } from "../src/core/config.js";
import type { MergeRequest, MergeResponse } from "../src/core/merge.js";
import type { Mode } from "../src/core/types.js";
import type { StorePort } from "../src/tricorder/store/port.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { createApp } from "../src/tricorder/web/app.js";
import { buildOverview } from "../src/tricorder/web/overview-view.js";
import { mergeClient, parseMergeUrl } from "../src/tricorder.js";

// Spied on rather than read from the HTML: the argument is the mode itself,
// where the page only shows what the mode did to an icon.
vi.mock("../src/tricorder/web/overview-view.js", async (original) => {
  const actual =
    await original<typeof import("../src/tricorder/web/overview-view.js")>();
  return { ...actual, buildOverview: vi.fn(actual.buildOverview) };
});

const HOST = "127.0.0.1:8787";
const ORIGIN = `http://${HOST}`;
const MERGED: MergeResponse = { outcome: "merged" };

const watched = [
  { owner: "no42-org", name: "twiki" },
  // Declared mixed case, as repos.yaml may. Stored slugs are lowercased.
  { owner: "no42-org", name: "CoolModFiles" },
];

function fakeMerge(answer: () => Promise<MergeResponse> = async () => MERGED) {
  return vi.fn((_request: MergeRequest) => answer());
}

function appWith(
  requestMerge: ReturnType<typeof fakeMerge> | null,
  mode: Mode = "enforce",
) {
  return createApp({
    // The route holds no store call. A null here proves it.
    store: null as unknown as StorePort,
    watched,
    policy: { cadenceMs: 1_000 },
    defaultBranchOf: () => "main",
    now: () => new Date("2026-10-31T00:00:00.000Z"),
    mode,
    requestMerge,
  });
}

/** Posts as a browser on the dashboard's own page would. */
function post(
  app: Hono,
  headers: Record<string, string> = {},
  body = JSON.stringify({ repo: "no42-org/twiki", number: 7 }),
) {
  return app.request(`${ORIGIN}/merge`, {
    method: "POST",
    headers: {
      Host: HOST,
      Origin: ORIGIN,
      "Content-Type": "application/json",
      ...headers,
    },
    body,
  });
}

describe("POST /merge", () => {
  it("returns twiki's answer for a same-origin JSON post", async () => {
    const answer: MergeResponse = { outcome: "refused", refusal: "ci-failed" };
    const requestMerge = fakeMerge(async () => answer);

    const res = await post(appWith(requestMerge));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(answer);
    expect(requestMerge.mock.calls).toEqual([
      [{ repo: "no42-org/twiki", number: 7 }],
    ]);
  });

  it("accepts a charset on the JSON content type", async () => {
    const res = await post(appWith(fakeMerge()), {
      "Content-Type": "application/json; charset=utf-8",
    });
    expect(await res.json()).toEqual(MERGED);
  });

  it("forwards only the fields of the contract", async () => {
    const requestMerge = fakeMerge();
    await post(
      appWith(requestMerge),
      {},
      JSON.stringify({ repo: "no42-org/twiki", number: 7, admin: true }),
    );
    expect(requestMerge.mock.calls).toEqual([
      [{ repo: "no42-org/twiki", number: 7 }],
    ]);
  });

  it.each([
    ["localhost", "localhost:8787"],
    ["an SSH tunnel's local port", "127.0.0.1:18787"],
    ["IPv6 loopback", "[::1]:8787"],
  ])("takes a same-origin post on %s", async (_name, host) => {
    const res = await post(appWith(fakeMerge()), {
      Host: host,
      Origin: `http://${host}`,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(MERGED);
  });

  // DNS rebinding: a page on an attacker's name, re-resolved to loopback. The
  // browser calls that same-origin and sends a matching Origin and Host, so
  // only the name itself can give it away.
  it.each([
    ["a rebound name", "evil.example:8787", "http://evil.example:8787"],
    ["a name without a port", "dash.example", "https://dash.example"],
    [
      "a name that starts like loopback",
      "127.0.0.1.evil.example:8787",
      "http://127.0.0.1.evil.example:8787",
    ],
  ])(
    "refuses %s with 403, matching Origin or not",
    async (_name, host, origin) => {
      const requestMerge = fakeMerge();
      const res = await post(appWith(requestMerge), {
        Host: host,
        Origin: origin,
      });

      expect(res.status).toBe(403);
      expect(requestMerge).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a foreign origin", { Origin: "https://evil.example" }],
    ["the same host name on another port", { Origin: "http://127.0.0.1:9999" }],
    ["an opaque origin", { Origin: "null" }],
    ["an origin that does not parse", { Origin: "not a url" }],
  ])("refuses %s with 403", async (_name, headers) => {
    const requestMerge = fakeMerge();
    const res = await post(appWith(requestMerge), headers);

    expect(res.status).toBe(403);
    expect(requestMerge).not.toHaveBeenCalled();
  });

  it("fails closed with 403 when Origin is missing", async () => {
    const requestMerge = fakeMerge();
    const res = await appWith(requestMerge).request(`${ORIGIN}/merge`, {
      method: "POST",
      headers: { Host: HOST, "Content-Type": "application/json" },
      body: JSON.stringify({ repo: "no42-org/twiki", number: 7 }),
    });

    expect(res.status).toBe(403);
    expect(requestMerge).not.toHaveBeenCalled();
  });

  it.each([
    ["text/plain"],
    ["application/x-www-form-urlencoded"],
    ["multipart/form-data"],
    ["application/jsonp"],
  ])("refuses a %s body with 415", async (contentType) => {
    const requestMerge = fakeMerge();
    const res = await post(appWith(requestMerge), {
      "Content-Type": contentType,
    });

    expect(res.status).toBe(415);
    expect(requestMerge).not.toHaveBeenCalled();
  });

  it.each([
    ["a body that is not JSON", "{"],
    ["a missing number", JSON.stringify({ repo: "no42-org/twiki" })],
    ["a number below one", JSON.stringify({ repo: "a/b", number: 0 })],
    ["a repo that is not a string", JSON.stringify({ repo: 1, number: 7 })],
  ])("answers 400 for %s", async (_name, body) => {
    const requestMerge = fakeMerge();
    const res = await post(appWith(requestMerge), {}, body);

    expect(res.status).toBe(400);
    expect(requestMerge).not.toHaveBeenCalled();
  });

  it("refuses a repository outside repos.yaml without calling twiki", async () => {
    const requestMerge = fakeMerge();
    const res = await post(
      appWith(requestMerge),
      {},
      JSON.stringify({ repo: "no42-org/other", number: 7 }),
    );

    expect(await res.json()).toEqual({
      outcome: "refused",
      refusal: "not-allowlisted",
    });
    expect(requestMerge).not.toHaveBeenCalled();
  });

  it("passes a lowercased slug for a mixed-case repository, as sent", async () => {
    const requestMerge = fakeMerge();
    const res = await post(
      appWith(requestMerge),
      {},
      JSON.stringify({ repo: "no42-org/coolmodfiles", number: 7 }),
    );

    expect(await res.json()).toEqual(MERGED);
    // twiki resolves the declared casing itself.
    expect(requestMerge.mock.calls).toEqual([
      [{ repo: "no42-org/coolmodfiles", number: 7 }],
    ]);
  });

  it("folds the request's casing too, the way GitHub displays a slug", async () => {
    const requestMerge = fakeMerge();
    const res = await post(
      appWith(requestMerge),
      {},
      JSON.stringify({ repo: "No42-Org/Twiki", number: 7 }),
    );

    expect(await res.json()).toEqual(MERGED);
    expect(requestMerge.mock.calls).toEqual([
      [{ repo: "No42-Org/Twiki", number: 7 }],
    ]);
  });

  it("refuses in shadow mode without calling twiki", async () => {
    const requestMerge = fakeMerge();
    const res = await post(appWith(requestMerge, "shadow"));

    expect(await res.json()).toEqual({
      outcome: "refused",
      refusal: "shadow-mode",
    });
    expect(requestMerge).not.toHaveBeenCalled();
  });

  it("names the allowlist before the mode, as twiki does", async () => {
    const res = await post(
      appWith(fakeMerge(), "shadow"),
      {},
      JSON.stringify({ repo: "no42-org/other", number: 7 }),
    );
    expect(await res.json()).toEqual({
      outcome: "refused",
      refusal: "not-allowlisted",
    });
  });

  it("refuses as unreachable when no merge URL is configured", async () => {
    const res = await post(appWith(null));
    expect(await res.json()).toEqual({
      outcome: "refused",
      refusal: "unreachable",
    });
  });

  it("refuses as unreachable when twiki fails, and leaks no detail", async () => {
    const requestMerge = fakeMerge(async () => {
      throw new Error("connect ECONNREFUSED 172.18.0.3:8788");
    });
    const res = await post(appWith(requestMerge));

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(
      JSON.stringify({ outcome: "refused", refusal: "unreachable" }),
    );
  });

  it.each([
    ["an answer", () => post(appWith(fakeMerge()))],
    [
      "a refusal",
      () => post(appWith(fakeMerge()), { Origin: "https://evil.example" }),
    ],
    [
      "a 415",
      () => post(appWith(fakeMerge()), { "Content-Type": "text/plain" }),
    ],
    ["a 400", () => post(appWith(fakeMerge()), {}, "{")],
  ])("is never cached: %s", async (_name, send) => {
    expect((await send()).headers.get("Cache-Control")).toBe("no-store");
  });
});

// Over a real socket, because `app.request` builds its own Request: there the
// node adapter's URL and Host derivation never runs, and a check that read the
// wrong one could pass by coincidence.
describe("POST /merge over a real listener", () => {
  let server: Server;
  let host: string;
  const requestMerge = fakeMerge();

  beforeEach(async () => {
    requestMerge.mockClear();
    await new Promise<void>((resolve) => {
      server = serve(
        { fetch: appWith(requestMerge).fetch, hostname: "127.0.0.1", port: 0 },
        () => resolve(),
      ) as Server;
    });
    host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    server.close();
  });

  function send(headers: Record<string, string>) {
    return new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = httpRequest(
        `http://${host}/merge`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
        },
        (res) => {
          let body = "";
          res.on("data", (chunk) => {
            body += chunk;
          });
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ repo: "no42-org/twiki", number: 7 }));
    });
  }

  it("takes a same-origin post", async () => {
    const res = await send({ Origin: `http://${host}` });
    expect(res).toEqual({ status: 200, body: JSON.stringify(MERGED) });
    expect(requestMerge).toHaveBeenCalledTimes(1);
  });

  it("refuses a foreign origin and a missing one", async () => {
    expect((await send({ Origin: "https://evil.example" })).status).toBe(403);
    expect((await send({})).status).toBe(403);
    expect(requestMerge).not.toHaveBeenCalled();
  });
});

describe("the overview's merge context", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "merge-route-"));
    store = SqliteStore.openForWrite(join(dir, "o.db"));
    vi.mocked(buildOverview).mockClear();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const contextFor = async (extra: {
    mode?: Mode;
    requestMerge?: ReturnType<typeof fakeMerge> | null;
  }) => {
    const res = await createApp({
      store,
      watched,
      policy: { cadenceMs: 1_000 },
      defaultBranchOf: () => "main",
      now: () => new Date("2026-10-31T00:00:00.000Z"),
      ...extra,
    }).request("/");
    expect(res.status).toBe(200);
    return vi.mocked(buildOverview).mock.calls.at(-1)?.[4];
  };

  it("carries the real mode and a configured listener", async () => {
    expect(
      await contextFor({ mode: "enforce", requestMerge: fakeMerge() }),
    ).toEqual({ mode: "enforce", configured: true });
  });

  it("reads an unset merge URL as not configured", async () => {
    expect(await contextFor({ mode: "enforce", requestMerge: null })).toEqual({
      mode: "enforce",
      configured: false,
    });
  });

  it("defaults to shadow with no listener", async () => {
    expect(await contextFor({})).toEqual({ mode: "shadow", configured: false });
  });
});

describe("TWIKI_MODE", () => {
  it("is the override when valid and absent when unset", () => {
    expect(modeFromEnv({ TWIKI_MODE: "enforce" })).toBe("enforce");
    expect(modeFromEnv({ TWIKI_MODE: "shadow" })).toBe("shadow");
    expect(modeFromEnv({})).toBeUndefined();
  });

  // Byte for byte, because twiki compares without trimming: a page that
  // forgave "enforce " would offer a merge twiki then refuses.
  it.each(["Enforce", "enforce ", "", "on"])("refuses %j, naming it", (bad) => {
    expect(() => modeFromEnv({ TWIKI_MODE: bad })).toThrow(
      `TWIKI_MODE must be shadow or enforce, got "${bad}"`,
    );
  });
});

describe("twiki's entrypoint", () => {
  // Spawned, because an entrypoint cannot be imported (AD-5). The cases above
  // cover the helper. This covers that twiki calls it.
  it("fails on a bad TWIKI_MODE, naming it", () => {
    const run = spawnSync(
      process.execPath,
      ["--import", "tsx", "src/index.ts"],
      {
        encoding: "utf8",
        // A config that cannot load, so a regression stops there rather
        // than reaching GitHub.
        env: {
          ...process.env,
          TWIKI_MODE: "Enforce",
          TWIKI_CONFIG: "/nonexistent/repos.yaml",
          TWIKI_ONCE: "1",
        },
      },
    );

    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(
      'TWIKI_MODE must be shadow or enforce, got "Enforce"',
    );
  });
});

describe("TWIKI_MERGE_URL", () => {
  it("is null when unset or blank", () => {
    expect(parseMergeUrl(undefined)).toBeNull();
    expect(parseMergeUrl("  ")).toBeNull();
  });

  it("drops a trailing slash, so joining /merge cannot double it", () => {
    expect(parseMergeUrl("http://twiki:8788")).toBe("http://twiki:8788");
    expect(parseMergeUrl("http://twiki:8788/")).toBe("http://twiki:8788");
  });

  it("refuses what is not an http URL, naming the variable", () => {
    expect(() => parseMergeUrl("nonsense")).toThrow(
      "TWIKI_MERGE_URL is not a URL",
    );
    // Parses, with `twiki:` as the scheme. The likeliest typo there is.
    expect(() => parseMergeUrl("twiki:8788")).toThrow(
      "TWIKI_MERGE_URL must be http or https",
    );
  });

  it.each([
    ["a query", "http://twiki:8788?a=1"],
    ["a fragment", "http://twiki:8788#a"],
    ["a user", "http://user@twiki:8788"],
    ["a password", "http://user:s3cret@twiki:8788"],
  ])("refuses %s", (_name, raw) => {
    expect(() => parseMergeUrl(raw)).toThrow(
      "TWIKI_MERGE_URL must not carry a query, fragment or credentials",
    );
  });

  // Every refusal, including the two that fire before anything can tell
  // credentials apart from the rest of the value.
  it.each([
    "http://user:s3cret@twiki:8788",
    "http://user:s3cret@",
    "ftp://user:s3cret@twiki:8788",
  ])("keeps the value out of the error: %s", (raw) => {
    let message = "";
    try {
      parseMergeUrl(raw);
    } catch (err) {
      message = String(err);
    }
    expect(message).toContain("TWIKI_MERGE_URL");
    expect(message).not.toContain("s3cret");
  });
});

describe("mergeClient", () => {
  let server: Server;
  let baseUrl: string;
  let received: { path: string; type: string | undefined; body: unknown }[];
  let reply: { status: number; body: string };
  const log = vi.fn();

  beforeEach(async () => {
    received = [];
    log.mockClear();
    const twiki = new Hono();
    twiki.post("*", async (c) => {
      received.push({
        path: c.req.path,
        type: c.req.header("content-type"),
        body: await c.req.json(),
      });
      return c.body(reply.body, reply.status as 200);
    });
    await new Promise<void>((resolve) => {
      server = serve(
        { fetch: twiki.fetch, hostname: "127.0.0.1", port: 0 },
        () => resolve(),
      ) as Server;
    });
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(() => {
    server.close();
  });

  const request = { repo: "no42-org/twiki", number: 7 };

  it("is null without a URL", () => {
    expect(mergeClient(null, log)).toBeNull();
  });

  it.each<[string, MergeResponse]>([
    ["merged", { outcome: "merged" }],
    ["already merged", { outcome: "already-merged" }],
    ["refused", { outcome: "refused", refusal: "head-changed" }],
  ])("posts the request and parses a reply: %s", async (_name, answer) => {
    reply = { status: 200, body: JSON.stringify(answer) };

    const client = mergeClient(baseUrl, log);

    expect(await client?.(request)).toEqual(answer);
    expect(received).toEqual([
      { path: "/merge", type: "application/json", body: request },
    ]);
    expect(log).not.toHaveBeenCalled();
  });

  it.each([
    ["a 500", { status: 500, body: '{"error":"merge failed"}' }],
    // A valid reply on a failed status. A failure must never read as merged.
    ["a 502 that says merged", { status: 502, body: '{"outcome":"merged"}' }],
    ["a reply that is not JSON", { status: 200, body: "<html>" }],
    ["an unknown outcome", { status: 200, body: '{"outcome":"maybe"}' }],
    [
      "an unknown refusal",
      { status: 200, body: '{"outcome":"refused","refusal":"nope"}' },
    ],
  ])("rejects %s and logs it", async (_name, answer) => {
    reply = answer;

    await expect(mergeClient(baseUrl, log)?.(request)).rejects.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0]?.[0]).toContain("no42-org/twiki#7");
  });

  it("rejects when nothing is listening", async () => {
    await expect(
      mergeClient("http://127.0.0.1:1", log)?.(request),
    ).rejects.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
  });
});
