/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { DatabaseSync } from "node:sqlite";
import type { Subject, SubjectType } from "../../core/subject.js";
import type {
  CurrentValue,
  ObservationInput,
  RunOutcome,
  RunRecord,
  RunRef,
  RunStart,
  StorePort,
  SubjectState,
  Validator,
} from "./port.js";
import { MIGRATIONS, SCHEMA_VERSION } from "./schema.js";

// node:sqlite is synchronous. That is fine for one user and an indexed store,
// but it blocks the event loop, so the collector and the web process run as
// separate containers (AD-13) and no query on the request path scans.
//
// Run both processes with --disable-warning=ExperimentalWarning, never
// --no-warnings: the targeted flag still lets a genuine warning through.

export interface OpenOptions {
  /** Read-only handles cannot write or run DDL; SQLite enforces it. */
  readOnly?: boolean;
}

export class SqliteStore implements StorePort {
  private readonly db: DatabaseSync;
  private readonly writable: boolean;

  private constructor(db: DatabaseSync, writable: boolean) {
    this.db = db;
    this.writable = writable;
  }

  /**
   * Collector entrypoint: opens read-write, sets WAL and migrates forward.
   * WAL persists in the file, so it is set at creation rather than per open.
   */
  static openForWrite(path: string): SqliteStore {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    const store = new SqliteStore(db, true);
    store.migrate();
    return store;
  }

