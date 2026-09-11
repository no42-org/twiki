/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// Chat delivery behind a small interface, owned by neither role.
//
// Both processes notify: twiki posts its run digest, gitricorder announces
// the items that reach `now`. They de-duplicate differently — twiki against a
// file it keeps between runs, gitricorder against `notification_sent` rows in
// its store — so de-duplication is a wrapper here (./dedupe.ts) rather than a
// base class every transport inherits. A transport is usable with it or
// without it.
//
// This directory may import src/core and node builtins and nothing else. The
// boundary is lint-enforced (AD-5) and probed in test/boundaries.test.ts.

export interface Notifier {
  /** Deliver `text`. Must throw on a non-success response. */
  send(text: string): Promise<void>;
}
