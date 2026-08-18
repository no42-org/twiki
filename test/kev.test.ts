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
import type { KevFetchOutcome } from "../src/enrich/port.js";

/** Unwrap a fresh outcome, failing legibly on a 304 the test did not expect. */
function catalogueOf(outcome: KevFetchOutcome) {
  if (outcome.kind !== "fresh") {
    throw new Error(`expected a fresh catalogue, got ${outcome.kind}`);
  }
  return outcome.catalogue;
}

import { collectKev, KEV_INSTALLATION } from "../src/tricorder/collect/kev.js";
import { kevSignal, loadKevIndex } from "../src/tricorder/kev-lookup.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { buildCollectionHealth } from "../src/tricorder/web/view.js";
import {
  buildSchedules,
  cycleInstallations,
  KEV_CADENCE_MS,
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
    await expect(port.fetchKev(null)).rejects.toThrow(/HTTP 503/);
  });

  it("returns a catalogue on success", async () => {
    const port = new HttpEnrichment("http://x", async () =>
      ok(payload(["CVE-2021-1111"])),
    );
    expect(catalogueOf(await port.fetchKev(null)).cveIds).toEqual([
      "CVE-2021-1111",
    ]);
  });

  it("sends both validators and answers not_modified on a 304", async () => {
    const seen: Record<string, string>[] = [];
    const port = new HttpEnrichment("http://x", async (_url, init) => {
      seen.push({ ...(init?.headers as Record<string, string>) });
      return { ok: false, status: 304 } as Response;
    });

    const outcome = await port.fetchKev({
      etag: 'W/"abc"',
      lastModified: "Mon, 17 Aug 2026 17:00:00 GMT",
    });

    expect(outcome.kind).toBe("not_modified");
    // Both, because RFC 9110 prefers If-None-Match while a CDN honouring
    // only Last-Modified still gets its chance to answer 304.
    expect(seen[0]?.["if-none-match"]).toBe('W/"abc"');
    expect(seen[0]?.["if-modified-since"]).toBe(
      "Mon, 17 Aug 2026 17:00:00 GMT",
    );
  });

  it("captures the response validators on a 200", async () => {
    const port = new HttpEnrichment("http://x", async () => {
      const res = ok(payload(["CVE-2021-1111"]));
      return {
        ...res,
        headers: new Headers({
          etag: 'W/"v2"',
          "content-type": "application/json",
          "last-modified": "Tue, 18 Aug 2026 06:00:00 GMT",
        }),
      } as Response;
    });

    const outcome = await port.fetchKev(null);
    expect(outcome.kind).toBe("fresh");
    expect(outcome.validator).toEqual({
      etag: 'W/"v2"',
      lastModified: "Tue, 18 Aug 2026 06:00:00 GMT",
    });
  });

  it("refuses a 304 it never asked for", async () => {
    // A broken proxy confirming a validator we never sent: honouring it
    // would report not_modified with nothing to be unmodified relative to.
    const port = new HttpEnrichment(
      "http://x",
      async () => ({ ok: false, status: 304 }) as Response,
    );
    await expect(port.fetchKev(null)).rejects.toThrow(/unconditional/);
  });

  it("an all-null validator does not make the request conditional", async () => {
    // Truthy but empty: no header goes on the wire, so a 304 back is just as
    // unsolicited as with no validator at all. Accepting it would confirm
    // the catalogue against nothing, sweep after sweep - the self-sustaining
    // freeze this lane was rebuilt to kill.
    const port = new HttpEnrichment(
      "http://x",
      async () => ({ ok: false, status: 304 }) as Response,
    );
    await expect(
      port.fetchKev({ etag: null, lastModified: null }),
    ).rejects.toThrow(/unconditional/);
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

  it("a throwing logger cannot fail the lane", async () => {
    // The first version of this test pinned the bug instead of the contract:
    // it accepted outcome "failed" for a run whose row said ok, which made a
    // TRICORDER_ONCE cron exit non-zero on a collection that delivered
    // everything. The logger is wrapped now, so an EPIPE on a closed stdout
    // changes nothing at all.
    const r = await collectKev({
      ...deps(port({ cveIds: ["CVE-2021-1111"] })),
      log: () => {
        throw new Error("logging blew up");
      },
    });
    expect(r.outcome).toBe("ok");
    expect(r.listed).toBe(1);
    expect(store.latestRuns(1)[0]?.outcome).toBe("ok");
  });
});

