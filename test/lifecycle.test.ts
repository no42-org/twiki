/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withLaneRun } from "../src/tricorder/collect/lifecycle.js";
import type { RunRef, StorePort } from "../src/tricorder/store/port.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";

// The one failure path every lane shares (#71). Against a real store, because
// the behaviour under test is what the run row ends up saying.

const LANE = "test-lane";
const INSTALLATION = "no42-org";

/** A stand-in for a lane's result: some counter, and the lane's own outcome. */
interface LaneResult {
  installation: string;
  outcome: "ok" | "partial" | "failed";
  things: number;
}

const ZERO: LaneResult = {
  installation: INSTALLATION,
  outcome: "failed",
  things: 0,
};

describe("the shared lane run lifecycle (#71)", () => {
  let dir: string;
  let store: SqliteStore;
  let logs: string[];
  let clock: number;

  const at = (minute: number) =>
    new Date(Date.UTC(2026, 8, 8, 12, minute)).toISOString();

  const deps = () => ({
    store,
    now: () => at(clock++),
    log: (m: string) => logs.push(m),
  });

  const start = {
    lane: LANE,
    installation: INSTALLATION,
    scope: "full" as const,
    reach: "per-installation" as const,
  };

  /**
   * The real store with one method replaced.
   *
   * A hand-written stub would have to implement the whole port and would
   * answer every other call with a fiction; here a run begun by the wrapper
   * is still a real row, so "the store threw while failing" can be told apart
   * from "no run was ever begun".
   */
  const storeWith = (over: Partial<StorePort>): StorePort =>
    new Proxy(store, {
      get(target, prop) {
        // hasOwn, not `in`: `in` walks the prototype chain, so an override
        // object would answer `toString` or `valueOf` with Object.prototype's
        // unbound version. It does not bite for the two methods the wrapper
        // touches, and this helper reads as general.
        if (Object.hasOwn(over, prop)) return Reflect.get(over, prop);
        const value = Reflect.get(target, prop);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lifecycle-"));
    store = SqliteStore.openForWrite(join(dir, "l.db"));
    logs = [];
    clock = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns the body's own result, with the body's own finishRun standing", async () => {
    const result = await withLaneRun<LaneResult>(
      deps(),
      start,
      ZERO,
      async (run) => {
        store.finishRun(run, "partial", at(clock++), "2 nodes unreadable");
        return { installation: INSTALLATION, outcome: "partial", things: 3 };
      },
    );

    expect(result).toEqual({
      installation: INSTALLATION,
      outcome: "partial",
      things: 3,
    });
    // The whole row: the wrapper must not have touched the outcome or the
    // detail the body committed.
    expect(store.latestRuns(10)).toEqual([
      {
        id: expect.any(Number),
        lane: LANE,
        installation: INSTALLATION,
        scope: "full",
        outcome: "partial",
        detail: "2 nodes unreadable",
        startedAt: at(0),
        verifiedAt: at(1),
      },
    ]);
    expect(logs).toEqual([]);
  });

  it("hands the body the run it began and the clock it began at", async () => {
    let seen: { run: RunRef; startedAt: string } | null = null;

    await withLaneRun<LaneResult>(
      deps(),
      start,
      ZERO,
      async (run, startedAt) => {
        seen = { run, startedAt };
        store.finishRun(run, "ok", at(clock++));
        return { installation: INSTALLATION, outcome: "ok", things: 1 };
      },
    );

    const [row] = store.latestRuns(1);
    expect(seen).toEqual({
      run: {
        id: row?.id,
        lane: LANE,
        installation: INSTALLATION,
        scope: "full",
      },
      // The same read of the clock the run row carries, not a second one:
      // a lane that judges its own work against the sweep's clock reads it
      // here.
      startedAt: row?.startedAt,
    });
    expect(row?.startedAt).toBe(at(0));
  });

  it("lets a body return early, running nothing after it", async () => {
    const steps: string[] = [];

    // Shaped like the 304 paths: a terminal branch that finishes the run
    // mid-body and skips everything below.
    const body = (notModified: boolean) => async (run: RunRef) => {
      if (notModified) {
        store.finishRun(run, "ok", at(clock++), "not modified (304)");
        steps.push("304");
        return {
          installation: INSTALLATION,
          outcome: "ok" as const,
          things: 0,
        };
      }
      steps.push("swept");
      store.finishRun(run, "ok", at(clock++));
      return { installation: INSTALLATION, outcome: "ok" as const, things: 9 };
    };

    const result = await withLaneRun<LaneResult>(
      deps(),
      start,
      ZERO,
      body(true),
    );

    expect(result).toEqual({
      installation: INSTALLATION,
      outcome: "ok",
      things: 0,
    });
    expect(steps).toEqual(["304"]);
    expect(store.latestRuns(10)).toEqual([
      {
        id: expect.any(Number),
        lane: LANE,
        installation: INSTALLATION,
        scope: "full",
        outcome: "ok",
        detail: "not modified (304)",
        startedAt: at(0),
        verifiedAt: at(1),
      },
    ]);
  });

  it("finishes the run failed and returns the zeroed result when the body throws", async () => {
    const result = await withLaneRun<LaneResult>(
      deps(),
      start,
      ZERO,
      async () => {
        throw new Error("connect ETIMEDOUT");
      },
    );

    expect(result).toEqual(ZERO);
    expect(store.latestRuns(10)).toEqual([
      {
        id: expect.any(Number),
        lane: LANE,
        installation: INSTALLATION,
        scope: "full",
        outcome: "failed",
        detail: "connect ETIMEDOUT",
        startedAt: at(0),
        verifiedAt: at(1),
      },
    ]);
    expect(logs).toEqual([
      `${LANE} ${INSTALLATION}: failed, connect ETIMEDOUT`,
    ]);
  });

  it("stringifies a throw that is not an Error", async () => {
    const result = await withLaneRun<LaneResult>(
      deps(),
      start,
      ZERO,
      async () => {
        throw "not an Error";
      },
    );

    expect(result).toEqual(ZERO);
    expect(store.latestRuns(1)[0]?.detail).toBe("not an Error");
    expect(logs).toEqual([`${LANE} ${INSTALLATION}: failed, not an Error`]);
  });

  it("redacts a credential in both the log line and the stored detail", async () => {
    const token = `ghp_${"A1b2C3d4".repeat(5)}`;

    const result = await withLaneRun<LaneResult>(
      deps(),
      start,
      ZERO,
      async () => {
        throw new Error(`bad credentials: ${token}`);
      },
    );

    expect(result).toEqual(ZERO);
    expect(store.latestRuns(1)[0]?.detail).toBe(
      "bad credentials: gh?_REDACTED",
    );
    expect(logs).toEqual([
      `${LANE} ${INSTALLATION}: failed, bad credentials: gh?_REDACTED`,
    ]);
    // Belt and braces: the token must not survive anywhere it was written.
    expect(JSON.stringify(store.latestRuns(1))).not.toContain(token);
    expect(logs.join("\n")).not.toContain(token);
  });

  it("swallows a store that throws while failing the run", async () => {
    const failing = storeWith({
      finishRun: () => {
        throw new Error("database is locked");
      },
    });

    const result = await withLaneRun<LaneResult>(
      { ...deps(), store: failing },
      start,
      ZERO,
      async () => {
        throw new Error("connect ETIMEDOUT");
      },
    );

    // The log line and the zeroed result still happen; the run row is left as
    // beginRun wrote it, because the store is what failed.
    //
    // That row is not a shrug: `partial` with a null detail and verified_at
    // still equal to started_at is exactly the triple
    // src/tricorder/attention/health.ts:63 reads as a run in flight, so the
    // lane shows `running` until its freshness budget passes and `stalled`
    // after - which is the truthful reading of a run nothing will ever
    // finish.
    expect(result).toEqual(ZERO);
    expect(logs).toEqual([
      `${LANE} ${INSTALLATION}: failed, connect ETIMEDOUT`,
    ]);
    expect(store.latestRuns(10)).toEqual([
      {
        id: expect.any(Number),
        lane: LANE,
        installation: INSTALLATION,
        scope: "full",
        outcome: "partial",
        detail: null,
        startedAt: at(0),
        verifiedAt: at(0),
      },
    ]);
  });

  it("contains a beginRun that throws, with no run to finish", async () => {
    let bodyRan = false;
    // Counted, not inferred from the absence of a row: with no run handle,
    // calling the store anyway would throw inside the failure path's own
    // guard and be swallowed, leaving every other assertion here true. This
    // is the assertion that says the null check ran.
    const finishes: unknown[][] = [];
    const failing = storeWith({
      beginRun: () => {
        throw new Error("database is locked");
      },
      finishRun: (...args: unknown[]) => {
        finishes.push(args);
      },
    });

    const result = await withLaneRun<LaneResult>(
      { ...deps(), store: failing },
      start,
      ZERO,
      async () => {
        bodyRan = true;
        return {
          installation: INSTALLATION,
          outcome: "ok" as const,
          things: 1,
        };
      },
    );

    expect(result).toEqual(ZERO);
    expect(bodyRan).toBe(false);
    expect(logs).toEqual([
      `${LANE} ${INSTALLATION}: failed, database is locked`,
    ]);
    // No row at all: there was never a run to finish.
    expect(store.latestRuns(10)).toEqual([]);
    expect(finishes).toEqual([]);
  });

  it("names the lane alone for a global lane", async () => {
    const result = await withLaneRun<LaneResult>(
      deps(),
      { ...start, installation: "cisa-kev", reach: "global" },
      ZERO,
      async () => {
        throw new Error("connect ETIMEDOUT");
      },
    );

    expect(result).toEqual(ZERO);
    expect(logs).toEqual([`${LANE}: failed, connect ETIMEDOUT`]);
    // The run is still stored against its installation; only the line differs.
    expect(store.latestRuns(1)[0]?.installation).toBe("cisa-kev");
  });

  it("returns a copy of the zeroed result, never the caller's object", async () => {
    // Every lane passes a fresh literal today, so this is latent. It stops
    // being latent the moment a lane hoists its zero into a module constant:
    // one caller mutating the result it got back would change every later
    // failure of that lane.
    const first = await withLaneRun<LaneResult>(
      deps(),
      start,
      ZERO,
      async () => {
        throw new Error("connect ETIMEDOUT");
      },
    );
    first.things = 99;

    const second = await withLaneRun<LaneResult>(
      deps(),
      start,
      ZERO,
      async () => {
        throw new Error("connect ETIMEDOUT");
      },
    );

    expect(second).toEqual({
      installation: INSTALLATION,
      outcome: "failed",
      things: 0,
    });
    expect(ZERO).toEqual({
      installation: INSTALLATION,
      outcome: "failed",
      things: 0,
    });
  });

  it("survives a logger that throws on the failure line", async () => {
    const result = await withLaneRun<LaneResult>(
      {
        store,
        now: () => at(clock++),
        log: () => {
          throw new Error("EPIPE");
        },
      },
      start,
      ZERO,
      async () => {
        throw new Error("connect ETIMEDOUT");
      },
    );

    expect(result).toEqual(ZERO);
    expect(store.latestRuns(1)[0]?.outcome).toBe("failed");
  });

  // Not tested here: a body that finishes its run `ok` and then throws. The
  // wrapper cannot contain that - its catch is where such a throw lands, and
  // from there it is indistinguishable from a genuine failure, so it would
  // rewrite the committed run as failed. Containing it is the lane's job, by
  // wrapping the one statement that can throw after finishRun, its own log
  // call, in safeLog. Each lane verifies its own: "a throwing logger cannot
  // fail the lane" in test/kev.test.ts, test/issues.test.ts,
  // test/coverage.test.ts, test/update-prs.test.ts, test/update-status.test.ts,
  // test/review-requests.test.ts and test/workflow-runs.test.ts.
});

describe("the collect directory has exactly one begin call (#71)", () => {
  const COLLECT = join("src", "tricorder", "collect");
  const WRAPPER = "lifecycle.ts";

  it("no file but the wrapper calls beginRun", () => {
    // Structural, in the style of test/boundaries.test.ts, and against the
    // real directory rather than a list: the extraction is only worth
    // anything while it is the only way in. A ninth lane that opens its own
    // run also hand-rolls the try, the catch, the redaction and the zeroed
    // result, and nothing else in the build would notice - the lane would
    // pass its own tests either way, which is how eight copies accumulated.
    //
    // Matched on the call, not the word, so prose about beginRun stays legal.
    const offenders = readdirSync(COLLECT)
      .filter((f) => /\.tsx?$/.test(f) && f !== WRAPPER)
      .filter((f) =>
        readFileSync(join(COLLECT, f), "utf8").includes("beginRun("),
      );

    expect(offenders).toEqual([]);
  });

  it("and the wrapper does call it", () => {
    // Without this, deleting the call would satisfy the rule above.
    expect(readFileSync(join(COLLECT, WRAPPER), "utf8")).toContain(
      "store.beginRun(",
    );
  });
});
