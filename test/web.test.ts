/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coverageSubject } from "../src/core/subject.js";
import {
  ageLabel,
  DEFAULT_STALE_AFTER_CADENCES,
  freshness,
} from "../src/tricorder/attention/freshness.js";
import { buildCollectionHealth } from "../src/tricorder/attention/health.js";
import {
  normalise,
  summariseRepo,
} from "../src/tricorder/collect/dependabot-alerts.js";
import { normaliseReviewRequest } from "../src/tricorder/collect/review-requests.js";
import { normalisePr } from "../src/tricorder/collect/update-prs.js";
import type { RunRef } from "../src/tricorder/store/port.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { createApp } from "../src/tricorder/web/app.js";
import { DEFAULT_HOST, startServer } from "../src/tricorder/web/server.js";
import { parsePort } from "../src/tricorder.js";
import {
  makeAlert,
  makeReviewRequest,
  makeUpdatePr,
  primaryNav,
} from "./fakes.js";

const REPO = { owner: "no42-org", name: "twiki" };
const OTHER = { owner: "no42-org", name: "quiet" };
const NEVER = { owner: "no42-org", name: "unseen" };
const POLICY = { cadenceMs: 15 * 60_000 };
const NOW = new Date("2026-08-16T12:00:00.000Z");

describe("freshness (AD-11)", () => {
  it("is fresh inside the cadence budget", () => {
    const seen = new Date(NOW.getTime() - 10 * 60_000).toISOString();
    expect(freshness(seen, NOW, POLICY)).toBe("fresh");
  });

  it("is stale beyond it", () => {
    const seen = new Date(NOW.getTime() - 60 * 60_000).toISOString();
    expect(freshness(seen, NOW, POLICY)).toBe("stale");
  });

  it("treats never-collected as unknown, not stale", () => {
    expect(freshness(null, NOW, POLICY)).toBe("unknown");
    expect(freshness(undefined, NOW, POLICY)).toBe("unknown");
  });

  it("treats an unparseable stamp as unknown rather than ancient", () => {
    expect(freshness("last tuesday", NOW, POLICY)).toBe("unknown");
  });

  it("tolerates exactly the configured number of cadences", () => {
    const edge = new Date(
      NOW.getTime() - POLICY.cadenceMs * DEFAULT_STALE_AFTER_CADENCES,
    ).toISOString();
    expect(freshness(edge, NOW, POLICY)).toBe("fresh");

    const past = new Date(
      NOW.getTime() - POLICY.cadenceMs * DEFAULT_STALE_AFTER_CADENCES - 1000,
    ).toISOString();
    expect(freshness(past, NOW, POLICY)).toBe("stale");
  });

  it("labels ages readably", () => {
    expect(ageLabel(new Date(NOW.getTime() - 30_000).toISOString(), NOW)).toBe(
      "30s ago",
    );
    expect(
      ageLabel(new Date(NOW.getTime() - 20 * 60_000).toISOString(), NOW),
    ).toBe("20m ago");
    expect(ageLabel(null, NOW)).toBe("never collected");
  });
});

describe("the page", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "page-"));
    store = SqliteStore.openForWrite(join(dir, "p.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const app = () =>
    createApp({
      defaultBranchOf: () => "main",
      store,
      watched: [REPO, NEVER],
      policy: POLICY,
      now: () => NOW,
    });

  it("renders every watched repository: swept ones in the quiet block, unswept ones as not yet confirmed", async () => {
    const run = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-16T11:55:00.000Z",
    });
    store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
      summariseRepo(REPO, []),
    ]);
    store.finishRun(run, "ok", "2026-08-16T11:55:00.000Z");

    const res = await app().request("/");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(
      '<p class="sub">2 watched repositories · 0 need attention now · 0 soon · 1 quiet · 1 unconfirmed</p>',
    );
    expect(html).toContain(
      '<details class="quiet"><summary id="quiet">1 repository is quiet</summary>' +
        '<p><a href="/repo/no42-org/twiki">no42-org/twiki</a></p></details>',
    );
    // A repository nobody has looked at is not quiet, and reads as a zero
    // nowhere on the page (AD-28).
    expect(html).toContain(
      '<p class="attest" id="unconfirmed">1 repository not yet confirmed by any completed sweep: ' +
        '<a href="/repo/no42-org/unseen">no42-org/unseen</a></p>',
    );
    expect(html).not.toContain("No repository needs attention right now.");
    expect(html).not.toContain('class="chip zero"');
  });

  it("says nothing needs attention only once every repository has been confirmed", async () => {
    const run = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-16T11:55:00.000Z",
    });
    store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
      summariseRepo(REPO, []),
      summariseRepo(NEVER, []),
    ]);
    store.finishRun(run, "ok", "2026-08-16T11:55:00.000Z");

    const html = await (await app().request("/")).text();

    expect(html).toContain(
      '<p class="sub">2 watched repositories · 0 need attention now · 0 soon · 2 quiet</p>',
    );
    expect(html).toContain("No repository needs attention right now.");
    expect(html).not.toContain('id="unconfirmed"');
  });

  it("says plainly when no collection has ever run", async () => {
    const html = await (await app().request("/")).text();
    expect(html).toContain("No collection has run yet");
  });

  it("surfaces a failed run on the page, not only in the logs", async () => {
    const run = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-16T11:55:00.000Z",
    });
    store.finishRun(run, "failed", "2026-08-16T11:56:00.000Z", "token expired");

    const html = await (await app().request("/")).text();

    expect(html).toContain("failed");
    expect(html).toContain("token expired");
  });

  it("puts the policy note in a footer outside main", async () => {
    const html = await (await app().request("/")).text();
    expect(html).toContain(
      '</main><footer class="policy-note">Tiers are buckets over the ordering of the queue, which is a local policy: a broken default branch, then CISA KEV listing, then EPSS, then severity, then update size, then whether GitHub could prepare the update. It is not SSVC and not any published standard.</footer>',
    );
  });

  it("answers liveness separately from collection health", async () => {
    const res = await app().request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });
});

describe("issues found in review", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "rev-"));
    store = SqliteStore.openForWrite(join(dir, "r.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("shows a lane that stopped running, rather than losing it to a window", () => {
    const dead = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "abandoned",
      scope: "full",
      startedAt: "2026-08-16T06:00:00.000Z",
    });
    store.finishRun(dead, "ok", "2026-08-16T06:01:00.000Z");
    // Plenty of newer runs from healthy lanes.
    for (let i = 0; i < 50; i++) {
      const r = store.beginRun({
        lane: "rest-org-dependabot",
        installation: `live-${i % 5}`,
        scope: "full",
        startedAt: "2026-08-16T11:55:00.000Z",
      });
      store.finishRun(r, "ok", "2026-08-16T11:56:00.000Z");
    }

    const health = buildCollectionHealth(store, NOW, POLICY);
    const abandoned = health.find((h) => h.installation === "abandoned");

    expect(abandoned).toBeDefined();
    expect(abandoned?.freshness).toBe("stale");
  });

  it("shows an in-flight run as running, not as partial", () => {
    store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-16T11:59:00.000Z",
    });

    const health = buildCollectionHealth(store, NOW, POLICY);

    // A running lane in amber "something is wrong" styling trains the reader
    // to ignore the real thing.
    expect(health[0]?.outcome).toBe("running");
  });

  it("still shows a genuinely partial run as partial", () => {
    const run = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-16T11:55:00.000Z",
    });
    store.finishRun(run, "partial", "2026-08-16T11:56:00.000Z", "3 unreadable");

    const health = buildCollectionHealth(store, NOW, POLICY);

    expect(health[0]?.outcome).toBe("partial");
    expect(health[0]?.detail).toBe("3 unreadable");
  });

  it("emits a doctype so browsers do not fall into quirks mode", async () => {
    const res = await createApp({
      defaultBranchOf: () => "main",
      store,
      watched: [REPO],
      policy: POLICY,
      now: () => NOW,
    }).request("/");

    expect((await res.text()).startsWith("<!DOCTYPE html>")).toBe(true);
  });
});

