/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TICK_MS,
  formatLine,
  isDue,
  type LaneSchedule,
  type LogFields,
  normaliseTickMs,
  runCycle,
} from "../src/tricorder/collect/scheduler.js";
import type { RunRecord } from "../src/tricorder/store/port.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import {
  DEFAULT_TICK_SECONDS,
  envFlag,
  MIN_TICK_SECONDS,
  parseTickSeconds,
} from "../src/tricorder.js";

const NOW = new Date("2026-08-17T12:00:00.000Z");

const record = (over: Partial<RunRecord> = {}): RunRecord => ({
  id: 1,
  lane: "l",
  installation: "no42-org",
  scope: "full",
  outcome: "ok",
  detail: null,
  startedAt: "2026-08-17T11:00:00.000Z",
  verifiedAt: "2026-08-17T11:00:00.000Z",
  ...over,
});

describe("deciding what is due", () => {
  it("runs a lane that has never run", () => {
    expect(isDue(undefined, 60_000, NOW)).toBe(true);
  });

  it("waits out the cadence", () => {
    const recent = record({ verifiedAt: "2026-08-17T11:59:00.000Z" });
    expect(isDue(recent, 15 * 60_000, NOW)).toBe(false);
  });

  it("runs once the cadence has passed", () => {
    const old = record({ verifiedAt: "2026-08-17T11:40:00.000Z" });
    expect(isDue(old, 15 * 60_000, NOW)).toBe(true);
  });

  it("runs exactly on the boundary rather than a tick late", () => {
    const edge = record({ verifiedAt: "2026-08-17T11:45:00.000Z" });
    expect(isDue(edge, 15 * 60_000, NOW)).toBe(true);
  });

  it("runs when the stored time is in the future", () => {
    // Clock skew ahead of now would otherwise park the lane until real time
    // caught up, which for a badly wrong clock means never collecting again.
    // One early cycle is cheap; stopping silently is the failure this build is
    // organised against.
    const future = record({ verifiedAt: "2027-01-01T00:00:00.000Z" });
    expect(isDue(future, 15 * 60_000, NOW)).toBe(true);
  });

  it("runs when the stored time cannot be read", () => {
    expect(isDue(record({ verifiedAt: "last tuesday" }), 60_000, NOW)).toBe(
      true,
    );
  });

  it("does not treat a failed run as a reason to hammer", () => {
    // A failed run still resets the cadence. Retrying instantly against an
    // installation that just refused us is how a collector burns a rate-limit
    // budget it will need when the problem clears.
    const failed = record({
      outcome: "failed",
      verifiedAt: "2026-08-17T11:59:00.000Z",
    });
    expect(isDue(failed, 15 * 60_000, NOW)).toBe(false);
  });
});

describe("the tick interval cannot become a hot loop", () => {
  it("falls back on values a timer would clamp to milliseconds", () => {
    // Number("") is 0 and Number("5m") is NaN. Either reaching the timer means
    // hammering GitHub continuously.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(normaliseTickMs(bad), String(bad)).toBe(DEFAULT_TICK_MS);
    }
  });

  it("keeps a usable interval", () => {
    expect(normaliseTickMs(5_000)).toBe(5_000);
  });
});

describe("log lines carry what AD-16 asks for", () => {
  it("names the lane, installation and scope", () => {
    const line = formatLine(
      { lane: "coverage", installation: "no42-org", scope: "full" },
      "ok",
    );
    expect(line).toContain("lane=coverage");
    expect(line).toContain("installation=no42-org");
    expect(line).toContain("scope=full");
  });

  it("carries verified_at when there is one", () => {
    const line = formatLine(
      {
        lane: "l",
        installation: "i",
        scope: "full",
        verifiedAt: "2026-08-17T12:00:00.000Z",
      },
      "ok",
    );
    expect(line).toContain("verified_at=2026-08-17T12:00:00.000Z");
  });
});

