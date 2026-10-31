/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Browser, chromium, type Page } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MergeRequest, MergeResponse } from "../../src/core/merge.js";
import {
  LANE as ALERTS_LANE,
  normalise,
  summariseRepo,
} from "../../src/tricorder/collect/dependabot-alerts.js";
import { SqliteStore } from "../../src/tricorder/store/sqlite-store.js";
import { createApp } from "../../src/tricorder/web/app.js";
import { LCARS_COLORS } from "../../src/tricorder/web/lcars-tokens.js";
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
    page.$$eval("#filter-bar lcars-chip", (chips) =>
      chips.map((c) => c.getAttribute("remove-label")),
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

  it("serves an Antonio that leaves equal room above and below a capital", async () => {
    const page = await open();
    const size = 100;
    const [above, below] = await page.evaluate(async (px) => {
      const font = `${px}px Antonio`;
      const faces = await document.fonts.load(font);
      if (faces.length === 0) throw new Error("Antonio did not load");
      const context = document
        .createElement("canvas")
        .getContext("2d") as CanvasRenderingContext2D;
      context.font = font;
      const m = context.measureText("H");
      return [
        m.fontBoundingBoxAscent - m.actualBoundingBoxAscent,
        m.fontBoundingBoxDescent - m.actualBoundingBoxDescent,
      ];
    }, size);
    expect(Math.abs((above as number) - (below as number))).toBeLessThanOrEqual(
      0.04 * size,
    );
    await page.close();
  });

  it("paints severity solid before any filter is applied", async () => {
    const page = await open();
    const paint = await page.$eval(
      '#rows button[data-value="CRITICAL"]',
      (el) => getComputedStyle(el).backgroundColor,
    );
    expect(paint).toBe("rgb(255, 85, 85)");
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

  it("answers hover and press as lcars-button does, with no ring", async () => {
    const page = await open();
    const pill = '#rows button[data-value="CRITICAL"]';
    const style = () =>
      page.$eval(pill, (el) => {
        const s = getComputedStyle(el);
        return { filter: s.filter, shadow: s.boxShadow };
      });
    await page.hover(pill);
    expect(await style()).toEqual({
      filter: "brightness(1.2)",
      shadow: "none",
    });
    await page.click(pill);
    await page.mouse.move(0, 0);
    expect(
      await page.$eval(
        '#rows button[data-value="CRITICAL"]',
        (el) => getComputedStyle(el).filter,
      ),
    ).toBe("brightness(1.4)");
    await page.close();
  });

  it("takes hover and press from the library's tokens, not copied numbers", async () => {
    const page = await open();
    await page.addStyleTag({
      content: `:root {
        --lcars-hover-brightness: 1.5;
        --lcars-active-brightness: 1.6;
        --lcars-active-scale: 0.9;
      }`,
    });
    const pill = '#rows button[data-value="CRITICAL"]';
    const style = () =>
      page.$eval(pill, (el) => {
        const s = getComputedStyle(el);
        return { filter: s.filter, transform: s.transform };
      });
    await page.hover(pill);
    expect(await style()).toEqual({
      filter: "brightness(1.5)",
      transform: "none",
    });
    await page.click(pill);
    await page.mouse.move(0, 0);
    expect(await style()).toEqual({
      filter: "brightness(1.6)",
      transform: "matrix(0.9, 0, 0, 0.9, 0, 0)",
    });
    await page.close();
  });

  it("names the badge's body for what it does", async () => {
    const page = await open("/?severity=CRITICAL");
    expect(
      await page.$eval("#filter-bar lcars-chip", (chip) => chip.textContent),
    ).toBe("Remove filter CRITICAL");
    await page.close();
  });

  it("moves focus to the next badge when one is removed", async () => {
    const page = await open("/?severity=CRITICAL&severity=HIGH");
    await page.focus('[aria-label="Remove filter CRITICAL"]');
    await page.keyboard.press("Space");
    await page.waitForFunction(
      () => document.activeElement?.tagName === "LCARS-CHIP",
    );
    expect(
      await page.evaluate(
        () => (document.activeElement as HTMLElement).dataset.value,
      ),
    ).toBe("HIGH");
    await page.close();
  });

  it("listens for badge events only inside the filter bar", async () => {
    const page = await open();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.evaluate(() => {
      const chip = document.createElement("lcars-chip");
      document.body.append(chip);
      chip.click();
    });
    await page.waitForFunction(() => document.querySelector("lcars-chip"));
    expect(errors).toEqual([]);
    await page.close();
  });

  it("leaves room for a pill's focus outline inside the scrolling table", async () => {
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

  it("scrolls a long table inside the frame, not the page", async () => {
    const page = await open();
    await page.setViewportSize({ width: 1280, height: 700 });
    await page.evaluate(async () => {
      const body = document.getElementById("rows") as Element;
      const row = body.firstElementChild as Element;
      for (let i = 0; i < 60; i++) body.append(row.cloneNode(true));
      await new Promise(requestAnimationFrame);
    });
    const measure = () =>
      page.evaluate(() => {
        const root = document.documentElement;
        const main = document
          .querySelector("lcars-frame")
          ?.shadowRoot?.querySelector("main") as Element;
        const last = (
          document.getElementById("rows") as Element
        ).lastElementChild?.getBoundingClientRect() as DOMRect;
        return {
          spare: root.scrollHeight - root.clientHeight,
          overflowing: main.scrollHeight > main.clientHeight,
          rowHeight: last.height,
          below: last.bottom - main.getBoundingClientRect().bottom,
        };
      });
    const before = await measure();
    expect(before.spare).toBe(0);
    expect(before.overflowing).toBe(true);
    expect(before.below).toBeGreaterThan(0);

    await page.hover("#overview-table");
    await page.mouse.wheel(0, 100_000);
    await page.waitForFunction(() => {
      const rows = document.getElementById("rows") as Element;
      return (
        (rows.lastElementChild as Element).getBoundingClientRect().bottom < 700
      );
    });
    const after = await measure();
    expect(after.rowHeight).toBeGreaterThan(0);
    expect(after.below).toBeLessThanOrEqual(0);
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

  it("removes a filter from the badge's body as well as its cross", async () => {
    const page = await open("/?severity=CRITICAL&severity=HIGH");
    await page.$eval('#filter-bar lcars-chip[data-value="CRITICAL"]', (chip) =>
      (chip as HTMLElement).click(),
    );
    expect(await badges(page)).toEqual(["Remove filter HIGH"]);
    expect(new URL(page.url()).search).toBe("?severity=HIGH");
    await page.close();
  });

  it("keeps a repository's casing on its badge", async () => {
    const page = await open("/?repo=no42-org/twiki");
    const transform = await page.$eval(
      '#filter-bar lcars-chip[data-remove="repo"] span:not(.vh)',
      (el) => getComputedStyle(el).textTransform,
    );
    expect(transform).toBe("none");
    await page.close();
  });

  it("wraps a long repository name inside its badge at 400px", async () => {
    const page = await open("/?repo=no42-org/twiki");
    await page.setViewportSize({ width: 400, height: 800 });
    const [right, room] = await page.evaluate(() => {
      const chip = document.querySelector(
        '#filter-bar lcars-chip[data-remove="repo"]',
      ) as Element;
      (chip.lastElementChild as Element).textContent = "x".repeat(200);
      return [chip, chip.parentElement as Element].map(
        (el) => el.getBoundingClientRect().right,
      );
    });
    expect(right).toBeLessThanOrEqual(room as number);
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

const rgb = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) =>
    Number.parseInt(hex.slice(i, i + 2), 16),
  );
  return `rgb(${r}, ${g}, ${b})`;
};

// A second app, so the three-row table above keeps its expectations: this one
// runs enforce, with a pull request that can merge and one that cannot.
describe("merging from the overview in Chromium", () => {
  const ENABLED = '.merge[data-number="12"]';
  const DIMMED = '.merge[data-number="13"]';

  let dir: string;
  let store: SqliteStore;
  let server: ReturnType<typeof startServer>;
  let browser: Browser;
  let base: string;
  let requests: MergeRequest[];
  /** What the fake answers, once `hold` lets it. */
  let reply: MergeResponse;
  let hold: Promise<void>;

  const pull = (number: number, headRef: string) => ({
    subject: { type: "pull_request", key: `PR_${number}` },
    payload: {
      repo: "no42-org/twiki",
      number,
      title: `Change ${number}`,
      author: "a-contributor",
      htmlUrl: `https://github.com/no42-org/twiki/pull/${number}`,
      createdAt: "2026-09-08T00:00:00.000Z",
      headRef,
      isDraft: false,
      reviewDecision: null,
    },
  });
  const run = (runNumber: number, headBranch: string, conclusion: string) => ({
    subject: { type: "pull_request_workflow_run", key: `WFR_${runNumber}` },
    payload: {
      repo: "no42-org/twiki",
      workflowId: 1,
      workflowName: "CI",
      runNumber,
      status: "completed",
      conclusion,
      headBranch,
      event: "pull_request",
      htmlUrl: `https://github.com/no42-org/twiki/actions/runs/${runNumber}`,
      createdAt: "2026-09-08T10:00:00.000Z",
    },
  });
  const seed = (lane: string, observations: unknown[]) => {
    const id = store.beginRun({
      lane,
      installation: "no42-org",
      scope: "full",
      startedAt: AT,
    });
    store.recordObservations(id, AT, observations as never[]);
    store.finishRun(id, "ok", AT);
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "overview-merge-browser-"));
    store = SqliteStore.openForWrite(join(dir, "m.db"));
    const alerts = [makeAlert({ number: 9, repo: REPO, severity: "high" })];
    seed(ALERTS_LANE, [...alerts.map(normalise), summariseRepo(REPO, alerts)]);
    seed("graphql-pull-requests", [pull(12, "green"), pull(13, "red")]);
    seed("rest-actions-runs", [
      run(1, "green", "success"),
      run(2, "red", "failure"),
    ]);

    server = startServer(
      createApp({
        defaultBranchOf: () => "main",
        store,
        watched: [REPO],
        policy: { cadenceMs: 15 * 60_000 },
        mode: "enforce",
        requestMerge: async (request) => {
          requests.push(request);
          await hold;
          return reply;
        },
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

  beforeEach(() => {
    requests = [];
    reply = { outcome: "merged" };
    hold = Promise.resolve();
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
  const stateOf = (page: Page, number: number) =>
    page.$eval(`tr[data-id="#${number}"]`, (tr) => {
      const pill = tr.querySelector('[data-facet="state"]') as HTMLElement;
      return {
        row: (tr as HTMLElement).dataset.state,
        text: pill.textContent,
        value: pill.dataset.value,
        label: pill.getAttribute("aria-label"),
      };
    });
  const icon = (page: Page, selector: string) =>
    page.$eval(selector, (el) => ({
      disabled: el.getAttribute("aria-disabled"),
      title: el.getAttribute("title"),
      label: el.getAttribute("aria-label"),
    }));

  it("paints an enabled icon green and a dimmed one muted", async () => {
    const page = await open();
    const color = (selector: string) =>
      page.$eval(selector, (el) => getComputedStyle(el).color);
    expect(await color(ENABLED)).toBe(rgb(LCARS_COLORS.go));
    expect(await color(DIMMED)).toBe(rgb(LCARS_COLORS.muted));
    await page.close();
  });

  it("paints a READY pill in the icon's green under black ink", async () => {
    const page = await open();
    expect(
      await page.$eval('tr[data-id="#12"] [data-facet="state"]', (el) => {
        const s = getComputedStyle(el);
        return [s.backgroundColor, s.color];
      }),
    ).toEqual([rgb(LCARS_COLORS.go), rgb(LCARS_COLORS.ink)]);
    await page.close();
  });

  it("leaves a dimmed icon reachable by keyboard", async () => {
    const page = await open();
    expect(
      await page.$eval(DIMMED, (el) => "disabled" in el && el.disabled),
    ).toBe(false);
    await page.focus(DIMMED);
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute("title")),
    ).toBe("CI failed");
    await page.close();
  });

  it("sends one POST with the repository and number on a merge click", async () => {
    const page = await open();
    await page.click(ENABLED);
    await page.waitForSelector(ENABLED, { state: "detached" });
    expect(requests).toEqual([{ repo: "no42-org/twiki", number: 12 }]);
    await page.close();
  });

  it("ignores a merge double-click while the first is in flight", async () => {
    let release = () => {};
    hold = new Promise((resolve) => {
      release = resolve;
    });
    const page = await open();
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST") posts.push(r.url());
    });
    await page.dblclick(ENABLED);
    await page.waitForFunction(
      (selector) =>
        document.querySelector(selector)?.getAttribute("aria-busy") === "true",
      ENABLED,
    );
    release();
    await page.waitForSelector(ENABLED, { state: "detached" });
    expect(posts).toEqual([`${base}/merge`]);
    expect(requests).toHaveLength(1);
    await page.close();
  });

  it.each<MergeResponse>([
    { outcome: "merged" },
    { outcome: "already-merged" },
  ])(
    "turns the row to MERGED on $outcome and keeps its What",
    async (answer) => {
      reply = answer;
      const page = await open();
      const what = await page.textContent('tr[data-id="#12"] td.d');
      await page.click(ENABLED);
      await page.waitForSelector(ENABLED, { state: "detached" });
      expect(await stateOf(page, 12)).toEqual({
        row: "MERGED",
        text: "MERGED",
        value: "MERGED",
        label: "Filter by state MERGED",
      });
      expect(await page.textContent('tr[data-id="#12"] td.d')).toBe(what);
      expect(what).toBe("Change 12. Checks passed.");
      await page.close();
    },
  );

  const announcement = (page: Page) =>
    page.$eval("#merge-status", (region) => ({
      live: region.getAttribute("aria-live"),
      text: region.textContent,
      width: region.getBoundingClientRect().width,
    }));

  it("announces a merge in the polite live region", async () => {
    const page = await open();
    expect(await announcement(page)).toEqual({
      live: "polite",
      text: "",
      width: 1,
    });
    await page.click(ENABLED);
    await page.waitForSelector(ENABLED, { state: "detached" });
    expect(await announcement(page)).toEqual({
      live: "polite",
      text: "no42-org/twiki#12 merged",
      width: 1,
    });
    await page.close();
  });

  it("announces a refusal with twiki's reason in the live region", async () => {
    reply = { outcome: "refused", refusal: "head-changed" };
    const page = await open();
    await page.click(ENABLED);
    await page.waitForSelector(`${ENABLED}[aria-disabled="true"]`);
    expect(await announcement(page)).toEqual({
      live: "polite",
      text: "Cannot merge no42-org/twiki#12: New commits pushed",
      width: 1,
    });
    await page.close();
  });

  it("gives keyboard focus to the ID when a merge removes the icon", async () => {
    const page = await open();
    await page.focus(ENABLED);
    await page.keyboard.press("Enter");
    await page.waitForSelector(ENABLED, { state: "detached" });
    expect(await page.evaluate(() => document.activeElement?.textContent)).toBe(
      "#12",
    );
    await page.close();
  });

  it("keeps an applied STATE filter true when a row merges", async () => {
    const page = await open("/?state=READY");
    await page.click(ENABLED);
    await page.waitForSelector(ENABLED, { state: "detached" });
    expect(await page.isVisible("#no-matches")).toBe(true);
    await page.close();
  });

  it("dims the icon with twiki's reason on a refusal", async () => {
    reply = { outcome: "refused", refusal: "head-changed" };
    const page = await open();
    await page.click(ENABLED);
    await page.waitForSelector(`${ENABLED}[aria-disabled="true"]`);
    expect(await icon(page, ENABLED)).toEqual({
      disabled: "true",
      title: "New commits pushed",
      label: "Cannot merge #12: New commits pushed",
    });
    expect(await stateOf(page, 12)).toMatchObject({ row: "READY" });

    // Forced, because Playwright will not click what aria-disabled marks.
    await page.click(ENABLED, { force: true });
    await page.evaluate(() => fetch("/healthz"));
    expect(requests).toHaveLength(1);
    await page.close();
  });

  it("reads a bare 403 as the loopback limit", async () => {
    const page = await open();
    await page.route("**/merge", (route) =>
      route.fulfill({
        status: 403,
        contentType: "text/plain",
        body: "Forbidden",
      }),
    );
    await page.click(ENABLED);
    await page.waitForSelector(`${ENABLED}[aria-disabled="true"]`);
    expect(await icon(page, ENABLED)).toEqual({
      disabled: "true",
      title: "Merging is limited to this machine",
      label: "Cannot merge #12: Merging is limited to this machine",
    });
    await page.close();
  });

  it("reads a failed request as twiki being out of reach", async () => {
    const page = await open();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.route("**/merge", (route) => route.abort());
    await page.click(ENABLED);
    await page.waitForSelector(`${ENABLED}[aria-disabled="true"]`);
    expect(await icon(page, ENABLED)).toEqual({
      disabled: "true",
      title: "twiki is not reachable",
      label: "Cannot merge #12: twiki is not reachable",
    });
    expect(errors).toEqual([]);
    await page.close();
  });

  it("sends nothing for a merge click on a dimmed icon", async () => {
    const page = await open();
    const posts: string[] = [];
    page.on("request", (r) => {
      if (r.method() === "POST") posts.push(r.url());
    });
    await page.click(DIMMED, { force: true });
    // Round-trips the page, so a stray fetch would have left by now.
    await page.evaluate(() => fetch("/healthz"));
    expect(posts).toEqual([]);
    expect(requests).toEqual([]);
    await page.close();
  });

  it("adds no filter or sort on a merge click", async () => {
    const page = await open();
    await page.click(ENABLED);
    await page.waitForSelector(ENABLED, { state: "detached" });
    expect(new URL(page.url()).search).toBe("");
    expect(await page.$$("#filter-bar lcars-chip")).toEqual([]);
    expect(await page.$$("th[aria-sort]")).toEqual([]);
    await page.close();
  });

  it("keeps the ID's text and its numeric sort", async () => {
    const page = await open();
    await page.click('[data-sort="id"]');
    expect(
      await page.$$eval("#rows tr td.i", (cells) =>
        cells.map((c) => c.textContent),
      ),
    ).toEqual(["#9", "#12", "#13"]);
    await page.close();
  });

  it("lines the icon up with its ID", async () => {
    const page = await open();
    const [merge, id] = await page.evaluate(() =>
      ['tr[data-id="#12"] .merge', 'tr[data-id="#12"] .num'].map((selector) => {
        const r = (
          document.querySelector(selector) as Element
        ).getBoundingClientRect();
        return r.y + r.height / 2;
      }),
    );
    expect(merge).toBeCloseTo(id as number, 0);
    await page.close();
  });

  it("starts every ID in the column at one x, icon or not", async () => {
    const page = await open();
    const lefts = await page.$$eval("#rows .num", (ids) =>
      ids.map((el) => el.getBoundingClientRect().left),
    );
    expect(new Set(lefts).size).toBe(1);
    await page.close();
  });

  it("keeps the page from scrolling sideways at 400px", async () => {
    const page = await open();
    await page.setViewportSize({ width: 400, height: 800 });
    const [scroll, client] = await page.evaluate(() => [
      document.documentElement.scrollWidth,
      document.documentElement.clientWidth,
    ]);
    expect(scroll).toBeLessThanOrEqual(client as number);
    await page.close();
  });

  it("renders every row with scripts off", async () => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();
    await page.goto(base);
    expect((await page.content()).match(/<tr data-kind=/g)).toHaveLength(3);
    await context.close();
  });
});