describe("bind address (AD-12)", () => {
  it("defaults to loopback", () => {
    expect(DEFAULT_HOST).toBe("127.0.0.1");
  });

  it("warns loudly when bound anywhere else", () => {
    const logs: string[] = [];
    const server = startServer(
      createApp({
        defaultBranchOf: () => "main",
        store: {} as never,
        watched: [],
        policy: POLICY,
        now: () => NOW,
      }),
      { host: "0.0.0.0", port: 0, log: (m) => logs.push(m) },
    );

    expect(logs.some((l) => l.includes("WARNING"))).toBe(true);
    expect(logs.some((l) => l.includes("no UI authentication"))).toBe(true);
    server.close();
  });

  it("does not warn on any loopback spelling", () => {
    for (const host of ["127.0.0.1", "localhost", "::1"]) {
      const logs: string[] = [];
      const server = startServer(
        createApp({
          defaultBranchOf: () => "main",
          store: {} as never,
          watched: [],
          policy: POLICY,
          now: () => NOW,
        }),
        { host, port: 0, log: (m) => logs.push(m) },
      );
      expect(logs.some((l) => l.includes("WARNING"))).toBe(false);
      server.close();
    }
  });

  it("does not warn on the default", () => {
    const logs: string[] = [];
    const server = startServer(
      createApp({
        defaultBranchOf: () => "main",
        store: {} as never,
        watched: [],
        policy: POLICY,
        now: () => NOW,
      }),
      { port: 0, log: (m) => logs.push(m) },
    );

    expect(logs.some((l) => l.includes("WARNING"))).toBe(false);
    server.close();
  });
});

