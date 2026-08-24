/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadAppAuthFromEnv } from "../src/github/auth.js";

// The directory case is the one that actually happens: Docker creates a
// MISSING mount source as an empty directory rather than refusing to start, so
// a host-side path typo surfaced as `EISDIR: illegal operation on a directory`
// - mentioning neither keys nor mounts. `.env.example` had to explain that in
// prose because the error would not.
//
// Assertions are on the path, the variable and the condition, never the exact
// sentence.

describe("an unusable App key says which way it is unusable", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "twiki-key-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const load = (keyPath: string, prefix: "TWIKI" | "TRICORDER" = "TWIKI") =>
    loadAppAuthFromEnv(
      {
        [`${prefix}_GITHUB_APP_ID`]: "4110450",
        [`${prefix}_GITHUB_APP_PRIVATE_KEY_PATH`]: keyPath,
      },
      prefix,
    );

  it("says a directory is a directory, and why one is there", () => {
    const p = join(dir, "twiki.pem");
    mkdirSync(p);
    try {
      load(p);
      expect.unreachable("a directory is not a key");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(p);
      expect(msg).toContain("TWIKI_GITHUB_APP_PRIVATE_KEY_PATH");
      expect(msg.toLowerCase()).toContain("directory");
      // The reason it is a directory is the part that is not guessable.
      expect(msg.toLowerCase()).toContain("mount");
      expect(msg).not.toContain("EISDIR");
    }
  });

  it("says a missing file is missing", () => {
    const p = join(dir, "absent.pem");
    try {
      load(p);
      expect.unreachable("a missing key must be rejected");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(p);
      expect(msg.toLowerCase()).toContain("does not exist");
      expect(msg).not.toContain("ENOENT");
    }
  });

  it("names the prefix, so the reader knows which App", () => {
    const p = join(dir, "tricorder.pem");
    mkdirSync(p);
    try {
      load(p, "TRICORDER");
      expect.unreachable("a directory is not a key");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("TRICORDER_GITHUB_APP_PRIVATE_KEY_PATH");
      expect(msg).not.toContain("TWIKI_");
    }
  });

  it("still loads a readable key, for both Apps", () => {
    for (const prefix of ["TWIKI", "TRICORDER"] as const) {
      const p = join(dir, `${prefix}.pem`);
      writeFileSync(p, "-----BEGIN PRIVATE KEY-----\nx\n");
      expect(load(p, prefix).privateKey).toContain("BEGIN PRIVATE KEY");
    }
  });

  it("prefers an inline key and never touches the path", () => {
    // The inline variable wins, so a broken path must not be read at all.
    const p = join(dir, "twiki.pem");
    mkdirSync(p);
    const auth = loadAppAuthFromEnv(
      {
        TWIKI_GITHUB_APP_ID: "4110450",
        TWIKI_GITHUB_APP_PRIVATE_KEY: "inline-key",
        TWIKI_GITHUB_APP_PRIVATE_KEY_PATH: p,
      },
      "TWIKI",
    );
    expect(auth.privateKey).toBe("inline-key");
  });

  it("says an unreadable file is unreadable", () => {
    const p = join(dir, "locked.pem");
    writeFileSync(p, "key");
    chmodSync(p, 0o000);
    // Root ignores the mode bits, so this assertion is only meaningful as a
    // non-root user. Skipping loudly beats a test that silently cannot fail.
    if (process.getuid?.() === 0) return;
    try {
      load(p);
      expect.unreachable("an unreadable key must be rejected");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(p);
      expect(msg.toLowerCase()).toContain("readable");
      expect(msg).not.toContain("EACCES");
    }
  });
});
