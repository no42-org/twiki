/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { alertSubject, repositorySubject } from "../src/core/subject.js";
import type { RunRef } from "../src/tricorder/store/port.js";
import { SCHEMA_VERSION } from "../src/tricorder/store/schema.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";

const REPO = { owner: "no42-org", name: "twiki" };
const T1 = "2026-08-16T10:00:00Z";
const T2 = "2026-08-16T10:15:00Z";
const T3 = "2026-08-16T10:30:00Z";

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

    it("does not re-tombstone an already resolved subject", () => {
      const subject = alertSubject("dependabot_alert", REPO, 1);
      store.recordObservations(run, T1, [
        { subject, payload: { severity: "high" } },
      ]);
      store.recordTombstones(run, T2, [subject]);
      store.recordTombstones(run, T3, [subject]);

      expect(store.current(subject)?.verifiedAt).toBe(T2);
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
});
