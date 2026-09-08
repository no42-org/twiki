/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { buildConfig, type Config } from "../src/core/config.js";
import type { Mode, VersionSource } from "../src/core/types.js";
import type { FileAtRef } from "../src/github/port.js";
import { applyPlan } from "../src/twiki/executor.js";
import type { Plan } from "../src/twiki/plan.js";
import { buildDigest, hasActionableActivity } from "../src/twiki/report.js";
import { FakeGitHub, type FakeRepoData, makeFacts } from "./fakes.js";

// A tag pushed over a tree that contradicts it (#145).
//
// twiki cut packyard v0.6.2 over a tree that still said `0.6.2-rc`, so the
// published image reports `0.6.2-rc` when asked its version. Nothing between
// "compute the version" and "push the tag" read the tree at all, and a
// published image cannot be corrected by a later sweep.

const SLUG = "no42-org/demo";
const SHA = "main-sha";
const GO = "internal/version/version.go";
const COMPOSE = "compose.yml";
const GO_PATTERN = 'const version = "([^"]+)"';

/** The version this fixture's tags make twiki compute. */
const COMPUTED = "v0.6.2";

const source = (path: string, pattern = GO_PATTERN): VersionSource => ({
  path,
  pattern,
});

function config(sources: VersionSource[], mode: Mode = "enforce"): Config {
  return buildConfig({
    mode,
    repos: [
      {
        repo: SLUG,
        ...(sources.length > 0 ? { versionSources: sources } : {}),
      },
    ],
  });
}

function gh(contents: Record<string, string> = {}): FakeGitHub {
  const data: FakeRepoData = {
    rawPrs: [],
    prChecks: {},
    mainChecks: "green",
    latestTag: "v0.6.1",
    unreleased: 1,
    hasWorkflow: true,
    defaultSha: SHA,
    contents,
  };
  return new FakeGitHub(new Map([[SLUG, data]]));
}

/** The Go file as packyard's tree carries it, saying whatever it is given. */
const goFile = (version: string) =>
  `package version\n\nconst version = "${version}"\n`;

const releasePlan: Plan = {
  repos: [
    {
      repo: SLUG,
      prDecisions: [],
      release: { action: "release", reason: "settled" },
    },
  ],
};

async function tick(
  sources: VersionSource[],
  contents: Record<string, string>,
  mode: Mode = "enforce",
) {
  const github = gh(contents);
  const result = await applyPlan(
    [makeFacts({ latestTag: "v0.6.1" })],
    releasePlan,
    config(sources, mode),
    github,
  );
  return { github, result, repo: result.repos[0] };
}

describe("a tree whose version contradicts the tag", () => {
  it("blocks the release, names both versions and the file, and writes nothing", async () => {
    const { repo, github } = await tick([source(GO)], {
      [`${SHA}:${GO}`]: goFile("0.6.2-rc"),
    });
    expect(repo?.release.status).toBe("tree-version-mismatch");
    expect(repo?.release.version).toBe(COMPUTED);
    expect(repo?.release.detail).toContain(COMPUTED);
    expect(repo?.release.detail).toContain("0.6.2-rc");
    expect(repo?.release.detail).toContain(GO);
    expect(github.tagged).toEqual([]);
  });

  it("is neither an errored nor a stopped repository", async () => {
    const { repo } = await tick([source(GO)], {
      [`${SHA}:${GO}`]: goFile("0.6.2-rc"),
    });
    expect(repo?.error).toBeUndefined();
    expect(repo?.stoppedEarly).toBeFalsy();
  });

  it("releases when the tree agrees", async () => {
    const { repo, github } = await tick([source(GO)], {
      [`${SHA}:${GO}`]: goFile("0.6.2"),
    });
    expect(repo?.release).toMatchObject({
      status: "released",
      version: COMPUTED,
    });
    expect(github.tagged).toEqual([{ repo: SLUG, tag: COMPUTED, sha: SHA }]);
  });

  it("releases when the tree carries the prefixed form", async () => {
    // One optional leading `v` comes off each side, and nothing else does.
    const { repo, github } = await tick([source(GO)], {
      [`${SHA}:${GO}`]: goFile("v0.6.2"),
    });
    expect(repo?.release.status).toBe("released");
    expect(github.tagged).toHaveLength(1);
  });

  it("names the source that disagreed, not the first one declared", async () => {
    const { repo, github } = await tick([source(GO), source(COMPOSE)], {
      [`${SHA}:${GO}`]: goFile("0.6.2"),
      [`${SHA}:${COMPOSE}`]: goFile("0.6.1"),
    });
    expect(repo?.release.status).toBe("tree-version-mismatch");
    expect(repo?.release.detail).toContain(COMPOSE);
    expect(repo?.release.detail).not.toContain(GO);
    expect(github.tagged).toEqual([]);
  });
});

