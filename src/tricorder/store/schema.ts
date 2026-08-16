/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// Schema and forward-only migrations. The collector owns both: it is the sole
// writer, and the web process holds a read-only handle that cannot run DDL
// (AD-26). The web process checks the version at startup and refuses to serve
// a schema it was not built against, rather than misreading rows.

export const SCHEMA_VERSION = 1;

/**
 * Forward-only. Never edit a landed migration; add the next one. Index is the
 * version it produces, so migrations[0] takes an empty database to version 1.
 */
export const MIGRATIONS: readonly string[] = [
  `
  -- Every observation is about a subject, identified by (type, key) per AD-22.
  -- Rows are inserted and never updated; only the retention job deletes them.
  CREATE TABLE observation (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    subject_type  TEXT    NOT NULL,
    subject_key   TEXT    NOT NULL,
    run_id        INTEGER NOT NULL REFERENCES collection_run(id),
    -- Payload shape is discriminated on subject_type (AD-22). One table with a
    -- JSON column, not a table per signal.
    payload       TEXT    NOT NULL,
    -- state distinguishes a live observation from a tombstone (AD-23).
    state         TEXT    NOT NULL DEFAULT 'present'
                  CHECK (state IN ('present', 'resolved')),
    -- observed_at is when the value last CHANGED. verified_at is when it was
    -- last CONFIRMED, including by a 304. Freshness renders from verified_at,
    -- or a quiet healthy repository reads as maximally stale (AD-11).
    observed_at   TEXT    NOT NULL,
    verified_at   TEXT    NOT NULL
  );

  CREATE INDEX observation_subject ON observation (subject_type, subject_key, id DESC);
  CREATE INDEX observation_verified ON observation (verified_at);

  -- Current state is a materialised projection, advanced by the collector in
  -- the same transaction as the observation that moves it (AD-3). It is never
  -- recomputed at read time, and the retention job never deletes from it: a
  -- projection row outlives the observation that produced it (AD-4).
  CREATE TABLE current_state (
    subject_type  TEXT    NOT NULL,
    subject_key   TEXT    NOT NULL,
    payload       TEXT    NOT NULL,
    state         TEXT    NOT NULL DEFAULT 'present'
                  CHECK (state IN ('present', 'resolved')),
    observed_at   TEXT    NOT NULL,
    verified_at   TEXT    NOT NULL,
    PRIMARY KEY (subject_type, subject_key)
  );

  CREATE INDEX current_state_verified ON current_state (verified_at);

  -- A run is identified by (lane, installation, scope). Scope matters: a
  -- 5-minute hot run must never be mistaken for authoritative over the full
  -- estate, or reconciliation would tombstone subjects it never queried
  -- (AD-16).
  CREATE TABLE collection_run (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    lane          TEXT    NOT NULL,
    installation  TEXT    NOT NULL,
    scope         TEXT    NOT NULL CHECK (scope IN ('hot', 'full')),
    outcome       TEXT    NOT NULL CHECK (outcome IN ('ok', 'partial', 'failed')),
    detail        TEXT,
    started_at    TEXT    NOT NULL,
    verified_at   TEXT    NOT NULL
  );

  CREATE INDEX collection_run_recent ON collection_run (lane, installation, scope, id DESC);

  -- Conditional-request validators live in the store, not in process memory,
  -- so a collector restart does not throw the cache away (AD-25). token_gen
  -- records the installation-token generation the validator was captured
  -- under: ETags key on the literal Authorization header, so rotation
  -- invalidates them upstream and the cache must treat itself as cold.
  CREATE TABLE validator (
    installation  TEXT    NOT NULL,
    request_url   TEXT    NOT NULL,
    etag          TEXT,
    last_modified TEXT,
    token_gen     TEXT    NOT NULL,
    verified_at   TEXT    NOT NULL,
    PRIMARY KEY (installation, request_url)
  );
  `,
];
