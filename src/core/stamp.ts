/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

/**
 * Timestamps are compared as TEXT in SQLite: retention orders on them, and so
 * does freshness. Lexicographic order only matches chronological order if every
 * value has the same shape, and they will not by default: one lane formats from
 * `new Date().toISOString()`, another from a GitHub `Last-Modified` header, a
 * third from a JSON payload with a `+00:00` offset.
 *
 * So every timestamp entering the store passes through here first. The canonical
 * form is UTC ISO 8601 with milliseconds and a `Z` suffix, exactly what
 * toISOString produces, which is fixed-width and therefore safe to compare.
 */
export function stamp(value: string | Date): string {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`not a usable timestamp: ${JSON.stringify(value)}`);
  }
  return d.toISOString();
}

/** True when `value` is already canonical. Useful in assertions and tests. */
export function isStamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}
