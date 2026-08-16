/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import {
  DEFAULT_POLL_MINUTES,
  normalisePollMinutes,
} from "../src/twiki/scheduler.js";

// A poll interval of 0 or NaN reaches setTimeout and is clamped to a few
// milliseconds, re-running the tick continuously. In enforce mode that is
// merge and tag attempts in a tight loop, so these cases matter more than
// their size suggests.

describe("normalisePollMinutes", () => {
  it("keeps a positive finite interval", () => {
    expect(normalisePollMinutes(60)).toBe(60);
    expect(normalisePollMinutes(5)).toBe(5);
    expect(normalisePollMinutes(0.5)).toBe(0.5);
  });

  it("rejects zero, which Number('') produces from a set-but-empty env var", () => {
    expect(normalisePollMinutes(Number(""))).toBe(DEFAULT_POLL_MINUTES);
    expect(normalisePollMinutes(0)).toBe(DEFAULT_POLL_MINUTES);
  });

  it("rejects NaN, which Number('60m') produces from a typo", () => {
    expect(normalisePollMinutes(Number("60m"))).toBe(DEFAULT_POLL_MINUTES);
    expect(normalisePollMinutes(Number.NaN)).toBe(DEFAULT_POLL_MINUTES);
  });

  it("rejects negative and infinite intervals", () => {
    expect(normalisePollMinutes(-1)).toBe(DEFAULT_POLL_MINUTES);
    expect(normalisePollMinutes(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_POLL_MINUTES,
    );
  });
});
