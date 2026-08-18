/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alertSubject, repositorySubject } from "../src/core/subject.js";
import type { RunRef } from "../src/tricorder/store/port.js";
import { SCHEMA_VERSION } from "../src/tricorder/store/schema.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";

const REPO = { owner: "no42-org", name: "twiki" };
const T1 = "2026-08-16T10:00:00.000Z";
const T2 = "2026-08-16T10:15:00.000Z";
const T3 = "2026-08-16T10:30:00.000Z";

describe("SqliteStore", () => {
  let dir: string;
  let path: string;
  let store: SqliteStore;
  let run: RunRef;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tricorder-"));
    path = join(dir, "test.db");
    store = SqliteStore.openForWrite(path);
    run = store.beginRun({
      lane: "rest-org",
      installation: "no42-org",
      scope: "full",
      startedAt: T1,
    });
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed by a test
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("migrates a fresh database to the current schema version", () => {
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
  });

  it("is idempotent when reopened: migrations are forward-only", () => {
    store.close();
    const again = SqliteStore.openForWrite(path);
    expect(again.schemaVersion()).toBe(SCHEMA_VERSION);
    again.close();
  });

  it("sets WAL, and WAL persists across a reopen", () => {
    // The -wal sidecar is the externally visible signal that WAL is on, and it
    // is what two containers share under AD-13.
    store.recordObservations(run, T1, [
      { subject: repositorySubject(REPO), payload: { alerts: 1 } },
    ]);
    expect(existsSync(`${path}-wal`)).toBe(true);

    store.close();
    const again = SqliteStore.openForWrite(path);
    again.recordObservations(
      again.beginRun({
        lane: "l",
        installation: "i",
        scope: "full",
        startedAt: T2,
      }),
      T2,
      [{ subject: repositorySubject(REPO), payload: { alerts: 2 } }],
    );
    expect(existsSync(`${path}-wal`)).toBe(true);
    again.close();
  });

  describe("observations and the projection (AD-3)", () => {
    it("writes an observation and advances current state together", () => {
      const subject = repositorySubject(REPO);
      store.recordObservations(run, T1, [{ subject, payload: { alerts: 3 } }]);

      const current = store.current(subject);
      expect(current?.payload).toEqual({ alerts: 3 });
      expect(current?.state).toBe("present");
      expect(current?.verifiedAt).toBe(T1);
    });

    it("keeps observed_at at the last CHANGE while verified_at advances (AD-11)", () => {
      const subject = repositorySubject(REPO);
      store.recordObservations(run, T1, [
        { subject, payload: { alerts: 3 }, observedAt: T1 },
      ]);
      // Same value seen again later: confirmed, not changed.
      store.recordObservations(run, T2, [{ subject, payload: { alerts: 3 } }]);

      const current = store.current(subject);
      expect(current?.observedAt).toBe(T1);
      expect(current?.verifiedAt).toBe(T2);
    });

    it("touchVerified advances freshness without writing an observation", () => {
      const subject = repositorySubject(REPO);
      store.recordObservations(run, T1, [
        { subject, payload: { alerts: 3 }, observedAt: T1 },
      ]);

      store.touchVerified([subject], T2);

      const current = store.current(subject);
      expect(current?.verifiedAt).toBe(T2);
      expect(current?.observedAt).toBe(T1);
      // This is the 304 path: a quiet healthy repo must read fresh, not stale.
    });

    it("returns every subject of a type, each with its freshness", () => {
      store.recordObservations(run, T1, [
        {
          subject: alertSubject("dependabot_alert", REPO, 1),
          payload: { severity: "high" },
        },
        {
          subject: alertSubject("dependabot_alert", REPO, 2),
          payload: { severity: "low" },
        },
      ]);

      const all = store.currentByType("dependabot_alert");
      expect(all).toHaveLength(2);
      expect(all.every((a) => a.verifiedAt === T1)).toBe(true);
    });
  });

  describe("regressions found in review", () => {
    it("advances observed_at when the payload actually changes", () => {
      const subject = repositorySubject(REPO);
      store.recordObservations(run, T1, [{ subject, payload: { alerts: 1 } }]);
      // No explicit observedAt: the store must notice the value differs.
      store.recordObservations(run, T2, [{ subject, payload: { alerts: 9 } }]);

      const current = store.current(subject);
      expect(current?.payload).toEqual({ alerts: 9 });
      expect(current?.observedAt).toBe(T2);
      expect(current?.verifiedAt).toBe(T2);
    });

    it("treats a state change as a change too", () => {
      const subject = alertSubject("dependabot_alert", REPO, 1);
      store.recordObservations(run, T1, [{ subject, payload: { s: "high" } }]);
      store.recordObservations(run, T2, [
        { subject, payload: { s: "high" }, state: "resolved" },
      ]);

      expect(store.current(subject)?.observedAt).toBe(T2);
    });

    it("keeps the projection monotonic when a slow run lands late", () => {
      const subject = repositorySubject(REPO);
      // A hot run writes the fresher value first.
      store.recordObservations(run, T3, [{ subject, payload: { alerts: 9 } }]);
      // A full run that started earlier lands afterwards with older data.
      store.recordObservations(run, T2, [{ subject, payload: { alerts: 1 } }]);

      const current = store.current(subject);
      expect(current?.payload).toEqual({ alerts: 9 });
      expect(current?.verifiedAt).toBe(T3);
    });

    it("never moves freshness backwards via touchVerified", () => {
      const subject = repositorySubject(REPO);
      store.recordObservations(run, T3, [{ subject, payload: { alerts: 1 } }]);
      store.touchVerified([subject], T1);

      expect(store.current(subject)?.verifiedAt).toBe(T3);
    });

    it("normalises timestamps so TEXT comparison matches chronology", () => {
      const subject = repositorySubject(REPO);
      // Same instant, three shapes a real lane could produce.
      store.recordObservations(run, "2026-08-16T10:00:00Z", [
        { subject, payload: { alerts: 1 } },
      ]);
      expect(store.current(subject)?.verifiedAt).toBe(
        "2026-08-16T10:00:00.000Z",
      );

      store.touchVerified([subject], "2026-08-16T11:00:00+00:00");
      expect(store.current(subject)?.verifiedAt).toBe(
        "2026-08-16T11:00:00.000Z",
      );
    });

    it("normalises run timestamps too, not just observations", () => {
      store.finishRun(run, "ok", "2026-08-16T12:00:00Z");
      const r = store.latestRuns(1)[0];
      expect(r?.startedAt).toBe("2026-08-16T10:00:00.000Z");
      expect(r?.verifiedAt).toBe("2026-08-16T12:00:00.000Z");
    });

    it("rejects a timestamp it cannot order", () => {
      const subject = repositorySubject(REPO);
      expect(() =>
        store.recordObservations(run, "last tuesday", [
          { subject, payload: {} },
        ]),
      ).toThrow(/not a usable timestamp/);
    });

    it("refuses to write to a database created by a newer build", () => {
      store.close();
      const raw = SqliteStore.openForWrite(path);
      // biome-ignore lint/suspicious/noExplicitAny: reaching past the port on purpose
      (raw as any).db.exec("PRAGMA user_version = 99");
      raw.close();

      expect(() => SqliteStore.openForWrite(path)).toThrow(/only knows/);
    });

    it("explains itself when the database does not exist yet", () => {
      expect(() => SqliteStore.openForRead(join(dir, "absent.db"))).toThrow(
        /Start the collector/,
      );
    });
  });

  describe("tombstones (AD-23)", () => {
    it("marks a subject resolved rather than deleting it", () => {
      const subject = alertSubject("dependabot_alert", REPO, 1);
      store.recordObservations(run, T1, [
        { subject, payload: { severity: "high" } },
      ]);

      store.recordTombstones(run, T2, [subject]);

      const current = store.current(subject);
      expect(current?.state).toBe("resolved");
      expect(current?.verifiedAt).toBe(T2);
    });

    it("does not tombstone a subject it has never seen", () => {
      const unseen = alertSubject("dependabot_alert", REPO, 99);
      store.recordTombstones(run, T2, [unseen]);
      expect(store.current(unseen)).toBeNull();
    });

    it("re-confirms an already resolved subject without a second tombstone", () => {
      const subject = alertSubject("dependabot_alert", REPO, 1);
      store.recordObservations(run, T1, [
        { subject, payload: { severity: "high" } },
      ]);
      store.recordTombstones(run, T2, [subject]);
      store.recordTombstones(run, T3, [subject]);

      const current = store.current(subject);
      expect(current?.state).toBe("resolved");
      // Freshness still advances. Freezing it at the tombstone would make a
      // correctly-resolved alert read as increasingly stale data.
      expect(current?.verifiedAt).toBe(T3);
      // The change itself happened once, at T2.
      expect(current?.observedAt).toBe(T2);
    });
  });

  describe("retention (AD-4)", () => {
    it("trims old observations but never a projection row", () => {
      const subject = repositorySubject(REPO);
      store.recordObservations(run, T1, [{ subject, payload: { alerts: 1 } }]);
      store.recordObservations(run, T2, [{ subject, payload: { alerts: 2 } }]);

      const removed = store.trimObservations(T3);

      expect(removed).toBe(2);
      // The projection survives even when its only observation was trimmed.
      expect(store.current(subject)?.payload).toEqual({ alerts: 2 });
    });
  });

  describe("runs (AD-16)", () => {
    it("records scope, so a hot run is never mistaken for a full one", () => {
      store.finishRun(run, "ok", T2);
      const hot = store.beginRun({
        lane: "graphql",
        installation: "no42-org",
        scope: "hot",
        startedAt: T2,
      });
      store.finishRun(hot, "partial", T3, "budget exhausted");

      const runs = store.latestRuns(10);
      expect(runs[0]?.scope).toBe("hot");
      expect(runs[0]?.outcome).toBe("partial");
      expect(runs[0]?.detail).toBe("budget exhausted");
      expect(runs[1]?.scope).toBe("full");
    });

    it("starts a run as partial, so an aborted run is never read as ok", () => {
      const runs = store.latestRuns(1);
      expect(runs[0]?.outcome).toBe("partial");
    });
  });

  describe("validators (AD-25)", () => {
    it("round-trips a validator and its token generation", () => {
      store.saveValidator(
        "no42-org",
        "https://api.github.com/orgs/no42-org/dependabot/alerts",
        { etag: 'W/"abc"', lastModified: null, tokenGen: "gen-1" },
        T1,
      );

      const v = store.loadValidator(
        "no42-org",
        "https://api.github.com/orgs/no42-org/dependabot/alerts",
      );
      expect(v).toEqual({
        etag: 'W/"abc"',
        lastModified: null,
        tokenGen: "gen-1",
      });
    });

    it("returns null for an unknown request", () => {
      expect(
        store.loadValidator("no42-org", "https://example.invalid/x"),
      ).toBeNull();
    });
  });

  describe("read-only handle (AD-14, AD-26)", () => {
    it("can read what the collector wrote", () => {
      const subject = repositorySubject(REPO);
      store.recordObservations(run, T1, [{ subject, payload: { alerts: 3 } }]);

      const ro = SqliteStore.openForRead(path);
      expect(ro.current(subject)?.payload).toEqual({ alerts: 3 });
      ro.close();
    });

    it("refuses every write method", () => {
      const ro = SqliteStore.openForRead(path);
      const subject = repositorySubject(REPO);

      expect(() =>
        ro.beginRun({
          lane: "x",
          installation: "y",
          scope: "full",
          startedAt: T1,
        }),
      ).toThrow(/writable store handle/);
      expect(() =>
        ro.recordObservations(run, T1, [{ subject, payload: {} }]),
      ).toThrow(/writable store handle/);
      expect(() => ro.recordTombstones(run, T1, [subject])).toThrow(
        /writable store handle/,
      );
      expect(() => ro.touchVerified([subject], T1)).toThrow(
        /writable store handle/,
      );
      expect(() => ro.trimObservations(T1)).toThrow(/writable store handle/);

      ro.close();
    });

    it("fails fast on a schema version it was not built against", () => {
      store.close();
      const raw = SqliteStore.openForWrite(path);
      // Simulate a database written by a newer build.
      // biome-ignore lint/suspicious/noExplicitAny: reaching past the port on purpose
      (raw as any).db.exec("PRAGMA user_version = 99");
      raw.close();

      expect(() => SqliteStore.openForRead(path)).toThrow(/version 99/);
    });
  });

  // The observation log records CHANGE, not attendance. Before this was
  // enforced, ten identical sweeps of one unchanged subject wrote ten rows with
  // one distinct payload, and nothing in the suite noticed.
  describe("the log appends on change, not on every sweep", () => {
    /**
     * Count rows directly.
     *
     * StorePort exposes no window onto the log's shape, and it should not: no
     * capability reads raw observations. AD-27 governs src/, and this is the
     * assertion that the log is not quietly filling with duplicates.
     */
    const observationRows = (): { payload: string; verified_at: string }[] => {
      const raw = new DatabaseSync(path, { readOnly: true });
      const rows = raw
        .prepare("SELECT payload, verified_at FROM observation ORDER BY id")
        .all() as { payload: string; verified_at: string }[];
      raw.close();
      return rows;
    };

    const sweep = (at: string, payload: unknown) => {
      const r = store.beginRun({
        lane: "rest-org",
        installation: "no42-org",
        scope: "full",
        startedAt: at,
      });
      store.recordObservations(r, at, [
        { subject: repositorySubject(REPO), payload },
      ]);
      store.finishRun(r, "ok", at);
    };

    it("writes one row for a subject confirmed unchanged many times", () => {
      const payload = { openAlerts: 0, worstSeverity: null };
      for (let i = 0; i < 10; i++) {
        sweep(`2026-08-16T1${i}:00:00.000Z`, payload);
      }
      expect(observationRows()).toHaveLength(1);
    });

    it("still advances freshness on every one of those sweeps", () => {
      const payload = { openAlerts: 0, worstSeverity: null };
      sweep(T1, payload);
      sweep(T2, payload);
      sweep(T3, payload);

      const current = store.current(repositorySubject(REPO));
      // The projection is what makes a quiet healthy repository read fresh.
      // Suppressing the log row must not suppress that.
      expect(current?.verifiedAt).toBe(T3);
      expect(current?.observedAt).toBe(T1);
    });

    it("appends a row the moment the value actually changes", () => {
      sweep(T1, { openAlerts: 0 });
      sweep(T2, { openAlerts: 0 });
      sweep(T3, { openAlerts: 2 });

      const rows = observationRows();
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.verified_at)).toEqual([T1, T3]);
      // The log answers "when did this change", and it can only answer that if
      // a real change is not buried under a drift of duplicates.
    });

    it("appends when a value changes back to a payload it held before", () => {
      sweep(T1, { openAlerts: 2 });
      sweep(T2, { openAlerts: 0 });
      sweep(T3, { openAlerts: 2 });
      expect(observationRows()).toHaveLength(3);
    });

    it("appends a tombstone, because a state change is a change", () => {
      const subject = repositorySubject(REPO);
      sweep(T1, { openAlerts: 2 });
      store.recordTombstones(run, T2, [subject]);

      const rows = observationRows();
      expect(rows).toHaveLength(2);
      expect(store.current(subject)?.state).toBe("resolved");
    });

    it("does not append a second tombstone for an already resolved subject", () => {
      const subject = repositorySubject(REPO);
      sweep(T1, { openAlerts: 2 });
      store.recordTombstones(run, T2, [subject]);
      store.recordTombstones(run, T3, [subject]);

      expect(observationRows()).toHaveLength(2);
      // Re-confirmed rather than re-tombstoned, or its freshness would freeze
      // and every staleness view would report it as rotting.
      expect(store.current(subject)?.verifiedAt).toBe(T3);
    });
  });

  describe("read ordering", () => {
    it("returns currentByType rows ordered by key", () => {
      // The queue's stable tie order and the repo page's row order both rest
      // on this. It was provided by an ORDER BY nothing asserted, which is one
      // edit away from a page that reshuffles between refreshes.
      store.recordObservations(run, T1, [
        {
          subject: repositorySubject({ owner: "no42-org", name: "zzz" }),
          payload: { a: 1 },
        },
        {
          subject: repositorySubject({ owner: "no42-org", name: "aaa" }),
          payload: { a: 2 },
        },
        {
          subject: repositorySubject({ owner: "no42-org", name: "mmm" }),
          payload: { a: 3 },
        },
      ]);
      expect(
        store.currentByType("repository").map((r) => r.subject.key),
      ).toEqual(["no42-org/aaa", "no42-org/mmm", "no42-org/zzz"]);
    });
  });

  describe("trimming collection runs", () => {
    const runAt = (at: string, installation = "no42-org") => {
      const r = store.beginRun({
        lane: "rest-org",
        installation,
        scope: "full",
        startedAt: at,
      });
      store.finishRun(r, "ok", at);
      return r;
    };
    const runCount = () => {
      const raw = new DatabaseSync(path, { readOnly: true });
      const n = Number(
        (
          raw.prepare("SELECT COUNT(*) AS c FROM collection_run").get() as {
            c: number;
          }
        ).c,
      );
      raw.close();
      return n;
    };

    it("deletes runs older than the cutoff", () => {
      runAt("2026-08-01T00:00:00.000Z");
      runAt("2026-08-02T00:00:00.000Z");
      runAt(T3);
      // The beforeEach run plus three here.
      expect(runCount()).toBe(4);

      expect(store.trimRuns("2026-08-10T00:00:00.000Z")).toBe(2);
      expect(runCount()).toBe(2);
    });

    it("never deletes the newest run for a key, however old", () => {
      // A lane that stopped months ago is exactly the one the health view must
      // keep showing. Deleting it removes the lane from the page, and a lane
      // missing from that table is indistinguishable from a lane that is fine.
      runAt("2026-01-01T00:00:00.000Z", "abandoned");

      store.trimRuns("2026-08-16T23:00:00.000Z");

      const keys = store.latestRunPerKey().map((r) => r.installation);
      expect(keys).toContain("abandoned");
    });

    it("never deletes a run an observation still points at", () => {
      const old = store.beginRun({
        lane: "rest-org",
        installation: "old-org",
        scope: "full",
        startedAt: "2026-01-01T00:00:00.000Z",
      });
      store.recordObservations(old, "2026-01-01T00:00:00.000Z", [
        { subject: repositorySubject(REPO), payload: { openAlerts: 1 } },
      ]);
      store.finishRun(old, "ok", "2026-01-01T00:00:00.000Z");
      // Make it non-newest for its key so only the reference protects it.
      runAt("2026-01-02T00:00:00.000Z", "old-org");
      runAt("2026-01-03T00:00:00.000Z", "old-org");

      const before = runCount();
      store.trimRuns("2026-08-16T23:00:00.000Z");

      // Foreign keys are ON, so a naive trim would throw here rather than
      // quietly skip. Either way the log must keep pointing at what produced it.
      const raw = new DatabaseSync(path, { readOnly: true });
      const orphans = Number(
        (
          raw
            .prepare(
              "SELECT COUNT(*) AS c FROM observation o LEFT JOIN collection_run r ON r.id = o.run_id WHERE r.id IS NULL",
            )
            .get() as { c: number }
        ).c,
      );
      raw.close();
      expect(orphans).toBe(0);
      expect(runCount()).toBeLessThan(before);
    });

    it("is refused on a read-only handle", () => {
      store.close();
      const reader = SqliteStore.openForRead(path);
      expect(() => reader.trimRuns(T3)).toThrow(/writable/);
      reader.close();
      store = SqliteStore.openForWrite(path);
    });
  });

  describe("the retention cutoff is exclusive", () => {
    // Retention is destructive and irreversible, so the boundary is worth
    // pinning rather than inferring. `olderThan` means strictly older: a row
    // stamped exactly at the cutoff is inside the window and survives.
    const rowsAt = (): string[] => {
      const raw = new DatabaseSync(path, { readOnly: true });
      const rows = (
        raw
          .prepare("SELECT verified_at FROM observation ORDER BY id")
          .all() as {
          verified_at: string;
        }[]
      ).map((r) => r.verified_at);
      raw.close();
      return rows;
    };

    it("keeps a row stamped exactly at the cutoff and drops the one before it", () => {
      store.recordObservations(run, T1, [
        {
          subject: alertSubject("dependabot_alert", REPO, 1),
          payload: { v: 1 },
        },
      ]);
      store.recordObservations(run, T2, [
        {
          subject: alertSubject("dependabot_alert", REPO, 2),
          payload: { v: 2 },
        },
      ]);

      expect(store.trimObservations(T2)).toBe(1);
      expect(rowsAt()).toEqual([T2]);
    });

    it("deletes nothing when the cutoff predates every row", () => {
      store.recordObservations(run, T2, [
        {
          subject: alertSubject("dependabot_alert", REPO, 1),
          payload: { v: 1 },
        },
      ]);
      expect(store.trimObservations(T1)).toBe(0);
      expect(rowsAt()).toEqual([T2]);
    });
  });
});
