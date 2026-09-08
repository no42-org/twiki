/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import {
  isBrokenVerdict,
  type RunVerdict,
  runVerdict,
  type VerdictRun,
} from "../src/core/run-verdict.js";

const NOW = new Date("2026-09-08T12:00:00.000Z");
/**
 * A threshold in the order of magnitude the wiring uses. Nothing here pins it
 * to the lane's cadence, and this comment does not claim it does: the binding
 * lives in `main()`, which is not exported, so the story that first reads the
 * count is where it gets pinned.
 */
const HUNG_AFTER_MS = 2 * 60 * 60_000;

/** A run created at `NOW`, i.e. one that could never be old enough to hang. */
const run = (over: Partial<VerdictRun> = {}): VerdictRun => ({
  status: "completed",
  conclusion: "success",
  createdAt: NOW.toISOString(),
  ...over,
});

/** `ms` before NOW, so a case says its age rather than a literal date. */
const agedMs = (ms: number): string =>
  new Date(NOW.getTime() - ms).toISOString();

describe("runVerdict", () => {
  describe.each<[string, VerdictRun, RunVerdict]>([
    // A concluded run is judged on its conclusion, one case per word GitHub
    // documents. `timed_out` and `startup_failure` are failures because a
    // reader looking at main cares that nothing shipped, not by which
    // mechanism it did not.
    ["failure", run({ conclusion: "failure" }), "failed"],
    ["timed_out", run({ conclusion: "timed_out" }), "failed"],
    ["startup_failure", run({ conclusion: "startup_failure" }), "failed"],
    ["success", run({ conclusion: "success" }), "passed"],
    ["cancelled", run({ conclusion: "cancelled" }), "other"],
    ["skipped", run({ conclusion: "skipped" }), "other"],
    ["neutral", run({ conclusion: "neutral" }), "other"],
    ["action_required", run({ conclusion: "action_required" }), "other"],
    ["stale", run({ conclusion: "stale" }), "other"],
    // A word this build has never heard of is not evidence of a failure.
    // Guessing otherwise would invent red mains out of a GitHub release note.
    ["a conclusion we do not know", run({ conclusion: "quantum" }), "other"],
  ])("a completed run concluding %s", (_word, input, expected) => {
    it(`is ${expected}`, () => {
      expect(runVerdict(input, NOW, HUNG_AFTER_MS)).toBe(expected);
    });
  });

  describe.each<[string, VerdictRun, RunVerdict]>([
    [
      "in_progress since well past the threshold",
      run({
        status: "in_progress",
        conclusion: null,
        createdAt: agedMs(HUNG_AFTER_MS * 3),
      }),
      "hung",
    ],
    [
      "queued since well past the threshold",
      run({
        status: "queued",
        conclusion: null,
        createdAt: agedMs(HUNG_AFTER_MS * 3),
      }),
      "hung",
    ],
    // Held for a person, not stuck. GitHub parks a run in each of these for
    // as long as the approval takes - days, routinely - and reading age as a
    // hang would put a red main on the overview for every repository that
    // gates its production deploy behind a reviewer.
    [
      "waiting for a deployment approval, however old",
      run({
        status: "waiting",
        conclusion: null,
        createdAt: agedMs(HUNG_AFTER_MS * 1000),
      }),
      "other",
    ],
    [
      "requested, however old",
      run({
        status: "requested",
        conclusion: null,
        createdAt: agedMs(HUNG_AFTER_MS * 1000),
      }),
      "other",
    ],
    [
      "pending behind a concurrency group, however old",
      run({
        status: "pending",
        conclusion: null,
        createdAt: agedMs(HUNG_AFTER_MS * 1000),
      }),
      "other",
    ],
    [
      // Whatever GitHub adds next is `other` until somebody decides
      // otherwise, which is the answer that cannot invent a failure.
      "a status we do not know, however old",
      run({
        status: "hibernating",
        conclusion: null,
        createdAt: agedMs(HUNG_AFTER_MS * 1000),
      }),
      "other",
    ],
    [
      "in_progress for a minute",
      run({
        status: "in_progress",
        conclusion: null,
        createdAt: agedMs(60_000),
      }),
      "other",
    ],
    [
      // The boundary itself, both sides. An off-by-one here decides whether
      // every run of a slow workflow reads hung one sweep early.
      "in_progress for exactly the threshold",
      run({
        status: "in_progress",
        conclusion: null,
        createdAt: agedMs(HUNG_AFTER_MS),
      }),
      "other",
    ],
    [
      "in_progress for one millisecond past the threshold",
      run({
        status: "in_progress",
        conclusion: null,
        createdAt: agedMs(HUNG_AFTER_MS + 1),
      }),
      "hung",
    ],
    [
      // A run created in the future is a clock disagreement, not a hang.
      "in_progress and created in the future",
      run({
        status: "in_progress",
        conclusion: null,
        createdAt: new Date(NOW.getTime() + HUNG_AFTER_MS).toISOString(),
      }),
      "other",
    ],
  ])("a run %s", (_word, input, expected) => {
    it(`is ${expected}`, () => {
      expect(runVerdict(input, NOW, HUNG_AFTER_MS)).toBe(expected);
    });
  });

  it("never calls a completed run with no conclusion hung", () => {
    // GitHub should not send this. If it does, the run is over: it cannot be
    // hanging. Falling through to the age check would turn the row into a
    // permanent `hung` the moment it aged past the threshold - a failure
    // invented out of a missing field, and one that never clears.
    expect(
      runVerdict(
        run({
          status: "completed",
          conclusion: null,
          createdAt: agedMs(HUNG_AFTER_MS * 100),
        }),
        NOW,
        HUNG_AFTER_MS,
      ),
    ).toBe("other");
  });

  it("reads an unparseable createdAt as other, not as a hang", () => {
    // A bad timestamp is not evidence that a run is old. Verdicts feed the
    // rank chain, so the answer here must be the one that cannot manufacture
    // a red main out of a corrupt string.
    expect(
      runVerdict(
        run({ status: "in_progress", conclusion: null, createdAt: "nonsense" }),
        NOW,
        HUNG_AFTER_MS,
      ),
    ).toBe("other");
    expect(
      runVerdict(
        run({ status: "in_progress", conclusion: null, createdAt: "" }),
        NOW,
        HUNG_AFTER_MS,
      ),
    ).toBe("other");
  });

  it("lets the conclusion decide even when the status disagrees", () => {
    // GitHub sets a conclusion only when it has concluded something, so a
    // stated one is the more specific fact. Reading the status first would
    // let an old run that GitHub has already failed read as hung, and the two
    // words mean different things to a reader.
    expect(
      runVerdict(
        run({
          status: "in_progress",
          conclusion: "failure",
          createdAt: agedMs(HUNG_AFTER_MS * 3),
        }),
        NOW,
        HUNG_AFTER_MS,
      ),
    ).toBe("failed");
  });

  it("owns no clock: the same run is judged by the `now` it is given", () => {
    // Purity, asserted rather than asserted about. The lane passes one
    // instant per sweep, and a function reading Date.now() itself could not
    // be driven that way.
    const stuck = run({
      status: "in_progress",
      conclusion: null,
      createdAt: NOW.toISOString(),
    });
    expect(runVerdict(stuck, NOW, HUNG_AFTER_MS)).toBe("other");
    expect(
      runVerdict(
        stuck,
        new Date(NOW.getTime() + HUNG_AFTER_MS + 1),
        HUNG_AFTER_MS,
      ),
    ).toBe("hung");
  });
});

describe("isBrokenVerdict", () => {
  it("counts failed and hung, and nothing else", () => {
    // Named once so the lane's counter and the rank term cannot disagree
    // about whether a run that never finished is a broken build.
    expect(
      (["failed", "hung", "passed", "other"] as const).map(isBrokenVerdict),
    ).toEqual([true, true, false, false]);
  });
});
