/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

// AD-5's module boundaries, asserted by running the real linter against real
// files. Nothing here parses biome.json: a config-shape assertion passes when
// the config is well-formed and wrong, which is how two dead `**/tricorder.ts`
// patterns sat in the overrides looking like enforcement. ESM specifiers end
// in `.js`, so they could never match anything, and each entrypoint could
// import the other.
//
// Biome's --stdin-file-path cannot be used for this. In stdin mode it reports
// only "The contents aren't fixed" and exits 1 for legal and illegal imports
// alike, so a probe built on it passes for the wrong reason.

const SRC = "src";
const BIOME = join("node_modules", ".bin", "biome");

/**
 * Both extensions, always.
 *
 * The overrides carry a glob per extension, and dropping the .tsx one leaves
 * every component file outside every boundary rule. A .ts-only probe cannot
 * see that, and .tsx arrived late enough that it was missed once already.
 */
const EXTENSIONS = [".ts", ".tsx"] as const;
const PROBE = "__boundary-probe__";
const isProbe = (name: string) => name.startsWith(PROBE);

/** Files touched by a probe, restored even if an assertion throws. */
const created: string[] = [];
const modified = new Map<string, string>();

/**
 * Put everything back.
 *
 * Each restore is isolated: one failure (read-only file, full disk) must not
 * abandon the rest half-written, and the collections are cleared whatever
 * happens so the next test does not inherit stale state.
 */
function restoreAll(): void {
  for (const [path, original] of modified) {
    try {
      writeFileSync(path, original);
    } catch {
      // Nothing useful to do here; the assertion below reports the damage.
    }
  }
  for (const path of created) {
    try {
      rmSync(path, { force: true });
    } catch {}
  }
  modified.clear();
  created.length = 0;
}

afterEach(restoreAll);

// probeFile rewrites real source files. Ctrl-C during a run, a worker crash or
// an OOM kill would otherwise leave src/index.ts corrupted on disk, which is
// easy to commit without noticing.
process.on("exit", restoreAll);

/**
 * How many boundary violations Biome reported for one file, at error severity.
 *
 * A count from the JSON reporter, never a substring search of the default
 * output: that output echoes the source lines surrounding each diagnostic, so
 * grepping it for a specifier matches the printed import statement whether or
 * not the rule fired. The first version of this file did exactly that and
 * reported a closed boundary that was wide open.
 *
 * Severity is part of the count because a warning is not enforcement:
 * noRestrictedImports is not on by default, and `biome check` exits 0 on
 * warnings, so an override that forgets `"level": "error"` produces a rule
 * that reports the violation and still lets CI pass.
 */
function violations(file: string): number {
  const args = [
    "lint",
    "--only=style/noRestrictedImports",
    "--reporter=json",
    file,
  ];
  let stdout: string;
  let stderr = "";
  try {
    stdout = execFileSync(BIOME, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    // Biome exits non-zero whenever it reported anything. The report is still
    // on stdout, and it is the report we want, not the exit code.
    const e = err as { stdout?: string; stderr?: string; message?: string };
    stdout = e.stdout ?? "";
    stderr = e.stderr || e.message || "";
  }

  let report: { diagnostics: { category: string; severity: string }[] };
  try {
    report = JSON.parse(stdout);
  } catch {
    // A missing binary or an unparseable biome.json produces empty stdout, and
    // a bare "Unexpected end of JSON input" from every test hides the cause.
    throw new Error(
      `biome produced no JSON report for ${file}.\n${stderr.trim()}`,
    );
  }
  return report.diagnostics.filter(
    (d) =>
      d.category === "lint/style/noRestrictedImports" && d.severity === "error",
  ).length;
}

/**
 * Lint a throwaway file inside `dir` containing exactly these imports, once
 * per extension. Returns the diagnostics for each, so a rule that covers .ts
 * but not .tsx fails rather than averaging out.
 */
function probeDirectory(
  dir: string,
  specifiers: readonly string[],
): { ext: string; found: number }[] {
  return EXTENSIONS.map((ext) => {
    const file = join(dir, `${PROBE}${ext}`);
    created.push(file);
    writeFileSync(file, specifiers.map((s) => `import "${s}";\n`).join(""));
    return { ext, found: violations(file) };
  });
}

/**
 * Lint an entrypoint with these imports appended.
 *
 * The entrypoint overrides key on the exact path, so a probe file beside them
 * would not be covered by the override under test. The real file is restored
 * in afterEach, and `no probe leaves the tree modified` proves it was.
 */
function probeFile(file: string, specifiers: readonly string[]): number {
  if (!modified.has(file)) modified.set(file, readFileSync(file, "utf8"));
  const original = modified.get(file) as string;
  writeFileSync(
    file,
    `${original}\n${specifiers.map((s) => `import "${s}";\n`).join("")}`,
  );
  return violations(file);
}

/** Every directory under src/ that holds code, relative to the repo root. */
function codeDirectories(dir: string = SRC): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  const here = entries.some(
    (e) => e.isFile() && /\.tsx?$/.test(e.name) && !isProbe(e.name),
  )
    ? [dir]
    : [];
  const below = entries
    .filter((e) => e.isDirectory())
    .flatMap((e) => codeDirectories(join(dir, e.name)));
  return [...here, ...below];
}