describe("the KEV conditional re-fetch (AD-25)", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kevc-"));
    store = SqliteStore.openForWrite(join(dir, "kc.db"));
  });
  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const depsFor = (p: FakeEnrichmentPort, now: string) => ({
    enrichment: p,
    store,
    now: () => now,
    log: () => {},
  });

  it("a 304 confirms the stored catalogue: fresh, intact, run ok", async () => {
    const p = new FakeEnrichmentPort();
    p.cveIds = ["CVE-2021-44228"];
    await collectKev(depsFor(p, "2026-08-18T06:00:00.000Z"));
    const before = store.current(KEV_SUBJECT);

    p.notModified = true;
    const r = await collectKev(depsFor(p, "2026-08-18T07:00:00.000Z"));

    expect(r.outcome).toBe("ok");
    expect(r.listed).toBe(1);
    // The second fetch was conditional: it carried the stored validator.
    expect(p.cachedSeen[1]).toEqual({ etag: 'W/"kev-1"', lastModified: null });
    const after = store.current(KEV_SUBJECT);
    // Catalogue intact, verified_at advanced: a quiet feed renders fresh
    // rather than stale, with no observation row written (AD-3).
    expect(after?.payload).toEqual(before?.payload);
    expect(after?.observedAt).toBe(before?.observedAt);
    expect(after?.verifiedAt).toBe("2026-08-18T07:00:00.000Z");
    expect(store.latestRuns(1)[0]?.detail).toContain("not modified");
  });

  it("fetches unconditionally while no stored catalogue exists", async () => {
    // A leftover validator with nothing behind it must not be sent: a 304
    // would confirm a catalogue we do not hold, and the lane would finish ok
    // holding nothing.
    store.saveValidator(
      KEV_INSTALLATION,
      "https://fake.test/kev.json",
      { etag: 'W/"stale"', lastModified: null, tokenGen: "none" },
      "2026-08-17T00:00:00.000Z",
    );
    const p = new FakeEnrichmentPort();
    p.cveIds = ["CVE-2021-44228"];
    p.notModified = true; // would 304 if a validator were sent

    const r = await collectKev(depsFor(p, "2026-08-18T06:00:00.000Z"));

    expect(p.cachedSeen[0]).toBeNull();
    expect(r).toMatchObject({ outcome: "ok", listed: 1 });
  });

  it("never saves a validator that cannot condition a request", async () => {
    // A 200 with neither ETag nor Last-Modified (some mirrors send none).
    // Storing the all-null pair would make the next sweep count as "cached"
    // while sending no header, the state a broken proxy's 304 exploits.
    const p = new FakeEnrichmentPort();
    p.cveIds = ["CVE-2021-44228"];
    p.validator = { etag: null, lastModified: null };

    const r = await collectKev(depsFor(p, "2026-08-18T06:00:00.000Z"));

    expect(r.outcome).toBe("ok");
    expect(
      store.loadValidator(KEV_INSTALLATION, "https://fake.test/kev.json"),
    ).toBeNull();
  });

  it("purges a stale validator when a fresh 200 carried none", async () => {
    // The stored validator matches the PREVIOUS body; the store now holds a
    // NEWER catalogue. If the feed later reverted to the old body, a 304
    // against the stale validator would confirm the newer catalogue as
    // current while the origin serves the older one.
    const p = new FakeEnrichmentPort();
    p.cveIds = ["CVE-2021-44228"];
    await collectKev(depsFor(p, "2026-08-18T06:00:00.000Z"));
    expect(
      store.loadValidator(KEV_INSTALLATION, "https://fake.test/kev.json"),
    ).not.toBeNull();

    p.cveIds = ["CVE-2021-44228", "CVE-2026-0001"];
    p.validator = { etag: null, lastModified: null };
    await collectKev(depsFor(p, "2026-08-18T07:00:00.000Z"));

    expect(
      store.loadValidator(KEV_INSTALLATION, "https://fake.test/kev.json"),
    ).toBeNull();
  });

  it("a degraded fetch leaves the validator alone with the catalogue", async () => {
    // The feed changed (we read a new degraded body), so the old validator
    // now misses: the next conditional fetch gets a 200 and a clean chance.
    // Overwriting it with the degraded body's validator would 304-confirm a
    // body we refused to store.
    const p = new FakeEnrichmentPort();
    p.cveIds = ["CVE-2021-44228"];
    await collectKev(depsFor(p, "2026-08-18T06:00:00.000Z"));

    p.unreadable = 3;
    p.validator = { etag: 'W/"kev-2"', lastModified: null };
    await collectKev(depsFor(p, "2026-08-18T07:00:00.000Z"));

    expect(
      store.loadValidator(KEV_INSTALLATION, "https://fake.test/kev.json"),
    ).toEqual({ etag: 'W/"kev-1"', lastModified: null, tokenGen: "none" });
  });
});

