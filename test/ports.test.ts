/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import type { GitHubReadPort } from "../src/github/port.js";
import { FakeGitHub, FakeGitHubReadPort } from "./fakes.js";

// The read/write split is a compile-time boundary: a consumer holding only
// GitHubReadPort has no write method to call, whatever its credential happens
// to allow. The @ts-expect-error assertions below fail typecheck if a write
// method ever leaks onto the read port, which is the point of having them.

describe("GitHubReadPort", () => {
  it("exposes no write methods", () => {
    const readOnly: GitHubReadPort = new FakeGitHubReadPort(new Map());

    // @ts-expect-error GitHubReadPort must not expose mergePR
    void readOnly.mergePR;
    // @ts-expect-error GitHubReadPort must not expose pushTag
    void readOnly.pushTag;
    // @ts-expect-error GitHubReadPort must not expose rerunFailedJobs
    void readOnly.rerunFailedJobs;
    // @ts-expect-error GitHubReadPort must not expose requestDependabotRebase
    void readOnly.requestDependabotRebase;

    expect(typeof readOnly.listOpenDependabotPRs).toBe("function");
  });

  it("is usable on its own, without the write half", () => {
    const readOnly = new FakeGitHubReadPort(new Map());

    expect(readOnly).toBeInstanceOf(FakeGitHubReadPort);
    expect(readOnly).not.toBeInstanceOf(FakeGitHub);
    expect(typeof readOnly.behindBy).toBe("function");
  });

  it("the full port still satisfies the read port", () => {
    const full: GitHubReadPort = new FakeGitHub(new Map());

    expect(typeof full.behindBy).toBe("function");
  });
});
