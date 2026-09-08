/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig, resolveDefaultBranch } from "../src/core/config.js";

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

  it("names the field when a default branch is not a string", () => {
    const p = write(
      "repos.yaml",
      "mode: shadow\nrepos:\n  - repo: no42-org/a\n    defaultBranch: 7\n",
    );
    try {
      loadConfig(p);
      expect.unreachable("a non-string defaultBranch must be rejected");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(p);
      expect(msg).toContain("repos[0].defaultBranch");
      expect(msg).not.toContain('"code"');
    }
  });

  it("names the field when a default branch is empty", () => {
    // Not folded into the default. An operator who wrote an empty string
    // meant something, and answering `main` would hide the one declaration
    // that is definitely wrong.
    const p = write(
      "repos.yaml",
      'mode: shadow\nrepos:\n  - repo: no42-org/a\n    defaultBranch: ""\n',
    );
    try {
      loadConfig(p);
      expect.unreachable("an empty defaultBranch must be rejected");
    } catch (err) {
      expect((err as Error).message).toContain("repos[0].defaultBranch");
    }
  });

  it("rejects a default branch written as a ref", () => {
    // `refs/heads/main` can never equal a stripped ref, so accepting it would
    // mean the declaration silently never matches anything.
    const p = write(
      "repos.yaml",
      "mode: shadow\nrepos:\n  - repo: no42-org/a\n    defaultBranch: refs/heads/main\n",
    );
    try {
      loadConfig(p);
      expect.unreachable("a ref-shaped defaultBranch must be rejected");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("repos[0].defaultBranch");
      expect(msg).toContain("not the ref");
    }
  });

  it("trims a default branch rather than never matching on it", () => {
    // Trailing whitespace in hand-written YAML is invisible and would make
    // the declaration silently never match.
    const p = write(
      "repos.yaml",
      'mode: shadow\nrepos:\n  - repo: no42-org/a\n    defaultBranch: "  master  "\n',
    );
    expect(loadConfig(p).policies.get("no42-org/a")?.defaultBranch).toBe(
      "master",
    );
  });

  it("rejects two entries that are the same repository in different casing", () => {
    // GitHub slugs are case-insensitive. The folded index keeps one entry per
    // repository, so without this the second declaration would silently
    // govern both.
    const p = write(
      "repos.yaml",
      [
        "mode: shadow",
        "repos:",
        "  - repo: No42-Org/A",
        "  - repo: no42-org/a",
        "    defaultBranch: master",
      ].join("\n"),
    );
    try {
      loadConfig(p);
      expect.unreachable("a case-folded duplicate must be rejected");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("no42-org/a");
      expect(msg).toContain("No42-Org/A");
    }
  });

  it("parses the example config this repository ships", () => {
    // The file the README tells every operator to copy. Nothing else parses
    // it, so a misspelled key here would break first startup with the whole
    // suite green.
    const config = loadConfig(
      join(import.meta.dirname, "..", "repos.example.yaml"),
    );
    expect(
      resolveDefaultBranch(config, {
        owner: "no42-org",
        name: "venerable-thing",
      }),
    ).toBe("master");
    expect(
      resolveDefaultBranch(config, {
        owner: "no42-org",
        name: "example-service",
      }),
    ).toBe("main");
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
        "  - repo: no42-org/c",
        "    defaultBranch: master",
        "bots:",
        "  - app/dependabot",
        "reviewers:",
        "  - indigo423",
      ].join("\n"),
    );
    const config = loadConfig(p);
    expect(config.mode).toBe("enforce");
    expect(config.repos.map((r) => r.name)).toEqual(["a", "b", "c"]);
    expect(config.policies.get("no42-org/b")?.mergeOnly).toBe(true);
    expect(config.policies.get("no42-org/c")?.defaultBranch).toBe("master");
    expect(config.policies.get("no42-org/a")?.defaultBranch).toBe("main");
    expect(config.bots).toEqual(["app/dependabot"]);
    expect(config.reviewers).toEqual(["indigo423"]);
  });
});