describe("a declared source that identifies no version", () => {
  it("blocks when the pattern matches but captures nothing", async () => {
    // The group sits in an alternative the match did not take. Something
    // matched and no version came of it, and the guard that says so is the
    // difference between a clean block and a thrown TypeError that would
    // error the whole repository.
    const { repo, github } = await tick(
      [source(GO, 'unreleased|const version = "(.*)"')],
      { [`${SHA}:${GO}`]: "package version\n\nunreleased\n" },
    );
    expect(repo?.release.status).toBe("tree-version-mismatch");
    expect(repo?.error).toBeUndefined();
    expect(github.tagged).toEqual([]);
  });

  it("blocks without a hole in the sentence when the capture is blank", async () => {
    const { repo } = await tick([source(GO, 'const version = "(.*)"')], {
      [`${SHA}:${GO}`]: goFile(""),
    });
    expect(repo?.release.status).toBe("tree-version-mismatch");
    // The bug this forbids: `says  at main-sh`, with nothing where the
    // version belongs.
    expect(repo?.release.detail).not.toMatch(/says\s+at /);
  });

  it("blocks and names the path when the file is not there at that commit", async () => {
    const { repo } = await tick([source(GO)], {});
    expect(repo?.release.status).toBe("tree-version-mismatch");
    expect(repo?.release.detail).toContain(GO);
    // An absent file is an absence, not a throw: nothing failed.
    expect(repo?.error).toBeUndefined();
    expect(repo?.stoppedEarly).toBeFalsy();
  });

  it("blocks and names the pattern when nothing in the file matches", async () => {
    const { repo, github } = await tick([source(GO)], {
      [`${SHA}:${GO}`]: "package version\n\n// the constant moved\n",
    });
    expect(repo?.release.status).toBe("tree-version-mismatch");
    expect(repo?.release.detail).toContain(GO);
    expect(repo?.release.detail).toContain(GO_PATTERN);
    expect(github.tagged).toEqual([]);
  });

  it("blocks on two matches rather than resolving to the first", async () => {
    // BOTH matches say what twiki computed, so an implementation that took
    // the first match would release here and this test would go green on the
    // very behaviour it forbids. Two answers do not identify a version.
    const { repo, github } = await tick([source(GO)], {
      [`${SHA}:${GO}`]: `${goFile("0.6.2")}${goFile("0.6.2")}`,
    });
    expect(repo?.release.status).toBe("tree-version-mismatch");
    expect(repo?.release.detail).toContain(GO);
    // Worded for any number of matches: the scan stops at the second, so no
    // count is carried and the sentence must not imply one.
    expect(repo?.release.detail).toContain("more than one place");
    expect(github.tagged).toEqual([]);
  });
});

