/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFUSAL_WORDS } from "../src/core/merge.js";
import { DEFAULT_RANK_POLICY, epssRank } from "../src/core/rank.js";
import type { ReleaseEvidence } from "../src/core/release-worthy.js";
import { coverageSubject, releaseSubject } from "../src/core/subject.js";
import { DEFAULT_NOW_EPSS } from "../src/core/tier.js";
import {
  LANE as ALERTS_LANE,
  normalise,
  summariseRepo,
} from "../src/tricorder/collect/dependabot-alerts.js";
import { summarisePullRequests } from "../src/tricorder/collect/pull-requests.js";
import { normalise as normaliseSecret } from "../src/tricorder/collect/secret-scanning.js";
import { normalisePr } from "../src/tricorder/collect/update-prs.js";
import { LANE as ACTIONS_LANE } from "../src/tricorder/collect/workflow-runs.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { createApp } from "../src/tricorder/web/app.js";
import { loadAssets } from "../src/tricorder/web/assets.js";
import { mergeAction } from "../src/tricorder/web/merge-action.js";
import { ageOf, buildOverview } from "../src/tricorder/web/overview-view.js";
import { makeAlert, makeSecretScanningAlert, makeUpdatePr } from "./fakes.js";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const AT = "2026-08-17T11:55:00.000Z";
const REPO = { owner: "no42-org", name: "twiki" };
const WATCHED = [REPO];
const POLICY = { cadenceMs: 15 * 60_000 };
const DEPS = {
  policy: POLICY,
  kevPolicy: { cadenceMs: 24 * 60 * 60_000 },
  actionsPolicy: { cadenceMs: 60 * 60_000 },
  rankPolicy: DEFAULT_RANK_POLICY,
  hungAfterMs: 2 * 60 * 60_000,
  defaultBranchOf: () => "main",
  cutRank: epssRank(DEFAULT_NOW_EPSS, DEFAULT_RANK_POLICY.epssBands),
  reviewBudgetDays: 3,
};
/** Merging switched on, so a row's action speaks for the row alone. */
const MERGE = { mode: "enforce", configured: true } as const;

describe("ageOf", () => {
  const ago = (hours: number) =>
    new Date(NOW.getTime() - hours * 3_600_000).toISOString();

  it.each([
    [0.5, 0, 1, "under 1 hour"],
    [1, 1, 1, "1 hour"],
    [23, 23, 1, "23 hours"],
    [24, 24, 2, "1 day"],
    [3 * 24 + 23, 95, 2, "3 days"],
    [4 * 24, 96, 3, "4 days"],
    [7 * 24 + 23, 191, 3, "7 days"],
    [8 * 24, 192, 4, "8 days"],
    [30 * 24 + 23, 743, 4, "30 days"],
    [31 * 24, 744, 5, "31 days"],
  ])("%s hours old is step %s", (hours, ageHours, ageStep, ageWords) => {
    expect(ageOf(ago(hours), NOW)).toEqual({ ageHours, ageStep, ageWords });
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["not a date"],
    ["2026-08-18T00:00:00Z"],
  ])("reads %s as unknown, never as new", (openedAt) => {
    expect(ageOf(openedAt, NOW)).toEqual({
      ageHours: null,
      ageStep: 0,
      ageWords: "unknown",
    });
  });
});