/**
 * The boundary contract, one entry per code-bearing directory under src/.
 *
 * A directory added later is not in this table, so `every code directory
 * declares its boundary` fails until someone writes down what it may import.
 * That is the whole point of story 9: an uncovered directory has no boundary
 * rule at all, and nothing else in the build would notice.
 */
const BOUNDARIES: Record<
  string,
  { forbidden: readonly string[]; allowed: readonly string[] }
> = {
  // The two entrypoints live directly in src/ and are covered per file below.
  src: { forbidden: [], allowed: [] },

  // core is the innermost leaf: it may import nothing but itself.
  "src/core": {
    forbidden: [
      "../github/port.js",
      "../twiki/executor.js",
      "../tricorder/store/port.js",
      // src/enrich arrives with story 18. Biome matches specifiers without
      // resolving them, so its rule is testable before the directory exists,
      // and an untested rule is how a dead pattern survives.
      "../enrich/kev.js",
    ],
    allowed: ["./types.js", "node:path"],
  },

  // github and enrich are peers of each other and may use core. enrich is the
  // only directory that performs non-GitHub HTTP (AD-15), which is why it is a
  // leaf of its own rather than a corner of github.
  "src/enrich": {
    forbidden: [
      "../github/port.js",
      "../twiki/executor.js",
      "../tricorder/store/port.js",
    ],
    allowed: ["../core/types.js", "./port.js"],
  },
  "src/github": {
    forbidden: [
      "../twiki/executor.js",
      "../tricorder/store/port.js",
      "../enrich/kev.js",
    ],
    // A bare package specifier must stay legal: the entrypoint patterns are
    // anchored to relative forms precisely so hono/dist/index.js is not read
    // as an AD-5 violation.
    allowed: ["../core/types.js", "./port.js", "octokit", "hono/dist/index.js"],
  },

  // The two feature directories may use the leaves, never each other.
  "src/tricorder": {
    forbidden: ["../twiki/executor.js"],
    allowed: ["../core/types.js", "../github/port.js"],
  },
  "src/twiki": {
    forbidden: [
      "../tricorder/store/port.js",
      // The write side that merges pull requests has no business reaching the
      // network fetcher. Declaring src/enrich's own boundary did not close
      // this reverse edge, and nothing asserted it.
      "../enrich/kev.js",
    ],
    allowed: [
      "../core/types.js",
      "../github/port.js",
      "@hono/node-server/dist/index.js",
    ],
  },
  "src/tricorder/collect": {
    forbidden: ["../../twiki/executor.js"],
    allowed: ["../../core/types.js", "../store/port.js"],
  },
  "src/tricorder/store": {
    forbidden: ["../../twiki/executor.js"],
    allowed: ["../../core/types.js"],
  },
  "src/tricorder/web": {
    forbidden: ["../../twiki/executor.js"],
    allowed: ["../../core/types.js", "../store/port.js", "hono", "hono/jsx"],
  },
};

