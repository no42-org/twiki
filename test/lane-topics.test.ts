/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import {
  LANE_TOPIC,
  laneTopic,
} from "../src/tricorder/attention/lane-topics.js";

// AD-32: every lane warns on one tile, resolved through one map keyed by the
// `LANE` constants. The walk below imports every module under collect/ that
// exports a `LANE` and reads it, so a lane added later cannot ship without a
// tile: the map would still compile, and its failure would warn nowhere.

const COLLECT = resolve("src/tricorder/collect");

/**
 * Every `LANE` exported from a module under collect/, keyed by file.
 *
 * Only modules whose source declares the export are imported. The
 * boundaries test writes probe files into this directory while the suite
 * runs, and one of them imports the twiki entrypoint: importing it here
 * started `main()` inside the test worker.
 */
async function exportedLanes(): Promise<Map<string, string>> {
  const lanes = new Map<string, string>();
  // Recursive and both extensions, so a lane filed in a subdirectory or as
  // .tsx is still walked.
  const files = readdirSync(COLLECT, { recursive: true, encoding: "utf8" })
    .filter((file) => /\.tsx?$/.test(file))
    .sort();
  for (const file of files) {
    const path = join(COLLECT, file);
    if (!/^export const LANE\b/m.test(readFileSync(path, "utf8"))) continue;
    const mod = (await import(pathToFileURL(path).href)) as { LANE?: unknown };
    if (typeof mod.LANE === "string") lanes.set(file, mod.LANE);
  }
  return lanes;
}

describe("lane-topics (AD-32)", () => {
  it("maps every LANE exported under collect/, and nothing else", async () => {
    const lanes = await exportedLanes();

    // Ten today. A count pins the walk itself: a directory read that found
    // nothing would otherwise pass the exhaustiveness check vacuously.
    expect([...lanes.values()].sort()).toEqual(
      [
        "coverage",
        "graphql-issues",
        "graphql-review-requests",
        "graphql-update-prs",
        "graphql-update-status",
        "kev",
        "rest-actions-runs",
        "rest-org-code-scanning",
        "rest-org-dependabot",
        "rest-org-secret-scanning",
      ].sort(),
    );
    for (const [file, lane] of lanes) {
      expect(laneTopic(lane), `${file} exports LANE ${lane}`).toBeDefined();
    }
    expect([...LANE_TOPIC.keys()].sort()).toEqual([...lanes.values()].sort());
  });

  it("sends each lane to its tile with the words the warning uses", () => {
    // Spelled as literals, not through the constants: a map asserted against
    // the constants it is keyed by cannot fail on a renamed lane.
    expect([...LANE_TOPIC.entries()]).toEqual([
      [
        "rest-org-dependabot",
        { topic: "security", word: "alerts", installation: null },
      ],
      [
        "rest-org-code-scanning",
        { topic: "security", word: "code scanning", installation: null },
      ],
      [
        "rest-org-secret-scanning",
        { topic: "security", word: "secret scanning", installation: null },
      ],
      [
        "graphql-update-prs",
        { topic: "dependencies", word: "update PRs", installation: null },
      ],
      [
        "graphql-update-status",
        { topic: "dependencies", word: "update status", installation: null },
      ],
      [
        "graphql-issues",
        { topic: "issues", word: "issues", installation: null },
      ],
      [
        "graphql-review-requests",
        { topic: "reviews", word: "review requests", installation: "reviews" },
      ],
      [
        "rest-actions-runs",
        { topic: "ci", word: "workflow runs", installation: null },
      ],
      ["coverage", { topic: "security", word: "coverage", installation: null }],
      [
        "kev",
        { topic: "security", word: "KEV catalogue", installation: "cisa" },
      ],
    ]);
    expect(laneTopic("no-such-lane")).toBeUndefined();
  });
});
