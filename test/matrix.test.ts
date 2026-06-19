/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { MatrixNotifier } from "../src/notify.js";

describe("MatrixNotifier", () => {
  it("PUTs an m.text message to the room with a Bearer token", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const notify = new MatrixNotifier(
        "https://matrix.example.org/",
        "secret-token",
        "!abc:example.org",
        ".twiki-matrix-test-digest",
      );
      await notify.send("hello matrix");

      expect(captured).not.toBeNull();
      const { url, init } = captured!;
      expect(init.method).toBe("PUT");
      expect(url).toContain(
        "/_matrix/client/v3/rooms/" +
          encodeURIComponent("!abc:example.org") +
          "/send/m.room.message/",
      );
      // homeserver trailing slash must not double up
      expect(url).not.toContain("//_matrix");
      const headers = init.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer secret-token");
      expect(JSON.parse(init.body as string)).toEqual({
        msgtype: "m.text",
        body: "hello matrix",
      });
    } finally {
      globalThis.fetch = origFetch;
      const fs = await import("node:fs");
      fs.rmSync?.(".twiki-matrix-test-digest", { force: true });
    }
  });

  it("uses a fresh transaction ID per send even for identical content", async () => {
    const urls: string[] = [];
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string) => {
      urls.push(url);
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      // Two separate instances (separate dedup files) so the identical message
      // is actually delivered twice rather than skipped by de-duplication.
      const a = new MatrixNotifier(
        "https://matrix.example.org",
        "tok",
        "!abc:example.org",
        ".twiki-matrix-test-txn-a",
      );
      const b = new MatrixNotifier(
        "https://matrix.example.org",
        "tok",
        "!abc:example.org",
        ".twiki-matrix-test-txn-b",
      );
      await a.send("same digest");
      await b.send("same digest");

      expect(urls).toHaveLength(2);
      const txn = (u: string) => u.split("/send/m.room.message/")[1];
      expect(txn(urls[0]!)).not.toBe(txn(urls[1]!));
    } finally {
      globalThis.fetch = origFetch;
      const fs = await import("node:fs");
      fs.rmSync?.(".twiki-matrix-test-txn-a", { force: true });
      fs.rmSync?.(".twiki-matrix-test-txn-b", { force: true });
    }
  });

  it("throws on a non-success homeserver response", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, {
        status: 403,
        statusText: "Forbidden",
      })) as typeof fetch;
    try {
      const notify = new MatrixNotifier(
        "https://matrix.example.org",
        "bad",
        "!abc:example.org",
        ".twiki-matrix-test-digest2",
      );
      await expect(notify.send("nope")).rejects.toThrow(
        /Matrix delivery failed: 403/,
      );
    } finally {
      globalThis.fetch = origFetch;
      const fs = await import("node:fs");
      fs.rmSync?.(".twiki-matrix-test-digest2", { force: true });
    }
  });
});
