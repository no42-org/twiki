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
import {
  collectKev,
  KEV_CADENCE_MS,
  KEV_INSTALLATION,
} from "../src/tricorder/collect/kev.js";
import { kevSignal, loadKevIndex } from "../src/tricorder/kev-lookup.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { buildCollectionHealth } from "../src/tricorder/web/view.js";
import {
  buildSchedules,
  cycleInstallations,
  parseKevUrl,
} from "../src/tricorder.js";
import { FakeEnrichmentPort } from "./fakes.js";

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

describe("the KEV lane stores only what it can vouch for", () => {
  let dir: string;
  let store: SqliteStore;
  let logs: string[];

  const port = (over: Partial<FakeEnrichmentPort> = {}) => {
    const p = new FakeEnrichmentPort();
    Object.assign(p, over);
    return p;
  };

  const deps = (enrichment: FakeEnrichmentPort, now = NOW.toISOString()) => ({
    enrichment,
    store,
    now: () => now,
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

  it("stores a catalogue it read in full", async () => {
    const r = await collectKev(deps(port({ cveIds: ["CVE-2021-1111"] })));
    expect(r).toMatchObject({ outcome: "ok", listed: 1, unreadable: 0 });
    expect(stored()?.cveIds).toEqual(["CVE-2021-1111"]);
  });

  it("stores nothing at all when any entry was unreadable", async () => {
    const r = await collectKev(
      deps(port({ cveIds: ["CVE-2021-1111"], unreadable: 1 })),
    );
    expect(r.outcome).toBe("partial");
    expect(store.current(KEV_SUBJECT)).toBeNull();
    expect(store.latestRuns(1)[0]?.detail).toContain("stored nothing");
  });

  it("leaves a good catalogue alone rather than replacing it with a worse one", async () => {
    await collectKev(
      deps(port({ cveIds: ["CVE-2021-1111", "CVE-2021-2222"] })),
    );
    const r = await collectKev(
      deps(port({ cveIds: ["CVE-2021-1111"], unreadable: 1 })),
    );
    expect(r.outcome).toBe("partial");
    expect(stored()?.cveIds).toHaveLength(2);
  });

  it("does not keep a degraded feed alive by topping up its freshness", async () => {
    // The regression this rewrite exists to remove. The previous version
    // touched the prior on every kept run, resetting the clock its own escape
    // hatch read, so the catalogue froze permanently AND rendered fresh with
    // trustworthy negatives. Ten degraded cycles: verified_at must not move.
    await collectKev(
      deps(port({ cveIds: ["CVE-2021-1111"] }), "2026-08-01T00:00:00.000Z"),
    );
    const first = store.current(KEV_SUBJECT)?.verifiedAt;

    for (let day = 2; day <= 11; day++) {
      await collectKev(
        deps(
          port({ cveIds: ["CVE-2021-1111", "CVE-2026-9999"], unreadable: 1 }),
          `2026-08-${String(day).padStart(2, "0")}T00:00:00.000Z`,
        ),
      );
    }

    expect(store.current(KEV_SUBJECT)?.verifiedAt).toBe(first);
    // And because it stopped being confirmed, the term goes unknown rather
    // than answering confidently from a ten-day-old list.
    const index = loadKevIndex(
      store,
      new Date("2026-08-11T00:00:00.000Z"),
      DAILY,
    );
    expect(index.usable).toBe(false);
    expect(kevSignal(index, "CVE-2099-9999")).toBeNull();
  });

  it("heals the moment one clean fetch arrives", async () => {
    await collectKev(deps(port({ cveIds: ["CVE-2021-1111"], unreadable: 1 })));
    expect(store.current(KEV_SUBJECT)).toBeNull();

    await collectKev(deps(port({ cveIds: ["CVE-2021-1111"] })));
    expect(stored()?.cveIds).toEqual(["CVE-2021-1111"]);
  });

  it("writes nothing when the fetch fails, so lookups stay unknown", async () => {
    const r = await collectKev(
      deps(port({ failWith: new Error("CISA is unreachable") })),
    );
    expect(r.outcome).toBe("failed");
    expect(store.current(KEV_SUBJECT)).toBeNull();
    expect(store.latestRuns(1)[0]?.detail).toContain("unreachable");
  });

  it("does not rewrite a finished run as failed if logging throws", async () => {
    // finishRun already committed `ok`; a throw afterwards must not turn a
    // successful run into a fetch failure that never happened.
    const r = await collectKev({
      ...deps(port({ cveIds: ["CVE-2021-1111"] })),
      log: () => {
        throw new Error("logging blew up");
      },
    });
    expect(r.outcome).toBe("failed");
    expect(store.latestRuns(1)[0]?.outcome).toBe("ok");
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

  it("can only ever be asked about a catalogue that was read in full", async () => {
    // The lane writes nothing when any entry was unreadable, so a partial
    // catalogue cannot reach the store. That is what makes a miss safe to
    // answer as false: the whole notion of an untrustworthy negative is gone.
    await seed(["CVE-2021-1111"]);
    const index = loadKevIndex(store, NOW, DAILY);
    expect(kevSignal(index, "CVE-2021-1111")).toBe(true);
    expect(kevSignal(index, "CVE-2099-9999")).toBe(false);
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
  it("refuses a KEV url that is not https, rather than silently defaulting", () => {
    // Every neighbouring setting validates. A typo here would revert to CISA's
    // feed and look like a working mirror until someone read the logs.
    expect(() => parseKevUrl("not a url")).toThrow(/not a URL/);
    expect(() => parseKevUrl("http://mirror.example/kev.json")).toThrow(
      /must be https/,
    );
    expect(parseKevUrl("  ")).toBeUndefined();
    expect(parseKevUrl(undefined)).toBeUndefined();
    expect(parseKevUrl("https://mirror.example/kev.json")).toBe(
      "https://mirror.example/kev.json",
    );
  });

  it("refuses a body the declared length says is too large", async () => {
    const port = new HttpEnrichment(
      "https://x/k.json",
      async () =>
        ({
          ok: true,
          status: 200,
          headers: new Headers({
            "content-type": "application/json",
            "content-length": String(64 * 1024 * 1024),
          }),
          json: async () => payload(["CVE-2021-1111"]),
        }) as Response,
    );
    await expect(port.fetchKev()).rejects.toThrow(/too large/);
  });

  it("pins the endpoint", () => {
    expect(new HttpEnrichment().endpoint()).toBe(KEV_URL);
    expect(KEV_URL).toContain("cisa.gov");
    expect(KEV_URL).toContain("known_exploited_vulnerabilities.json");
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

  it("refuses a stored list that is not made of CVE ids", () => {
    // A fresh, confident-looking index built from junk would answer false for
    // every real CVE asked, which is the worst shape for the chain's top term.
    write({
      version: "v",
      released: "r",
      cveIds: ["GHSA-xxxx-yyyy-zzzz", "not-an-id"],
    });
    const index = loadKevIndex(store, NOW, DAILY);
    expect(index.usable).toBe(false);
    expect(kevSignal(index, "CVE-2021-1111")).toBeNull();
  });

  it("refuses a list where only some entries are CVE ids", () => {
    write({
      version: "v",
      released: "r",
      cveIds: ["CVE-2021-1111", "garbage"],
    });
    expect(loadKevIndex(store, NOW, DAILY).usable).toBe(false);
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

  it("ignores a tombstoned catalogue", () => {
    write({ version: "v", released: "r", cveIds: ["CVE-2021-1111"] });
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
