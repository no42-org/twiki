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
import {
  LANE as ISSUES_LANE,
  normaliseIssue,
} from "../../src/tricorder/collect/issues.js";
import {
  normaliseReviewRequest,
  REVIEWS_INSTALLATION,
  LANE as REVIEWS_LANE,
} from "../../src/tricorder/collect/review-requests.js";
import { LANE as UPDATE_PRS_LANE } from "../../src/tricorder/collect/update-prs.js";
import { SqliteStore } from "../../src/tricorder/store/sqlite-store.js";
import { createApp } from "../../src/tricorder/web/app.js";
import { startServer } from "../../src/tricorder/web/server.js";
import { makeAlert, makeRawIssue, makeReviewRequest } from "../fakes.js";

// Story 1.9 (#131): the one thing the unit suite cannot see. A real Chromium
// renders each page at phone and desktop width, and the body must never
// scroll sideways (NFR1). The store is seeded so every page has a table
// with the states a phone card has to fit: a count with a severity, a
// plain count, an overdue review, a lane that failed, and the topics no
// collector serves yet. The tablet width is checked too, since that is the
// one layout with a cell of its own.

const REPO = { owner: "no42-org", name: "twiki" };
// Nothing in the seed may be short enough to fit by luck: a slug, a title
// token and a package name each wider than 320px, so a card that does not
// break them scrolls the body sideways and the assertions below say so.
const LONG = {
  owner: "no42-org",
  name: "observabilityplatformintegrationtestingharness",
};
const LONG_TITLE =
  "Crash in ConnectionPoolExhaustionRecoveryCoordinatorFactoryBuilder on startup";
const LONG_PACKAGE =
  "@no42-org/observabilityplatformintegrationtestingharnesscore";
const NOW = new Date("2026-09-08T12:00:00.000Z");
const AT = "2026-09-08T11:55:00.000Z";
const POLICY = { cadenceMs: 15 * 60_000 };

const PAGES = ["/", "/queue", "/repo/no42-org/twiki", "/reviews"] as const;
const PHONE = { width: 320, height: 640 };
const TABLET = { width: 800, height: 1024 };
const DESKTOP = { width: 1280, height: 800 };

describe("rendered in Chromium (Story 1.9, #131)", () => {
  let dir: string;
  let store: SqliteStore;
  let server: ReturnType<typeof startServer>;
  let browser: Browser;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "browser-"));
    store = SqliteStore.openForWrite(join(dir, "b.db"));
    const run = (lane: string, installation: string) =>
      store.beginRun({ lane, installation, scope: "full", startedAt: AT });

    const alerts = [
      makeAlert({
        number: 1,
        repo: REPO,
        severity: "high",
        epssPercentage: 0.02,
        packageName: LONG_PACKAGE,
      }),
    ];
    const longAlerts = [
      makeAlert({
        number: 4,
        repo: LONG,
        severity: "high",
        epssPercentage: 0.02,
      }),
    ];
    const swept = run(ALERTS_LANE, "no42-org");
    store.recordObservations(swept, AT, [
      ...alerts.map(normalise),
      summariseRepo(REPO, alerts),
      ...longAlerts.map(normalise),
      summariseRepo(LONG, longAlerts),
    ]);
    store.finishRun(swept, "ok", AT);

    const issues = run(ISSUES_LANE, "no42-org");
    store.recordObservations(issues, AT, [
      normaliseIssue(
        makeRawIssue({ number: 2, repo: REPO, title: LONG_TITLE }),
      ),
    ]);
    store.finishRun(issues, "ok", AT);

    const reviews = run(REVIEWS_LANE, REVIEWS_INSTALLATION);
    store.recordObservations(reviews, AT, [
      normaliseReviewRequest(
        makeReviewRequest({
          number: 3,
          repo: REPO,
          createdAt: "2026-09-01T12:00:00.000Z",
        }),
      ),
    ]);
    store.finishRun(reviews, "ok", AT);

    store.finishRun(run(UPDATE_PRS_LANE, "no42-org"), "failed", AT, "HTTP 502");

    server = startServer(
      createApp({
        defaultBranchOf: () => "main",
        store,
        watched: [REPO, LONG],
        policy: POLICY,
        now: () => NOW,
      }),
      { port: 0 },
    );
    // A bind failure is an `error`, never `listening`; waiting on the one
    // alone would time the hook out instead of naming the cause.
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

  const open = async (
    path: string,
    viewport: { width: number; height: number },
  ): Promise<Page> => {
    const page = await browser.newPage({ viewport });
    const res = await page.goto(base + path);
    expect(res?.status(), path).toBe(200);
    return page;
  };

  /** How far the page reaches past its own width: zero when it does not. */
  const overflow = (page: Page) =>
    page.evaluate(() => ({
      body: document.body.scrollWidth - document.body.clientWidth,
      root: document.documentElement.scrollWidth - window.innerWidth,
    }));

  describe.each([PHONE, TABLET, DESKTOP])("at $width px", (viewport) => {
    it.each(PAGES)("%s does not scroll sideways", async (path) => {
      const page = await open(path, viewport);
      const reach = await overflow(page);
      expect(reach.body).toBe(0);
      expect(reach.root).toBeLessThanOrEqual(0);
      await page.close();
    });
  });

  /** The board's layout facts at one width, from computed style. */
  const board = (page: Page) =>
    page.evaluate(() => {
      const display = (selector: string) =>
        getComputedStyle(document.querySelector(selector) as Element).display;
      const tbody = document.querySelector("table.board tbody") as Element;
      return {
        tileColumns: getComputedStyle(
          document.querySelector("nav.tiles") as Element,
        ).gridTemplateColumns.split(" ").length,
        tbodyOverflow: tbody.scrollWidth - tbody.clientWidth,
        signals: display("td.signals"),
        chips: display("td.c"),
        rest: display(".signals-rest"),
        // Visually hidden, not display: none: the roles stay in the tree.
        theadHidden: display("table.board thead") === "none",
        theadPosition: getComputedStyle(
          document.querySelector("table.board thead") as Element,
        ).position,
        // The header word painted on the card, off beside a real header.
        label: display("table.board td.c .lbl"),
      };
    });

  it("at 320px wraps the tiles into two columns and stacks the board into cards", async () => {
    const page = await open("/", PHONE);
    expect(await board(page)).toEqual({
      tileColumns: 2,
      tbodyOverflow: 0,
      signals: "none",
      chips: "block",
      rest: "none",
      theadHidden: false,
      theadPosition: "absolute",
      label: "inline",
    });
    await page.close();
  });

  it("at 800px shows one signals cell in place of the six chip columns, and three tile columns", async () => {
    const page = await open("/", TABLET);
    expect(await board(page)).toEqual({
      tileColumns: 3,
      tbodyOverflow: 0,
      signals: "table-cell",
      chips: "none",
      rest: "inline",
      theadHidden: false,
      theadPosition: "static",
      label: "none",
    });
    expect(await overflow(page)).toEqual({ body: 0, root: 0 });
    await page.close();
  });

  it("at 1280px shows the six chip columns and no signals cell", async () => {
    const page = await open("/", DESKTOP);
    expect(await board(page)).toEqual({
      tileColumns: 6,
      tbodyOverflow: 0,
      signals: "none",
      chips: "table-cell",
      rest: "none",
      theadHidden: false,
      theadPosition: "static",
      label: "none",
    });
    await page.close();
  });
});
