/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Chat delivery behind a small interface. Webhook delivery emits a Slack
// incoming-webhook payload (Discord's webhook accepts the same shape via a thin
// adapter); Matrix delivery uses the Client-Server API directly. Minimal
// de-duplication skips re-posting an identical digest run-over-run.

export interface Notifier {
  send(text: string): Promise<void>;
}

const DEFAULT_DEDUPE_PATH = ".twiki-last-digest";

/**
 * Base notifier that handles run-over-run de-duplication and delegates the
 * actual transport to {@link deliver}.
 */
abstract class DedupingNotifier implements Notifier {
  constructor(
    /** Path used to remember the last digest for de-duplication. */
    protected readonly dedupePath = DEFAULT_DEDUPE_PATH,
  ) {}

  async send(text: string): Promise<void> {
    const hash = createHash("sha256").update(text).digest("hex");
    if (this.lastHash() === hash) return; // unchanged since last run — skip
    await this.deliver(text);
    this.rememberHash(hash);
  }

  /** Transport-specific delivery; must throw on a non-success response. */
  protected abstract deliver(text: string): Promise<void>;

  private lastHash(): string | null {
    try {
      return readFileSync(this.dedupePath, "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  private rememberHash(hash: string): void {
    try {
      writeFileSync(this.dedupePath, hash);
    } catch {
      // De-dup is best-effort; a write failure must not break delivery.
    }
  }
}

export class WebhookNotifier extends DedupingNotifier {
  constructor(
    private readonly webhookUrl: string,
    /** "slack" => {text}, "discord" => {content}. */
    private readonly flavor: "slack" | "discord" = "slack",
    dedupePath = `${DEFAULT_DEDUPE_PATH}.${flavor}`,
  ) {
    super(dedupePath);
  }

  protected async deliver(text: string): Promise<void> {
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
 * with a Bearer access token. Sends `org.matrix.custom.html` so the digest's
 * mrkdwn renders as formatting, with the plain text kept in `body` as the
 * fallback. A fresh transaction ID is used per send; de-duplication of
 * identical digests is the base class's job.
 */
export class MatrixNotifier extends DedupingNotifier {
  constructor(
    private readonly homeserver: string,
    private readonly accessToken: string,
    private readonly roomId: string,
    dedupePath = `${DEFAULT_DEDUPE_PATH}.matrix`,
  ) {
    super(dedupePath);
  }

  protected async deliver(text: string): Promise<void> {
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
      // The CS API returns a diagnostic {errcode, error} body — surface it so
      // auth/permission misconfig is debuggable.
      const detail = (await res.text().catch(() => "")).slice(0, 500);
      throw new Error(
        `Matrix delivery failed: ${res.status} ${res.statusText}` +
          (detail ? ` — ${detail}` : ""),
      );
    }
  }
}

/** Notifier that prints to stdout — used in shadow/local runs without a webhook. */
export class ConsoleNotifier implements Notifier {
  async send(text: string): Promise<void> {
    console.log(text);
  }
}