describe("mergeAction", () => {
  const facts = {
    checks: "passed",
    isDraft: false,
    reviewDecision: "APPROVED",
  } as const;
  const open = { ...MERGE, watched: true, facts };
  const dim = (reason: string) => ({ enabled: false, reason });

  it.each([
    [
      "shadow mode, whatever else is wrong",
      {
        mode: "shadow",
        configured: false,
        watched: false,
        facts: { ...facts, checks: "failed" },
      },
      "Shadow mode",
    ],
    [
      "no merge route, ahead of the allowlist",
      { ...open, configured: false, watched: false },
      "Merging not configured",
    ],
    [
      "a repository outside the allowlist, ahead of the facts",
      { ...open, watched: false, facts: null },
      "Not in the allowlist",
    ],
    ["no facts", { ...open, facts: null }, "Checks not observed"],
    [
      "failed checks, ahead of a draft",
      { ...open, facts: { ...facts, checks: "failed", isDraft: true } },
      "CI failed",
    ],
    [
      "running checks, ahead of a draft",
      { ...open, facts: { ...facts, checks: "running", isDraft: true } },
      "CI running",
    ],
    [
      "no checks, ahead of a draft",
      { ...open, facts: { ...facts, checks: "none", isDraft: true } },
      "Checks not observed",
    ],
    [
      "a draft, ahead of a requested change",
      {
        ...open,
        facts: {
          ...facts,
          isDraft: true,
          reviewDecision: "CHANGES_REQUESTED",
        },
      },
      "Draft",
    ],
    [
      "a requested change, ahead of an unknown draft state",
      {
        ...open,
        facts: {
          ...facts,
          isDraft: null,
          reviewDecision: "CHANGES_REQUESTED",
        },
      },
      "Changes requested",
    ],
    [
      "a required review, ahead of an unknown draft state",
      {
        ...open,
        facts: { ...facts, isDraft: null, reviewDecision: "REVIEW_REQUIRED" },
      },
      "Review required",
    ],
    [
      "an unknown review decision",
      { ...open, facts: { ...facts, reviewDecision: "unknown" } },
      "Review state not observed",
    ],
    [
      "an unknown draft state",
      { ...open, facts: { ...facts, isDraft: null } },
      "Review state not observed",
    ],
  ] as const)("dims for %s", (_name, input, reason) => {
    expect(mergeAction(input)).toEqual(dim(reason));
  });

  it.each(["APPROVED", null] as const)(
    "enables a green pull request reviewed as %s",
    (reviewDecision) => {
      expect(
        mergeAction({ ...open, facts: { ...facts, reviewDecision } }),
      ).toEqual({ enabled: true });
    },
  );
});

