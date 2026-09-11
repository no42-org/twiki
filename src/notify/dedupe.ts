/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import type { Notifier } from "./port.js";

/**
 * Wraps a transport so a message identical to the last one is not re-sent.
 *
 * A wrapper rather than a base class. twiki remembers the last digest's hash
 * in a file it keeps between runs; gitricorder is to de-duplicate per item
 * through `notification_sent` rows in its store (story 4.2) and must not
 * inherit a file. Only the caller that wants this composes it, and the
 * transport underneath is unaffected either way.
 *
 * `dedupePath` has no default: the historical default is `.twiki-last-digest`,
 * which is the write side's name for it, and it stays in src/twiki/notify.ts
 * with the rest of twiki's state-directory rules.
 */
export class DedupingNotifier implements Notifier {
  constructor(
    private readonly inner: Notifier,
    /** Path used to remember the last message for de-duplication. */
    private readonly dedupePath: string,
  ) {}

  async send(text: string): Promise<void> {
    const hash = createHash("sha256").update(text).digest("hex");
    if (this.lastHash() === hash) return; // unchanged since last run — skip
    await this.inner.send(text);
    this.rememberHash(hash);
  }

  private lastHash(): string | null {
    try {
      return readFileSync(this.dedupePath, "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  private rememberHash(hash: string): void {
    try {
      writeFileSync(this.dedupePath, hash);
    } catch {
      // De-dup is best-effort; a write failure must not break delivery.
    }
  }
}
