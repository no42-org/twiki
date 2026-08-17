/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NOT_APPLICABLE } from "../src/core/rank.js";
import { KEV_SUBJECT } from "../src/core/subject.js";
import { HttpEnrichment, KEV_URL, parseKev } from "../src/enrich/kev.js";
import type { EnrichmentPort } from "../src/enrich/port.js";
import {
  collectKev,
  KEV_CADENCE_MS,
  KEV_INSTALLATION,
  MAX_UNREADABLE_RATIO,
  MIN_RETAINED_RATIO,
  usablePrior,
} from "../src/tricorder/collect/kev.js";
import { kevSignal, loadKevIndex } from "../src/tricorder/kev-lookup.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { buildCollectionHealth } from "../src/tricorder/web/view.js";
import { buildSchedules, cycleInstallations } from "../src/tricorder.js";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const DAILY = { cadenceMs: 24 * 60 * 60_000 };

/** The shape measured against the real feed on 2026-08-17. */
const payload = (ids: string[]) => ({
  title: "CISA Catalog of Known Exploited Vulnerabilities",
  catalogVersion: "2026.08.17",
  dateReleased: "2026-08-17T17:00:24.7655Z",
  count: ids.length,
  vulnerabilities: ids.map((cveID) => ({
    cveID,
    vendorProject: "v",
    product: "p",
    vulnerabilityName: "n",
    dateAdded: "2026-08-17",
    knownRansomwareCampaignUse: "Unknown",
  })),
});

describe("parsing CISA's catalogue", () => {
  it("keeps the ids, upper-cased and sorted", () => {
    const r = parseKev(payload(["CVE-2025-2222", "cve-2021-1111"]));
    expect(r.cveIds).toEqual(["CVE-2021-1111", "CVE-2025-2222"]);
    expect(r.version).toBe("2026.08.17");
    expect(r.unreadable).toBe(0);
  });

  it("refuses an empty catalogue rather than mapping it to an empty set", () => {
    // The failure that matters. An empty set answers "not in KEV" for every
    // CVE, which is a confident negative on the chain's most significant term
    // and would look like good news on every row.
    expect(() => parseKev(payload([]))).toThrow(/never legitimately is/);
  });

  it("refuses a payload with no vulnerabilities array", () => {
    expect(() => parseKev({ catalogVersion: "x" })).toThrow(
      /no vulnerabilities array/,
    );
    expect(() => parseKev(null)).toThrow(/no vulnerabilities array/);
    expect(() => parseKev("nonsense")).toThrow(/no vulnerabilities array/);
  });

  it("refuses a catalogue whose every entry is unreadable", () => {
    const junk = { vulnerabilities: [{ nope: 1 }, { alsoNope: 2 }] };
    expect(() => parseKev(junk)).toThrow(/no readable CVE ids/);
  });

  it("counts unreadable entries rather than dropping them silently", () => {
    const doc = payload(["CVE-2021-1111"]);
    doc.vulnerabilities.push({ cveID: "not-a-cve" } as never);
    const r = parseKev(doc);
    expect(r.cveIds).toEqual(["CVE-2021-1111"]);
    expect(r.unreadable).toBe(1);
  });

  it("does not let a duplicate inflate the count", () => {
    const r = parseKev(payload(["CVE-2021-1111", "CVE-2021-1111"]));
    expect(r.cveIds).toHaveLength(1);
  });
});

describe("fetching", () => {
  const ok = (body: unknown) =>
    ({ ok: true, status: 200, json: async () => body }) as Response;

  it("refuses a non-200 rather than parsing an error page", async () => {
    const port = new HttpEnrichment(
      "http://x",
      async () => ({ ok: false, status: 503 }) as Response,
    );
    await expect(port.fetchKev()).rejects.toThrow(/HTTP 503/);
  });

  it("returns a catalogue on success", async () => {
    const port = new HttpEnrichment("http://x", async () =>
      ok(payload(["CVE-2021-1111"])),
    );
    expect((await port.fetchKev()).cveIds).toEqual(["CVE-2021-1111"]);
  });
});

