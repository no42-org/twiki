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
import { HttpEnrichment, parseKev } from "../src/enrich/kev.js";
import type { EnrichmentPort } from "../src/enrich/port.js";
import { collectKev } from "../src/tricorder/collect/kev.js";
import { kevSignal, loadKevIndex } from "../src/tricorder/kev-lookup.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";

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

  it("accepts a fetch with one bad entry rather than freezing forever", async () => {
    // The trap this replaced: rejecting on ANY unreadable entry meant one
    // malformed record among 1666 discarded the fetch, the next day's fetch
    // contained the same record, and the catalogue never updated again. Two
    // cadences later the chain's top term went permanently unknown with no way
    // back.
    const many = Array.from({ length: 200 }, (_, i) => `CVE-2021-${1000 + i}`);
    await collectKev(deps(fake(async () => parseKev(payload(many)))));

    const next = parseKev(payload([...many, "CVE-2026-9999"]));
    const r = await collectKev(
      deps(fake(async () => ({ ...next, unreadable: 1 }))),
    );

    expect(r.outcome).toBe("partial");
    expect(stored()?.cveIds).toContain("CVE-2026-9999");
  });

  it("still refuses a fetch that lost a large share of the catalogue", async () => {
    const many = Array.from({ length: 200 }, (_, i) => `CVE-2021-${1000 + i}`);
    await collectKev(deps(fake(async () => parseKev(payload(many)))));

    const gutted = parseKev(payload(["CVE-2021-1000"]));
    const r = await collectKev(
      deps(fake(async () => ({ ...gutted, unreadable: 199 }))),
    );

    expect(r.outcome).toBe("partial");
    expect(stored()?.cveIds).toHaveLength(200);
    // And says how many it kept, rather than reporting zero for a run that
    // kept a full catalogue.
    expect(r.listed).toBe(200);
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