describe("the overview", () => {
  let dir: string;
  let store: SqliteStore;

  const seed = (
    lane: string,
    observations: unknown[],
    outcome: "ok" | "failed" = "ok",
    at = AT,
    installation = "no42-org",
  ) => {
    const run = store.beginRun({
      lane,
      installation,
      scope: "full",
      startedAt: at,
    });
    store.recordObservations(run, at, observations as never[]);
    store.finishRun(run, outcome, at);
  };

  const seedAlerts = (alerts: ReturnType<typeof makeAlert>[]) =>
    seed(ALERTS_LANE, [...alerts.map(normalise), summariseRepo(REPO, alerts)]);

  const build = (watched = WATCHED) =>
    buildOverview(store, watched, NOW, DEPS, MERGE);

  const evidence = (over: Partial<ReleaseEvidence> = {}): ReleaseEvidence => ({
    tag: "v1.3.0",
    tagDate: "2026-08-12T12:00:00.000Z",
    commits: [
      { sha: "a", subject: "feat: one", url: "https://x.test/a" },
      { sha: "b", subject: "fix: two", url: "https://x.test/b" },
      { sha: "c", subject: "chore: three", url: "https://x.test/c" },
    ],
    truncated: false,
    fixedAlerts: [],
    ...over,
  });

  const seedRelease = (payload: ReleaseEvidence) =>
    seed("rest-release-readiness", [
      { subject: releaseSubject(REPO), payload },
    ]);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "overview-"));
    store = SqliteStore.openForWrite(join(dir, "o.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("security rows", () => {
    it("maps an alert into the whole row", () => {
      seedAlerts([
        makeAlert({
          number: 3,
          severity: "critical",
          packageName: "left-pad",
          cveId: "CVE-2026-0001",
          relationship: "direct",
          scope: "runtime",
          firstPatchedVersion: "2.4.1",
          createdAt: "2026-08-14T12:00:00.000Z",
        }),
      ]);

      expect(build().rows).toEqual([
        {
          key: "no42-org/twiki#3",
          group: "SECURITY",
          severity: "CRITICAL",
          severityRank: 4,
          state: "FIX AVAILABLE",
          repo: "no42-org/twiki",
          repoLabel: "twiki",
          repoUrl: "https://github.com/no42-org/twiki",
          id: "#3",
          url: "https://github.com/no42-org/twiki/security/dependabot/1",
          what: "left-pad (CVE-2026-0001). Direct runtime dependency. KEV status unknown. Fix in 2.4.1.",
          merge: null,
          ageHours: 72,
          ageStep: 2,
          ageWords: "3 days",
        },
      ]);
    });

    it.each([
      ["2.4.1", "FIX AVAILABLE"],
      [null, "NO FIX"],
    ])("reads a patched version of %s as %s", (firstPatchedVersion, state) => {
      seedAlerts([makeAlert({ firstPatchedVersion })]);
      expect(build().rows[0]?.state).toBe(state);
    });

    it("reads a row from before the field as OPEN, which claims neither", () => {
      const { firstPatchedVersion: _gone, ...old } = normalise(makeAlert())
        .payload as Record<string, unknown>;
      seed(ALERTS_LANE, [
        { subject: normalise(makeAlert()).subject, payload: old },
        summariseRepo(REPO, [makeAlert()]),
      ]);
      expect(build().rows[0]?.state).toBe("OPEN");
    });

    it("says UPDATE PR when an update PR names the alert's package, ahead of the fix", () => {
      seedAlerts([makeAlert({ packageName: "Left-Pad" })]);
      seed("graphql-update-prs", [
        normalisePr(
          makeUpdatePr({ title: "Bump left-pad from 1.0.0 to 1.1.0" }),
        ),
      ]);
      const row = build().rows.find((r) => r.group === "SECURITY");
      expect(row?.state).toBe("UPDATE PR");
    });

    it("words a dev dependency as not shipped code", () => {
      seedAlerts([makeAlert({ scope: "development", relationship: null })]);
      expect(build().rows[0]?.what).toContain("Dev dependency only.");
    });

    it("says ROTATE for a leaked secret, at critical, with its display name", () => {
      seed("rest-org-secret-scanning", [
        normaliseSecret(makeSecretScanningAlert({ number: 5 })),
      ]);
      const row = build().rows[0];
      expect(row).toMatchObject({
        group: "SECURITY",
        severity: "CRITICAL",
        state: "ROTATE",
        id: "#5",
      });
      expect(row?.what).toContain("exposed. Rotate the credential.");
    });

    it("lists nothing from a repository outside the allowlist", () => {
      seedAlerts([
        makeAlert({ repo: { owner: "no42-org", name: "delisted" } }),
      ]);
      expect(build().rows).toEqual([]);
    });

    it("drops alerts coverage says GitHub stopped reporting", () => {
      seedAlerts([makeAlert()]);
      seed("coverage", [
        {
          subject: coverageSubject(REPO),
          payload: {
            repo: "no42-org/twiki",
            state: "alerts_disabled",
            archived: false,
            codeScanning: { state: "covered", reason: null },
            secretScanning: { state: "covered", reason: null },
          },
        },
      ]);
      expect(
        buildOverview(
          store,
          WATCHED,
          NOW,
          {
            ...DEPS,
            coveragePolicy: { cadenceMs: 86_400_000 },
          },
          MERGE,
        ).rows,
      ).toEqual([]);
    });

    it("keeps the ranking chain's order", () => {
      seedAlerts([
        makeAlert({ number: 1, severity: "low", epssPercentage: 0.001 }),
        makeAlert({ number: 2, severity: "critical", epssPercentage: 0.9 }),
      ]);
      expect(build().rows.map((r) => r.id)).toEqual(["#2", "#1"]);
    });

    it("turns a javascript: URL into a plain ID, not a link", () => {
      seedAlerts([makeAlert({ htmlUrl: "javascript:alert(1)" })]);
      expect(build().rows[0]?.url).toBeNull();
    });
  });

  describe("pull request rows", () => {
    const pr = (over: Record<string, unknown> = {}) => ({
      subject: { type: "pull_request", key: `PR_${over.number ?? 7}` },
      payload: {
        repo: "no42-org/twiki",
        number: 7,
        title: "Fix the thing",
        author: "a-contributor",
        htmlUrl: "https://github.com/no42-org/twiki/pull/7",
        createdAt: "2026-08-17T00:00:00.000Z",
        headRef: "feature",
        ...over,
      },
    });
    const check = (
      conclusion: string | null,
      over: Record<string, unknown> = {},
    ) => ({
      subject: {
        type: "pull_request_workflow_run",
        key: `WFR_${over.runNumber ?? 3}`,
      },
      payload: {
        repo: "no42-org/twiki",
        workflowId: 1,
        workflowName: "CI",
        runNumber: 3,
        status: "completed",
        conclusion,
        headBranch: "feature",
        event: "pull_request",
        htmlUrl: "https://github.com/no42-org/twiki/actions/runs/3",
        createdAt: "2026-08-17T10:00:00.000Z",
        ...over,
      },
    });
    /** Nothing in the way but the checks. */
    const clear = { isDraft: false, reviewDecision: null };
    const seedReview = (number: number, repo = "no42-org/twiki") =>
      seed(
        "graphql-review-requests",
        [
          {
            subject: { type: "review_request", key: `RR_${number}` },
            payload: {
              repo,
              number,
              title: "Wire the thing",
              author: "a-contributor",
              htmlUrl: `https://github.com/${repo}/pull/${number}`,
              createdAt: "2026-08-15T12:00:00.000Z",
              requestedReviewers: ["indigo423"],
            },
          },
        ],
        "ok",
        AT,
        "reviews",
      );
    /** An update pull request on the `feature` ref, which GitHub could not update. */
    const seedStuckUpdate = () => {
      seed("graphql-update-prs", [
        normalisePr(makeUpdatePr({ number: 1, headRef: "feature" })),
      ]);
      seed("rest-dependabot-status", [
        {
          subject: {
            type: "dependabot_update_status",
            key: "no42-org/twiki#21",
          },
          payload: {
            repo: "no42-org/twiki",
            alertNumber: 21,
            update: { pullRequestNumber: 1, error: "update_not_possible" },
          },
        },
      ]);
    };

    it("lists a failing pull request as the whole row", () => {
      seed("graphql-pull-requests", [pr()]);
      seed("rest-actions-runs", [check("failure")]);

      expect(build().rows).toEqual([
        {
          key: "PR_7",
          group: "PULL REQUESTS",
          severity: null,
          severityRank: null,
          state: "FAILING",
          repo: "no42-org/twiki",
          repoLabel: "twiki",
          repoUrl: "https://github.com/no42-org/twiki",
          id: "#7",
          url: "https://github.com/no42-org/twiki/pull/7",
          what: "Fix the thing. Checks failing.",
          merge: { enabled: false, reason: "CI failed" },
          ageHours: 12,
          ageStep: 1,
          ageWords: "12 hours",
        },
      ]);
    });

    it("lists a green pull request nobody asked about as the whole READY row", () => {
      seed("graphql-pull-requests", [pr(clear)]);
      seed("rest-actions-runs", [check("success")]);

      expect(build().rows).toEqual([
        {
          key: "PR_7",
          group: "PULL REQUESTS",
          severity: null,
          severityRank: null,
          state: "READY",
          repo: "no42-org/twiki",
          repoLabel: "twiki",
          repoUrl: "https://github.com/no42-org/twiki",
          id: "#7",
          url: "https://github.com/no42-org/twiki/pull/7",
          what: "Fix the thing. Checks passed.",
          merge: { enabled: true },
          ageHours: 12,
          ageStep: 1,
          ageWords: "12 hours",
        },
      ]);
    });

    it("lists a green update pull request as the whole READY row", () => {
      seed("graphql-update-prs", [
        normalisePr(makeUpdatePr({ number: 1, headRef: "feature" })),
      ]);
      seed("rest-actions-runs", [check("success")]);

      expect(build().rows).toEqual([
        {
          key: "PR_1",
          group: "PULL REQUESTS",
          severity: null,
          severityRank: null,
          state: "READY",
          repo: "no42-org/twiki",
          repoLabel: "twiki",
          repoUrl: "https://github.com/no42-org/twiki",
          id: "#1",
          url: "https://github.com/no42-org/twiki/pull/1",
          what: "Update left-pad. Checks passed.",
          merge: { enabled: true },
          ageHours: 12,
          ageStep: 1,
          ageWords: "12 hours",
        },
      ]);
    });

    describe("the merge icon", () => {
      const page = async () => {
        const app = createApp({
          defaultBranchOf: () => "main",
          store,
          watched: WATCHED,
          policy: POLICY,
          mode: "enforce",
          requestMerge: async () => ({ outcome: "merged" }),
          now: () => NOW,
        });
        return (await app.request("/")).text();
      };
      it("embeds the refusal words for the client, unchanged", async () => {
        const attribute = (await page()).match(/data-refusals="([^"]*)"/)?.[1];
        expect(JSON.parse((attribute ?? "").replaceAll("&quot;", '"'))).toEqual(
          REFUSAL_WORDS,
        );
      });
    });

    it("keeps a green draft on a READY row, with its action dimmed", () => {
      seed("graphql-pull-requests", [pr({ ...clear, isDraft: true })]);
      seed("rest-actions-runs", [check("success")]);
      expect(build().rows.map((r) => [r.state, r.merge])).toEqual([
        ["READY", { enabled: false, reason: "Draft" }],
      ]);
    });

    it("lists a green pull request that wants your review as one enabled REVIEW row", () => {
      seed("graphql-pull-requests", [pr(clear)]);
      seed("rest-actions-runs", [check("success")]);
      seedReview(7, "No42-Org/twiki");
      expect(build().rows.map((r) => [r.state, r.id, r.merge])).toEqual([
        ["REVIEW", "#7", { enabled: true }],
      ]);
    });

    it("dims a review row with no pull request behind it", () => {
      seedReview(9);
      expect(build().rows.map((r) => [r.state, r.id, r.merge])).toEqual([
        ["REVIEW", "#9", { enabled: false, reason: "Checks not observed" }],
      ]);
    });

    it.each([
      ["running checks", [check(null, { status: "in_progress" })]],
      ["a cancelled run", [check("cancelled")]],
      ["no checks", []],
    ])("gives no READY row to a pull request with %s", (_name, runs) => {
      seed("graphql-pull-requests", [pr(clear)]);
      seed("rest-actions-runs", runs);
      expect(build().rows).toEqual([]);
    });

    it("dims a failing pull request that wants your review, on its one row", () => {
      seed("graphql-pull-requests", [pr(clear)]);
      seed("rest-actions-runs", [check("failure")]);
      seedReview(7);
      expect(build().rows.map((r) => [r.state, r.merge])).toEqual([
        ["FAILING", { enabled: false, reason: "CI failed" }],
      ]);
    });

    it("keeps a stuck update with passing checks FAILING and enabled, and says it is stuck", () => {
      seedStuckUpdate();
      seed("rest-actions-runs", [check("success")]);
      expect(build().rows.map((r) => [r.state, r.what, r.merge])).toEqual([
        [
          "FAILING",
          "Update left-pad is stuck: KEV status unknown, EPSS unknown, severity unknown, patch bump, GitHub could not prepare this update.",
          { enabled: true },
        ],
      ]);
    });

    it("dims a stuck update whose checks failed", () => {
      seedStuckUpdate();
      seed("rest-actions-runs", [check("failure")]);
      expect(build().rows.map((r) => [r.state, r.merge])).toEqual([
        ["FAILING", { enabled: false, reason: "CI failed" }],
      ]);
    });

    it("orders READY after FAILING and REVIEW, and counts all three", () => {
      seed("graphql-pull-requests", [
        pr({ ...clear, number: 1, headRef: "green" }),
        pr({ ...clear, number: 2, headRef: "asked" }),
        pr({ ...clear, number: 3, headRef: "red" }),
      ]);
      seed("rest-actions-runs", [
        check("success", { runNumber: 1, headBranch: "green" }),
        check("success", { runNumber: 2, headBranch: "asked" }),
        check("failure", { runNumber: 3, headBranch: "red" }),
      ]);
      seedReview(2);

      const { rows, boxes } = build();
      expect(rows.map((r) => [r.state, r.id])).toEqual([
        ["FAILING", "#3"],
        ["REVIEW", "#2"],
        ["READY", "#1"],
      ]);
      expect(boxes[1]).toMatchObject({
        count: 3,
        breakdown: "1 FAILING / 1 REVIEW / 1 READY",
      });
    });

    it.each([
      [{ mode: "shadow", configured: true }, "Shadow mode"],
      [{ mode: "enforce", configured: false }, "Merging not configured"],
    ] as const)("hands %j to every pull request row", (merge, reason) => {
      seed("graphql-pull-requests", [
        pr({ ...clear, number: 1, headRef: "green" }),
        pr({ ...clear, number: 2, headRef: "asked" }),
        pr({ ...clear, number: 3, headRef: "red" }),
      ]);
      seed("rest-actions-runs", [
        check("success", { runNumber: 1, headBranch: "green" }),
        check("success", { runNumber: 2, headBranch: "asked" }),
        check("failure", { runNumber: 3, headBranch: "red" }),
      ]);
      seedReview(2);

      const dim = { enabled: false, reason };
      expect(
        buildOverview(store, WATCHED, NOW, DEPS, merge).rows.map(
          (r) => r.merge,
        ),
      ).toEqual([dim, dim, dim]);
    });

    it("lists a failing pull request that wants your review once", () => {
      seed("graphql-pull-requests", [pr()]);
      seed("rest-actions-runs", [check("failure")]);
      seed(
        "graphql-review-requests",
        [
          {
            subject: { type: "review_request", key: "RR_7" },
            payload: {
              repo: "No42-Org/twiki",
              number: 7,
              title: "Fix the thing",
              author: "a-contributor",
              htmlUrl: "https://github.com/no42-org/twiki/pull/7",
              createdAt: "2026-08-15T12:00:00.000Z",
              requestedReviewers: ["indigo423"],
            },
          },
        ],
        "ok",
        AT,
        "reviews",
      );
      const pulls = build().rows;
      expect(pulls.map((r) => [r.state, r.what])).toEqual([
        ["FAILING", "Fix the thing. Checks failing. Your review requested."],
      ]);
    });

    it("lists a review request, naming the owner of an unwatched repository", () => {
      seed(
        "graphql-review-requests",
        [
          {
            subject: { type: "review_request", key: "RR_1" },
            payload: {
              repo: "someone/else",
              number: 9,
              title: "Wire the thing",
              author: "a-contributor",
              htmlUrl: "https://github.com/someone/else/pull/9",
              createdAt: "2026-08-15T12:00:00.000Z",
              requestedReviewers: ["indigo423"],
            },
          },
        ],
        "ok",
        AT,
        "reviews",
      );
      expect(build().rows).toEqual([
        {
          key: "review:RR_1",
          group: "PULL REQUESTS",
          severity: null,
          severityRank: null,
          state: "REVIEW",
          repo: "someone/else",
          repoLabel: "someone/else",
          repoUrl: "https://github.com/someone/else",
          id: "#9",
          url: "https://github.com/someone/else/pull/9",
          what: "Wire the thing. Your review requested.",
          merge: { enabled: false, reason: "Not in the allowlist" },
          ageHours: 48,
          ageStep: 2,
          ageWords: "2 days",
        },
      ]);
    });
  });

  describe("release rows", () => {
    it("lists plain changes as the whole row, with no severity", () => {
      seedRelease(evidence());

      expect(build().rows).toEqual([
        {
          key: "release:no42-org/twiki",
          group: "RELEASE WORTHY",
          severity: null,
          severityRank: null,
          state: "CHANGES",
          repo: "no42-org/twiki",
          repoLabel: "twiki",
          repoUrl: "https://github.com/no42-org/twiki",
          id: "v1.3.0",
          url: "https://github.com/no42-org/twiki/compare/v1.3.0...HEAD",
          what: "2 changes since v1.3.0: 1 feat, 1 fix.",
          merge: null,
          ageHours: 120,
          ageStep: 3,
          ageWords: "5 days",
        },
      ]);
    });

    it("leads with a security fix and carries its severity", () => {
      seedRelease(
        evidence({
          commits: [],
          fixedAlerts: [
            {
              number: 2,
              severity: "high",
              ghsaId: null,
              cveId: null,
              packageName: "left-pad",
              scope: "runtime",
              htmlUrl: null,
              fixedAt: "2026-08-14T00:00:00.000Z",
            },
          ],
        }),
      );
      expect(build().rows[0]).toMatchObject({
        severity: "HIGH",
        severityRank: 3,
        state: "SECURITY FIX",
        what: "1 security alert fixed since v1.3.0.",
      });
    });

    it("falls back to the commits with no tag, and an unknown age", () => {
      seedRelease(evidence({ tag: null, tagDate: null }));
      expect(build().rows[0]).toMatchObject({
        id: "no tag",
        url: "https://github.com/no42-org/twiki/commits",
        what: "2 changes with no tag yet: 1 feat, 1 fix.",
        ageHours: null,
        ageWords: "unknown",
      });
    });

    it("leaves out a repository with nothing to release", () => {
      seedRelease(evidence({ commits: [] }));
      expect(build().rows).toEqual([]);
    });
  });

  describe("boxes", () => {
    it("totals and breaks down each box", () => {
      seedAlerts([
        makeAlert({ number: 1, severity: "critical" }),
        makeAlert({ number: 2, severity: "critical" }),
        makeAlert({ number: 3, severity: "high" }),
      ]);
      seedRelease(evidence());

      const [security, , release] = build().boxes;
      expect(security).toMatchObject({
        count: 3,
        unconfirmed: null,
        breakdown: "2 CRITICAL / 1 HIGH",
      });
      expect(release).toMatchObject({ count: 1, breakdown: "1 CHANGES" });
    });

    it("never reads an unswept estate as zero", () => {
      const [security, pulls, release] = build().boxes;
      for (const box of [security, pulls, release]) {
        expect(box?.count).toBeNull();
        expect(box?.unconfirmed).not.toBeNull();
      }
    });

    it("withholds the release count when the lane failed", () => {
      seed("rest-release-readiness", [], "failed");
      expect(build().boxes[2]).toMatchObject({
        count: null,
        unconfirmed: "UNCONFIRMED",
      });
    });

    it("shows rows it has over a lane that is unconfirmed, and says so beside them", () => {
      seed(
        "graphql-review-requests",
        [
          {
            subject: { type: "review_request", key: "RR_1" },
            payload: {
              repo: "no42-org/twiki",
              number: 9,
              title: "Wire the thing",
              author: "a-contributor",
              htmlUrl: "https://github.com/no42-org/twiki/pull/9",
              createdAt: "2026-08-15T12:00:00.000Z",
              requestedReviewers: ["indigo423"],
            },
          },
        ],
        "ok",
        AT,
        "reviews",
      );
      const pulls = build().boxes[1];
      expect(pulls).toMatchObject({ count: 1, partial: true });
      expect(pulls?.notes.join()).toContain("not confirmed");
    });

    it("withholds a zero when only the review lane is missing", () => {
      seed("graphql-pull-requests", [summarisePullRequests(REPO, [])]);
      seed("graphql-update-prs", []);
      expect(build().boxes[1]).toMatchObject({
        count: null,
        breakdown: "review requests not confirmed by a completed sweep",
      });
    });

    it("states unreadable rows and takes back the all-clear", () => {
      seedAlerts([]);
      seed(ALERTS_LANE, [
        {
          subject: { type: "dependabot_alert", key: "no42-org/twiki#9" },
          payload: { number: 9, repo: "no42-org/twiki", severity: 7 },
        },
        summariseRepo(REPO, []),
      ]);
      const [security] = build().boxes;
      expect(security?.notes).toContain("1 row could not be read");
      expect(build().health.allCurrent).toBe(false);
    });

    it("says how many repositories nothing confirmed", () => {
      seedAlerts([]);
      const [security] = build([
        REPO,
        { owner: "no42-org", name: "other" },
      ]).boxes;
      expect(security?.notes).toContain("1 repository not confirmed");
    });

    it("reads a confirmed zero as a zero", () => {
      seedAlerts([]);
      expect(build().boxes[0]).toMatchObject({ count: 0, unconfirmed: null });
    });
  });

  describe("health", () => {
    it("says nothing was collected before the first sweep", () => {
      expect(build().health).toEqual({
        allCurrent: false,
        readout: "NOTHING COLLECTED YET",
        status: "NO DATA",
      });
    });

    /** Every lane a box stands on, confirmed and clean. */
    const seedAllClean = () => {
      seedAlerts([]);
      seed("graphql-pull-requests", [summarisePullRequests(REPO, [])]);
      seed("graphql-update-prs", []);
      seed("graphql-review-requests", [], "ok", AT, "reviews");
      seedRelease(evidence({ commits: [] }));
    };

    it("ignores a failed run for an owner nobody watches, and a failed hot run", () => {
      seedAllClean();
      seed("rest-org-dependabot", [], "failed", AT, "gone-org");
      const run = store.beginRun({
        lane: "rest-org-dependabot",
        installation: "no42-org",
        scope: "hot",
        startedAt: AT,
      });
      store.finishRun(run, "failed", AT);
      expect(build().health.allCurrent).toBe(true);
    });

    it("names a red default branch, ahead of everything, in place of an all-clear", () => {
      seedAllClean();
      seed(ACTIONS_LANE, [
        {
          subject: { type: "repository_actions", key: "no42-org/twiki" },
          payload: { repo: "no42-org/twiki", workflows: 1, failing: 1 },
        },
        {
          subject: { type: "workflow_run", key: "WFR_1" },
          payload: {
            repo: "no42-org/twiki",
            workflowId: 1,
            workflowName: "CI",
            runNumber: 3,
            status: "completed",
            conclusion: "failure",
            headBranch: "main",
            event: "push",
            htmlUrl: "https://github.com/no42-org/twiki/actions/runs/3",
            createdAt: "2026-08-17T11:00:00.000Z",
          },
        },
      ]);
      expect(build().health).toEqual({
        allCurrent: false,
        readout: "RED DEFAULT BRANCH: twiki",
        status: "RED MAIN",
      });
    });

    it("does not call a lane current that has never run", () => {
      seedAlerts([]);
      expect(build().health).toEqual({
        allCurrent: false,
        readout: "NOT CONFIRMED: PULL REQUESTS, RELEASE WORTHY",
        status: "CHECK LANES",
      });
    });

    it("reads all current only when every lane is", () => {
      seedAllClean();
      expect(build().health).toEqual({
        allCurrent: true,
        readout: "ALL LANES CURRENT // LAST SWEEP 5M AGO",
        status: "SYS OK",
      });
    });

    it("names a failed lane", () => {
      seedAlerts([]);
      seed("rest-release-readiness", [], "failed");
      expect(build().health).toEqual({
        allCurrent: false,
        readout:
          "LANES NOT CURRENT: rest-release-readiness // NOT CONFIRMED: PULL REQUESTS, RELEASE WORTHY",
        status: "CHECK LANES",
      });
    });

    it("judges a lane on its own cadence", () => {
      seedAllClean();
      seed("rest-org-coverage", [], "ok", "2026-08-17T06:00:00.000Z");
      const daily = buildOverview(
        store,
        WATCHED,
        NOW,
        {
          ...DEPS,
          lanePolicies: { "rest-org-coverage": { cadenceMs: 86_400_000 } },
        },
        MERGE,
      );
      expect(daily.health.allCurrent).toBe(true);
      expect(build().health.allCurrent).toBe(false);
    });
  });

  describe("the routes", () => {
    const app = () =>
      createApp({
        defaultBranchOf: () => "main",
        store,
        watched: WATCHED,
        policy: POLICY,
        now: () => NOW,
      });

    it("hands every row to the table, escaped", async () => {
      seedAlerts([makeAlert({ number: 1 }), makeAlert({ number: 2 })]);
      const res = await app().request("/");
      const html = await res.text();

      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(html.startsWith("<!DOCTYPE html>")).toBe(true);
      const rows = html.match(/data-rows="([^"]*)"/)?.[1] ?? "";
      expect(JSON.parse(rows.replaceAll("&quot;", '"'))).toHaveLength(2);
      expect(html).toContain("<title>2 security");
      expect(html).toContain('<lcars-frame theme="tng"');
      expect(html).toContain('data-lcars-theme="tng"');
    });

    it("leaves centering and the brand's color to the library", async () => {
      const html = await (await app().request("/")).text();
      expect(html).not.toContain("text-box");
      expect(html.match(/\.brand \{[^}]*\}/)?.[0]).not.toContain("color");
    });

    it("escapes what a repository's owners wrote", async () => {
      seedAlerts([makeAlert({ packageName: "<img src=x onerror=1>" })]);
      const html = await (await app().request("/")).text();
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;img src=x");
    });

    it("keeps every button a real, labelled control, and every sound off", async () => {
      seedAlerts([makeAlert({ number: 1 })]);
      const html = await (await app().request("/")).text();
      for (const [button] of html.matchAll(/<lcars-button[^>]*>/g)) {
        expect(button).toContain('sound="none"');
      }
    });

    it.each(["/queue", "/queue?topic=security", "/reviews"])(
      "answers 404 at %s",
      async (path) => {
        expect((await app().request(path)).status).toBe(404);
      },
    );

    it("links to neither removed page from any page", async () => {
      seedAlerts([makeAlert({ number: 1 })]);
      for (const path of ["/", "/repo/no42-org/twiki"]) {
        const html = await (await app().request(path)).text();
        expect(html).not.toContain('href="/queue');
        expect(html).not.toContain('href="/reviews');
      }
    });

    it("answers 200 when the branch resolver throws", async () => {
      seedAlerts([makeAlert({ number: 1 })]);
      const res = await createApp({
        defaultBranchOf: () => {
          throw new Error("no branch");
        },
        store,
        watched: WATCHED,
        policy: POLICY,
        now: () => NOW,
      }).request("/");
      expect(res.status).toBe(200);
    });

    it.each([
      ["lcars.css", "text/css"],
      ["lcars.iife.js", "text/javascript"],
      ["overview-client.js", "text/javascript"],
    ])("serves %s as %s", async (name, type) => {
      const res = await app().request(`/assets/${name}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(type);
      expect((await res.text()).length).toBeGreaterThan(100);
    });

    it("points the page at the hashed asset URLs it serves", async () => {
      const html = await (await app().request("/")).text();
      for (const asset of Object.values(loadAssets())) {
        expect(html).toContain(asset.href);
      }
    });

    it.each([
      "/assets/package.json",
      "/assets/constructor",
      "/assets/toString",
      "/assets/__proto__",
      "/assets/..%2F..%2Fpackage.json",
      "/assets/%2e%2e%2fapp.js",
    ])("refuses %s", async (path) => {
      expect((await app().request(path)).status).toBe(404);
    });

    it("loads nothing from another host", async () => {
      const html = await (await app().request("/")).text();
      const sources = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
        .map((m) => m[1] ?? "")
        .filter((url) => !url.startsWith("https://github.com/"));
      expect(sources.length).toBeGreaterThan(0);
      for (const url of sources) expect(url.startsWith("/")).toBe(true);
    });
  });

  it("names the package and why it is needed when an asset will not load", async () => {
    vi.resetModules();
    vi.doMock("node:fs", async (original) => ({
      ...(await original<typeof import("node:fs")>()),
      readFileSync: () => {
        throw new Error("ENOENT: no such file");
      },
    }));
    const { loadAssets: load } = await import("../src/tricorder/web/assets.js");
    expect(() => load()).toThrow(
      /cannot load @no42-org\/lcars-47\/css, which styles the overview: ENOENT/,
    );
    vi.doUnmock("node:fs");
    vi.resetModules();
  });
});