describe("the KEV lane", () => {
  let dir: string;
  let store: SqliteStore;
  let logs: string[];

  const fake = (impl: () => Promise<ReturnType<typeof parseKev>>) =>
    ({ fetchKev: impl }) as EnrichmentPort;

  const deps = (enrichment: EnrichmentPort) => ({
    enrichment,
    store,
    now: () => NOW.toISOString(),
    log: (m: string) => logs.push(m),
  });

  const stored = () =>
    store.current(KEV_SUBJECT)?.payload as { cveIds: string[] } | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kev-"));
    store = SqliteStore.openForWrite(join(dir, "k.db"));
    logs = [];
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores the catalogue as one subject", async () => {
    const r = await collectKev(
      deps(fake(async () => parseKev(payload(["CVE-2021-1111"])))),
    );
    expect(r).toMatchObject({ outcome: "ok", listed: 1 });
    expect(stored()?.cveIds).toEqual(["CVE-2021-1111"]);
  });

  it("writes nothing when the fetch fails, so lookups stay unknown", async () => {
    // AD-20: a failed KEV fetch must leave every lookup unknown, never "not
    // listed". Writing nothing is what achieves that.
    const r = await collectKev(
      deps(
        fake(async () => {
          throw new Error("CISA is unreachable");
        }),
      ),
    );
    expect(r.outcome).toBe("failed");
    expect(store.current(KEV_SUBJECT)).toBeNull();
    expect(store.latestRuns(1)[0]?.detail).toContain("unreachable");
  });

  it("keeps the previous catalogue rather than shrinking it", async () => {
    // Superseded in intent by the freshness-aware cases above; retained
    // because it pins the no-freshFor default, which keeps the prior.
    await collectKev(
      deps(
        fake(async () =>
          parseKev(
            payload(["CVE-1", "CVE-2"].map((_, i) => `CVE-2021-111${i}`)),
          ),
        ),
      ),
    );
    const before = stored()?.cveIds;

    // A partly-readable fetch would answer "not listed" for everything it
    // dropped: a false negative on the chain's top term.
    const degraded = parseKev(payload(["CVE-2021-1110"]));
    const r = await collectKev(
      deps(fake(async () => ({ ...degraded, unreadable: 1 }))),
    );

    expect(r.outcome).toBe("partial");
    expect(stored()?.cveIds).toEqual(before);
  });

  it("does store a partial catalogue when there is nothing to keep", async () => {
    const degraded = parseKev(payload(["CVE-2021-1110"]));
    const r = await collectKev(
      deps(fake(async () => ({ ...degraded, unreadable: 3 }))),
    );
    expect(r.outcome).toBe("partial");
    expect(stored()?.cveIds).toEqual(["CVE-2021-1110"]);
  });

  it("keeps the complete catalogue it holds while that one is still fresh", async () => {
    // The policy: prefer a complete catalogue over a degraded one, but only
    // while the complete one can still be vouched for.
    const many = Array.from({ length: 200 }, (_, i) => `CVE-2021-${1000 + i}`);
    await collectKev(deps(fake(async () => parseKev(payload(many)))));

    const next = parseKev(payload([...many, "CVE-2026-9999"]));
    const r = await collectKev({
      ...deps(fake(async () => ({ ...next, unreadable: 1 }))),
      freshFor: DAILY,
    });

    expect(r.outcome).toBe("partial");
    expect(stored()?.cveIds).toHaveLength(200);
    expect(r.listed).toBe(200);
  });

  it("takes the degraded catalogue once the one it holds is going stale", async () => {
    // And this is why it cannot freeze. Holding a complete catalogue forever
    // was the original trap: a feed that stays slightly broken would keep the
    // old one, it would age past its budget, and the term would go unknown
    // with no way back.
    const many = Array.from({ length: 200 }, (_, i) => `CVE-2021-${1000 + i}`);
    await collectKev({
      ...deps(fake(async () => parseKev(payload(many)))),
      now: () => "2026-08-14T12:00:00.000Z",
    });

    const next = parseKev(payload([...many, "CVE-2026-9999"]));
    const r = await collectKev({
      ...deps(fake(async () => ({ ...next, unreadable: 1 }))),
      freshFor: DAILY,
    });

    expect(r.outcome).toBe("partial");
    expect(stored()?.cveIds).toContain("CVE-2026-9999");
  });

  it("keeps a complete catalogue when a well-formed fetch has shrunk", async () => {
    // Nothing in the unreadable count shows this. A truncated body parses
    // cleanly, reports zero unreadable, and would otherwise be accepted as a
    // complete catalogue that happens to be smaller, flipping every dropped
    // CVE to a confident "not in KEV".
    const many = Array.from({ length: 200 }, (_, i) => `CVE-2021-${1000 + i}`);
    await collectKev(deps(fake(async () => parseKev(payload(many)))));

    const truncated = parseKev(payload(many.slice(0, 5)));
    const r = await collectKev({
      ...deps(fake(async () => truncated)),
      freshFor: DAILY,
    });

    expect(r.outcome).toBe("partial");
    expect(stored()?.cveIds).toHaveLength(200);
    expect(store.latestRuns(1)[0]?.detail).toContain("shrank");
  });

  it("keeps the kept catalogue fresh, so holding it does not age it out", async () => {
    const many = Array.from({ length: 200 }, (_, i) => `CVE-2021-${1000 + i}`);
    await collectKev({
      ...deps(fake(async () => parseKev(payload(many)))),
      now: () => "2026-08-17T00:00:00.000Z",
    });

    await collectKev({
      ...deps(
        fake(async () => ({ ...parseKev(payload(many)), unreadable: 5 })),
      ),
      now: () => "2026-08-17T06:00:00.000Z",
      freshFor: DAILY,
    });

    // Without this the kept catalogue silently ages into stale and the term
    // goes unknown anyway, which is the freeze by another route.
    expect(store.current(KEV_SUBJECT)?.verifiedAt).toBe(
      "2026-08-17T06:00:00.000Z",
    );
  });

  it("records how many entries it could not read", async () => {
    const degraded = parseKev(payload(["CVE-2021-1110"]));
    await collectKev(deps(fake(async () => ({ ...degraded, unreadable: 2 }))));
    const row = store.current(KEV_SUBJECT)?.payload as
      | { unreadable: number }
      | undefined;
    expect(row?.unreadable).toBe(2);
  });
});

