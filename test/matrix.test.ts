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
        format: "org.matrix.custom.html",
        formatted_body: "hello matrix",
      });
    } finally {
      globalThis.fetch = origFetch;
      const fs = await import("node:fs");
      fs.rmSync?.(".twiki-matrix-test-digest", { force: true });
    }
  });

  it("renders mrkdwn as an HTML formatted_body, escaping HTML in titles", async () => {
    let captured: { init: RequestInit } | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = { init };
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const notify = new MatrixNotifier(
        "https://matrix.example.org",
        "tok",
        "!abc:example.org",
        ".twiki-matrix-test-html",
      );
      await notify.send(
        "🟢 *twiki run — ENFORCE*\n_quiet & <ok>_\n*bold* line",
      );

      const body = JSON.parse(captured!.init.body as string);
      expect(body.format).toBe("org.matrix.custom.html");
      expect(body.formatted_body).toBe(
        "🟢 <strong>twiki run — ENFORCE</strong><br />\n" +
          "<em>quiet &amp; &lt;ok&gt;</em><br />\n" +
          "<strong>bold</strong> line",
      );
      // plain-text fallback is untouched
      expect(body.body).toContain("*twiki run — ENFORCE*");
    } finally {
      globalThis.fetch = origFetch;
      const fs = await import("node:fs");
      fs.rmSync?.(".twiki-matrix-test-html", { force: true });
    }
  });

  it("linkifies bare URLs, keeping a trailing paren outside the link", async () => {
    let captured: { init: RequestInit } | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = { init };
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const notify = new MatrixNotifier(
        "https://matrix.example.org",
        "tok",
        "!abc:example.org",
        ".twiki-matrix-test-link",
      );
      await notify.send("  ↳ build (https://github.com/o/r/actions/runs/123)");

      const body = JSON.parse(captured!.init.body as string);
      expect(body.formatted_body).toBe(
        "  ↳ build (" +
          '<a href="https://github.com/o/r/actions/runs/123">' +
          "https://github.com/o/r/actions/runs/123</a>)",
      );
    } finally {
      globalThis.fetch = origFetch;
      const fs = await import("node:fs");
      fs.rmSync?.(".twiki-matrix-test-link", { force: true });
    }
  });

  it("keeps an escaped query string inside the linkified URL", async () => {
    let captured: { init: RequestInit } | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = { init };
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const notify = new MatrixNotifier(
        "https://matrix.example.org",
        "tok",
        "!abc:example.org",
        ".twiki-matrix-test-query",
      );
      await notify.send("see https://ci.example.org/log?run=1&job=2 now");

      const body = JSON.parse(captured!.init.body as string);
      expect(body.formatted_body).toBe(
        "see " +
          '<a href="https://ci.example.org/log?run=1&amp;job=2">' +
          "https://ci.example.org/log?run=1&amp;job=2</a> now",
      );
    } finally {
      globalThis.fetch = origFetch;
      const fs = await import("node:fs");
      fs.rmSync?.(".twiki-matrix-test-query", { force: true });
    }
  });

  it("leaves underscores inside a linkified URL out of the href", async () => {
    let captured: { init: RequestInit } | null = null;
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
      captured = { init };
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const notify = new MatrixNotifier(
        "https://matrix.example.org",
        "tok",
        "!abc:example.org",
        ".twiki-matrix-test-uscore",
      );
      await notify.send("log https://ci.example.org/badge_status_/foo done");

      const body = JSON.parse(captured!.init.body as string);
      // No <em> injected into the href; the URL round-trips intact.
      expect(body.formatted_body).toBe(
        "log " +
          '<a href="https://ci.example.org/badge_status_/foo">' +
          "https://ci.example.org/badge_status_/foo</a> done",
      );
    } finally {
      globalThis.fetch = origFetch;
      const fs = await import("node:fs");
      fs.rmSync?.(".twiki-matrix-test-uscore", { force: true });
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