  /**
   * Web entrypoint: read-only, and fails fast on a schema it was not built
   * against rather than serving misread rows (AD-26).
   */
  static openForRead(path: string): SqliteStore {
    const db = new DatabaseSync(path, { readOnly: true });
    const store = new SqliteStore(db, false);
    const found = store.schemaVersion();
    if (found !== SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `store schema is version ${found}, this build expects ${SCHEMA_VERSION}. ` +
          "Start the collector to migrate, then restart the web process.",
      );
    }
    return store;
  }

  private migrate(): void {
    const from = this.schemaVersion();
    for (let v = from; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v] as string);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  }

  schemaVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as
      | { user_version?: number }
      | undefined;
    return row?.user_version ?? 0;
  }

  private assertWritable(op: string): void {
    if (!this.writable) {
      throw new Error(`${op} requires the collector's writable store handle`);
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  beginRun(start: RunStart): RunRef {
    this.assertWritable("beginRun");
    this.db
      .prepare(
        `INSERT INTO collection_run (lane, installation, scope, outcome, started_at, verified_at)
         VALUES (?, ?, ?, 'partial', ?, ?)`,
      )
      .run(
        start.lane,
        start.installation,
        start.scope,
        start.startedAt,
        start.startedAt,
      );
    const row = this.db.prepare("SELECT last_insert_rowid() AS id").get() as {
      id: number;
    };
    return {
      id: row.id,
      lane: start.lane,
      installation: start.installation,
      scope: start.scope,
    };
  }

  finishRun(
    run: RunRef,
    outcome: RunOutcome,
    verifiedAt: string,
    detail?: string,
  ): void {
    this.assertWritable("finishRun");
    this.db
      .prepare(
        "UPDATE collection_run SET outcome = ?, detail = ?, verified_at = ? WHERE id = ?",
      )
      .run(outcome, detail ?? null, verifiedAt, run.id);
  }

  recordObservations(
    run: RunRef,
    verifiedAt: string,
    observations: readonly ObservationInput[],
  ): void {
    this.assertWritable("recordObservations");
    if (observations.length === 0) return;
    this.tx(() => {
      for (const o of observations) this.writeOne(run, verifiedAt, o);
    });
  }

  recordTombstones(
    run: RunRef,
    verifiedAt: string,
    subjects: readonly Subject[],
  ): void {
    this.assertWritable("recordTombstones");
    if (subjects.length === 0) return;
    this.tx(() => {
      for (const subject of subjects) {
        const prior = this.readCurrent(subject);
        if (!prior || prior.state === "resolved") continue;
        this.writeOne(run, verifiedAt, {
          subject,
          payload: prior.payload,
          state: "resolved",
          observedAt: verifiedAt,
        });
      }
    });
  }

  /** One observation plus its projection advance, inside the caller's transaction. */
  private writeOne(run: RunRef, verifiedAt: string, o: ObservationInput): void {
    const state: SubjectState = o.state ?? "present";
    const payload = JSON.stringify(o.payload);
    const prior = this.readCurrent(o.subject);
    // Unchanged values carry the previous observed_at forward, so freshness
    // and last-change stay distinct (AD-11).
    const observedAt = o.observedAt ?? prior?.observedAt ?? verifiedAt;

    this.db
      .prepare(
        `INSERT INTO observation
           (subject_type, subject_key, run_id, payload, state, observed_at, verified_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        o.subject.type,
        o.subject.key,
        run.id,
        payload,
        state,
        observedAt,
        verifiedAt,
      );

    this.db
      .prepare(
        `INSERT INTO current_state
           (subject_type, subject_key, payload, state, observed_at, verified_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (subject_type, subject_key) DO UPDATE SET
           payload = excluded.payload,
           state = excluded.state,
           observed_at = excluded.observed_at,
           verified_at = excluded.verified_at`,
      )
      .run(
        o.subject.type,
        o.subject.key,
        payload,
        state,
        observedAt,
        verifiedAt,
      );
  }

  touchVerified(subjects: readonly Subject[], verifiedAt: string): void {
    this.assertWritable("touchVerified");
    if (subjects.length === 0) return;
    const stmt = this.db.prepare(
      "UPDATE current_state SET verified_at = ? WHERE subject_type = ? AND subject_key = ?",
    );
    this.tx(() => {
      for (const s of subjects) stmt.run(verifiedAt, s.type, s.key);
    });
  }

  saveValidator(
    installation: string,
    requestUrl: string,
    validator: Validator,
    verifiedAt: string,
  ): void {
    this.assertWritable("saveValidator");
    this.db
      .prepare(
        `INSERT INTO validator (installation, request_url, etag, last_modified, token_gen, verified_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (installation, request_url) DO UPDATE SET
           etag = excluded.etag,
           last_modified = excluded.last_modified,
           token_gen = excluded.token_gen,
           verified_at = excluded.verified_at`,
      )
      .run(
        installation,
        requestUrl,
        validator.etag,
        validator.lastModified,
        validator.tokenGen,
        verifiedAt,
      );
  }

  trimObservations(olderThan: string): number {
    this.assertWritable("trimObservations");
    const before = this.db
      .prepare("SELECT count(*) AS c FROM observation")
      .get() as { c: number };
    this.db
      .prepare("DELETE FROM observation WHERE verified_at < ?")
      .run(olderThan);
    const after = this.db
      .prepare("SELECT count(*) AS c FROM observation")
      .get() as { c: number };
    return before.c - after.c;
  }

  private readCurrent(subject: Subject): CurrentValue | null {
    const row = this.db
      .prepare(
        `SELECT payload, state, observed_at, verified_at
         FROM current_state WHERE subject_type = ? AND subject_key = ?`,
      )
      .get(subject.type, subject.key) as
      | {
          payload: string;
          state: SubjectState;
          observed_at: string;
          verified_at: string;
        }
      | undefined;
    if (!row) return null;
    return {
      subject,
      payload: JSON.parse(row.payload),
      state: row.state,
      observedAt: row.observed_at,
      verifiedAt: row.verified_at,
    };
  }

  current(subject: Subject): CurrentValue | null {
    return this.readCurrent(subject);
  }

  currentByType(type: SubjectType): CurrentValue[] {
    const rows = this.db
      .prepare(
        `SELECT subject_key, payload, state, observed_at, verified_at
         FROM current_state WHERE subject_type = ? ORDER BY subject_key`,
      )
      .all(type) as {
      subject_key: string;
      payload: string;
      state: SubjectState;
      observed_at: string;
      verified_at: string;
    }[];
    return rows.map((r) => ({
      subject: { type, key: r.subject_key },
      payload: JSON.parse(r.payload),
      state: r.state,
      observedAt: r.observed_at,
      verifiedAt: r.verified_at,
    }));
  }

  latestRuns(limit: number): RunRecord[] {
    const rows = this.db
      .prepare(
        `SELECT id, lane, installation, scope, outcome, detail, started_at, verified_at
         FROM collection_run ORDER BY id DESC LIMIT ?`,
      )
      .all(limit) as {
      id: number;
      lane: string;
      installation: string;
      scope: "hot" | "full";
      outcome: RunOutcome;
      detail: string | null;
      started_at: string;
      verified_at: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      lane: r.lane,
      installation: r.installation,
      scope: r.scope,
      outcome: r.outcome,
      detail: r.detail,
      startedAt: r.started_at,
      verifiedAt: r.verified_at,
    }));
  }

  loadValidator(installation: string, requestUrl: string): Validator | null {
    const row = this.db
      .prepare(
        "SELECT etag, last_modified, token_gen FROM validator WHERE installation = ? AND request_url = ?",
      )
      .get(installation, requestUrl) as
      | { etag: string | null; last_modified: string | null; token_gen: string }
      | undefined;
    if (!row) return null;
    return {
      etag: row.etag,
      lastModified: row.last_modified,
      tokenGen: row.token_gen,
    };
  }

  close(): void {
    this.db.close();
  }
}