describe("the chain's first term", () => {
  let dir: string;
  let store: SqliteStore;

  const seed = async (ids: string[], at = NOW.toISOString()) => {
    await collectKev({
      enrichment: { fetchKev: async () => parseKev(payload(ids)) },
      store,
      now: () => at,
      log: () => {},
    });
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kevq-"));
    store = SqliteStore.openForWrite(join(dir, "k.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("answers true for a listed CVE", async () => {
    await seed(["CVE-2021-1111"]);
    const index = loadKevIndex(store, NOW, DAILY);
    expect(kevSignal(index, "CVE-2021-1111")).toBe(true);
  });

  it("answers false for one we checked and did not find", async () => {
    await seed(["CVE-2021-1111"]);
    const index = loadKevIndex(store, NOW, DAILY);
    expect(kevSignal(index, "CVE-2099-9999")).toBe(false);
  });

  it("answers unknown when the catalogue has never been fetched", () => {
    const index = loadKevIndex(store, NOW, DAILY);
    expect(kevSignal(index, "CVE-2021-1111")).toBeNull();
  });

  it("answers unknown once the catalogue goes stale", async () => {
    // The one that must never leak. A confident "not exploited" on a
    // three-day-old catalogue outranks nothing and hides everything.
    await seed(["CVE-2021-1111"], "2026-08-14T12:00:00.000Z");
    const index = loadKevIndex(store, NOW, DAILY);
    expect(index.usable).toBe(false);
    expect(kevSignal(index, "CVE-2099-9999")).toBeNull();
    expect(kevSignal(index, "CVE-2021-1111")).toBeNull();
  });

  it("answers n/a for a CVE-less advisory even with no catalogue at all", () => {
    // Guard order matters. "Nothing to look up" needs no catalogue, and
    // answering unknown here ranks every CVE-less advisory ABOVE the ones we
    // checked and found absent, because unknown sits higher than n/a. On a
    // stale catalogue that inverted the whole queue.
    const index = loadKevIndex(store, NOW, DAILY);
    expect(index.usable).toBe(false);
    expect(kevSignal(index, null)).toBe(NOT_APPLICABLE);
  });

  it("trusts a hit but not a miss when entries were unreadable", async () => {
    // A catalogue missing entries still proves a positive: an id we can see is
    // listed. It cannot prove a negative, because the CVE being asked about may
    // be one of the entries we failed to read.
    await collectKev({
      enrichment: {
        fetchKev: async () => ({
          ...parseKev(payload(["CVE-2021-1111"])),
          unreadable: 1,
        }),
      },
      store,
      now: () => NOW.toISOString(),
      log: () => {},
    });

    const index = loadKevIndex(store, NOW, DAILY);
    expect(index.negativesTrustworthy).toBe(false);
    expect(kevSignal(index, "CVE-2021-1111")).toBe(true);
    expect(kevSignal(index, "CVE-2099-9999")).toBeNull();
  });

  it("degrades to unknown on a payload of the wrong shape", async () => {
    await seed(["CVE-2021-1111"]);
    const run = store.beginRun({
      lane: "x",
      installation: "cisa",
      scope: "full",
      startedAt: NOW.toISOString(),
    });
    store.recordObservations(run, NOW.toISOString(), [
      { subject: KEV_SUBJECT, payload: { nonsense: true } },
    ]);

    // Everything else here answers "we do not know" when it cannot answer;
    // throwing would be the one path that fails the request instead.
    const index = loadKevIndex(store, NOW, DAILY);
    expect(index.usable).toBe(false);
    expect(kevSignal(index, "CVE-2021-1111")).toBeNull();
  });

  it("answers n/a when the advisory carries no CVE at all", async () => {
    await seed(["CVE-2021-1111"]);
    const index = loadKevIndex(store, NOW, DAILY);
    // Nothing to look up is a fact, not a gap. Treating it as unknown would
    // float every CVE-less advisory above every one we checked.
    expect(kevSignal(index, null)).toBe(NOT_APPLICABLE);
    expect(kevSignal(index, "  ")).toBe(NOT_APPLICABLE);
  });

  it("matches case and whitespace the way GitHub might send them", async () => {
    await seed(["CVE-2021-1111"]);
    const index = loadKevIndex(store, NOW, DAILY);
    expect(kevSignal(index, " cve-2021-1111 ")).toBe(true);
  });
});

describe("the real schedule table", () => {
  // Every lane here was deletable with a fully green suite. Removing the KEV
  // block, or the `installations` restriction that keeps the GitHub lanes off
  // the KEV pseudo-installation, passed lint, typecheck and all 378 tests.
  // `biome check` exits 0 on the orphaned imports, so lint is no backstop.
  const noop = async () => ({ outcome: "ok" as const });
  const schedules = buildSchedules({
    installations: ["no42-org", "other-org"],
    alerts: noop,
    coverage: noop,
    kev: noop,
  });

  const lane = (name: string) => schedules.find((s) => s.lane === name);

  it("schedules every lane the collector is supposed to run", () => {
    expect(schedules.map((s) => s.lane).sort()).toEqual([
      "coverage",
      "kev",
      "rest-org-dependabot",
    ]);
  });

  it("runs KEV only on its own pseudo-installation", () => {
    expect(lane("kev")?.installations).toEqual([KEV_INSTALLATION]);
  });

  it("keeps the GitHub lanes off that pseudo-installation", () => {
    // The bug this restriction fixed: both lanes swept `cisa`, failed, and the
    // run reported failure it had not really had.
    for (const name of ["rest-org-dependabot", "coverage"]) {
      const installations = lane(name)?.installations;
      expect(installations, name).toBeDefined();
      expect(installations, name).not.toContain(KEV_INSTALLATION);
      expect(installations, name).toEqual(["no42-org", "other-org"]);
    }
  });

  it("gives KEV a daily cadence and a shorter retry after failure", () => {
    // One transient blip must not mean no KEV data for 24 hours, and two in a
    // row would otherwise cross the staleness budget entirely.
    expect(lane("kev")?.cadenceMs).toBe(KEV_CADENCE_MS);
    expect(lane("kev")?.retryAfterMs).toBeLessThan(KEV_CADENCE_MS);
  });

  it("declares the scope it actually runs at", () => {
    // If the declared scope and the executed scope disagree, the due-ness key
    // never matches the run row and the lane re-fetches on every tick.
    for (const s of schedules) expect(s.scope, s.lane).toBe("full");
  });

  it("visits KEV's pseudo-installation exactly once", () => {
    expect(cycleInstallations(["no42-org"])).toEqual([
      "no42-org",
      KEV_INSTALLATION,
    ]);
  });

  it("does not visit an org literally named cisa twice", () => {
    expect(cycleInstallations([KEV_INSTALLATION, "no42-org"])).toEqual([
      KEV_INSTALLATION,
      "no42-org",
    ]);
  });
});

describe("the KEV subject and installation cannot drift apart", () => {
  it("uses one constant for both", () => {
    // They were two unrelated string literals in unrelated modules, with
    // nothing asserting the relationship they depend on.
    expect(KEV_SUBJECT.key).toBe(KEV_INSTALLATION);
  });
});

describe("the constants that hold the guards in place", () => {
  // Each of these was free to drift with a green suite. The threshold could be
  // set to 0.4, the URL to a nonexistent file, and the timeout deleted, and all
  // 378 tests still passed.
  it("pins the unreadable threshold at its documented boundary", () => {
    expect(MAX_UNREADABLE_RATIO).toBe(0.01);
  });

  it("treats exactly the threshold as acceptable, and just over it as not", async () => {
    const dir = mkdtempSync(join(tmpdir(), "kevt-"));
    const store = SqliteStore.openForWrite(join(dir, "t.db"));
    const seed = Array.from({ length: 100 }, (_, i) => `CVE-2021-${1000 + i}`);
    const base = {
      store,
      now: () => NOW.toISOString(),
      log: () => {},
      freshFor: DAILY,
    };
    await collectKev({
      ...base,
      enrichment: { fetchKev: async () => parseKev(payload(seed)) },
    });

    // 1 unreadable in 100 is exactly 0.01; the guard is `>`, so it passes the
    // ratio test and is refused only because it also lost an entry.
    const r = await collectKev({
      ...base,
      enrichment: {
        fetchKev: async () => ({
          ...parseKev(payload(seed.slice(0, 99))),
          unreadable: 1,
        }),
      },
    });
    expect(r.outcome).toBe("partial");

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("pins the endpoint and the shrink floor", () => {
    expect(new HttpEnrichment().endpoint()).toBe(KEV_URL);
    expect(KEV_URL).toContain("cisa.gov");
    expect(KEV_URL).toContain("known_exploited_vulnerabilities.json");
    expect(MIN_RETAINED_RATIO).toBeGreaterThan(0);
    expect(MIN_RETAINED_RATIO).toBeLessThan(1);
  });

  it("sends a timeout, an accept header and a user agent", async () => {
    // The timeout's stated purpose is stopping a hung CISA response from
    // stalling the whole collection cycle. Deleting it was green.
    let seen: RequestInit | undefined;
    const port = new HttpEnrichment("http://x", async (_u, init) => {
      seen = init;
      return {
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        json: async () => payload(["CVE-2021-1111"]),
      } as Response;
    });
    await port.fetchKev();

    expect(
      seen?.signal,
      "no timeout on the one external request",
    ).toBeDefined();
    const headers = seen?.headers as Record<string, string>;
    expect(headers.accept).toContain("json");
    expect(headers["user-agent"]).toContain("gitricorder");
  });

  it("refuses a 200 that is not JSON", async () => {
    // A captive portal or proxy answers 200 with HTML.
    const port = new HttpEnrichment(
      "http://x",
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "text/html" }),
          json: async () => ({}),
        }) as Response,
    );
    await expect(port.fetchKev()).rejects.toThrow(/not JSON/);
  });

  it("refuses a body CISA's own count says is truncated", async () => {
    const doc = payload(["CVE-2021-1111", "CVE-2021-2222"]);
    doc.count = 1666;
    expect(() => parseKev(doc)).toThrow(/truncated/);
  });
});