describe("the cycle", () => {
  let dir: string;
  let store: SqliteStore;
  let lines: { fields: LogFields; msg: string }[];

  const deps = () => ({
    store,
    now: () => NOW,
    log: (fields: LogFields, msg: string) => lines.push({ fields, msg }),
  });

  const lane = (
    name: string,
    onRun: (installation: string) => Promise<{ outcome: "ok" | "failed" }>,
  ): LaneSchedule => ({
    lane: name,
    scope: "full",
    cadenceMs: 15 * 60_000,
    run: onRun,
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sched-"));
    store = SqliteStore.openForWrite(join(dir, "s.db"));
    lines = [];
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs every installation for every due lane", async () => {
    const seen: string[] = [];
    const schedules = [
      lane("a", async (i) => {
        seen.push(`a:${i}`);
        return { outcome: "ok" as const };
      }),
      lane("b", async (i) => {
        seen.push(`b:${i}`);
        return { outcome: "ok" as const };
      }),
    ];

    const report = await runCycle(deps(), schedules, ["org-1", "org-2"]);

    expect(report).toEqual({ ran: 4, skipped: 0, failed: 0 });
    // Serial, and grouped per installation (AD-24).
    expect(seen).toEqual(["a:org-1", "b:org-1", "a:org-2", "b:org-2"]);
  });

  it("skips a lane whose cadence has not elapsed", async () => {
    const r = store.beginRun({
      lane: "a",
      installation: "org-1",
      scope: "full",
      startedAt: "2026-08-17T11:59:00.000Z",
    });
    store.finishRun(r, "ok", "2026-08-17T11:59:00.000Z");

    let ran = 0;
    const report = await runCycle(
      deps(),
      [
        lane("a", async () => {
          ran++;
          return { outcome: "ok" as const };
        }),
      ],
      ["org-1"],
    );

    expect(ran).toBe(0);
    expect(report.skipped).toBe(1);
  });

  it("leaves the other installations collecting when one lane throws", async () => {
    // The property AD-16 exists for. Revoking one installation's access must
    // not take the other twelve down with it.
    const reached: string[] = [];
    const schedules = [
      lane("a", async (i) => {
        if (i === "broken") throw new Error("access revoked");
        reached.push(i);
        return { outcome: "ok" as const };
      }),
    ];

    const report = await runCycle(deps(), schedules, [
      "org-1",
      "broken",
      "org-2",
    ]);

    expect(reached).toEqual(["org-1", "org-2"]);
    expect(report.failed).toBe(1);
    expect(report.ran).toBe(3);
  });

  it("says which installation escaped its lane, not just that one did", async () => {
    await runCycle(
      deps(),
      [
        lane("a", async () => {
          throw new Error("access revoked");
        }),
      ],
      ["broken"],
    );

    const line = lines.find((l) => l.msg.includes("escaped"));
    expect(line?.fields.installation).toBe("broken");
    expect(line?.fields.lane).toBe("a");
    expect(line?.msg).toContain("access revoked");
  });

  it("counts a contained failure without treating it as an escape", async () => {
    const report = await runCycle(
      deps(),
      [lane("a", async () => ({ outcome: "failed" as const }))],
      ["org-1"],
    );
    expect(report.failed).toBe(1);
    expect(lines.some((l) => l.msg.includes("escaped"))).toBe(false);
  });

  it("does not leak a token or a secret into a log line", async () => {
    // AD-16: no token or secret-scanning finding content appears in any line.
    await runCycle(
      deps(),
      [
        lane("a", async () => {
          throw new Error("Bad credentials: ghs_SUPERSECRETTOKENVALUE");
        }),
      ],
      ["org-1"],
    );
    const all = lines.map((l) => formatLine(l.fields, l.msg)).join("\n");
    // The message is passed through verbatim, so this is a live hazard rather
    // than a theoretical one: an auth failure from GitHub can carry the
    // credential in its text. Redacting at the formatter covers every line,
    // including lines a future lane adds without thinking about it.
    expect(all).not.toMatch(/ghs_[A-Za-z0-9]{8,}/);
    expect(all).toContain("Bad credentials");
  });

  it("redacts every credential shape, not just the one that prompted this", () => {
    const shapes = [
      "ghp_AAAAAAAAAAAAAAAAAAAA",
      "ghs_BBBBBBBBBBBBBBBBBBBB",
      "gho_CCCCCCCCCCCCCCCCCCCC",
      "github_pat_11ABCDEFG_aaaaaaaaaaaaaaaaaaaa",
      "eyJhbGciOiJSUzI1NiJ9.eyJpYXQiOjE2MDAwMDAwMDB9",
    ];
    for (const secret of shapes) {
      const line = formatLine(
        { lane: "a", installation: "i", scope: "full" },
        `failed with ${secret}`,
      );
      expect(line, secret).not.toContain(secret);
      expect(line).toContain("failed with");
    }
  });
});