describe("what the check reads, and when", () => {
  it("reads the declared sources at the sha it is about to tag", async () => {
    // The agreeing text exists ONLY at the sha that gets tagged. A check that
    // read some other ref would find nothing there and block.
    const { repo, github } = await tick([source(GO)], {
      [`${SHA}:${GO}`]: goFile("0.6.2"),
      [`other-sha:${GO}`]: goFile("0.6.2-rc"),
    });
    expect(repo?.release.status).toBe("released");
    expect(github.contentReads).toEqual([{ repo: SLUG, path: GO, ref: SHA }]);
    expect(github.tagged[0]?.sha).toBe(github.contentReads[0]?.ref);
  });

  it("tags the commit it read, when the branch moves underneath it", async () => {
    // The sha is read once and handed to the push. Were it read again for the
    // push, this repository would be tagged at `second-sha` on the strength
    // of a check that only ever looked at `first-sha`.
    class MovingHead extends FakeGitHub {
      calls = 0;
      override async defaultBranchSha(): Promise<string> {
        this.calls += 1;
        return this.calls === 1 ? "first-sha" : "second-sha";
      }
    }
    const github = new MovingHead(
      new Map([
        [
          SLUG,
          {
            rawPrs: [],
            prChecks: {},
            mainChecks: "green" as const,
            latestTag: "v0.6.1",
            unreleased: 1,
            hasWorkflow: true,
            defaultSha: "unused",
            contents: { [`first-sha:${GO}`]: goFile("0.6.2") },
          },
        ],
      ]),
    );

    const result = await applyPlan(
      [makeFacts({ latestTag: "v0.6.1" })],
      releasePlan,
      config([source(GO)]),
      github,
    );

    expect(result.repos[0]?.release.status).toBe("released");
    expect(github.contentReads[0]?.ref).toBe("first-sha");
    expect(github.tagged).toEqual([
      { repo: SLUG, tag: COMPUTED, sha: "first-sha" },
    ]);
  });

  it("reads nothing at all for a repository that declares no source", async () => {
    const { repo, github } = await tick([], {});
    expect(repo?.release.status).toBe("released");
    expect(github.contentReads).toEqual([]);
  });

  it("reaches the same verdict in shadow, and writes nothing", async () => {
    const { repo, github } = await tick(
      [source(GO)],
      { [`${SHA}:${GO}`]: goFile("0.6.2-rc") },
      "shadow",
    );
    expect(repo?.release.status).toBe("tree-version-mismatch");
    expect(repo?.release.detail).toContain("0.6.2-rc");
    expect(github.contentReads).toHaveLength(1);
    expect(github.tagged).toEqual([]);
  });

  it("still says would-release in shadow when the tree agrees", async () => {
    const { repo, github } = await tick(
      [source(GO)],
      { [`${SHA}:${GO}`]: goFile("0.6.2") },
      "shadow",
    );
    expect(repo?.release).toMatchObject({
      status: "would-release",
      version: COMPUTED,
    });
    expect(github.tagged).toEqual([]);
  });
});

describe("a blocked release in the digest", () => {
  it("is posted, and reads as work for a human rather than a failure", async () => {
    const { result } = await tick([source(GO)], {
      [`${SHA}:${GO}`]: goFile("0.6.2-rc"),
    });
    expect(hasActionableActivity(result)).toBe(true);
    const digest = buildDigest(result);
    expect(digest).toContain("0.6.2-rc");
    expect(digest).toContain(COMPUTED);
    expect(digest).toContain(GO);
    expect(digest).not.toMatch(/errored|failed write|stopped early/i);
  });

  it("is not suppressed for a repository whose only news is the block", async () => {
    // A quiet repository is exactly where a block hides: nothing merging,
    // nothing releasing, so without this it would be blocked every tick and
    // reported on none of them.
    const { result } = await tick([source(GO)], {
      [`${SHA}:${GO}`]: goFile("0.6.2-rc"),
    });
    expect(result.repos[0]?.prs).toEqual([]);
    expect(hasActionableActivity(result)).toBe(true);
  });
});