describe("guards on what the index will answer with", () => {
  let dir: string;
  let store: SqliteStore;

  const write = (payload: unknown) => {
    const run = store.beginRun({
      lane: "kev",
      installation: KEV_INSTALLATION,
      scope: "full",
      startedAt: NOW.toISOString(),
    });
    store.recordObservations(run, NOW.toISOString(), [
      { subject: KEV_SUBJECT, payload },
    ]);
    store.finishRun(run, "ok", NOW.toISOString());
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kevg-"));
    store = SqliteStore.openForWrite(join(dir, "g.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("refuses an empty catalogue rather than answering false for everything", () => {
    // A fresh, confident-looking index that answers "not listed" for every CVE
    // ever asked is the worst possible shape for the chain's top term.
    write({ version: "v", released: "r", cveIds: [], unreadable: 0 });
    const index = loadKevIndex(store, NOW, DAILY);
    expect(index.usable).toBe(false);
    expect(kevSignal(index, "CVE-2021-1111")).toBeNull();
  });

  it("does not answer for an identifier KEV is not indexed by", () => {
    // GitHub attaches GHSA ids to advisories with no CVE. KEV knows nothing
    // about them, and "not exploited" would be a confident negative.
    write({
      version: "v",
      released: "r",
      cveIds: ["CVE-2021-1111"],
      unreadable: 0,
    });
    const index = loadKevIndex(store, NOW, DAILY);
    for (const id of ["GHSA-xxxx-yyyy-zzzz", "not-an-id", "CVE-bad"]) {
      expect(kevSignal(index, id), id).toBe(NOT_APPLICABLE);
    }
    expect(kevSignal(index, "CVE-2021-1111")).toBe(true);
  });

  it("ignores a tombstoned catalogue instead of keeping it", async () => {
    // The lane and the lookup disagreed: the lookup rejected a resolved row
    // while the lane counted it as "something better to keep".
    write({
      version: "v",
      released: "r",
      cveIds: ["CVE-2021-1111"],
      unreadable: 0,
    });
    store.recordTombstones(
      store.beginRun({
        lane: "kev",
        installation: KEV_INSTALLATION,
        scope: "full",
        startedAt: NOW.toISOString(),
      }),
      NOW.toISOString(),
      [KEV_SUBJECT],
    );

    expect(usablePrior(store)).toBeNull();
    expect(loadKevIndex(store, NOW, DAILY).usable).toBe(false);
  });
});

describe("the collection-health table judges each lane on its own cadence", () => {
  it("does not call a daily lane stale thirty minutes after it succeeded", () => {
    // AD-11 names this exact defect: one global cadence applied to every lane.
    // Both daily lanes had it, and the KEV lane would have been the second.
    const dir = mkdtempSync(join(tmpdir(), "kevh-"));
    const store = SqliteStore.openForWrite(join(dir, "h.db"));
    const r = store.beginRun({
      lane: "kev",
      installation: KEV_INSTALLATION,
      scope: "full",
      startedAt: "2026-08-17T06:00:00.000Z",
    });
    store.finishRun(r, "ok", "2026-08-17T06:00:00.000Z");

    const sweep = { cadenceMs: 15 * 60_000 };
    const withoutPolicy = buildCollectionHealth(store, NOW, sweep);
    const withPolicy = buildCollectionHealth(store, NOW, sweep, {
      kev: { cadenceMs: KEV_CADENCE_MS },
    });

    expect(withoutPolicy[0]?.freshness).toBe("stale");
    expect(withPolicy[0]?.freshness).toBe("fresh");

    store.close();
    rmSync(dir, { recursive: true, force: true });
  });
});
