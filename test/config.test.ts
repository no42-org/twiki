/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETENTION,
  retentionCutoff,
  retentionFromEnv,
} from "../src/core/config.js";

describe("retention configuration", () => {
  it("keeps everything when unset, which is the default", () => {
    expect(retentionFromEnv({})).toEqual(DEFAULT_RETENTION);
    expect(DEFAULT_RETENTION).toEqual({
      observationDays: null,
      runDays: null,
    });
  });

  it("treats an empty or whitespace value as unset", () => {
    expect(
      retentionFromEnv({ TRICORDER_RETENTION_DAYS: "  " }).observationDays,
    ).toBeNull();
  });

  it("reads each window independently", () => {
    expect(
      retentionFromEnv({
        TRICORDER_RETENTION_DAYS: "90",
        TRICORDER_RUN_RETENTION_DAYS: "30",
      }),
    ).toEqual({ observationDays: 90, runDays: 30 });
  });

  it("throws on a malformed window rather than quietly keeping everything", () => {
    // The failure mode this prevents: a typo in the one setting that deletes
    // data irreversibly, silently ignored, so the operator believes retention
    // is on for months while nothing is trimmed.
    for (const bad of ["0", "-1", "seven", "1e3", "0x1f", "7.5"]) {
      expect(
        () => retentionFromEnv({ TRICORDER_RETENTION_DAYS: bad }),
        bad,
      ).toThrow(/whole number of days/);
    }
  });

  it("names the variable it rejected", () => {
    expect(() =>
      retentionFromEnv({ TRICORDER_RUN_RETENTION_DAYS: "nope" }),
    ).toThrow(/TRICORDER_RUN_RETENTION_DAYS/);
  });

  it("computes an exclusive cutoff from whole days", () => {
    const now = new Date("2026-08-17T12:00:00.000Z");
    expect(retentionCutoff(now, 1)).toBe("2026-08-16T12:00:00.000Z");
    expect(retentionCutoff(now, 90)).toBe("2026-05-19T12:00:00.000Z");
  });
});
