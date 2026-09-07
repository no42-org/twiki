/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RANK_POLICY } from "../src/core/rank.js";
import { normalise } from "../src/tricorder/collect/dependabot-alerts.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { createApp } from "../src/tricorder/web/app.js";
import { ExternalLink } from "../src/tricorder/web/components.js";
import { safeUrl } from "../src/tricorder/web/safe-url.js";
import { makeAlert } from "./fakes.js";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const REPO = { owner: "no42-org", name: "twiki" };
const HREF = "https://github.com/no42-org/twiki/security/dependabot/7";

// The whole anchor, not one attribute of it: a missing rel or a dropped
// suffix is exactly the regression a single toContain('target') would miss.
const ANCHOR =
  '<a href="https://github.com/no42-org/twiki/security/dependabot/7" target="_blank" rel="noopener noreferrer">no42-org/twiki#7<span class="ext" aria-hidden="true"> ↗</span><span class="sr-only">, opens GitHub in a new tab</span></a>';

describe("ExternalLink (AD-40)", () => {
  it("renders the full outbound anchor", () => {
    const html = (
      <ExternalLink href={HREF}>no42-org/twiki#7</ExternalLink>
    ).toString();
    expect(html).toBe(ANCHOR);
  });

  it("joins the glyph to the text with a narrow no-break space", () => {
    // U+202F does not break, so the last word and the glyph stay together
    // without a wrapper; the marker is hidden from assistive tech and the
    // spoken suffix carries the meaning instead.
    const html = (<ExternalLink href={HREF}>x</ExternalLink>).toString();
    expect(html).toContain('>x<span class="ext" aria-hidden="true"> ↗</span>');
    expect(html).not.toContain(" ↗");
  });
});

describe("safeUrl", () => {
  it("keeps https and drops everything else", () => {
    expect(safeUrl(HREF)).toBe(HREF);
    expect(safeUrl("http://github.com/x")).toBeNull();
    expect(safeUrl("https://example.com/x")).toBeNull();
    expect(safeUrl("https://github.com.evil.example/x")).toBeNull();
    expect(safeUrl("javascript:alert(1)")).toBeNull();
    expect(safeUrl(null)).toBeNull();
    expect(safeUrl(undefined)).toBeNull();
  });
});

describe("every page's outbound links", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "extlink-"));
    store = SqliteStore.openForWrite(join(dir, "e.db"));
    const run = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-17T11:55:00.000Z",
    });
    store.recordObservations(run, "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number: 7, htmlUrl: HREF })),
      normalise(makeAlert({ number: 8, htmlUrl: "javascript:alert(1)" })),
    ]);
    const reviews = store.beginRun({
      lane: "graphql-review-requests",
      installation: "reviews",
      scope: "full",
      startedAt: "2026-08-17T11:56:00.000Z",
    });
    store.recordObservations(reviews, "2026-08-17T11:56:00.000Z", [
      {
        subject: { type: "review_request", key: "RR_1" },
        payload: {
          repo: "no42-org/twiki",
          number: 9,
          title: "Wire the thing",
          author: "someone-else",
          htmlUrl: "https://github.com/no42-org/twiki/pull/9",
          createdAt: "2026-08-16T09:00:00Z",
          requestedReviewers: ["indigo423"],
        },
      },
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const render = async (path: string): Promise<string> => {
    const app = createApp({
      store,
      watched: [REPO],
      policy: { cadenceMs: 15 * 60_000 },
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });
    const res = await app.request(path);
    expect(res.status).toBe(200);
    return res.text();
  };

  // Minimum outbound anchors per page, so the https branch of the loop is
  // known to have run: the queue row, the alert plus the review request on
  // the repo page, the review row on /reviews. The overview links inward only.
  it.each([
    ["/", 0],
    ["/queue", 1],
    ["/repo/no42-org/twiki", 2],
    ["/reviews", 1],
  ] as const)(
    "%s: https anchors open a new tab, internal ones do not, javascript: never renders",
    async (path, outbound) => {
      const html = await render(path);
      const anchors = [...html.matchAll(/<a [^>]*>/g)].map((m) => m[0]);
      expect(anchors.length).toBeGreaterThan(0);
      expect(
        anchors.filter((a) => a.includes('target="_blank"')).length,
      ).toBeGreaterThanOrEqual(outbound);
      for (const a of anchors) {
        if (a.includes('href="https://')) {
          expect(a).toContain('target="_blank"');
          expect(a).toContain('rel="noopener noreferrer"');
        } else {
          expect(a).not.toContain("target=");
          expect(a).not.toContain("rel=");
        }
      }
      expect(html).not.toContain("javascript:");
    },
  );

  it("renders the queue row's link as the whole anchor and the unsafe one as text", async () => {
    const html = await render("/queue");
    expect(html).toContain(ANCHOR);
    expect(html).toContain("no42-org/twiki#8");
    expect(html).not.toMatch(/<a [^>]*>no42-org\/twiki#8/);
  });
});