describe("the chain's first term", () => {
  let dir: string;
  let store: SqliteStore;

  const seed = async (ids: string[], at = NOW.toISOString()) => {
    await collectKev({
      enrichment: {
        endpoint: () => "https://fake.test/kev.json",
        fetchKev: async () => ({
          kind: "fresh" as const,
          catalogue: parseKev(payload(ids)),
          validator: { etag: null, lastModified: null },
        }),
      },
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
    updatePrs: noop,
    issues: noop,
    updateStatuses: noop,
    actionsRuns: { installation: "no42-org", run: noop },
  });

  const lane = (name: string) => schedules.find((s) => s.lane === name);

  it("schedules every lane the collector is supposed to run", () => {
    expect(schedules.map((s) => s.lane).sort()).toEqual([
      "coverage",
      "graphql-issues",
      "graphql-update-prs",
      "graphql-update-status",
      "kev",
      "rest-actions-runs",
      "rest-org-dependabot",
    ]);
  });

  it("omits the update-PR lane when no bot actors are configured", () => {
    // AD-19: the actor set is configuration with no default, so an unset
    // config genuinely has no lane. The entrypoint logs the absence loudly;
    // this pins that the schedule table itself does not invent one.
    const without = buildSchedules({
      installations: ["no42-org"],
      alerts: noop,
      coverage: noop,
      kev: noop,
      updatePrs: null,
      issues: noop,
      updateStatuses: noop,
      actionsRuns: null,
    });
    expect(without.map((s) => s.lane)).not.toContain("graphql-update-prs");
    // Same rule for the Actions lane: unset means absent, and the
    // entrypoint says so, rather than a lane silently running on a guess.
    expect(without.map((s) => s.lane)).not.toContain("rest-actions-runs");
  });

  it("runs KEV only on its own pseudo-installation", () => {
    expect(lane("kev")?.installations).toEqual([KEV_INSTALLATION]);
  });

  it("runs the Actions lane only on its opted-in installation", () => {
    // Story 15: one installation, measured, before story 16 commits the
    // whole allowlist to the lane with the hard per-repo floor.
    expect(lane("rest-actions-runs")?.installations).toEqual(["no42-org"]);
  });

  it("keeps the GitHub lanes off that pseudo-installation", () => {
    // The bug this restriction fixed: both lanes swept `cisa`, failed, and the
    // run reported failure it had not really had.
    for (const name of [
      "rest-org-dependabot",
      "coverage",
      "graphql-update-prs",
      "graphql-issues",
      "graphql-update-status",
    ]) {
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

  it("caps the body even when no length is declared", async () => {
    // Chunked and gzip-encoded responses carry no content-length, so the
    // header check alone left res.json() buffering an unbounded body while
    // the comment claimed otherwise. Real Response, real stream, tiny cap.
    const big = JSON.stringify(payload(["CVE-2021-1111"])).repeat(50);
    const port = new HttpEnrichment(
      "https://x/k.json",
      async () =>
        new Response(big, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      256,
    );
    await expect(port.fetchKev(null)).rejects.toThrow(/too large/);
  });

  it("still parses a streamed body under the cap", async () => {
    const body = JSON.stringify(payload(["CVE-2021-1111"]));
    const port = new HttpEnrichment(
      "https://x/k.json",
      async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      1024 * 1024,
    );
    expect(catalogueOf(await port.fetchKev(null)).cveIds).toEqual([
      "CVE-2021-1111",
    ]);
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
    await expect(port.fetchKev(null)).rejects.toThrow(/too large/);
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
    await port.fetchKev(null);

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
    await expect(port.fetchKev(null)).rejects.toThrow(/not JSON/);
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
