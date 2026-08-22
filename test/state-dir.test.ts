/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebhookNotifier } from "../src/twiki/notify.js";

// De-duplication state has to outlive the process, and in a container the
// working directory is a writable layer that dies on every recreate. Without
// a configurable location the first run after a redeploy re-sent a digest
// byte-identical to the one already delivered.

describe("the notifier's de-duplication state can live outside the workdir", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "twiki-state-"));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it("writes its state where it is told, and dedupes across instances", async () => {
    const path = join(dir, ".twiki-last-digest.slack");

    // Two notifiers, as two runs of the process would be.
    await new WebhookNotifier(
      "https://example.invalid/hook",
      "slack",
      path,
    ).send("the same digest");
    await new WebhookNotifier(
      "https://example.invalid/hook",
      "slack",
      path,
    ).send("the same digest");

    expect(readdirSync(dir)).toEqual([".twiki-last-digest.slack"]);
    // Delivered once: the second run recognised the digest it had already sent.
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("still delivers when the digest actually changed", async () => {
    const path = join(dir, ".twiki-last-digest.slack");

    await new WebhookNotifier(
      "https://example.invalid/hook",
      "slack",
      path,
    ).send("first");
    await new WebhookNotifier(
      "https://example.invalid/hook",
      "slack",
      path,
    ).send("second");

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