describe("the CLI still offers what it advertises", () => {
  // A whole role was once deleted by a refactor while `usage` kept listing it,
  // the README kept documenting it, and an adapter error kept telling operators
  // to run it. Biome flagged the orphaned imports, but only as a warning, and
  // `biome check` exits 0 on warnings.
  const roles = ["collect", "web", "doctor"];

  /**
   * Run the real entrypoint from source.
   *
   * Through tsx rather than dist/, because `make verify` does not build: a
   * version of this test that needed a build passed locally and failed in CI,
   * and a test whose whole job is noticing a deleted role must not itself be
   * the fragile one.
   */
  const runRole = (role: string, env: NodeJS.ProcessEnv = {}): string => {
    try {
      return execFileSync("npx", ["tsx", "src/tricorder.ts", role], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        env: { ...process.env, ...env },
      });
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string };
      return `${e.stdout ?? ""}${e.stderr ?? ""}`;
    }
  };

  it("lists exactly the roles it implements", () => {
    const text = runRole("definitely-not-a-role");
    for (const role of roles) {
      expect(text, `usage should mention ${role}`).toContain(role);
    }
  });

  it("implements every role it lists", () => {
    for (const role of roles) {
      // Each role gets a deliberately unusable environment, so it fails INSIDE
      // its own branch. What matters is that it reaches that branch at all.
      const out = runRole(role, {
        TRICORDER_DB: "/nonexistent/dir/x.db",
        TRICORDER_GITHUB_APP_ID: "",
        TRICORDER_GITHUB_APP_PRIVATE_KEY: "",
        TRICORDER_GITHUB_APP_PRIVATE_KEY_PATH: "",
        TRICORDER_ONCE: "1",
      });
      // Guard against the vacuous pass: if the entrypoint could not be loaded
      // at all, this test proves nothing, and an earlier version of it was
      // green for exactly that reason.
      expect(out, `${role} did not run at all`).not.toContain(
        "MODULE_NOT_FOUND",
      );
      expect(out, `${role} fell through to usage`).not.toContain(
        "usage: tricorder",
      );
    }
  });
});

describe("environment flags read the way an operator expects", () => {
  it("does not treat the word false as true", () => {
    // A compose file written to turn the feature OFF would otherwise turn it
    // on, and the container would run one cycle and exit.
    for (const off of ["false", "0", "no", "off", "", "  ", "FALSE"]) {
      expect(envFlag(off), JSON.stringify(off)).toBe(false);
    }
  });

  it("accepts the usual ways of saying yes", () => {
    for (const on of ["1", "true", "yes", "on"]) {
      expect(envFlag(on), on).toBe(true);
    }
  });
});

describe("the tick floor", () => {
  it("refuses a fractional interval that would hammer GitHub", () => {
    // 0.001 is finite and above zero, so a "> 0" check passes it through as one
    // millisecond: a cycle against GitHub every millisecond.
    const warnings: string[] = [];
    expect(parseTickSeconds("0.001", (m) => warnings.push(m))).toBe(
      DEFAULT_TICK_SECONDS,
    );
    expect(warnings).toHaveLength(1);
  });

  it("warns rather than silently substituting", () => {
    // The previous guard normalised before the warning could compare, so an
    // operator typing 5m got 60s with no message at all.
    const warnings: string[] = [];
    parseTickSeconds("5m", (m) => warnings.push(m));
    expect(warnings[0]).toContain("5m");
    expect(warnings[0]).toContain("not usable");
  });

  it("keeps a sane interval and defaults an unset one", () => {
    expect(parseTickSeconds(String(MIN_TICK_SECONDS))).toBe(MIN_TICK_SECONDS);
    expect(parseTickSeconds("300")).toBe(300);
    expect(parseTickSeconds(undefined)).toBe(DEFAULT_TICK_SECONDS);
  });
});
