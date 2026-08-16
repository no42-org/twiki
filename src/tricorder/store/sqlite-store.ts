/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { DatabaseSync } from "node:sqlite";
import { stamp } from "../../core/stamp.js";
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

/** Wait this long for a competing writer before giving up (AD-13). */
const BUSY_TIMEOUT_MS = 5_000;

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
    // Two containers share this file (AD-13). Wait rather than failing the
    // whole run on a moment's contention.
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
    const store = new SqliteStore(db, true);
    store.migrate();
    return store;
  }

  /**
   * Web entrypoint: read-only, and fails fast on a schema it was not built
   * against rather than serving misread rows (AD-26).
   */
  static openForRead(path: string): SqliteStore {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(path, { readOnly: true });
    } catch (err) {
      // A raw SQLITE_CANTOPEN here almost always means the collector has not
      // created the database yet. Note a read-only WAL connection still needs
      // write access to the DIRECTORY for the -shm file, so mounting the
      // volume :ro fails at open.
      throw new Error(
        `cannot open the store at ${path} for reading: ${err instanceof Error ? err.message : err}. ` +
          "Start the collector to create and migrate it. Note the volume must not be mounted read-only: " +
          "a read-only WAL connection still needs write access to the directory.",
      );
    }
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
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
    // Symmetric with openForRead. Rolling the collector back after a newer
    // migration has landed would otherwise write old-shaped rows into a newer
    // schema, silently, instead of refusing to start.
    if (from > MIGRATIONS.length) {
      this.db.close();
      throw new Error(
        `store schema is version ${from}, this build only knows ${MIGRATIONS.length}. ` +
          "Refusing to write to a database created by a newer build.",
      );
    }
    for (let v = from; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        this.db.exec(MIGRATIONS[v] as string);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (err) {
        this.rollbackQuietly();
        throw err;
      }
    }
  }

  /**
   * A throw from COMMIT itself leaves no active transaction, so ROLLBACK would
   * throw "cannot rollback - no transaction is active" and replace the real
   * failure in the stack.
   */
  private rollbackQuietly(): void {
    try {
      this.db.exec("ROLLBACK");
    } catch {
      // no transaction to roll back
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
      this.rollbackQuietly();
      throw err;
    }
  }

  beginRun(start: RunStart): RunRef {
    this.assertWritable("beginRun");
    const at = stamp(start.startedAt);
    this.db
      .prepare(
        `INSERT INTO collection_run (lane, installation, scope, outcome, started_at, verified_at)
         VALUES (?, ?, ?, 'partial', ?, ?)`,
      )
      .run(start.lane, start.installation, start.scope, at, at);
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
      .run(outcome, detail ?? null, stamp(verifiedAt), run.id);
  }

  recordObservations(
    run: RunRef,
    verifiedAt: string,
    observations: readonly ObservationInput[],
  ): void {
    this.assertWritable("recordObservations");
    if (observations.length === 0) return;
    const at = stamp(verifiedAt);
    this.tx(() => {
      for (const o of observations) this.writeOne(run, at, o);
    });
  }

  recordTombstones(
    run: RunRef,
    verifiedAt: string,
    subjects: readonly Subject[],
  ): void {
    this.assertWritable("recordTombstones");
    if (subjects.length === 0) return;
    const at = stamp(verifiedAt);
    this.tx(() => {
      for (const subject of subjects) {
        const prior = this.readCurrent(subject);
        if (!prior) continue;
        if (prior.state === "resolved") {
          // Already gone. Do not write a second tombstone, but do confirm it:
          // otherwise a correctly-resolved subject's freshness freezes at the
          // tombstone and every staleness view reports it as rotting.
          this.touchOne(subject, at);
          continue;
        }
        this.writeOne(run, at, {
          subject,
          payload: prior.payload,
          state: "resolved",
          observedAt: at,
        });
      }
    });
  }

  /** One observation plus its projection advance, inside the caller's transaction. */
  private writeOne(run: RunRef, verifiedAt: string, o: ObservationInput): void {
    const state: SubjectState = o.state ?? "present";
    const payload = JSON.stringify(o.payload);
    const prior = this.readCurrent(o.subject);

    // Detect change here rather than trusting the caller to diff. An explicit
    // observedAt still wins, but the default is derived: if the payload or the
    // state differs from what the projection holds, the value CHANGED now.
    // Carrying the prior stamp forward unconditionally would report a changed
    // value as unchanged, which defeats the point of the split (AD-11).
    const changed =
      prior === null ||
      JSON.stringify(prior.payload) !== payload ||
      prior.state !== state;
    const observedAt = o.observedAt
      ? stamp(o.observedAt)
      : changed
        ? verifiedAt
        : (prior?.observedAt ?? verifiedAt);

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

    // The projection is monotonic in verified_at. Lanes and scopes overlap, so
    // a slow full run can land after a fast hot run that already wrote a newer
    // value; without this guard it would clobber the fresher payload and move
    // freshness backwards. The observation row above is still appended, so
    // nothing observed is lost.
    this.db
      .prepare(
        `INSERT INTO current_state
           (subject_type, subject_key, payload, state, observed_at, verified_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (subject_type, subject_key) DO UPDATE SET
           payload = excluded.payload,
           state = excluded.state,
           observed_at = excluded.observed_at,
           verified_at = excluded.verified_at
         WHERE excluded.verified_at >= current_state.verified_at`,
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

  /** Advance freshness for one subject, never backwards. */
  private touchOne(subject: Subject, verifiedAt: string): void {
    this.db
      .prepare(
        `UPDATE current_state SET verified_at = ?
         WHERE subject_type = ? AND subject_key = ? AND verified_at <= ?`,
      )
      .run(verifiedAt, subject.type, subject.key, verifiedAt);
  }

  touchVerified(subjects: readonly Subject[], verifiedAt: string): void {
    this.assertWritable("touchVerified");
    if (subjects.length === 0) return;
    const at = stamp(verifiedAt);
    this.tx(() => {
      for (const s of subjects) this.touchOne(s, at);
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
        stamp(verifiedAt),
      );
  }

  trimObservations(olderThan: string): number {
    this.assertWritable("trimObservations");
    // DELETE reports its own row count; two COUNT(*) scans of the one table
    // expected to grow would be the expensive way to learn the same number.
    const result = this.db
      .prepare("DELETE FROM observation WHERE verified_at < ?")
      .run(stamp(olderThan));
    return Number(result.changes);
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

  currentByTypeForOwner(type: SubjectType, owner: string): CurrentValue[] {
    const rows = this.db
      .prepare(
        `SELECT subject_key, payload, state, observed_at, verified_at
         FROM current_state
         WHERE subject_type = ? AND subject_key LIKE ? ORDER BY subject_key`,
      )
      .all(type, `${owner.toLowerCase()}/%`) as {
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
