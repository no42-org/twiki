/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { highestStableTag, planRelease } from "../src/semver.js";

// CI glue for the release workflow: gather git/env facts, defer the version and
// tag decisions to the canonical (tested) planRelease(), and emit the result as
// GitHub Actions step outputs. Keeping the rules in src/semver.ts means the
// workflow and the app reason about versions the same way.

function git(args: string[]): string {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const refType = process.env.GITHUB_REF_TYPE === "tag" ? "tag" : "branch";
const refName = process.env.GITHUB_REF_NAME ?? "";
const registry = process.env.REGISTRY ?? "ghcr.io";
const image = `${registry}/${(process.env.GITHUB_REPOSITORY ?? "").toLowerCase()}`;
const shortSha = git(["rev-parse", "--short", "HEAD"]);
const tags = git(["tag", "--list", "v*"]).split("\n").filter(Boolean);

// Commits since the highest stable tag (the -dev.<n> counter); 0 on first release.
const highest = highestStableTag(tags);
const commitsSinceHighest = Number(
  highest
    ? git(["rev-list", `${highest}..HEAD`, "--count"])
    : git(["rev-list", "HEAD", "--count"]),
);

let plan: ReturnType<typeof planRelease>;
try {
  plan = planRelease({ refType, refName, tags, commitsSinceHighest, shortSha });
} catch (err) {
  console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}

const tagRefs = plan.tagSuffixes.map((s) => `${image}:${s}`);
const outPath = process.env.GITHUB_OUTPUT;
if (!outPath) {
  console.error("GITHUB_OUTPUT is not set");
  process.exit(1);
}

appendFileSync(
  outPath,
  [
    `image=${image}`,
    `channel=${plan.channel}`,
    `prerelease=${plan.prerelease}`,
    `latest=${plan.tagSuffixes.includes("latest")}`,
    `relversion=${plan.version}`,
    `short=${shortSha}`,
    "tags<<__EOF__",
    ...tagRefs,
    "__EOF__",
    "",
  ].join("\n"),
);

console.error(
  `channel=${plan.channel} version=${plan.version} tags=${tagRefs.join(",")}`,
);
