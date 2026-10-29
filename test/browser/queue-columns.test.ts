/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LANE as ISSUES_LANE,
  normaliseIssue,
} from "../../src/tricorder/collect/issues.js";
import { SqliteStore } from "../../src/tricorder/store/sqlite-store.js";
import { createApp } from "../../src/tricorder/web/app.js";
import { startServer } from "../../src/tricorder/web/server.js";
import { makeRawIssue } from "../fakes.js";

// #201: on a wide screen the queue wrapped the rank one digit per line, the
// topic one letter per line and the freshness badge into a tall pill.
// `overflow-wrap: anywhere` on body lowers every cell's min-content width to
// one character, so a single long title took the width from every short
// column. A queue of short titles never showed it, which is why the seed here
// carries one very long title beside more than a hundred items.

const REPO = { owner: "no42-org", name: "twiki" };
const SLUGGY = { owner: "labmonkeys-space", name: "prometheus-remote-writer" };
// GitHub's longest allowed repository name, with nowhere to break: the slug
// segments are held whole, and this is what holds them to a cap.
const HUGE = { owner: "no42-org", name: "x".repeat(100) };
const LONG_TITLE =
  "chore(deps): bump the production group across 1 directory with 14 updates ".repeat(
    8,
  );
const NOW = new Date("2026-09-08T12:00:00.000Z");
const AT = "2026-09-08T11:55:00.000Z";

const NARROW = { width: 640, height: 1024 };
const TABLET = { width: 800, height: 1024 };
const DESKTOP = { width: 1280, height: 800 };
const SMALL_DESKTOP = { width: 1024, height: 800 };

describe("queue columns (#201)", () => {
  let dir: string;
  let store: SqliteStore;
  let server: ReturnType<typeof startServer>;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "queue-cols-"));
    store = SqliteStore.openForWrite(join(dir, "q.db"));
    const run = store.beginRun({
      lane: ISSUES_LANE,
      installation: "no42-org",
      scope: "full",
      startedAt: AT,
    });
    const issues = Array.from({ length: 110 }, (_, i) =>
      makeRawIssue({ number: i + 1, repo: REPO, title: `Issue ${i + 1}` }),
    );
    issues.push(
      makeRawIssue({ number: 500, repo: REPO, title: LONG_TITLE }),
      makeRawIssue({ number: 7, repo: SLUGGY, title: "Batch remote writes" }),
      makeRawIssue({ number: 8, repo: HUGE, title: "Too long a name" }),
    );
    store.recordObservations(run, AT, issues.map(normaliseIssue));
    store.finishRun(run, "ok", AT);

    server = startServer(
      createApp({
        defaultBranchOf: () => "main",
        store,
        watched: [REPO, SLUGGY, HUGE],
        policy: { cadenceMs: 15 * 60_000 },
        now: () => NOW,
      }),
      { port: 0 },
    );
    await new Promise((resolve, reject) => {
      server.once("listening", resolve);
      server.once("error", reject);
    });
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    server?.close();
    store?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const open = async (viewport: {
    width: number;
    height: number;
  }): Promise<Page> => {
    const page = await browser.newPage({ viewport });
    const res = await page.goto(`${base}/queue`);
    expect(res?.status()).toBe(200);
    return page;
  };

  /**
   * Every short cell in the queue table that renders on more than one line,
   * as `selector: text (lines)`. Lines are counted from the painted glyphs,
   * one Range per character, so a cell's height or padding cannot pass for a
   * second line. The visually hidden card labels are skipped: they are
   * clipped to one pixel and paint nothing.
   */
  const wrapped = (page: Page) =>
    page.evaluate(() => {
      const lines = (el: Element): string[] => {
        const rows = new Map<number, string>();
        const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n !== null; n = walk.nextNode()) {
          if (n.parentElement?.closest(".lbl")) continue;
          const text = n.textContent ?? "";
          for (let i = 0; i < text.length; i++) {
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + 1);
            const rect = r.getClientRects()[0];
            if (!rect || rect.width === 0) continue;
            const top = Math.round(rect.top);
            const key = [...rows.keys()].find((t) => Math.abs(t - top) <= 2);
            const at = key ?? top;
            rows.set(at, (rows.get(at) ?? "") + text[i]);
          }
        }
        return [...rows.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
      };
      const out: string[] = [];
      const table = document.querySelector("#list table") as Element;
      for (const sel of ["td.num", "td.topic", ".badge"]) {
        for (const el of table.querySelectorAll(sel)) {
          const l = lines(el);
          if (l.length > 1) out.push(`${sel}: ${l.join(" | ")}`);
        }
      }
      // Headers on one line on a desktop; below that they may wrap, but only
      // between words, never inside one.
      const desktop = window.innerWidth >= 1024;
      for (const el of table.querySelectorAll("th")) {
        const l = lines(el);
        const words = (el.textContent ?? "").split(" ");
        const whole = l.every((line) =>
          line
            .trim()
            .split(" ")
            .every((w) => words.includes(w)),
        );
        if (desktop ? l.length > 1 : !whole) {
          out.push(`th: ${l.join(" | ")}`);
        }
      }
      const slug = [...table.querySelectorAll(".slug")].find(
        (s) => s.textContent === "labmonkeys-space/prometheus-remote-writer",
      ) as Element;
      // Header and first-row left edges per column, for the alignment
      // complaint in #201 that the reported slice could not show.
      const left = (el: Element) => el.getBoundingClientRect().left;
      const misaligned = [...table.querySelectorAll("thead th")].filter(
        (th, i) =>
          Math.abs(
            left(th) -
              left(
                table.querySelectorAll("tbody tr:first-child td")[i] as Element,
              ),
          ) > 1,
      ).length;
      return { cells: out, slug: lines(slug), misaligned };
    });

  it.each([DESKTOP, TABLET, NARROW])(
    "at $width px no rank, topic or badge wraps, and no header breaks badly",
    async (viewport) => {
      const page = await open(viewport);
      const r = await wrapped(page);
      expect(r.cells).toEqual([]);
      expect(r.misaligned).toBe(0);
      await page.close();
    },
  );

  it("at 1280px breaks a long slug only after its slash", async () => {
    const page = await open(DESKTOP);
    const { slug } = await wrapped(page);
    // Whole on one line, or broken exactly once at the slash.
    expect([
      ["labmonkeys-space/prometheus-remote-writer"],
      ["labmonkeys-space/", "prometheus-remote-writer"],
    ]).toContainEqual(slug);
    await page.close();
  });

  it.each([SMALL_DESKTOP, DESKTOP, TABLET, NARROW])(
    "at $width px a 100-character repository name does not scroll the page sideways",
    async (viewport) => {
      const page = await open(viewport);
      const reach = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth,
      );
      expect(reach).toBeLessThanOrEqual(0);
      await page.close();
    },
  );

  it("copies the slug as exactly owner/name", async () => {
    const page = await open(DESKTOP);
    const text = await page.evaluate(() =>
      [...document.querySelectorAll("#list .slug")].map((s) => s.textContent),
    );
    expect(text).toContain("labmonkeys-space/prometheus-remote-writer");
    await page.close();
  });
});