/** An entrypoint wires exactly one side, and nothing wires the other's. */
const ENTRYPOINTS: Record<
  string,
  { forbidden: readonly string[]; allowed: readonly string[] }
> = {
  "src/index.ts": {
    forbidden: ["./tricorder/web/app.js", "./tricorder.js"],
    allowed: ["./twiki/executor.js", "./core/types.js"],
  },
  "src/tricorder.ts": {
    forbidden: ["./twiki/executor.js", "./index.js"],
    allowed: ["./tricorder/web/app.js", "./core/types.js"],
  },
};

describe.sequential("module boundaries (AD-5)", () => {
  const gitStatus = () =>
    execFileSync("git", ["status", "--porcelain", SRC], { encoding: "utf8" });

  /** The tree before any probe ran, including the developer's own changes. */
  let baseline: string;
  beforeAll(() => {
    baseline = gitStatus();
  });

  describe("coverage", () => {
    it("every code directory declares its boundary", () => {
      // Compared as sets against the real tree. Adding src/enrich for story 18
      // fails here until its rules are written down and probed.
      expect(codeDirectories().sort()).toEqual(Object.keys(BOUNDARIES).sort());
    });

    it("every entrypoint declares its boundary", () => {
      const files = readdirSync(SRC, { withFileTypes: true })
        .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
        .map((e) => join(SRC, e.name))
        .sort();
      expect(files).toEqual(Object.keys(ENTRYPOINTS).sort());
    });

    it("no directory under src may import an entrypoint", () => {
      // The one rule that holds everywhere, so it doubles as the coverage
      // probe: a directory with no override at all lets this through, and
      // nothing else in the build would fail.
      for (const dir of codeDirectories().filter((d) => d !== SRC)) {
        const up = "../".repeat(relative(SRC, dir).split("/").length);
        for (const { ext, found } of probeDirectory(dir, [
          `${up}index.js`,
          `${up}tricorder.js`,
        ])) {
          // Both entrypoints, so a rule naming only one is a failure here.
          expect(found, `${dir}/*${ext} does not block both entrypoints`).toBe(
            2,
          );
        }
      }
    });
  });

  describe("relative cross-boundary imports fail lint", () => {
    for (const [dir, rules] of Object.entries(BOUNDARIES)) {
      if (rules.forbidden.length === 0) continue;

      it(`${dir} may not import across its boundary`, () => {
        // One probe carrying every forbidden import: Biome reports one
        // diagnostic per violation, so a rule that fires for only the first
        // specifier is visible here.
        for (const { ext, found } of probeDirectory(dir, rules.forbidden)) {
          expect(
            found,
            `${dir}/*${ext} allowed one of ${rules.forbidden.join(", ")}`,
          ).toBe(rules.forbidden.length);
        }
      });

      it(`${dir} may still import what it is allowed to`, () => {
        // Without this, a rule broad enough to forbid everything would pass
        // every assertion above.
        for (const { ext, found } of probeDirectory(dir, rules.allowed)) {
          expect(
            found,
            `${dir}/*${ext} forbids one of ${rules.allowed.join(", ")}`,
          ).toBe(0);
        }
      });
    }
  });

  describe("an entrypoint wires exactly one side", () => {
    for (const [file, rules] of Object.entries(ENTRYPOINTS)) {
      it(`${file} may not wire the other side`, () => {
        expect(
          probeFile(file, rules.forbidden),
          `${file} allowed one of ${rules.forbidden.join(", ")}`,
        ).toBe(rules.forbidden.length);
      });

      it(`${file} may still wire its own side`, () => {
        expect(
          probeFile(file, rules.allowed),
          `${file} may not wire its own side`,
        ).toBe(0);
      });
    }
  });

  it("no probe leaves the tree modified", () => {
    // The entrypoint probes edit real source files. If a restore ever fails,
    // this is the assertion that says so rather than a confusing diff later.
    //
    // Compared against the baseline, not against clean: work in progress under
    // src/ is the normal state while implementing, and failing on it would
    // make this suite something people learn to ignore.
    expect(gitStatus()).toBe(baseline);
  });
});