// A second review round found each of the following could break with the whole
// suite green. Every test here was checked by mutating the code it covers.
describe("issues found in review (round 2)", () => {
  let dir: string;
  let store: SqliteStore;
  let run: RunRef;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "web2-"));
    store = SqliteStore.openForWrite(join(dir, "s.db"));
    run = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-16T11:55:00.000Z",
    });
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("clock skew", () => {
    const future = new Date(NOW.getTime() + 6 * 60 * 60_000).toISOString();

    it("does not read a future timestamp as maximally fresh", () => {
      // `now - seen <= budget` is satisfied trivially by any future stamp, so
      // the least trustworthy value on the page got the most reassuring badge.
      expect(freshness(future, NOW, POLICY)).toBe("stale");
    });

    it("says the clock is wrong rather than clamping to 0s ago", () => {
      expect(ageLabel(future, NOW)).toContain("clock skew");
    });

    it("still tolerates a few seconds of ordinary drift", () => {
      const drift = new Date(NOW.getTime() + 5_000).toISOString();
      expect(freshness(drift, NOW, POLICY)).toBe("fresh");
    });
  });

  describe("collection health", () => {
    it("shows a run still in flight as running", () => {
      store.beginRun({
        lane: "rest-org-dependabot",
        installation: "live",
        scope: "full",
        startedAt: "2026-08-16T11:59:00.000Z",
      });

      const h = buildCollectionHealth(store, NOW, POLICY).find(
        (r) => r.installation === "live",
      );
      expect(h?.outcome).toBe("running");
      expect(h?.freshness).toBe("fresh");
    });

    it("does not show a crashed collector as running and fresh forever", () => {
      store.beginRun({
        lane: "rest-org-dependabot",
        installation: "crashed",
        scope: "full",
        startedAt: "2026-06-01T00:00:00.000Z",
      });

      const h = buildCollectionHealth(store, NOW, POLICY).find(
        (r) => r.installation === "crashed",
      );

      // OOM, SIGKILL or eviction leaves exactly this row, and nothing will ever
      // finish it. Forcing it green hides the dead lane the table exists for.
      expect(h?.outcome).toBe("stalled");
      expect(h?.freshness).toBe("stale");
    });

    it("does not mistake a genuinely partial run for a running one", () => {
      const r = store.beginRun({
        lane: "rest-org-dependabot",
        installation: "same-stamp",
        scope: "full",
        startedAt: "2026-08-16T11:59:00.000Z",
      });
      // A fast lane can finish inside its own clock tick.
      store.finishRun(r, "partial", "2026-08-16T11:59:00.000Z", "3 unreadable");

      const h = buildCollectionHealth(store, NOW, POLICY).find(
        (x) => x.installation === "same-stamp",
      );
      // "running · 3 unreadable" is incoherent: it reports a detail only a
      // finished run can have.
      expect(h?.outcome).toBe("partial");
    });

    it("reports the newest run for a key, not the first one", () => {
      const key = {
        lane: "rest-org-dependabot",
        installation: "twice",
        scope: "full" as const,
      };
      const first = store.beginRun({
        ...key,
        startedAt: "2026-08-16T11:50:00.000Z",
      });
      store.finishRun(first, "ok", "2026-08-16T11:51:00.000Z");
      const second = store.beginRun({
        ...key,
        startedAt: "2026-08-16T11:56:00.000Z",
      });
      store.finishRun(second, "failed", "2026-08-16T11:57:00.000Z", "boom");

      const h = buildCollectionHealth(store, NOW, POLICY).find(
        (r) => r.installation === "twice",
      );

      // Returning the older row would report a stale success in place of the
      // current failure, which is the inverse of this table's job.
      expect(h?.outcome).toBe("failed");
      expect(h?.detail).toBe("boom");
    });
  });

  /**
   * The shared run is in flight until a test says otherwise. A page with no
   * completed sweep behind it reads `nothing collected yet` (#127), so
   * every rendering test that expects counts completes the run first.
   */
  const complete = () => store.finishRun(run, "ok", "2026-08-16T11:55:00.000Z");

  describe("the rendered page", () => {
    const render = async () => {
      complete();
      return (
        await createApp({
          defaultBranchOf: () => "main",
          store,
          watched: [REPO, OTHER, NEVER],
          policy: POLICY,
          now: () => NOW,
        }).request("/")
      ).text();
    };

    /** A review old enough to lift its repository to soon, so its row shows. */
    const lift = (repo: { owner: string; name: string }, number: number) =>
      normaliseReviewRequest(
        makeReviewRequest({
          repo,
          number,
          createdAt: "2026-08-07T12:00:00.000Z",
        }),
      );

    const NO_COLLECTOR = "no collector for this topic yet";
    const NO_SWEEP = "not confirmed by any completed sweep";
    // Story 1.9 (#131): every cell states its role and starts with its
    // header word, painted on the chip cells and visually hidden elsewhere.
    const cell = (label: string, chip: string) =>
      `<td class="c" role="cell"><span class="lbl">${label}</span>${chip}</td>`;
    const unconfirmed = (label: string, reason: string) =>
      cell(
        label,
        `<span class="chip unconfirmed" title="${reason}">unconfirmed</span>`,
      );
    const NO_LANE = (label: string) => unconfirmed(label, NO_COLLECTOR);
    const UNSWEPT = (label: string) => unconfirmed(label, NO_SWEEP);
    // CI, Dependencies, Pull requests, Issues, Reviews: one has no collector
    // yet, four have a lane that has not confirmed this repository.
    const REST =
      UNSWEPT("CI") +
      UNSWEPT("Dependencies") +
      NO_LANE("Pull requests") +
      UNSWEPT("Issues") +
      UNSWEPT("Reviews");
    /** What the tablet's rationale line says about REST. */
    const REST_UNCONFIRMED =
      "unconfirmed: CI, Dependencies, Pull requests, Issues, Reviews";
    const ZERO = cell("Security", '<span class="chip zero">0</span>');
    const open = (t: string) =>
      `<tbody class="${t}" role="rowgroup"><tr class="repo" role="row">`;
    const tier = (t: string) =>
      `<td class="tier-cell" role="cell"><span class="lbl hid">Tier</span><span class="tier ${t}"><span class="sr-only">attention tier: </span>${t}</span></td>`;
    const slug = (s: string) =>
      `<td class="slug-cell" colspan="2" role="cell"><span class="lbl hid">Repository</span><a class="slug" href="/repo/${s}">${s}</a></td>`;
    /** The tablet's one cell: the chips that say something, topic first. */
    const signals = (...chips: string[]) =>
      `<td class="signals" role="cell"><span class="lbl hid">Signals</span>${chips.join(" · ")}</td>`;
    /** The rationale row; `rest` is what the signals cell left out. */
    const why = (reason: string, rest = "") =>
      '<tr class="why" role="row"><th scope="row" role="rowheader"><span class="sr-only">why</span></th>' +
      `<td colspan="9" role="cell"><span class="lbl hid">why</span><span class="why">${reason}` +
      (rest === "" ? "" : `<span class="signals-rest"> · ${rest}</span>`) +
      "</span></td></tr>";
    const badge = (b: string) =>
      `<td class="fresh-cell" role="cell"><span class="lbl hid">Last confirmed</span>${b}</td>`;
    const FRESH = badge(
      '<span class="badge fresh" title="5m ago">fresh · 5m ago</span>',
    );

    it("renders a count, a confirmed zero and an unconfirmed topic as three different chips, in whole rows", async () => {
      // Three states, three renderings, asserted as whole rows: the chip, the
      // tier, the badge and the rationale come from one computation (AD-32),
      // and a test that looked only at the chip would let the rest drift.
      const alerts = [
        makeAlert({ number: 1, repo: REPO, severity: "critical" }),
      ];
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        ...alerts.map(normalise),
        summariseRepo(REPO, alerts),
        summariseRepo(OTHER, []),
        lift(OTHER, 4),
        lift(NEVER, 5),
      ]);

      const html = await render();

      expect(html).toContain(
        open("now") +
          slug("no42-org/twiki") +
          tier("now") +
          signals(
            '<a class="chip critical" href="/queue?repo=no42-org%2Ftwiki&amp;topic=security">Security 1 critical</a>',
          ) +
          cell(
            "Security",
            '<a class="chip critical" href="/queue?repo=no42-org%2Ftwiki&amp;topic=security">1 critical</a>',
          ) +
          REST +
          FRESH +
          "</tr>" +
          why(
            "alert #1 left-pad: KEV status unknown, EPSS 42.0%, severity critical, not an update, stuck state unknown",
            REST_UNCONFIRMED,
          ) +
          "</tbody>",
      );
      expect(html).toContain(
        open("soon") +
          slug("no42-org/quiet") +
          tier("soon") +
          signals() +
          ZERO +
          REST +
          FRESH +
          "</tr>" +
          why(
            "pull request #4 open 9d, past the 3d review budget",
            `zero: Security · ${REST_UNCONFIRMED}`,
          ) +
          "</tbody>",
      );
      expect(html).toContain(
        open("soon") +
          slug("no42-org/unseen") +
          tier("soon") +
          signals() +
          UNSWEPT("Security") +
          REST +
          badge(
            '<span class="badge unknown" title="never collected">never collected</span>',
          ) +
          "</tr>" +
          why(
            "pull request #5 open 9d, past the 3d review budget",
            "unconfirmed: Security, CI, Dependencies, Pull requests, Issues, Reviews",
          ) +
          "</tbody>",
      );
      expect(html).toContain(
        '<details class="quiet"><summary id="quiet">0 repositories are quiet</summary><p></p></details>',
      );
    });

    it("states every table part's role and starts every cell with its header word", async () => {
      // Under 640px the tables become cards by `display: block`, and a
      // browser then drops the semantics the elements implied; a stated
      // role survives that, and the header word in each cell is what a
      // screen reader hears in place of the column (EXPERIENCE.md
      // Accessibility Floor). Walked over the board and the health table.
      const alerts = [
        makeAlert({ number: 1, repo: REPO, epssPercentage: 0.02 }),
      ];
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        ...alerts.map(normalise),
        summariseRepo(REPO, alerts),
      ]);

      const html = await render();

      const ROLE: Record<string, RegExp> = {
        table: /^table$/,
        thead: /^rowgroup$/,
        tbody: /^rowgroup$/,
        tr: /^row$/,
        th: /^(columnheader|rowheader)$/,
        td: /^cell$/,
      };
      const parts = [
        ...html.matchAll(/<(table|thead|tbody|tr|th|td)\b([^>]*)>/g),
      ];
      expect(parts.length).toBeGreaterThan(30);
      for (const [tag, name, attrs] of parts) {
        const role = / role="([^"]*)"/.exec(attrs ?? "")?.[1] ?? "";
        expect(role, tag).toMatch(ROLE[name ?? ""] ?? /^$/);
      }
      for (const [tag] of html.matchAll(/<th\b[^>]*>/g)) {
        expect(tag).toMatch(/ scope="(col|row)"/);
      }
      // Ten on the repo row, the rationale cell, five on the health row.
      const cells = [...html.matchAll(/<td\b[^>]*>(?:<[^>]*>)?/g)];
      expect(cells.length).toBe(16);
      for (const [cell] of cells) {
        expect(cell).toMatch(/<span class="lbl(?: hid)?">$/);
      }
    });

    it("links a count chip to the queue filtered by repository and topic", async () => {
      const alerts = [
        makeAlert({ number: 1, repo: REPO, epssPercentage: 0.02 }),
        makeAlert({ number: 2, repo: REPO, epssPercentage: 0.02 }),
      ];
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        ...alerts.map(normalise),
        summariseRepo(REPO, alerts),
      ]);

      const html = await render();

      expect(html).toContain(
        open("soon") +
          slug("no42-org/twiki") +
          tier("soon") +
          signals(
            '<a class="chip high" href="/queue?repo=no42-org%2Ftwiki&amp;topic=security">Security 2 high</a>',
          ) +
          cell(
            "Security",
            '<a class="chip high" href="/queue?repo=no42-org%2Ftwiki&amp;topic=security">2 high</a>',
          ) +
          REST +
          FRESH +
          "</tr>" +
          why(
            "alert #1 left-pad: KEV status unknown, EPSS 2.0%, severity high, not an update, stuck state unknown",
            REST_UNCONFIRMED,
          ) +
          "</tbody>",
      );
    });

    const unconfirmedTile = (label: string, reason: string) =>
      `<div class="tile"><span class="count unconfirmed">unconfirmed</span><span class="label">${label}</span><span class="attest">${reason}</span></div>`;
    /** Every tile but Security, none of which has a confirmed chip here. */
    const REST_TILES =
      unconfirmedTile("CI", NO_SWEEP) +
      unconfirmedTile("Dependencies", NO_SWEEP) +
      unconfirmedTile("Pull requests", NO_COLLECTOR) +
      unconfirmedTile("Issues", NO_SWEEP) +
      unconfirmedTile("Reviews", NO_SWEEP);

    it("renders the six tiles, with a now marker only where an item is now", async () => {
      const alerts = [
        makeAlert({ number: 1, repo: REPO, epssPercentage: 0.5 }),
        makeAlert({ number: 2, repo: REPO, epssPercentage: 0.02 }),
      ];
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        ...alerts.map(normalise),
        summariseRepo(REPO, alerts),
        summariseRepo(OTHER, []),
        summariseRepo(NEVER, []),
      ]);

      const html = await render();

      // An unconfirmed tile is not a link: the filter behind it is empty.
      expect(html).toContain(
        '<nav class="tiles" aria-label="topics">' +
          '<a class="tile" href="/queue?topic=security"><span class="count critical">2 <span class="now-marker">· 1 now</span></span><span class="label">Security</span></a>' +
          REST_TILES +
          "</nav>",
      );
      expect(html).toContain(
        '<p class="sub">3 watched repositories · 1 needs attention now · 0 soon · 2 quiet</p>',
      );
      expect(html).toContain(
        '<p class="legend">now: act today · soon: act this week · quiet: nothing pressing</p>',
      );
    });

    it("renders a red main first, as a now tile, chip and rationale", async () => {
      // The whole surface of Story 2.3 in one rendering: the CI tile carries
      // a count and the `now` marker, the row's CI chip links to the
      // filtered queue, and the rationale is one plain sentence naming the
      // workflow. The alert beside it is KEV-listed and `now` too, and it
      // ranks second, because nothing ships from a red main.
      const alerts = [
        makeAlert({ number: 1, repo: OTHER, epssPercentage: 0.5 }),
      ];
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        ...alerts.map(normalise),
        summariseRepo(REPO, []),
        summariseRepo(OTHER, alerts),
        summariseRepo(NEVER, []),
      ]);
      const actions = store.beginRun({
        lane: "rest-actions-runs",
        installation: "no42-org",
        scope: "full",
        startedAt: "2026-08-16T11:55:00.000Z",
      });
      store.recordObservations(actions, "2026-08-16T11:55:00.000Z", [
        {
          subject: { type: "repository_actions", key: "no42-org/twiki" },
          payload: { repo: "no42-org/twiki", workflows: 1, failing: 1 },
        },
        {
          subject: { type: "workflow_run", key: "WFR_9" },
          payload: {
            repo: "no42-org/twiki",
            workflowId: 1,
            workflowName: "CI",
            runNumber: 9,
            status: "completed",
            conclusion: "failure",
            headBranch: "main",
            event: "push",
            htmlUrl: "https://github.com/no42-org/twiki/actions/runs/9",
            createdAt: "2026-08-16T10:00:00.000Z",
          },
        },
      ] as never[]);
      store.finishRun(actions, "ok", "2026-08-16T11:55:00.000Z");

      const html = await render();

      expect(html).toContain(
        '<nav class="tiles" aria-label="topics">' +
          '<a class="tile" href="/queue?topic=security"><span class="count critical">1 <span class="now-marker">· 1 now</span></span><span class="label">Security</span></a>' +
          '<a class="tile" href="/queue?topic=ci"><span class="count critical">1 <span class="now-marker">· 1 now</span></span><span class="label">CI</span></a>' +
          unconfirmedTile("Dependencies", NO_SWEEP) +
          unconfirmedTile("Pull requests", NO_COLLECTOR) +
          unconfirmedTile("Issues", NO_SWEEP) +
          unconfirmedTile("Reviews", NO_SWEEP) +
          "</nav>",
      );
      // The red main is the first row on the board, above the KEV alert.
      expect(html).toContain(
        open("now") +
          slug("no42-org/twiki") +
          tier("now") +
          signals(
            '<a class="chip" href="/queue?repo=no42-org%2Ftwiki&amp;topic=ci">CI 1</a>',
          ) +
          ZERO +
          cell(
            "CI",
            '<a class="chip" href="/queue?repo=no42-org%2Ftwiki&amp;topic=ci">1</a>',
          ) +
          UNSWEPT("Dependencies") +
          NO_LANE("Pull requests") +
          UNSWEPT("Issues") +
          UNSWEPT("Reviews") +
          FRESH +
          "</tr>" +
          why(
            "workflow run #9: default branch workflow CI failed 2h ago",
            "zero: Security · unconfirmed: Dependencies, Pull requests, Issues, Reviews",
          ) +
          "</tbody>",
      );
      expect(html.indexOf("no42-org/twiki")).toBeLessThan(
        html.indexOf("no42-org/quiet"),
      );
    });

    it("renders a plain count on a tile with nothing now", async () => {
      const alerts = [
        makeAlert({ number: 1, repo: REPO, epssPercentage: 0.02 }),
        makeAlert({ number: 2, repo: REPO, epssPercentage: 0.02 }),
      ];
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        ...alerts.map(normalise),
        summariseRepo(REPO, alerts),
      ]);

      const html = await render();

      expect(html).toContain(
        '<nav class="tiles" aria-label="topics">' +
          '<a class="tile" href="/queue?topic=security"><span class="count">2</span><span class="label">Security</span></a>' +
          REST_TILES +
          "</nav>",
      );
    });

    it("renders a severity-less count chip as a plain link", async () => {
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        summariseRepo(REPO, []),
      ]);
      const prs = store.beginRun({
        lane: "graphql-update-prs",
        installation: "no42-org",
        scope: "full",
        startedAt: "2026-08-16T11:55:00.000Z",
      });
      store.recordObservations(prs, "2026-08-16T11:55:00.000Z", [
        normalisePr(
          makeUpdatePr({
            number: 7,
            repo: REPO,
            title: "Bump left-pad from 1.0.0 to 1.1.0",
          }),
        ),
      ]);
      store.finishRun(prs, "ok", "2026-08-16T11:55:00.000Z");

      const html = await render();

      expect(html).toContain(
        open("soon") +
          slug("no42-org/twiki") +
          tier("soon") +
          signals(
            '<a class="chip" href="/queue?repo=no42-org%2Ftwiki&amp;topic=dependencies">Dependencies 1</a>',
          ) +
          ZERO +
          UNSWEPT("CI") +
          cell(
            "Dependencies",
            '<a class="chip" href="/queue?repo=no42-org%2Ftwiki&amp;topic=dependencies">1</a>',
          ) +
          NO_LANE("Pull requests") +
          UNSWEPT("Issues") +
          UNSWEPT("Reviews") +
          FRESH +
          "</tr>" +
          why(
            "update PR #7 left-pad: no CVE to check against KEV, no CVE to score, no advisory, minor bump, no Dependabot fix attempt on record",
            "zero: Security · unconfirmed: CI, Pull requests, Issues, Reviews",
          ) +
          "</tbody>",
      );
    });

    it("warns on the tile whose lane failed, where the count is read (#127)", async () => {
      const alerts = [
        makeAlert({ number: 1, repo: REPO, epssPercentage: 0.02 }),
        makeAlert({ number: 2, repo: REPO, epssPercentage: 0.02 }),
      ];
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        ...alerts.map(normalise),
        summariseRepo(REPO, alerts),
      ]);
      const dead = store.beginRun({
        lane: "rest-org-dependabot",
        installation: "riptide-labs",
        scope: "full",
        startedAt: "2026-08-16T09:00:00.000Z",
      });
      store.finishRun(dead, "failed", "2026-08-16T09:00:00.000Z", "HTTP 502");
      complete();

      // riptide-labs has a watched repository, or its failure would qualify
      // no count on this page.
      const html = await (
        await createApp({
          defaultBranchOf: () => "main",
          store,
          watched: [REPO, { owner: "riptide-labs", name: "riptide" }],
          policy: POLICY,
          now: () => NOW,
        }).request("/")
      ).text();

      // The count stays: it is a lower bound, and the line says so.
      expect(html).toContain(
        '<nav class="tiles" aria-label="topics">' +
          '<a class="tile" href="/queue?topic=security"><span class="count">2</span><span class="label">Security</span>' +
          '<p class="attest warn">alerts sweep failed for riptide-labs 3h ago; counts may be low</p></a>' +
          REST_TILES +
          "</nav>",
      );
    });

    it("renders every warning line on a tile that has no count, without the suffix", async () => {
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        summariseRepo(REPO, []),
      ]);
      for (const lane of ["graphql-update-prs", "graphql-update-status"]) {
        const r = store.beginRun({
          lane,
          installation: "no42-org",
          scope: "full",
          startedAt: "2026-08-16T11:55:00.000Z",
        });
        store.finishRun(r, "failed", "2026-08-16T11:55:00.000Z", "boom");
      }

      const html = await render();

      expect(html).toContain(
        '<div class="tile"><span class="count unconfirmed">unconfirmed</span><span class="label">Dependencies</span>' +
          `<span class="attest">${NO_SWEEP}</span>` +
          '<p class="attest warn">update PRs sweep failed for no42-org 5m ago</p>' +
          '<p class="attest warn">update status sweep failed for no42-org 5m ago</p></div>',
      );
    });

    it("keeps the confirmed rows, stale, when every lane failed after a good sweep", async () => {
      const alerts = [
        makeAlert({ number: 1, repo: REPO, epssPercentage: 0.02 }),
        makeAlert({ number: 2, repo: REPO, epssPercentage: 0.02 }),
      ];
      store.recordObservations(run, "2026-08-16T09:00:00.000Z", [
        ...alerts.map(normalise),
        summariseRepo(REPO, alerts),
      ]);
      const dead = store.beginRun({
        lane: "rest-org-dependabot",
        installation: "no42-org",
        scope: "full",
        startedAt: "2026-08-16T11:55:00.000Z",
      });
      store.finishRun(dead, "failed", "2026-08-16T11:55:00.000Z", "HTTP 502");

      // render() completes the earlier run; the failed one is still the
      // latest for its key.
      const html = await render();

      expect(html).toContain(
        '<p class="sub">3 watched repositories · 0 need attention now · 1 soon · 0 quiet · 2 unconfirmed</p>',
      );
      expect(html).toContain(
        '<a class="tile" href="/queue?topic=security"><span class="count">2</span><span class="label">Security</span>' +
          '<p class="attest warn">alerts sweep failed for no42-org 5m ago; counts may be low</p></a>',
      );
      expect(html).toContain(
        open("soon") +
          slug("no42-org/twiki") +
          tier("soon") +
          signals(
            '<a class="chip high" href="/queue?repo=no42-org%2Ftwiki&amp;topic=security">Security 2 high</a>',
          ) +
          cell(
            "Security",
            '<a class="chip high" href="/queue?repo=no42-org%2Ftwiki&amp;topic=security">2 high</a>',
          ) +
          REST +
          badge(
            '<span class="badge stale" title="3h ago">stale · 3h ago</span>',
          ) +
          "</tr>" +
          why(
            "alert #1 left-pad: KEV status unknown, EPSS 2.0%, severity high, not an update, stuck state unknown",
            REST_UNCONFIRMED,
          ) +
          "</tbody>",
      );
      expect(html).not.toContain("nothing collected yet");
    });

    it("treats a store holding only a partial completion as collected", async () => {
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        summariseRepo(REPO, []),
      ]);
      store.finishRun(
        run,
        "partial",
        "2026-08-16T11:55:00.000Z",
        "3 unreadable",
      );

      // Not through render(), which would complete the run as ok.
      const html = await (
        await createApp({
          defaultBranchOf: () => "main",
          store,
          watched: [REPO],
          policy: POLICY,
          now: () => NOW,
        }).request("/")
      ).text();

      expect(html).toContain(
        '<p class="sub">1 watched repository · 0 need attention now · 0 soon · 1 quiet</p>',
      );
      expect(html).toContain(
        '<a class="tile" href="/queue?topic=security"><span class="count">0</span><span class="label">Security</span>' +
          '<p class="attest warn">alerts sweep partial for no42-org 5m ago; counts may be low</p></a>',
      );
      expect(html).not.toContain("nothing collected yet");
    });

    it("states unreadable rows directly under the summary and withholds the all-quiet sentence", async () => {
      const bad = (number: number) => ({
        subject: {
          type: "dependabot_alert" as const,
          key: `no42-org/twiki#${number}`,
        },
        payload: { number, repo: "no42-org/twiki", cveId: 42 },
      });
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        bad(8),
        bad(9),
        summariseRepo(REPO, []),
        summariseRepo(OTHER, []),
        summariseRepo(NEVER, []),
      ]);

      const html = await render();

      // The queue's sentence, verbatim, and in the one place the reader
      // sees before any count.
      expect(html).toContain(
        '<p class="sub">3 watched repositories · 0 need attention now · 0 soon · 3 quiet</p>' +
          '<p class="failed">2 stored items could not be read and are not shown. This list is incomplete.</p>',
      );
      expect(html).not.toContain("No repository needs attention right now.");
    });

    it("replaces the board with one note before the first completed sweep", async () => {
      // The shared run is still in flight; nothing has completed.
      const html = await (
        await createApp({
          defaultBranchOf: () => "main",
          store,
          watched: [REPO, OTHER, NEVER],
          policy: POLICY,
          now: () => NOW,
        }).request("/")
      ).text();

      const never = (label: string) =>
        `<div class="tile"><span class="count never">never collected</span><span class="label">${label}</span></div>`;
      expect(html).toContain(
        '<p class="sub">3 watched repositories · nothing collected yet</p>',
      );
      expect(html).toContain(
        '<nav class="tiles" aria-label="topics">' +
          never("Security") +
          never("CI") +
          never("Dependencies") +
          never("Pull requests") +
          never("Issues") +
          never("Reviews") +
          "</nav>" +
          '<h2 id="board">What needs attention</h2>' +
          '<p class="attest">nothing collected yet; see <a href="#health">Collection health</a></p>' +
          '<h2 id="health">Collection health</h2>',
      );
      expect(html).not.toContain('class="quiet"');
      expect(html).not.toContain('class="legend"');
      expect(html).not.toContain("No repository needs attention right now.");
    });

    it("says both that nothing was collected and which lane failed", async () => {
      store.finishRun(
        run,
        "failed",
        "2026-08-16T11:55:00.000Z",
        "token expired",
      );

      // Not through render(), which would complete the shared run as ok.
      const html = await (
        await createApp({
          defaultBranchOf: () => "main",
          store,
          watched: [REPO],
          policy: POLICY,
          now: () => NOW,
        }).request("/")
      ).text();

      expect(html).toContain(
        '<div class="tile"><span class="count never">never collected</span><span class="label">Security</span>' +
          '<p class="attest warn">alerts sweep failed for no42-org 5m ago</p></div>',
      );
      expect(html).toContain(
        '<p class="attest">nothing collected yet; see <a href="#health">Collection health</a></p>',
      );
      expect(html).toContain(
        '<td class="failed" role="cell"><span class="lbl">Outcome</span>failed · token expired</td>',
      );
    });

    /** The health table's body: the one `<tbody>` on the page with no class. */
    const HEALTH_BODY = '<tbody role="rowgroup">';
    const healthBody = (html: string): string => {
      const start = html.lastIndexOf(HEALTH_BODY);
      return html.slice(start, html.indexOf("</tbody>", start) + 8);
    };
    const healthRow = (
      lane: string,
      installation: string,
      outcome: string,
      badge: string,
    ) =>
      '<tr role="row">' +
      `<td role="cell"><span class="lbl">Lane</span>${lane}</td>` +
      `<td role="cell"><span class="lbl">Installation</span>${installation}</td>` +
      '<td role="cell"><span class="lbl">Scope</span>full</td>' +
      `<td class="${outcome.split(" ")[0]}" role="cell"><span class="lbl">Outcome</span>${outcome}</td>` +
      `<td role="cell"><span class="lbl">Last run</span>${badge}</td>` +
      "</tr>";
    const FRESH_BADGE =
      '<span class="badge fresh" title="5m ago">fresh · 5m ago</span>';

    it("keeps the health table in lane, installation, scope order across renders, failed rows included", async () => {
      // Inserted out of order, so an insertion-ordered table cannot pass.
      const at = "2026-08-16T11:55:00.000Z";
      const runs: [string, string, "ok" | "failed"][] = [
        ["rest-org-dependabot", "riptide-labs", "failed"],
        ["kev", "cisa", "ok"],
        ["graphql-issues", "no42-org", "ok"],
        ["rest-org-dependabot", "labmonkeys-space", "ok"],
      ];
      for (const [lane, installation, outcome] of runs) {
        const r = store.beginRun({
          lane,
          installation,
          scope: "full",
          startedAt: at,
        });
        store.finishRun(
          r,
          outcome,
          at,
          outcome === "failed" ? "HTTP 502" : undefined,
        );
      }

      const first = healthBody(await render());
      const second = healthBody(await render());

      expect(first).toBe(
        HEALTH_BODY +
          healthRow("graphql-issues", "no42-org", "ok", FRESH_BADGE) +
          healthRow("kev", "cisa", "ok", FRESH_BADGE) +
          healthRow(
            "rest-org-dependabot",
            "labmonkeys-space",
            "ok",
            FRESH_BADGE,
          ) +
          healthRow("rest-org-dependabot", "no42-org", "ok", FRESH_BADGE) +
          healthRow(
            "rest-org-dependabot",
            "riptide-labs",
            "failed · HTTP 502",
            FRESH_BADGE,
          ) +
          "</tbody>",
      );
      expect(second).toBe(first);
    });

    it("paints every health outcome by its own class", async () => {
      const at = "2026-08-16T11:55:00.000Z";
      const finished = (
        installation: string,
        outcome: "partial" | "failed",
        detail: string,
      ) => {
        const r = store.beginRun({
          lane: "coverage",
          installation,
          scope: "full",
          startedAt: at,
        });
        store.finishRun(r, outcome, at, detail);
      };
      finished("a-partial", "partial", "3 unreadable");
      finished("b-failed", "failed", "boom");
      store.beginRun({
        lane: "coverage",
        installation: "c-running",
        scope: "full",
        startedAt: "2026-08-16T11:58:00.000Z",
      });
      store.beginRun({
        lane: "coverage",
        installation: "d-stalled",
        scope: "full",
        startedAt: "2026-08-16T06:00:00.000Z",
      });

      const body = healthBody(await render());

      expect(body).toBe(
        HEALTH_BODY +
          healthRow(
            "coverage",
            "a-partial",
            "partial · 3 unreadable",
            FRESH_BADGE,
          ) +
          healthRow("coverage", "b-failed", "failed · boom", FRESH_BADGE) +
          healthRow(
            "coverage",
            "c-running",
            "running",
            '<span class="badge fresh" title="2m ago">fresh · 2m ago</span>',
          ) +
          healthRow(
            "coverage",
            "d-stalled",
            "stalled",
            '<span class="badge stale" title="6h ago">stale · 6h ago</span>',
          ) +
          healthRow("rest-org-dependabot", "no42-org", "ok", FRESH_BADGE) +
          "</tbody>",
      );
    });

    it("refuses to be cached, so a stale copy cannot claim to be fresh", async () => {
      const res = await createApp({
        defaultBranchOf: () => "main",
        store,
        watched: [REPO],
        policy: POLICY,
        now: () => NOW,
      }).request("/");

      expect(res.headers.get("cache-control")).toBe("no-store");
    });
  });

  describe("bind address (AD-12)", () => {
    const serveOn = (host?: string) => {
      const logs: string[] = [];
      const server = startServer(
        createApp({
          defaultBranchOf: () => "main",
          store: {} as never,
          watched: [],
          policy: POLICY,
          now: () => NOW,
        }),
        { host, port: 0, log: (m) => logs.push(m) },
      );
      return { logs, server };
    };

    it("actually binds loopback by default, not merely logs that it did", async () => {
      const { server } = serveOn();
      await new Promise((r) => server.once("listening", r));

      // The warning is computed from the requested hostname, so dropping
      // hostname from serve() left every assertion about it still passing.
      const addr = server.address() as { address: string };
      expect(addr.address).toBe("127.0.0.1");
      server.close();
    });

    it("does not warn on loopback spellings beyond the obvious four", () => {
      for (const host of [
        "Localhost",
        "127.0.0.2",
        "::ffff:127.0.0.1",
        "0:0:0:0:0:0:0:1",
        "[::1]",
      ]) {
        const { logs, server } = serveOn(host);
        expect(
          logs.some((l) => l.includes("WARNING")),
          `${host} is loopback and must not warn`,
        ).toBe(false);
        server.close();
      }
    });
  });

  // Story 1.8 (#129): the title says what the page found, the primary nav
  // says where the reader is, and the skip links are the first Tab stops.
  // Each is asserted whole, never one attribute of it.
  describe("titles, landmarks and skip links", () => {
    const NAV = primaryNav("overview", "2026-08-16T12:00:00.000Z");

    const app = () =>
      createApp({
        defaultBranchOf: () => "main",
        store,
        watched: [REPO, NEVER],
        policy: POLICY,
        now: () => NOW,
      });

    /** Complete the run the outer beforeEach began, with these rows. */
    const sweep = (payloads: { subject: unknown; payload: unknown }[]) => {
      store.recordObservations(
        run,
        "2026-08-16T11:55:00.000Z",
        payloads as never[],
      );
      store.finishRun(run, "ok", "2026-08-16T11:55:00.000Z");
    };

    it("announces the tiers in the title, marks the overview current, and skips to each block", async () => {
      const alerts = [
        makeAlert({ number: 1, repo: REPO, epssPercentage: 0.5 }),
      ];
      sweep([...alerts.map(normalise), summariseRepo(REPO, alerts)]);

      const html = await (await app().request("/")).text();

      expect(html).toContain("<title>1 now, 0 soon · gitricorder</title>");
      // The skip links are the first focusable things on the page, in this
      // order, before the nav; the nav marks this page and carries the
      // rendered-at time as text.
      expect(html).toContain(
        "<body>" +
          '<a class="skip" href="#board">skip to board</a>' +
          '<a class="skip" href="#quiet">skip to quiet repositories</a>' +
          '<a class="skip" href="#health">skip to collection health</a>' +
          NAV +
          '<main id="main">',
      );
      // Each target is a block heading that exists on the page.
      expect(html).toContain('<h2 id="board">What needs attention</h2>');
      expect(html).toContain('<summary id="quiet">');
      expect(html).toContain('<h2 id="health">Collection health</h2>');
      // The rendered-at time appears once, in the nav, and no longer on the
      // summary line.
      expect(html.match(/<time /g)).toHaveLength(1);
      expect(html).not.toContain("· rendered");
      expect(html).toContain('</main><footer class="policy-note">');
    });

    it("reads nothing pressing when no repository needs attention", async () => {
      sweep([summariseRepo(REPO, []), summariseRepo(NEVER, [])]);

      const html = await (await app().request("/")).text();

      expect(html).toContain("<title>nothing pressing · gitricorder</title>");
    });

    it("reads 0 now, 0 soon rather than nothing pressing while a repository is unconfirmed", async () => {
      // The board withholds its "nothing needs attention" sentence here;
      // the title must not say it either (AD-28).
      sweep([summariseRepo(REPO, [])]);

      const html = await (await app().request("/")).text();

      expect(html).toContain("<title>0 now, 0 soon · gitricorder</title>");
      expect(html).not.toContain("No repository needs attention right now.");
    });

    it("reads nothing collected yet before the first sweep, and offers no link to a quiet block that is not there", async () => {
      const html = await (await app().request("/")).text();

      expect(html).toContain(
        "<title>nothing collected yet · gitricorder</title>",
      );
      expect(html).toContain(
        "<body>" +
          '<a class="skip" href="#board">skip to board</a>' +
          '<a class="skip" href="#health">skip to collection health</a>' +
          NAV,
      );
      expect(html).not.toContain('id="quiet"');
    });
  });

  describe("TRICORDER_PORT", () => {
    it("rejects 0, the arbitrary-port case the guard exists for", () => {
      expect(() => parsePort("0")).toThrow(/not a valid port/);
    });

    it("rejects values Number() would silently accept", () => {
      for (const raw of ["1e4", "0x1f", "8080.5", "abc", "-1", "70000"]) {
        expect(() => parsePort(raw), raw).toThrow(/not a valid port/);
      }
    });

    it("accepts a real port and treats unset as unset", () => {
      expect(parsePort("8787")).toBe(8787);
      expect(parsePort(undefined)).toBeUndefined();
      expect(parsePort("  ")).toBeUndefined();
    });
  });

  describe("coverage is a separate axis from freshness (AD-28)", () => {
    const cov = (repo: { owner: string; name: string }, state: string) => ({
      subject: coverageSubject(repo),
      payload: {
        repo: `${repo.owner}/${repo.name}`.toLowerCase(),
        state,
        archived: false,
      },
    });

    it("says not covered on the page, not not collected", async () => {
      // A repository with nothing open is quiet and has no row, so an
      // overdue review lifts it into view; the chip then carries the verdict.
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        summariseRepo(REPO, []),
        cov(REPO, "archived"),
        normaliseReviewRequest(
          makeReviewRequest({
            repo: REPO,
            number: 4,
            createdAt: "2026-08-07T12:00:00.000Z",
          }),
        ),
      ]);
      complete();

      const html = await (
        await createApp({
          defaultBranchOf: () => "main",
          store,
          watched: [REPO],
          policy: POLICY,
          now: () => NOW,
        }).request("/")
      ).text();

      // "not collected" would blame the collector for GitHub's setting. The
      // reason rides on the chip's title AND in the rationale sentence: a
      // title is never the sole carrier.
      expect(html).toContain(
        '<td class="c" role="cell"><span class="lbl">Security</span><span class="chip uncovered" title="the repository is archived, so nothing is updating it">not covered</span></td>',
      );
      // On tablet the chip is a signal in its own right, and the rest of
      // the topics are listed after the sentence.
      expect(html).toContain(
        '<td class="signals" role="cell"><span class="lbl hid">Signals</span><span class="chip uncovered" title="the repository is archived, so nothing is updating it">Security not covered</span></td>',
      );
      expect(html).toContain(
        '<tr class="why" role="row"><th scope="row" role="rowheader"><span class="sr-only">why</span></th><td colspan="9" role="cell"><span class="lbl hid">why</span><span class="why">' +
          "pull request #4 open 9d, past the 3d review budget · security not covered: the repository is archived, so nothing is updating it" +
          '<span class="signals-rest"> · unconfirmed: CI, Dependencies, Pull requests, Issues, Reviews</span>' +
          "</span></td></tr>",
      );
      expect(html).not.toContain("not collected");
    });
  });

  describe("per-lane cadences reach the rendered page", () => {
    it("does not show a daily lane as stale through createApp", async () => {
      // The unit test for this bypassed createApp, so deleting the argument at
      // its only wiring point left 401 tests green while the dashboard
      // permanently red-flagged two healthy lanes.
      const r = store.beginRun({
        lane: "kev",
        installation: "cisa",
        scope: "full",
        startedAt: "2026-08-16T06:00:00.000Z",
      });
      store.finishRun(r, "ok", "2026-08-16T06:00:00.000Z");

      const html = await (
        await createApp({
          defaultBranchOf: () => "main",
          store,
          watched: [REPO],
          policy: POLICY,
          lanePolicies: { kev: { cadenceMs: 24 * 60 * 60_000 } },
          now: () => NOW,
        }).request("/")
      ).text();

      const kevRow = html.slice(html.indexOf("kev"));
      expect(kevRow).toContain("fresh");
      expect(kevRow.slice(0, 200)).not.toContain("stale");
    });

    it("puts a scanner's answer in the rationale sentence, not only in a title", async () => {
      // The renderer's own rule: a title is never the sole carrier. The
      // Dependabot count stands - a scanner cannot withdraw it (#152) - and
      // what GitHub said about the scanner rides beside it in the sentence.
      const body = "Secret scanning is disabled on this repository.";
      store.recordObservations(run, "2026-08-16T11:55:00.000Z", [
        summariseRepo(REPO, []),
        {
          subject: coverageSubject(REPO),
          payload: {
            repo: "no42-org/twiki",
            state: "covered",
            codeScanning: { state: "covered", reason: null },
            secretScanning: { state: "feature_off", reason: body },
          },
        },
        normaliseReviewRequest(
          makeReviewRequest({
            repo: REPO,
            number: 4,
            createdAt: "2026-08-07T12:00:00.000Z",
          }),
        ),
      ] as never[]);
      complete();

      const html = await (
        await createApp({
          defaultBranchOf: () => "main",
          store,
          watched: [REPO],
          policy: POLICY,
          now: () => NOW,
        }).request("/")
      ).text();

      expect(html).toContain(`\u00B7 secret scanning: ${body}`);
      expect(html).not.toContain("not covered");
    });

    it("judges the coverage attestation on the lane's own cadence through createApp", async () => {
      // The repo rows used to get their coverage cadence from a separate
      // coveragePolicy field while the health table read lanePolicies. Two
      // wirings for one number is how AD-11's drift happens, so both now read
      // the same table, and this pins the repo-row half of it: a five-hour-old
      // attestation is fresh on a daily cadence and must still suppress the
      // count.
      const cRun = store.beginRun({
        lane: "coverage",
        installation: "no42-org",
        scope: "full",
        startedAt: "2026-08-16T07:00:00.000Z",
      });
      store.recordObservations(cRun, "2026-08-16T07:00:00.000Z", [
        {
          subject: coverageSubject(REPO),
          payload: { repo: "no42-org/twiki", state: "alerts_disabled" },
        },
        // Lifted into view by an overdue review, as a quiet repository has
        // no row for the chip to sit in.
        normaliseReviewRequest(
          makeReviewRequest({
            repo: REPO,
            number: 4,
            createdAt: "2026-08-07T12:00:00.000Z",
          }),
        ),
      ]);
      store.finishRun(cRun, "ok", "2026-08-16T07:00:00.000Z");

      const html = await (
        await createApp({
          defaultBranchOf: () => "main",
          store,
          watched: [REPO],
          policy: POLICY,
          lanePolicies: { coverage: { cadenceMs: 24 * 60 * 60_000 } },
          now: () => NOW,
        }).request("/")
      ).text();

      // The reason is the discriminating assertion: judged on the sweep
      // cadence the attestation would be stale, coverage unknown, and the
      // chip a plain unconfirmed. On the daily cadence it is the real state.
      expect(html).toContain(
        '<span class="chip uncovered" title="Dependabot alerts: switched off for this repository">not covered</span>',
      );
    });

    it("falls back to the sweep policy for a lane with no entry", async () => {
      const r = store.beginRun({
        lane: "rest-org-dependabot",
        installation: "no42-org",
        scope: "full",
        startedAt: "2026-08-16T06:00:00.000Z",
      });
      store.finishRun(r, "ok", "2026-08-16T06:00:00.000Z");

      const html = await (
        await createApp({
          defaultBranchOf: () => "main",
          store,
          watched: [REPO],
          policy: POLICY,
          lanePolicies: { kev: { cadenceMs: 24 * 60 * 60_000 } },
          now: () => NOW,
        }).request("/")
      ).text();

      expect(html).toContain("stale");
    });
  });
});

