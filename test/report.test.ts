/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { buildDigest } from "../src/twiki/report.js";

describe("digest for a red main", () => {
  it("says main is red without promising anything about releases", () => {
    const digest = buildDigest({
      mode: "enforce",
      repos: [{ repo: "no42-org/demo", mainRed: true, prs: [] }],
    });

    expect(digest).toContain("🔴 *main is RED*");
    expect(digest).not.toMatch(/releas/i);
  });
});