/** A fake whose content read answers however the test says. */
class Answering extends FakeGitHub {
  constructor(
    private readonly answer: FileAtRef | Error,
    data: FakeRepoData,
  ) {
    super(new Map([[SLUG, data]]));
  }
  override async readFileAtRef(): Promise<FileAtRef> {
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

const answering = (answer: FileAtRef | Error) =>
  new Answering(answer, {
    rawPrs: [],
    prChecks: {},
    mainChecks: "green",
    latestTag: "v0.6.1",
    unreleased: 1,
    hasWorkflow: true,
    defaultSha: SHA,
  });

async function tickWith(github: FakeGitHub) {
  const result = await applyPlan(
    [makeFacts({ latestTag: "v0.6.1" })],
    releasePlan,
    config([source(GO)]),
    github,
  );
  return { github, result, repo: result.repos[0] };
}

describe("what the check says about a path that is not a readable file", () => {
  it("errors the repository when the read fails, rather than blaming it", async () => {
    // A 403 or a 502 is twiki's outage, not the repository's. Swallowed into
    // "the file is absent" it would read as a tree the operator has to go and
    // fix, and every subsequent tick would repeat the accusation.
    const { repo, github } = await tickWith(
      answering(
        Object.assign(new Error("403 Resource not accessible by integration"), {
          status: 403,
        }),
      ),
    );
    expect(repo?.release.status).not.toBe("tree-version-mismatch");
    expect(repo?.error).toMatch(/403/);
    expect(repo?.stoppedEarly).toBe(true);
    expect(github.tagged).toEqual([]);
  });

  it("does not call a directory or a symlink a missing file", async () => {
    for (const type of ["dir", "symlink", "submodule"]) {
      const { repo } = await tickWith(answering({ kind: "not-a-file", type }));
      expect(repo?.release.status).toBe("tree-version-mismatch");
      expect(repo?.release.detail).toContain(type);
      // It IS at the declared path. Saying otherwise sends the operator
      // looking for a file that is right there.
      expect(repo?.release.detail).not.toContain("not in the tree");
      expect(repo?.error).toBeUndefined();
    }
  });

  it("names the size and the limit when GitHub will not inline the file", async () => {
    const { repo } = await tickWith(
      answering({
        kind: "too-large",
        bytes: 2_000_000,
        limitBytes: 1_048_576,
        encoding: "none",
      }),
    );
    expect(repo?.release.status).toBe("tree-version-mismatch");
    expect(repo?.release.detail).toContain("2000000");
    expect(repo?.release.detail).toContain("1048576");
    // Never "the pattern found nothing": the file is fine, the API declined.
    expect(repo?.release.detail).not.toContain(GO_PATTERN);
    expect(repo?.error).toBeUndefined();
  });
});

describe("a block stops one repository and nothing else", () => {
  it("leaves the rest of the tick to release", async () => {
    // The whole reason this is an outcome and not an error: the blocked
    // repository finishes its own tick and the ones after it are untouched.
    const OTHER = "no42-org/other";
    const data = (contents: Record<string, string>): FakeRepoData => ({
      rawPrs: [],
      prChecks: {},
      mainChecks: "green",
      latestTag: "v0.6.1",
      unreleased: 1,
      hasWorkflow: true,
      defaultSha: SHA,
      contents,
    });
    const github = new FakeGitHub(
      new Map([
        [SLUG, data({ [`${SHA}:${GO}`]: goFile("0.6.2-rc") })],
        [OTHER, data({ [`${SHA}:${GO}`]: goFile("0.6.2") })],
      ]),
    );
    const two = buildConfig({
      mode: "enforce",
      repos: [
        { repo: SLUG, versionSources: [source(GO)] },
        { repo: OTHER, versionSources: [source(GO)] },
      ],
    });

    const result = await applyPlan(
      [
        makeFacts({ latestTag: "v0.6.1" }),
        makeFacts({
          repo: { owner: "no42-org", name: "other" },
          latestTag: "v0.6.1",
        }),
      ],
      { repos: [] },
      two,
      github,
    );

    expect(result.repos[0]?.release.status).toBe("tree-version-mismatch");
    expect(result.repos[0]?.stoppedEarly).toBeFalsy();
    expect(result.repos[0]?.notEvaluated).toBeUndefined();
    expect(result.repos[1]?.release.status).toBe("released");
    expect(github.tagged).toEqual([{ repo: OTHER, tag: COMPUTED, sha: SHA }]);
  });
});