// The web role's own wiring, asserted through the routes. Each of these
// could be unwired with the rest of the suite green, because every view-model
// test passes the value directly and only the app supplies it from a lane
// name or a guard.
describe("what createApp binds for the CI signal", () => {
  let dir: string;
  let store: SqliteStore;

  const ACTIONS_LANE = "rest-actions-runs";
  // Forty-five minutes before the render: stale on the fifteen-minute sweep
  // budget, which tolerates two cadences, and fresh on the hourly one.
  const CONFIRMED_AT = new Date(NOW.getTime() - 45 * 60_000).toISOString();

  const seedRedMain = () => {
    const alerts = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: CONFIRMED_AT,
    });
    store.recordObservations(alerts, CONFIRMED_AT, [summariseRepo(REPO, [])]);
    store.finishRun(alerts, "ok", CONFIRMED_AT);

    const actions = store.beginRun({
      lane: ACTIONS_LANE,
      installation: "no42-org",
      scope: "full",
      startedAt: CONFIRMED_AT,
    });
    store.recordObservations(actions, CONFIRMED_AT, [
      {
        subject: { type: "repository_actions", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", workflows: 1, failing: 1 },
      },
      {
        subject: { type: "workflow_run", key: "WFR_9" },
        payload: {
          repo: "no42-org/twiki",
          workflowId: 1,
          workflowName: "CI",
          runNumber: 9,
          status: "completed",
          conclusion: "failure",
          headBranch: "main",
          event: "push",
          htmlUrl: "https://github.com/no42-org/twiki/actions/runs/9",
          createdAt: "2026-08-16T10:00:00.000Z",
        },
      },
    ] as never[]);
    store.finishRun(actions, "ok", CONFIRMED_AT);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wiring-"));
    store = SqliteStore.openForWrite(join(dir, "w.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("judges the Actions lane on its own hourly cadence, not the sweep's", async () => {
    // Exactly the shape of the KEV test above, and for the same reason: the
    // view-model tests pass `actionsPolicy` directly, so unwiring the lane
    // lookup in createApp left every one of them green while the whole
    // feature switched itself off - a confirmation is stale within half an
    // hour on the sweep budget, and with it go the item, the chip and the
    // tile.
    seedRedMain();

    const html = await (
      await createApp({
        defaultBranchOf: () => "main",
        store,
        watched: [REPO],
        policy: POLICY,
        lanePolicies: { [ACTIONS_LANE]: { cadenceMs: 60 * 60_000 } },
        now: () => NOW,
      }).request("/")
    ).text();

    expect(html).toContain(
      '<a class="tile" href="/queue?topic=ci"><span class="count critical">1 <span class="now-marker">· 1 now</span></span><span class="label">CI</span></a>',
    );
    expect(html).toContain(
      "workflow run #9: default branch workflow CI failed 2h ago",
    );
  });

  it("reads the sweep cadence with no lane policy, so the same store says unconfirmed", async () => {
    // The control for the test above: same store, no lane policy, and the
    // CI tile must then read `unconfirmed` rather than counting. Without
    // this, the assertion above passes whatever cadence is in force.
    seedRedMain();

    const html = await (
      await createApp({
        defaultBranchOf: () => "main",
        store,
        watched: [REPO],
        policy: POLICY,
        now: () => NOW,
      }).request("/")
    ).text();

    expect(html).toContain(
      '<div class="tile"><span class="count unconfirmed">unconfirmed</span><span class="label">CI</span>',
    );
  });

  it("answers 200 on every page when the branch resolver throws", async () => {
    // The board and the queue call the resolver now, not only the repository
    // page, so removing the guard 500s the whole dashboard rather than one
    // page of it. A route has no logger; a page is what it has.
    seedRedMain();
    // Lifted by an overdue review, so the repository has a row and its chips
    // are rendered: a quiet repository folds into the quiet block and shows
    // none of them.
    const reviews = store.beginRun({
      lane: "graphql-review-requests",
      installation: "reviews",
      scope: "full",
      startedAt: CONFIRMED_AT,
    });
    store.recordObservations(reviews, CONFIRMED_AT, [
      normaliseReviewRequest(
        makeReviewRequest({
          repo: REPO,
          number: 4,
          createdAt: "2026-08-07T12:00:00.000Z",
        }),
      ),
    ]);
    store.finishRun(reviews, "ok", CONFIRMED_AT);
    const app = createApp({
      defaultBranchOf: () => {
        throw new Error("repos.yaml is unreadable");
      },
      store,
      watched: [REPO],
      policy: POLICY,
      lanePolicies: { [ACTIONS_LANE]: { cadenceMs: 60 * 60_000 } },
      now: () => NOW,
    });

    for (const path of ["/", "/queue", "/repo/no42-org/twiki"]) {
      expect((await app.request(path)).status).toBe(200);
    }

    // And the guard does not answer `main`: a resolver that could not say is
    // not evidence that this repository's build is green, so the chip reads
    // unconfirmed rather than a confident zero.
    const html = await (await app.request("/")).text();
    expect(html).toContain(
      '<span class="chip unconfirmed" title="the default branch could not be resolved">unconfirmed</span>',
    );
  });
});
