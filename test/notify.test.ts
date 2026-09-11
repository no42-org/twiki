/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { redact } from "../src/core/redact.js";
import { DedupingNotifier } from "../src/notify/dedupe.js";
import {
  ConsoleTransport,
  MatrixTransport,
  WebhookTransport,
} from "../src/notify/transports.js";
import { withLaneRun } from "../src/tricorder/collect/lifecycle.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";

// The shared transports (story 4.1). twiki's own suites — test/matrix.test.ts,
// test/advisor-outage.test.ts, test/state-dir.test.ts — are the other half of
// this story's coverage and were deliberately not edited: they exercise the
// compat classes in src/twiki/notify.ts that now compose what is tested here.

const HOMESERVER = "https://matrix.example.org";
const ROOM = "!abc:example.org";

/** A synthetic Synapse-shaped access token. Not a credential. */
const TOKEN = `syt_${"A".repeat(32)}`;

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "notify-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllGlobals();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.length = 0;
});

/** Every fetch the transport made, so a whole request can be asserted. */
function captureFetch(respond: () => Response): { url: string }[] {
  const calls: { url: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      calls.push({ url });
      return respond();
    }),
  );
  return calls;
}

describe("a transport sends every time it is called", () => {
  it("MatrixTransport re-sends identical text and touches no file", async () => {
    // The point of the extraction: de-duplication is a wrapper, so a bare
    // transport has none. gitricorder de-duplicates per item in its store and
    // must not inherit twiki's file.
    const calls = captureFetch(() => new Response(null, { status: 200 }));
    const transport = new MatrixTransport(HOMESERVER, TOKEN, ROOM);

    await transport.send("the same sentence");
    await transport.send("the same sentence");

    expect(calls).toHaveLength(2);
    // Nothing fell back to the historical default path in the working
    // directory, which is the only file a transport could have written.
    expect(existsSync(".twiki-last-digest")).toBe(false);
    expect(existsSync(".twiki-last-digest.matrix")).toBe(false);
  });

  it("WebhookTransport re-sends identical text and touches no file", async () => {
    const calls = captureFetch(() => new Response("ok", { status: 200 }));
    const transport = new WebhookTransport(
      "https://example.invalid/h",
      "slack",
    );

    await transport.send("the same sentence");
    await transport.send("the same sentence");

    expect(calls).toHaveLength(2);
    expect(existsSync(".twiki-last-digest.slack")).toBe(false);
  });

  it("ConsoleTransport prints every call", async () => {
    const printed: unknown[][] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => void printed.push(args));
    try {
      const transport = new ConsoleTransport();
      await transport.send("one");
      await transport.send("one");
      expect(printed).toEqual([["one"], ["one"]]);
    } finally {
      log.mockRestore();
    }
  });
});

describe("the same transport wrapped in DedupingNotifier", () => {
  it("skips an unchanged message and sends a changed one", async () => {
    // The behaviour twiki keeps, now composed rather than inherited.
    const calls = captureFetch(() => new Response(null, { status: 200 }));
    const notifier = new DedupingNotifier(
      new MatrixTransport(HOMESERVER, TOKEN, ROOM),
      join(tempDir(), ".twiki-last-digest.matrix"),
    );

    await notifier.send("the same sentence");
    await notifier.send("the same sentence");
    expect(calls).toHaveLength(1);

    await notifier.send("something else");
    expect(calls).toHaveLength(2);
  });

  it("does not remember a message the transport refused", async () => {
    // Ordering: the hash is written after delivery, so a failed send is
    // retried on the next run rather than swallowed as "already sent".
    const calls = captureFetch(
      () => new Response(null, { status: 500, statusText: "Server Error" }),
    );
    const path = join(tempDir(), ".twiki-last-digest.slack");
    const notifier = new DedupingNotifier(
      new WebhookTransport("https://example.invalid/h", "slack"),
      path,
    );

    await expect(notifier.send("a digest")).rejects.toThrow(
      "Webhook delivery failed: 500 Server Error",
    );
    expect(existsSync(path)).toBe(false);

    await expect(notifier.send("a digest")).rejects.toThrow();
    expect(calls).toHaveLength(2);
  });
});

