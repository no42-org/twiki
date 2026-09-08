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

  it("names the field when a version pattern will not compile", () => {
    // Validated where it was written. A pattern that cannot compile is a
    // mistake in the document, not a fact about any repository, so it must
    // not wait until the one tick that would have released.
    const p = write(
      "repos.yaml",
      [
        "mode: shadow",
        "repos:",
        "  - repo: no42-org/a",
        "    versionSources:",
        "      - path: version.go",
        "        pattern: 'version = ([0-9'",
      ].join("\n"),
    );
    try {
      loadConfig(p);
      expect.unreachable("an uncompilable pattern must be rejected");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain(p);
      expect(msg).toContain("repos[0].versionSources[0].pattern");
      expect(msg).not.toContain('"code"');
    }
  });

  it("names the field when a version pattern captures nothing", () => {
    const p = write(
      "repos.yaml",
      [
        "mode: shadow",
        "repos:",
        "  - repo: no42-org/a",
        "    versionSources:",
        "      - path: version.go",
        "        pattern: 'version = .*'",
      ].join("\n"),
    );
    try {
      loadConfig(p);
      expect.unreachable("a pattern with no capture group must be rejected");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("repos[0].versionSources[0].pattern");
      expect(msg).toContain("capture group");
    }
  });

  it("names the field when a version pattern captures twice", () => {
    // Two groups is the same problem as two matches: the declaration does not
    // identify WHICH of them is the version.
    const p = write(
      "repos.yaml",
      [
        "mode: shadow",
        "repos:",
        "  - repo: no42-org/a",
        "    versionSources:",
        "      - path: version.go",
        "        pattern: 'version = (\\d+)\\.(\\d+)'",
      ].join("\n"),
    );
    try {
      loadConfig(p);
      expect.unreachable("a pattern with two capture groups must be rejected");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("repos[0].versionSources[0].pattern");
      // The count, not just the word: "no42-org" contains a 2, so asserting
      // on the digit alone could not fail.
      expect(msg).toContain("exactly one capture group");
      expect(msg).toContain("has 2");
    }
  });

  it("rejects an empty version-source list rather than reading it as absence", () => {
    // Same reason as `defaultBranch: ""`. Somebody who wrote the key meant
    // something, and treating it as "declares nothing" would silently turn
    // the check off for the repository that asked for it.
    const p = write(
      "repos.yaml",
      [
        "mode: shadow",
        "repos:",
        "  - repo: no42-org/a",
        "    versionSources: []",
      ].join("\n"),
    );
    try {
      loadConfig(p);
      expect.unreachable("an empty versionSources must be rejected");
    } catch (err) {
      expect((err as Error).message).toContain("repos[0].versionSources");
    }
  });

  it("names the field when a version source has no path", () => {
    const p = write(
      "repos.yaml",
      [
        "mode: shadow",
        "repos:",
        "  - repo: no42-org/a",
        "    versionSources:",
        '      - path: ""',
        "        pattern: 'version = (.*)'",
      ].join("\n"),
    );
    try {
      loadConfig(p);
      expect.unreachable("an empty path must be rejected");
    } catch (err) {
      expect((err as Error).message).toContain(
        "repos[0].versionSources[0].path",
      );
    }
  });

  it("rejects a version-source path that cannot name a file", () => {
    // Each of these reaches the contents endpoint exactly as written, so a
    // path that can never name a file is refused where it was typed rather
    // than blocking a release months later.
    for (const [path, expected] of [
      ["/version.go", "leading slash"],
      ["internal/", "trailing slash"],
      ["../other/version.go", "`..`"],
    ] as const) {
      const p = write(
        "repos.yaml",
        [
          "mode: shadow",
          "repos:",
          "  - repo: no42-org/a",
          "    versionSources:",
          `      - path: "${path}"`,
          "        pattern: 'version = (.*)'",
        ].join("\n"),
      );
      try {
        loadConfig(p);
        expect.unreachable(`${path} must be rejected`);
      } catch (err) {
        const msg = (err as Error).message;
        expect(msg).toContain("repos[0].versionSources[0].path");
        expect(msg).toContain(expected);
      }
    }
  });

  it("refuses a pattern long enough to cost the whole digest", () => {
    // A pattern that fails to match is quoted verbatim in the outcome, and a
    // chat transport drops an over-long message whole - so one long pattern
    // could cost the digest, the merges reported in it included.
    const p = write(
      "repos.yaml",
      [
        "mode: shadow",
        "repos:",
        "  - repo: no42-org/a",
        "    versionSources:",
        "      - path: version.go",
        `        pattern: '(${"a".repeat(300)})'`,
      ].join("\n"),
    );
    try {
      loadConfig(p);
      expect.unreachable("an over-long pattern must be rejected");
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain("repos[0].versionSources[0].pattern");
      expect(msg).toContain("at most 200 characters");
    }
  });

  it("keeps a declared version source, and leaves an undeclared one empty", () => {
    const p = write(
      "repos.yaml",
      [
        "mode: shadow",
        "repos:",
        "  - repo: no42-org/a",
        "    versionSources:",
        "      - path: internal/version/version.go",
        '        pattern: \'const version = "([^"]+)"\'',
        "  - repo: no42-org/b",
      ].join("\n"),
    );
    const config = loadConfig(p);
    expect(config.policies.get("no42-org/a")?.versionSources).toEqual([
      {
        path: "internal/version/version.go",
        pattern: 'const version = "([^"]+)"',
      },
    ]);
    // Absence is a real answer, not a gap to fill.
    expect(config.policies.get("no42-org/b")?.versionSources).toEqual([]);
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
    // Every pattern the example ships is compiled by the strict parse, so a
    // documented pattern that could never identify a version fails here.
    expect(
      config.policies.get("no42-org/versioned-service")?.versionSources,
    ).toHaveLength(2);
    expect(
      config.policies.get("no42-org/example-service")?.versionSources,
    ).toEqual([]);
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
