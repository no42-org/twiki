/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { randomUUID } from "node:crypto";
import { redact } from "../core/redact.js";
import type { Notifier } from "./port.js";

// The transports themselves. Webhook delivery emits a Slack incoming-webhook
// payload (Discord's webhook accepts the same shape via a thin adapter);
// Matrix delivery uses the Client-Server API directly.
//
// None of them de-duplicates: a transport sends every time it is called, and
// a caller that wants run-over-run de-duplication wraps it in
// DedupingNotifier. Nothing here reads or writes a file.
//
// With src/enrich, this is the non-GitHub HTTP in the system (AD-15).

export class WebhookTransport implements Notifier {
  constructor(
    private readonly webhookUrl: string,
    /** "slack" => {text}, "discord" => {content}. */
    private readonly flavor: "slack" | "discord" = "slack",
  ) {}

  async send(text: string): Promise<void> {
    const body = this.flavor === "discord" ? { content: text } : { text };
    const res = await fetch(this.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(
        `Webhook delivery failed: ${res.status} ${res.statusText}`,
      );
    }
  }
}

// Bare http(s) URL, terminating at whitespace, a closing paren, or an HTML
// entity boundary. By the time this runs every `&` has been escaped to `&amp;`,
// so query-string separators are matched explicitly (the `&amp;` alternative)
// to keep them inside the link, while a stray `&` still stops the match. The
// digest prints details links bare, e.g. `(https://…/runs/123)`, so the
// trailing `)` must stay outside the link.
const URL_RE = /https?:\/\/(?:&amp;|[^\s<)&])+/g;

/**
 * Converts the digest's Slack-style mrkdwn (`*bold*`, `_italic_`, bare URLs,
 * line breaks) to the HTML subset Matrix accepts in a `formatted_body`. Source
 * text is HTML-escaped first so that `<`, `>` and `&` in repo/PR titles survive
 * literally. Without this the raw `*`/`_` markers and plain URLs show up
 * verbatim in Matrix clients, since `m.text` carries no formatting.
 */
function mrkdwnToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  // Emphasis markers must be flanked by whitespace or a string edge (matching
  // Slack's mrkdwn rules). This keeps `*`/`_` inside a URL — e.g. an `…/_foo_/…`
  // path, already wrapped in an <a> by the pass above — from being mistaken for
  // emphasis and having tags injected into the href.
  return escaped
    .replace(URL_RE, (url) => `<a href="${url}">${url}</a>`)
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$)/g, "$1<strong>$2</strong>")
    .replace(/(^|\s)_([^_\n]+)_(?=\s|$)/g, "$1<em>$2</em>")
    .replace(/\n/g, "<br />\n");
}

/**
 * Posts a message to a Matrix room via the Client-Server API:
 * PUT /_matrix/client/v3/rooms/{roomId}/send/m.room.message/{txnId}, authed
 * with a Bearer access token. Sends `org.matrix.custom.html` so mrkdwn renders
 * as formatting, with the plain text kept in `body` as the fallback. A fresh
 * transaction ID is used per send.
 */
export class MatrixTransport implements Notifier {
  constructor(
    private readonly homeserver: string,
    private readonly accessToken: string,
    private readonly roomId: string,
  ) {}

  async send(text: string): Promise<void> {
    // `twiki-` is the product's namespace, not the write side's role name, and
    // the homeserver treats the whole value as opaque. Kept verbatim so the
    // request gitricorder sends and the request twiki already sends are the
    // same shape.
    const txnId = `twiki-${randomUUID()}`;
    const base = this.homeserver.replace(/\/+$/, "");
    const url =
      `${base}/_matrix/client/v3/rooms/${encodeURIComponent(this.roomId)}` +
      `/send/m.room.message/${encodeURIComponent(txnId)}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.accessToken}`,
      },
      body: JSON.stringify({
        msgtype: "m.text",
        body: text,
        format: "org.matrix.custom.html",
        formatted_body: mrkdwnToHtml(text),
      }),
    });
    if (!res.ok) {
      // The CS API returns a diagnostic {errcode, error} body — surfaced so an
      // auth or permission misconfiguration is debuggable.
      //
      // That body is not ours. A reverse proxy, or a homeserver that is not
      // Synapse, can echo the credential it rejected back into it, and this
      // error is thrown into a log line and into collection_run.detail. So the
      // token is removed by exact match, here, where its value is known — and
      // BEFORE the 500-character bound, because bounding first would keep the
      // leading half of a token that straddles the cut. A `syt_` pattern in
      // redact() would not do: `syt_` is Synapse's format, not a Matrix
      // guarantee.
      const body = await res.text().catch(() => "");
      const detail = redact(body, [this.accessToken]).slice(0, 500);
      throw new Error(
        `Matrix delivery failed: ${res.status} ${res.statusText}` +
          (detail ? ` — ${detail}` : ""),
      );
    }
  }
}

/** Transport that prints to stdout — used in shadow/local runs without a webhook. */
export class ConsoleTransport implements Notifier {
  async send(text: string): Promise<void> {
    console.log(text);
  }
}
