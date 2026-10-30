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
  LANE as ALERTS_LANE,
  normalise,
  summariseRepo,
} from "../../src/tricorder/collect/dependabot-alerts.js";
import { SqliteStore } from "../../src/tricorder/store/sqlite-store.js";
import { createApp } from "../../src/tricorder/web/app.js";
import { startServer } from "../../src/tricorder/web/server.js";
import { makeAlert } from "../fakes.js";

// What the unit suite cannot see: the components upgrade, and the real client
// script filters, sorts and rewrites the URL in a real Chromium.

const NOW = new Date("2026-09-08T12:00:00.000Z");
const AT = "2026-09-08T11:55:00.000Z";
const REPO = { owner: "no42-org", name: "twiki" };
const OTHER = { owner: "no42-org", name: "blitsbom" };

describe("the overview in Chromium", () => {
  let dir: string;
  let store: SqliteStore;
  let server: ReturnType<typeof startServer>;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "overview-browser-"));
    store = SqliteStore.openForWrite(join(dir, "b.db"));
    const twiki = [
      makeAlert({
        number: 9,
        repo: REPO,
        severity: "critical",
        createdAt: "2026-09-07T12:00:00.000Z",
      }),
      makeAlert({
        number: 42,
        repo: REPO,
        severity: "low",
        createdAt: "2026-07-01T12:00:00.000Z",
      }),
    ];
    const blitsbom = [
      makeAlert({
        number: 3,
        repo: OTHER,
        severity: "high",
        createdAt: "2026-09-01T12:00:00.000Z",
      }),
    ];
    const run = store.beginRun({
      lane: ALERTS_LANE,
      installation: "no42-org",
      scope: "full",
      startedAt: AT,
    });
    store.recordObservations(run, AT, [
      ...[...twiki, ...blitsbom].map(normalise),
      summariseRepo(REPO, twiki),
      summariseRepo(OTHER, blitsbom),
    ]);
    store.finishRun(run, "ok", AT);

    server = startServer(
      createApp({
        defaultBranchOf: () => "main",
        store,
        watched: [REPO, OTHER],
        policy: { cadenceMs: 15 * 60_000 },
        now: () => NOW,
      }),
      { port: 0, log: () => {} },
    );
    await new Promise((resolve) => server.once("listening", resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    browser = await chromium.launch();
  });

  afterAll(async () => {
    await browser?.close();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const open = async (path = "/"): Promise<Page> => {
    const page = await browser.newPage({
      viewport: { width: 1280, height: 800 },
    });
    await page.goto(`${base}${path}`);
    await page.waitForFunction(
      () => customElements.get("lcars-frame") !== undefined,
    );
    return page;
  };

  const ids = (page: Page) =>
    page.$$eval("#rows tr:not([hidden]) td.i", (cells) =>
      cells.map((c) => c.textContent),
    );
  const badges = (page: Page) =>
    page.$$eval("#filter-bar .chip", (chips) =>
      chips.map((c) => c.getAttribute("aria-label")),
    );

  it("upgrades the LCARS components and asks for nothing elsewhere", async () => {
    const page = await browser.newPage();
    const hosts = new Set<string>();
    page.on("request", (r) => hosts.add(new URL(r.url()).host));
    await page.goto(base);
    await page.waitForFunction(
      () => customElements.get("lcars-frame") !== undefined,
    );
    expect([...hosts]).toEqual([new URL(base).host]);
    expect(await page.$eval("lcars-frame", (f) => f.shadowRoot !== null)).toBe(
      true,
    );
    await page.close();
  });

  it("shows the name black on the gold corner", async () => {
    const page = await open();
    const color = await page.$eval(
      ".brand",
      (el) => getComputedStyle(el).color,
    );
    expect(color).toBe("rgb(0, 0, 0)");
    expect(await page.isVisible(".brand")).toBe(true);
    await page.close();
  });

  it("reads sentences in the system font, not condensed Antonio", async () => {
    const page = await open();
    const family = await page.$eval(
      "td.d",
      (el) => getComputedStyle(el).fontFamily,
    );
    expect(family).toContain("system-ui");
    await page.close();
  });

  it("paints a pressed box in its own color", async () => {
    const page = await open();
    await page.click('.tile[data-value="SECURITY"]');
    await page.mouse.move(0, 0);
    const paint = await page.$eval(
      '.tile[data-value="SECURITY"]',
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(paint).toBe("rgb(255, 85, 85)");
    await page.close();
  });

  it("centers pill and badge capitals by trimming to the cap height", async () => {
    const page = await open("/?severity=CRITICAL");
    const trim = await page.evaluate(() =>
      ["#rows .pill", ".chip .label"].map((selector) => {
        const style = getComputedStyle(
          document.querySelector(selector) as Element,
        );
        return style.getPropertyValue("text-box-trim");
      }),
    );
    expect(trim).toEqual(["trim-both", "trim-both"]);
    await page.close();
  });

  it("centers the drawn cross in its circle", async () => {
    const page = await open("/?severity=CRITICAL");
    const offset = await page.evaluate(() => {
      const middle = (selector: string) => {
        const r = (
          document.querySelector(selector) as Element
        ).getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      };
      const circle = middle(".chip .x");
      const cross = middle(".chip .x svg");
      return { x: circle.x - cross.x, y: circle.y - cross.y };
    });
    expect(offset).toEqual({ x: 0, y: 0 });
    await page.close();
  });

  it("lines the repository name up with its ID", async () => {
    const page = await open();
    const [repo, id] = await page.evaluate(() =>
      ["#rows .rb", "#rows .num"].map((selector) => {
        const r = (
          document.querySelector(selector) as Element
        ).getBoundingClientRect();
        return r.y + r.height / 2;
      }),
    );
    expect(repo).toBeCloseTo(id as number, 0);
    await page.close();
  });

  it("leaves room for a pill's hover ring inside the scrolling table", async () => {
    const page = await open();
    const room = await page.evaluate(() => {
      const wrap = document.querySelector(".table-wrap") as Element;
      const pill = document.querySelector("#rows .pill") as Element;
      return (
        pill.getBoundingClientRect().left - wrap.getBoundingClientRect().left
      );
    });
    expect(room).toBeGreaterThanOrEqual(4);
    await page.close();
  });

  it("keeps the boxes on screen at 400px, with the table scrolling inside itself", async () => {
    const page = await open();
    await page.setViewportSize({ width: 400, height: 800 });
    const reach = await page.evaluate(() =>
      [...document.querySelectorAll(".tile, .table-wrap")].map(
        (el) => el.getBoundingClientRect().right,
      ),
    );
    for (const right of reach) expect(right).toBeLessThanOrEqual(400);
    await page.close();
  });

  it("adds a filter by clicking, shows a badge, and writes the URL", async () => {
    const page = await open();
    await page.click('#rows button[data-value="CRITICAL"]');
    expect(await ids(page)).toEqual(["#9"]);
    expect(await badges(page)).toEqual(["Remove filter CRITICAL"]);
    expect(new URL(page.url()).search).toBe("?severity=CRITICAL");
    expect(await page.textContent("#filter-bar span")).toBe("1 ITEMS");
    await page.close();
  });

  it("narrows across facets and removes one badge at a time", async () => {
    const page = await open();
    await page.click('#rows button[data-facet="repo"][data-label="twiki"]');
    expect((await ids(page)).sort()).toEqual(["#42", "#9"]);
    await page.click('#rows button[data-value="CRITICAL"]');
    expect(await ids(page)).toEqual(["#9"]);
    expect(await badges(page)).toHaveLength(2);

    await page.click('[aria-label="Remove filter CRITICAL"]');
    expect((await ids(page)).sort()).toEqual(["#42", "#9"]);
    expect(await badges(page)).toEqual(["Remove filter twiki"]);
    await page.close();
  });

  it("clears everything with CLEAR FILTER, which shows only while it can act", async () => {
    const page = await open();
    expect(await page.$("#clear")).toBeNull();
    await page.click('.tile[data-value="SECURITY"]');
    await page.click('#rows button[data-value="HIGH"]');
    await page.click("#clear");
    expect(await ids(page)).toHaveLength(3);
    expect(await badges(page)).toEqual([]);
    expect(await page.$("#clear")).toBeNull();
    expect(new URL(page.url()).search).toBe("");
    await page.close();
  });

  it("leaves the box totals alone and marks the box pressed", async () => {
    const page = await open();
    await page.click('#rows button[data-value="CRITICAL"]');
    expect(await page.textContent('.tile[data-value="SECURITY"] .count')).toBe(
      "3",
    );
    await page.click('.tile[data-value="SECURITY"]');
    expect(
      await page.getAttribute('.tile[data-value="SECURITY"]', "aria-pressed"),
    ).toBe("true");
    await page.close();
  });

  it("says so when nothing matches, in place of an empty table", async () => {
    const page = await open(
      "/?kind=SECURITY&severity=CRITICAL&repo=no42-org/blitsbom",
    );
    expect(await ids(page)).toEqual([]);
    expect(await page.isVisible("#no-matches")).toBe(true);
    expect(await page.isVisible("#overview-table")).toBe(false);
    await page.close();
  });

  it("cycles a header through both directions and back", async () => {
    const page = await open();
    const start = await ids(page);
    await page.click('[data-sort="age"]');
    expect(await ids(page)).toEqual(["#42", "#3", "#9"]);
    expect(await page.getAttribute('th[data-col="age"]', "aria-sort")).toBe(
      "descending",
    );
    await page.click('[data-sort="age"]');
    expect(await ids(page)).toEqual(["#9", "#3", "#42"]);
    expect(await page.getAttribute('th[data-col="age"]', "aria-sort")).toBe(
      "ascending",
    );
    await page.click('[data-sort="age"]');
    expect(await ids(page)).toEqual(start);
    expect(
      await page.getAttribute('th[data-col="age"]', "aria-sort"),
    ).toBeNull();
    await page.close();
  });

  it("sorts severity by rank, not by the word", async () => {
    const page = await open();
    // Reversed, because descending is also the default order and would pass
    // with no sort at all.
    await page.click('[data-sort="severity"]');
    await page.click('[data-sort="severity"]');
    expect(await ids(page)).toEqual(["#42", "#3", "#9"]);
    await page.close();
  });

  it("sorts IDs as numbers", async () => {
    const page = await open();
    await page.click('[data-sort="id"]');
    expect(await ids(page)).toEqual(["#3", "#9", "#42"]);
    await page.close();
  });

  it("restores filters and sort from a bookmark, ignoring what it does not know", async () => {
    const page = await open(
      "/?severity=CRITICAL&severity=NOPE&sort=age&dir=desc",
    );
    expect(await ids(page)).toEqual(["#9"]);
    expect(await badges(page)).toEqual(["Remove filter CRITICAL"]);
    expect(new URL(page.url()).search).toBe(
      "?severity=CRITICAL&sort=age&dir=desc",
    );
    await page.close();
  });

  it("works from the keyboard", async () => {
    const page = await open();
    await page.focus('#rows button[data-value="CRITICAL"]');
    await page.keyboard.press("Enter");
    expect(await ids(page)).toEqual(["#9"]);
    await page.focus('[aria-label="Remove filter CRITICAL"]');
    await page.keyboard.press("Space");
    expect(await ids(page)).toHaveLength(3);
    await page.close();
  });

  it("shows the full table with scripts off", async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(base);
    expect((await page.content()).match(/<tr data-kind=/g)).toHaveLength(3);
    await context.close();
  });
});
