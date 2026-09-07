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
import { buildCollectionHealth } from "../src/tricorder/web/view.js";
import { parsePort } from "../src/tricorder.js";
import { makeAlert, makeReviewRequest, makeUpdatePr } from "./fakes.js";

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
      '<p class="sub">2 watched repositories · 0 need attention now · 0 soon · 1 quiet · 1 unconfirmed · rendered 2026-08-16T12:00:00.000Z</p>',
    );
    expect(html).toContain(
      '<details class="quiet" open=""><summary id="quiet">1 repository is quiet</summary>' +
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
      '<p class="sub">2 watched repositories · 0 need attention now · 0 soon · 2 quiet · rendered 2026-08-16T12:00:00.000Z</p>',
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
      '</main><footer class="policy-note">Tiers are buckets over the ordering of the queue, which is a local policy: CISA KEV listing, then EPSS, then severity, then update size. It is not SSVC and not any published standard.</footer>',
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

  describe("the rendered page", () => {
    const render = async () =>
      (
        await createApp({
          store,
          watched: [REPO, OTHER, NEVER],
          policy: POLICY,
          now: () => NOW,
        }).request("/")
      ).text();

    /** A review old enough to lift its repository to soon, so its row shows. */
    const lift = (repo: { owner: string; name: string }, number: number) =>
      normaliseReviewRequest(
        makeReviewRequest({
          repo,
          number,
          createdAt: "2026-08-07T12:00:00.000Z",
        }),
      );

    const cell = (chip: string) => `<td class="c">${chip}</td>`;
    const unconfirmed = (reason: string) =>
      cell(
        `<span class="chip unconfirmed" title="${reason}">unconfirmed</span>`,
      );
    const NO_LANE = unconfirmed("no collector for this topic yet");
    const UNSWEPT = unconfirmed("not confirmed by any completed sweep");
    // CI, Dependencies, Pull requests, Issues, Reviews: two have no collector
    // yet, three have a lane that has not confirmed this repository.
    const REST = NO_LANE + UNSWEPT + NO_LANE + UNSWEPT + UNSWEPT;
    const ZERO = cell('<span class="chip zero">0</span>');
    const tier = (t: string) =>
      `<td class="tier-cell"><span class="tier ${t}"><span class="sr-only">attention tier: </span>${t}</span></td>`;
    const slug = (s: string) =>
      `<td class="slug-cell" colspan="2"><a class="slug" href="/repo/${s}">${s}</a></td>`;
    const why = (reason: string) =>
      `<tr class="why"><th scope="row"><span class="sr-only">why</span></th><td colspan="9"><span class="why">${reason}</span></td></tr>`;
    const badge = (b: string) => `<td class="fresh-cell">${b}</td>`;
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
        '<tbody class="now"><tr class="repo">' +
          slug("no42-org/twiki") +
          tier("now") +
          cell(
            '<a class="chip critical" href="/queue?repo=no42-org%2Ftwiki&amp;topic=security">1 critical</a>',
          ) +
          REST +
          FRESH +
          "</tr>" +
          why(
            "alert #1 left-pad: KEV status unknown, EPSS 42.0%, severity critical, not an update, stuck state unknown",
          ) +
          "</tbody>",
      );
      expect(html).toContain(
        '<tbody class="soon"><tr class="repo">' +
          slug("no42-org/quiet") +
          tier("soon") +
          ZERO +
          REST +
          FRESH +
          "</tr>" +
          why("pull request #4 open 9d, past the 3d review budget") +
          "</tbody>",
      );
      expect(html).toContain(
        '<tbody class="soon"><tr class="repo">' +
          slug("no42-org/unseen") +
          tier("soon") +
          UNSWEPT +
          REST +
          badge(
            '<span class="badge unknown" title="never collected">never collected</span>',
          ) +
          "</tr>" +
          why("pull request #5 open 9d, past the 3d review budget") +
          "</tbody>",
      );
      expect(html).toContain(
        '<details class="quiet" open=""><summary id="quiet">0 repositories are quiet</summary><p></p></details>',
      );
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
        '<tbody class="soon"><tr class="repo">' +
          slug("no42-org/twiki") +
          tier("soon") +
          cell(
            '<a class="chip high" href="/queue?repo=no42-org%2Ftwiki&amp;topic=security">2 high</a>',
          ) +
          REST +
          FRESH +
          "</tr>" +
          why(
            "alert #1 left-pad: KEV status unknown, EPSS 2.0%, severity high, not an update, stuck state unknown",
          ) +
          "</tbody>",
      );
    });

    const unconfirmedTile = (label: string, reason: string) =>
      `<span class="tile"><span class="count unconfirmed">unconfirmed</span><span class="label">${label}</span><span class="attest">${reason}</span></span>`;
    const NO_COLLECTOR = "no collector for this topic yet";
    const NO_SWEEP = "not confirmed by any completed sweep";
    /** Every tile but Security, none of which has a confirmed chip here. */
    const REST_TILES =
      unconfirmedTile("CI", NO_COLLECTOR) +
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
        '<p class="sub">3 watched repositories · 1 needs attention now · 0 soon · 2 quiet · rendered 2026-08-16T12:00:00.000Z</p>',
      );
      expect(html).toContain(
        '<p class="legend">now: act today · soon: act this week · quiet: nothing pressing</p>',
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
        '<tbody class="soon"><tr class="repo">' +
          slug("no42-org/twiki") +
          tier("soon") +
          ZERO +
          NO_LANE +
          cell(
            '<a class="chip" href="/queue?repo=no42-org%2Ftwiki&amp;topic=dependencies">1</a>',
          ) +
          NO_LANE +
          UNSWEPT +
          UNSWEPT +
          FRESH +
          "</tr>" +
          why(
            "update PR #7 left-pad: no CVE to check against KEV, no CVE to score, no advisory, minor bump, no Dependabot fix attempt on record",
          ) +
          "</tbody>",
      );
    });

    it("refuses to be cached, so a stale copy cannot claim to be fresh", async () => {
      const res = await createApp({
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

      const html = await (
        await createApp({
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
        '<td class="c"><span class="chip uncovered" title="the repository is archived, so nothing is updating it">not covered</span></td>',
      );
      expect(html).toContain(
        '<tr class="why"><th scope="row"><span class="sr-only">why</span></th><td colspan="9"><span class="why">' +
          "pull request #4 open 9d, past the 3d review budget · security not covered: the repository is archived, so nothing is updating it" +
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
        '<span class="chip uncovered" title="Dependabot alerts are switched off for this repository">not covered</span>',
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
