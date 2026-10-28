/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import {
  assessRelease,
  type CommitRef,
  type FixedAlertRef,
  improvementKind,
  type ReleaseVerdict,
  releaseSummary,
} from "../src/core/release-worthy.js";

const commit = (subject: string, sha = "abc"): CommitRef => ({
  sha,
  subject,
  url: `https://example.test/c/${sha}`,
});

const alert = (over: Partial<FixedAlertRef> = {}): FixedAlertRef => ({
  number: 1,
  severity: "high",
  ghsaId: null,
  cveId: null,
  packageName: "lodash",
  scope: "runtime",
  htmlUrl: null,
  fixedAt: "2026-10-02T00:00:00Z",
  ...over,
});

describe("improvementKind", () => {
  it.each([
    ["feat: x", "feat"],
    ["fix(ui): x", "fix"],
    ["perf: x", "perf"],
    ["refactor!: x", "breaking"],
    ["feat(api)!: x", "breaking"],
    ["fix(deps): bump a", null],
    ["feat(deps)!: x", null],
    ["fix(DEPS): x", null],
    ["chore: x", null],
    ["docs: x", null],
    ["ci: x", null],
    ["Merge pull request #4", null],
    ["fixed the thing", null],
  ])("%s -> %s", (subject, kind) => {
    expect(improvementKind(subject)).toBe(kind);
  });
});

describe("assessRelease", () => {
  const base = {
    tag: "v1.0.0",
    tagDate: "2026-10-01T00:00:00Z",
    commits: [],
    truncated: false,
  };

  it("counts runtime and unknown-scope alerts fixed after the tag only", () => {
    const counted = [
      alert({ number: 1, scope: "runtime" }),
      alert({ number: 2, scope: null }),
    ];
    const verdict = assessRelease({
      ...base,
      fixedAlerts: [
        ...counted,
        alert({ number: 3, scope: "development" }),
        alert({ number: 4, fixedAt: "2026-09-30T00:00:00Z" }),
      ],
    });
    expect(verdict).toEqual({
      ready: true,
      tag: "v1.0.0",
      securityFixes: counted,
      improvements: [],
      truncated: false,
    });
  });

  it("compares dates as instants, not strings", () => {
    const verdict = assessRelease({
      ...base,
      fixedAlerts: [alert({ fixedAt: "2026-10-01T01:00:00+02:00" })],
    });
    expect(verdict.securityFixes).toEqual([]);
  });

  it("is ready on improvements alone, and drops non-improvements", () => {
    const feat = commit("feat: a", "1");
    const verdict = assessRelease({
      ...base,
      commits: [feat, commit("chore: b", "2"), commit("fix(deps): c", "3")],
      fixedAlerts: [],
    });
    expect(verdict).toEqual({
      ready: true,
      tag: "v1.0.0",
      securityFixes: [],
      improvements: [{ ...feat, kind: "feat" }],
      truncated: false,
    });
  });

  it("is not ready when both lists are empty", () => {
    const verdict = assessRelease({
      ...base,
      commits: [commit("chore: b")],
      fixedAlerts: [alert({ scope: "development" })],
      truncated: true,
    });
    expect(verdict).toEqual({
      ready: false,
      tag: "v1.0.0",
      securityFixes: [],
      improvements: [],
      truncated: true,
    });
  });

  it("with no tag every runtime or unknown fixed alert counts", () => {
    const old = alert({ number: 1, fixedAt: "2001-01-01T00:00:00Z" });
    const verdict = assessRelease({
      tag: null,
      tagDate: null,
      commits: [],
      truncated: false,
      fixedAlerts: [old, alert({ number: 2, scope: "development" })],
    });
    expect(verdict).toEqual({
      ready: true,
      tag: null,
      securityFixes: [old],
      improvements: [],
      truncated: false,
    });
  });
});

describe("releaseSummary", () => {
  const verdict = (over: Partial<ReleaseVerdict>): ReleaseVerdict => ({
    ready: true,
    tag: "v1.0.0",
    securityFixes: [],
    improvements: [],
    truncated: false,
    ...over,
  });
  const imp = (kind: "breaking" | "feat" | "fix" | "perf") => ({
    ...commit(`${kind}: x`),
    kind,
  });

  it("joins security and fixes", () => {
    expect(
      releaseSummary(
        verdict({
          tag: "v0.4.1",
          securityFixes: [alert()],
          improvements: [imp("fix"), imp("fix")],
        }),
      ),
    ).toBe("1 security fix (high, lodash) · 2 fixes since v0.4.1");
  });

  it("orders and pluralises kinds", () => {
    expect(
      releaseSummary(
        verdict({ tag: "v1.2.0", improvements: [imp("perf"), imp("feat")] }),
      ),
    ).toBe("1 feature, 1 perf since v1.2.0");
  });

  it("names the worst alert", () => {
    expect(
      releaseSummary(
        verdict({
          tag: "v3.0.0",
          securityFixes: [
            alert({ severity: "low", packageName: "a" }),
            alert({ severity: "critical", packageName: "openssl" }),
          ],
        }),
      ),
    ).toBe("2 security fixes (critical, openssl) since v3.0.0");
  });

  it("says since the first commit without a tag", () => {
    expect(
      releaseSummary(verdict({ tag: null, improvements: [imp("breaking")] })),
    ).toBe("1 breaking change since the first commit");
  });

  it("marks truncated counts", () => {
    expect(
      releaseSummary(
        verdict({
          truncated: true,
          improvements: [imp("fix"), imp("fix"), imp("fix")],
        }),
      ),
    ).toBe("3+ fixes since v1.0.0");
  });

  it("is empty when not ready", () => {
    expect(releaseSummary(verdict({ ready: false }))).toBe("");
  });
});
