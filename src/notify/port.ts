/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// Chat delivery behind a small interface, owned by neither role.
//
// Both processes are meant to notify: twiki posts its run digest today, and
// gitricorder will announce the items that reach `now` (story 4.2). They are
// to de-duplicate differently — twiki against a file it keeps between runs,
// gitricorder against `notification_sent` rows in its store — so
// de-duplication is a wrapper here (./dedupe.ts) rather than a base class
// every transport inherits. A transport is usable with it or without it.
//
// This directory keeps to src/core and node builtins. Lint enforces the half
// of that a linter can see: a relative import of src/twiki, src/tricorder,
// src/github or src/enrich (AD-5), probed in test/boundaries.test.ts. It does
// not restrict npm packages, here or in src/core; that half is convention.

export interface Notifier {
  /** Deliver `text`. Must throw on a non-success response. */
  send(text: string): Promise<void>;
}
