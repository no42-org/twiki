/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
import {
  ConsoleNotifier,
  MatrixNotifier,
  WebhookNotifier,
} from "../src/twiki/notify.js";

// The shared transports, the wrapper, and twiki's compat classes (story 4.1).
//
// twiki's own suites — test/matrix.test.ts, test/advisor-outage.test.ts,
// test/state-dir.test.ts — are deliberately unedited: that they still pass is
// this story's evidence that twiki's behaviour did not move. So anything the
// extraction newly needs pinning for is pinned HERE, not there.

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

/** Every request the transport made, whole, so one can be asserted entire. */
function captureFetch(
  respond: () => Response,
): { url: string; init: RequestInit }[] {
  const calls: { url: string; init: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return respond();
    }),
  );
  return calls;
}

describe("a transport sends every time it is called", () => {
  it("MatrixTransport re-sends identical text, with a fresh transaction ID", async () => {
    // The point of the extraction: de-duplication is a wrapper, so a bare
    // transport has none. gitricorder's lane (story 4.2) de-duplicates per
    // item in its store and must not inherit twiki's file.
    const calls = captureFetch(() => new Response(null, { status: 200 }));
    const transport = new MatrixTransport(HOMESERVER, TOKEN, ROOM);

    await transport.send("the same sentence");
    await transport.send("the same sentence");

    expect(calls).toHaveLength(2);
    // The whole first request, not one field of it: the room encoding, the
    // Bearer header and the three body fields all came along in the move, and
    // a test that looked at one of them would not have noticed the others.
    const [first, second] = calls as [
      (typeof calls)[number],
      (typeof calls)[number],
    ];
    const prefix = `${HOMESERVER}/_matrix/client/v3/rooms/${encodeURIComponent(
      ROOM,
    )}/send/m.room.message/`;
    expect(first.url.startsWith(prefix)).toBe(true);
    expect(first.init.method).toBe("PUT");
    expect(first.init.headers).toEqual({
      "content-type": "application/json",
      authorization: `Bearer ${TOKEN}`,
    });
    expect(JSON.parse(first.init.body as string)).toEqual({
      msgtype: "m.text",
      body: "the same sentence",
      format: "org.matrix.custom.html",
      formatted_body: "the same sentence",
    });
    expect(first.url.slice(prefix.length)).not.toBe(
      second.url.slice(prefix.length),
    );
  });

  it("WebhookTransport re-sends identical text, in its flavour's shape", async () => {
    const calls = captureFetch(() => new Response("ok", { status: 200 }));

    await new WebhookTransport("https://example.invalid/h", "slack").send("hi");
    await new WebhookTransport("https://example.invalid/h", "slack").send("hi");
    // Discord's webhook takes the same request with a different key. Both
    // branches are asserted, because swapping them is invisible to a test that
    // only counts calls.
    await new WebhookTransport("https://example.invalid/d", "discord").send(
      "hi",
    );

    expect(
      calls.map((c) => ({
        url: c.url,
        method: c.init.method,
        headers: c.init.headers,
        body: JSON.parse(c.init.body as string),
      })),
    ).toEqual([
      {
        url: "https://example.invalid/h",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { text: "hi" },
      },
      {
        url: "https://example.invalid/h",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { text: "hi" },
      },
      {
        url: "https://example.invalid/d",
        method: "POST",
        headers: { "content-type": "application/json" },
        body: { content: "hi" },
      },
    ]);
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

  it("no transport can touch the filesystem", async () => {
    // Asserted on the module's imports rather than on a directory listing. A
    // listing can only be taken somewhere: the working directory is whatever
    // vitest was launched from, so `.twiki-last-digest` left there by a real
    // twiki run is a false failure, and a transport writing to any other path
    // is a false pass. A module that imports no filesystem API has no path it
    // could write, wherever it runs.
    const src = readFileSync("src/notify/transports.ts", "utf8");
    expect(src).not.toMatch(/["']node:fs["']/);
  });
});

describe("the same transport wrapped in DedupingNotifier", () => {
  it("skips an unchanged message and sends a changed one", async () => {
    // The behaviour twiki keeps, now composed rather than inherited.
    const calls = captureFetch(() => new Response(null, { status: 200 }));
    const dir = tempDir();
    const notifier = new DedupingNotifier(
      new MatrixTransport(HOMESERVER, TOKEN, ROOM),
      join(dir, ".twiki-last-digest.matrix"),
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

  it("still delivers when the dedupe file cannot be written", async () => {
    // De-duplication is best-effort by design and swallows its write error.
    // The silent half of that must still be true: an unwritable path costs
    // de-duplication, never delivery. Here the parent directory is absent, so
    // writeFileSync throws ENOENT.
    const calls = captureFetch(() => new Response(null, { status: 200 }));
    const path = join(tempDir(), "absent", ".twiki-last-digest.matrix");
    const notifier = new DedupingNotifier(
      new MatrixTransport(HOMESERVER, TOKEN, ROOM),
      path,
    );

    await notifier.send("a digest");
    await notifier.send("a digest");

    // Delivered both times, because nothing was ever remembered.
    expect(calls).toHaveLength(2);
    expect(existsSync(path)).toBe(false);
  });

  it("treats a blank dedupe file as no state, then writes real state", async () => {
    // A zero-byte or whitespace-only file is what a crashed or truncated write
    // leaves behind. It must not suppress the digest, and what the send leaves
    // behind must be a hash, so the NEXT identical digest is skipped.
    //
    // Honest about what each half pins. The blank read is a contract
    // assertion: today it cannot fail, because the comparison is against a
    // 64-hex digest and no blank read equals one. It is here so that a
    // `lastHash() !== null` style check - which WOULD drop the digest for the
    // life of that file - cannot land without turning this red. The hash
    // assertion below does fail on its own if rememberHash writes the wrong
    // thing.
    const calls = captureFetch(() => new Response(null, { status: 200 }));
    const path = join(tempDir(), ".twiki-last-digest.matrix");
    writeFileSync(path, "   \n");
    const notifier = new DedupingNotifier(
      new MatrixTransport(HOMESERVER, TOKEN, ROOM),
      path,
    );

    await notifier.send("a digest");
    await notifier.send("a digest");

    expect(calls).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("twiki's notifiers compose the shared transports", () => {
  it("MatrixNotifier de-duplicates an unchanged digest", async () => {
    // This was guaranteed by `extends DedupingNotifier` and is now one
    // constructor line. Nothing else in the tree pins it: replacing the
    // wiring with a bare MatrixTransport left the whole suite green, while
    // the same mutation on WebhookNotifier is caught twice over by
    // test/advisor-outage.test.ts and test/state-dir.test.ts. This is the
    // Matrix half of that pair, kept out of test/matrix.test.ts so that suite
    // stays byte-unchanged.
    const calls = captureFetch(() => new Response(null, { status: 200 }));
    const path = join(tempDir(), ".twiki-last-digest.matrix");
    const notifier = new MatrixNotifier(HOMESERVER, TOKEN, ROOM, path);

    await notifier.send("a digest");
    await notifier.send("a digest");
    expect(calls).toHaveLength(1);

    await notifier.send("a changed digest");
    expect(calls).toHaveLength(2);
  });

  it("WebhookNotifier de-duplicates an unchanged digest", async () => {
    // Already covered by twiki's own suites; kept here so the three compat
    // classes are pinned in one place and the Matrix case above does not read
    // as a special case.
    const calls = captureFetch(() => new Response("ok", { status: 200 }));
    const path = join(tempDir(), ".twiki-last-digest.slack");
    const notifier = new WebhookNotifier(
      "https://example.invalid/h",
      "slack",
      path,
    );

    await notifier.send("a digest");
    await notifier.send("a digest");
    expect(calls).toHaveLength(1);

    await notifier.send("a changed digest");
    expect(calls).toHaveLength(2);
  });

  it("ConsoleNotifier prints every call", async () => {
    // There is no de-duplication test to add: ConsoleNotifier never extended
    // DedupingNotifier and must keep printing every time. What the extraction
    // put at risk is the name — it is now an alias of ConsoleTransport — so
    // what is pinned is that the name still delivers.
    const printed: unknown[][] = [];
    const log = vi
      .spyOn(console, "log")
      .mockImplementation((...args: unknown[]) => void printed.push(args));
    try {
      const notifier = new ConsoleNotifier();
      await notifier.send("a digest");
      await notifier.send("a digest");
      expect(printed).toEqual([["a digest"], ["a digest"]]);
    } finally {
      log.mockRestore();
    }
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
        '{"errcode":"M_FORBIDDEN","error":"access token SECRET_REDACTED is not allowed in this room"}',
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
        "<html><body>upstream rejected Bearer SECRET_REDACTED</body></html>",
    );
  });

  it("redacts before bounding, so a token across the 500-char cut is gone", async () => {
    // Bounding first would keep the leading characters of a token that starts
    // just before the cut, which is most of the secret. The 500-char bound
    // still applies, to the redacted text: 485 of padding plus the 15-character
    // marker is exactly the bound, so the marker survives whole and the tail
    // after it does not.
    const straddling = `${"x".repeat(485)}${TOKEN} trailing`;
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
        `${"x".repeat(485)}SECRET_REDACTED`,
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
      '{"errcode":"M_UNKNOWN_TOKEN","error":"Invalid access token SECRET_REDACTED"}';
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
    ).toBe("token SECRET_REDACTED and gh?_REDACTED together");
  });

  it("removes every occurrence, not only the first", () => {
    expect(redact(`${TOKEN}/${TOKEN}`, [TOKEN])).toBe(
      "SECRET_REDACTED/SECRET_REDACTED",
    );
  });

  it("runs before the pattern list, so a GitHub-shaped secret still goes", () => {
    // Pattern-first would rewrite ghs_… into gh?_REDACTED, and the exact match
    // would then find nothing equal to the configured value. The observable
    // difference is only the marker, which is exactly why it is asserted.
    expect(
      redact("ghs_AAAAAAAAAAAAAAAAAAAAAAAA", ["ghs_AAAAAAAAAAAAAAAAAAAAAAAA"]),
    ).toBe("SECRET_REDACTED");
  });

  it("ignores an empty secret rather than matching everywhere", () => {
    // An unset env var arrives as "". String.split("") matches at every
    // character boundary, so an unguarded loop would rewrite the whole string.
    expect(redact("nothing to hide here", [""])).toBe("nothing to hide here");
  });

  it("ignores a blank secret rather than eating every space", () => {
    // TWIKI_MATRIX_TOKEN=" " is a misconfiguration, not a credential, and
    // redaction exists to preserve the diagnostic.
    expect(redact("Invalid access token", [" "])).toBe("Invalid access token");
  });

  it("ignores a secret too short to be a credential", () => {
    // test/matrix.test.ts really does construct a notifier with the token
    // `tok`; without a floor, any body explaining the failure would come back
    // with the word "token" rewritten.
    expect(redact("Invalid access token", ["tok"])).toBe(
      "Invalid access token",
    );
  });

  it("is unchanged when no secrets are passed", () => {
    expect(redact("Bad credentials: ghs_AAAAAAAAAAAAAAAAAAAAAAAA")).toBe(
      "Bad credentials: gh?_REDACTED",
    );
  });
});