describe("the access token never survives into an error", () => {
  it("removes a token the homeserver echoes in a 403 body", async () => {
    captureFetch(
      () =>
        new Response(
          `{"errcode":"M_FORBIDDEN","error":"access token ${TOKEN} is not allowed in this room"}`,
          { status: 403, statusText: "Forbidden" },
        ),
    );

    // The whole message, not a substring search for the token: an assertion
    // that only says "the token is absent" also passes for a message that
    // dropped the diagnostic entirely, and the diagnostic is why the body is
    // echoed at all.
    await expect(
      new MatrixTransport(HOMESERVER, TOKEN, ROOM).send("hello"),
    ).rejects.toThrow(
      "Matrix delivery failed: 403 Forbidden — " +
        '{"errcode":"M_FORBIDDEN","error":"access token REDACTED is not allowed in this room"}',
    );
  });

  it("removes a token a proxy echoes in a 502 body", async () => {
    // Not a Matrix body at all. The measured leak path is a reverse proxy or a
    // homeserver that is not Synapse putting the credential into a body this
    // transport deliberately quotes.
    captureFetch(
      () =>
        new Response(
          `<html><body>upstream rejected Bearer ${TOKEN}</body></html>`,
          { status: 502, statusText: "Bad Gateway" },
        ),
    );

    await expect(
      new MatrixTransport(HOMESERVER, TOKEN, ROOM).send("hello"),
    ).rejects.toThrow(
      "Matrix delivery failed: 502 Bad Gateway — " +
        "<html><body>upstream rejected Bearer REDACTED</body></html>",
    );
  });

  it("redacts before bounding, so a token across the 500-char cut is gone", async () => {
    // Bounding first would keep the leading characters of a token that starts
    // just before the cut, which is most of the secret. The 500-char bound
    // still applies, to the redacted text: 490 padding + "REDACTED" + " t".
    const straddling = `${"x".repeat(490)}${TOKEN} trailing`;
    captureFetch(
      () =>
        new Response(straddling, { status: 500, statusText: "Server Error" }),
    );

    const err = await new MatrixTransport(HOMESERVER, TOKEN, ROOM)
      .send("hello")
      .then(
        () => null,
        (e: unknown) => e as Error,
      );

    expect(err).not.toBeNull();
    expect(err?.message).toBe(
      "Matrix delivery failed: 500 Server Error — " +
        `${"x".repeat(490)}REDACTED t`,
    );
    expect(err?.message).not.toContain(TOKEN.slice(0, 12));
  });

  it("keeps the token out of collection_run.detail when a lane sends", async () => {
    // NFR8, at the site that actually persists a failure: withLaneRun calls
    // redact() with no secret of its own, so the token must already be gone by
    // the time the error leaves the transport.
    const store = SqliteStore.openForWrite(join(tempDir(), "r.db"));
    const logs: string[] = [];
    captureFetch(
      () =>
        new Response(
          `{"errcode":"M_UNKNOWN_TOKEN","error":"Invalid access token ${TOKEN}"}`,
          { status: 401, statusText: "Unauthorized" },
        ),
    );

    const result = await withLaneRun(
      {
        store,
        now: () => "2026-09-11T10:00:00.000Z",
        log: (m: string) => logs.push(m),
      },
      {
        lane: "notify",
        installation: "gitricorder",
        scope: "hot",
        reach: "global",
      },
      { sent: 0 },
      async () => {
        await new MatrixTransport(HOMESERVER, TOKEN, ROOM).send(
          "a new critical Dependabot alert landed in no42-org/twiki",
        );
        return { sent: 1 };
      },
    );

    const detail =
      "Matrix delivery failed: 401 Unauthorized — " +
      '{"errcode":"M_UNKNOWN_TOKEN","error":"Invalid access token REDACTED"}';
    expect(result).toEqual({ sent: 0 });
    expect(store.latestRuns(1)).toEqual([
      {
        id: expect.any(Number),
        lane: "notify",
        installation: "gitricorder",
        scope: "hot",
        outcome: "failed",
        detail,
        startedAt: "2026-09-11T10:00:00.000Z",
        verifiedAt: "2026-09-11T10:00:00.000Z",
      },
    ]);
    expect(logs).toEqual([`notify: failed, ${detail}`]);

    store.close();
  });
});

describe("redact's exact-match argument", () => {
  it("removes the secret and still applies the pattern list", () => {
    expect(
      redact(`token ${TOKEN} and ghs_AAAAAAAAAAAAAAAAAAAAAAAA together`, [
        TOKEN,
      ]),
    ).toBe("token REDACTED and gh?_REDACTED together");
  });

  it("removes every occurrence, not only the first", () => {
    expect(redact(`${TOKEN}/${TOKEN}`, [TOKEN])).toBe("REDACTED/REDACTED");
  });

  it("runs before the pattern list, so a GitHub-shaped secret still goes", () => {
    // Pattern-first would rewrite ghs_… into gh?_REDACTED, and the exact match
    // would then find nothing equal to the configured value. The observable
    // difference is only the marker, which is exactly why it is asserted.
    expect(
      redact("ghs_AAAAAAAAAAAAAAAAAAAAAAAA", ["ghs_AAAAAAAAAAAAAAAAAAAAAAAA"]),
    ).toBe("REDACTED");
  });

  it("ignores an empty secret rather than matching everywhere", () => {
    // An unset env var arrives as "". String.split("") matches at every
    // character boundary, so an unguarded loop would rewrite the whole string.
    expect(redact("nothing to hide here", [""])).toBe("nothing to hide here");
  });

  it("is unchanged when no secrets are passed", () => {
    expect(redact("Bad credentials: ghs_AAAAAAAAAAAAAAAAAAAAAAAA")).toBe(
      "Bad credentials: gh?_REDACTED",
    );
  });
});
