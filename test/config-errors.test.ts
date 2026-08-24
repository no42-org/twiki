/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";

// Unwrapped, a schema failure surfaced as zod's serialised issue array plus a
// stack trace into config.ts - naming the parser and never the config file the
// operator has to go and fix.
//
// These assert on the PATH and the CONDITION, never the exact sentence, so the
// wording can be improved without a test rewrite.

describe("a rejected config says which file and what is wrong", () => {
  let dir: string;
  const write = (name: string, body: string): string => {
    const p = join(dir, name);
    writeFileSync(p, body);
    return p;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "twiki-config-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("names the file, the key, and where it sits", () => {
    const p = write(
      "repos.yaml",
      "mode: shadow\nrepos:\n  - repo: no42-org/a\n    mergeOnyl: true\n",
    );
    try {
      loadConfig(p);
      expect.unreachable("an unknown key must be rejected");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(p);
      expect(msg).toContain("repos[0].mergeOnyl");
      // The raw issue array must not reach the operator.
      expect(msg).not.toContain("unrecognized_keys");
      expect(msg).not.toContain('"path"');
    }
  });

  it("offers version skew as a cause, not only a typo", () => {
    // The failure an older build produces for a config written against a newer
    // one. Blaming the operator's spelling sends them hunting for a mistake
    // they did not make.
    const p = write(
      "repos.yaml",
      "mode: shadow\nrepos:\n  - repo: no42-org/a\nsomethingFromTheFuture: 1\n",
    );
    try {
      loadConfig(p);
      expect.unreachable("an unknown top-level key must be rejected");
    } catch (err) {
      const msg = (err as Error).message.toLowerCase();
      expect(msg).toContain("somethingfromthefuture");
      expect(msg).toContain("typo");
      expect(msg).toContain("newer");
    }
  });

  it("renders a type error as a sentence against its field", () => {
    const p = write("repos.yaml", "mode: shadow\nrepos: nope\n");
    try {
      loadConfig(p);
      expect.unreachable("a non-array repos must be rejected");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(p);
      expect(msg).toContain("repos");
      expect(msg).not.toContain('"code"');
    }
  });

  it("names the file when the YAML itself will not parse", () => {
    const p = write("repos.yaml", "mode: shadow\nrepos: [\n");
    try {
      loadConfig(p);
      expect.unreachable("malformed YAML must be rejected");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(p);
      expect(msg.toLowerCase()).toContain("yaml");
    }
  });

  it("names the file when it is not there at all", () => {
    const p = join(dir, "absent.yaml");
    try {
      loadConfig(p);
      expect.unreachable("a missing config must be rejected");
    } catch (err) {
      expect((err as Error).message).toContain(p);
    }
  });

  it("still accepts what it accepted before, unchanged", () => {
    // The round-trip guard. Wrapping the error must not move the line between
    // a valid config and an invalid one.
    const p = write(
      "repos.yaml",
      [
        "mode: enforce",
        "repos:",
        "  - repo: no42-org/a",
        "  - repo: no42-org/b",
        "    mergeOnly: true",
        "bots:",
        "  - app/dependabot",
        "reviewers:",
        "  - indigo423",
      ].join("\n"),
    );
    const config = loadConfig(p);
    expect(config.mode).toBe("enforce");
    expect(config.repos.map((r) => r.name)).toEqual(["a", "b"]);
    expect(config.policies.get("no42-org/b")?.mergeOnly).toBe(true);
    expect(config.bots).toEqual(["app/dependabot"]);
    expect(config.reviewers).toEqual(["indigo423"]);
  });
});
