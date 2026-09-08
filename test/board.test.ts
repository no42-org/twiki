/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RANK_POLICY, epssRank } from "../src/core/rank.js";
import { alertSubject, coverageSubject } from "../src/core/subject.js";
import { DEFAULT_NOW_EPSS } from "../src/core/tier.js";
import type { Topic } from "../src/core/topics.js";
import type { RepoRef } from "../src/core/types.js";
import {
  type Board,
  type BoardRow,
  buildBoard,
  type Chip,
  type Tile,
} from "../src/tricorder/attention/board.js";
import type {
  CollectionHealth,
  HealthOutcome,
} from "../src/tricorder/attention/health.js";
import {
  normalise,
  summariseRepo,
} from "../src/tricorder/collect/dependabot-alerts.js";
import { normaliseIssue } from "../src/tricorder/collect/issues.js";
import { normaliseReviewRequest } from "../src/tricorder/collect/review-requests.js";
import { normalisePr } from "../src/tricorder/collect/update-prs.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import {
  makeAlert,
  makeRawIssue,
  makeReviewRequest,
  makeUpdatePr,
} from "./fakes.js";

// AD-32, AD-35: one board from one queue. Every matrix row of Story 1.4,
// asserted on the whole Board or the whole row, never on one chip of it.

const NOW = new Date("2026-08-16T12:00:00.000Z");
const AT = "2026-08-16T11:55:00.000Z";
const POLICY = { cadenceMs: 15 * 60_000 };
const HOURLY = { cadenceMs: 60 * 60_000 };
const DEPS = {
  policy: POLICY,
  kevPolicy: { cadenceMs: 24 * 60 * 60_000 },
  actionsPolicy: HOURLY,
  rankPolicy: DEFAULT_RANK_POLICY,
  cutRank: epssRank(DEFAULT_NOW_EPSS, DEFAULT_RANK_POLICY.epssBands),
  reviewBudgetDays: 3,
  hungAfterMs: 2 * 60 * 60_000,
  defaultBranchOf: () => "main",
};
const REPO = { owner: "no42-org", name: "twiki" };
const OTHER = { owner: "no42-org", name: "quiet" };
const NEVER = { owner: "no42-org", name: "unseen" };

const daysAgo = (days: number): string =>
  new Date(NOW.getTime() - days * 24 * 60 * 60_000).toISOString();
const hoursAgo = (hours: number): string =>
  new Date(NOW.getTime() - hours * 60 * 60_000).toISOString();

// The two absences, spelled here rather than imported: a constant asserted
// against itself cannot fail.
const NO_COLLECTOR = "no collector for this topic yet";
const NO_SWEEP = "not confirmed by any completed sweep";

const absent = (reason: string): Chip => ({
  state: "unconfirmed",
  count: 0,
  severity: null,
  href: null,
  reason,
});
/** A topic that has no collector yet: Pull requests. */
const NO_LANE = absent(NO_COLLECTOR);
/** A topic whose lane has not completed a current sweep here. */
const UNSWEPT = absent(NO_SWEEP);
const ZERO: Chip = {
  state: "zero",
  count: 0,
  severity: null,
  href: null,
  reason: null,
};
const linked = (
  count: number,
  href: string,
  severity: Chip["severity"] = null,
): Chip => ({ state: "count", count, severity, href, reason: null });
const SECURITY = "/queue?repo=no42-org%2Ftwiki&topic=security";

/** The five topics beyond Security, in order, as `signalsRest` lists them. */
const REST_TOPICS: Topic[] = [
  "ci",
  "dependencies",
  "pulls",
  "issues",
  "reviews",
];

/** The six chips of a row that only the alert lane has confirmed. */
const alertsOnly = (security: Chip): BoardRow["chips"] => ({
  security,
  // CI has a lane now, so its absence is the same absence Dependencies has:
  // no sweep confirmed this repository, not "nobody collects this".
  ci: UNSWEPT,
  dependencies: UNSWEPT,
  pulls: NO_LANE,
  issues: UNSWEPT,
  reviews: UNSWEPT,
});

const TILE_FACTS: Record<Topic, [label: string, href: string, absent: string]> =
  {
    security: ["Security", "/queue?topic=security", NO_SWEEP],
    ci: ["CI", "/queue?topic=ci", NO_SWEEP],
    dependencies: ["Dependencies", "/queue?topic=dependencies", NO_SWEEP],
    pulls: ["Pull requests", "/queue?topic=pulls", NO_COLLECTOR],
    issues: ["Issues", "/queue?topic=issues", NO_SWEEP],
    reviews: ["Reviews", "/reviews", NO_SWEEP],
  };
const tile = (
  topic: Topic,
  count: Tile["count"],
  nowCount = 0,
  warnings: string[] = [],
): Tile => {
  const [label, href, reason] = TILE_FACTS[topic];
  return {
    topic,
    label,
    href,
    count,
    nowCount,
    reason: count === "unconfirmed" ? reason : null,
    warnings,
  };
};
const TOPICS_ORDER: Topic[] = [
  "security",
  "ci",
  "dependencies",
  "pulls",
  "issues",
  "reviews",
];
/** A tile before the first completed sweep. */
const never = (topic: Topic, warnings: string[] = []): Tile =>
  tile(topic, "never collected", 0, warnings);

/** One health-table row: a full-scope run five minutes ago, ok unless said. */
const ran = (
  lane: string,
  installation: string,
  outcome: HealthOutcome = "ok",
  over: Partial<CollectionHealth> = {},
): CollectionHealth => ({
  lane,
  installation,
  scope: "full",
  outcome,
  detail: null,
  age: "5m ago",
  freshness: "fresh",
  ...over,
});

describe("buildBoard (AD-32, AD-35)", () => {
  let dir: string;
  let store: SqliteStore;

  const seed = (
    lane: string,
    installation: string,
    observations: { subject: unknown; payload: unknown }[],
    at = AT,
    outcome: "ok" | "partial" | "failed" = "ok",
    detail?: string,
  ) => {
    const r = store.beginRun({
      lane,
      installation,
      scope: "full",
      startedAt: at,
    });
    store.recordObservations(r, at, observations as never[]);
    store.finishRun(r, outcome, at, detail);
    return r;
  };

  /** One repository confirmed by the alert lane, with these alerts. */
  const sweep = (
    repos: { repo: RepoRef; alerts: ReturnType<typeof makeAlert>[] }[],
    at = AT,
  ) =>
    seed(
      "rest-org-dependabot",
      "no42-org",
      repos.flatMap(({ repo, alerts }) => [
        ...alerts.map(normalise),
        summariseRepo(repo, alerts),
      ]),
      at,
    );

  /** A review request old enough to lift its repository to soon. */
  const overdue = (repo: RepoRef, number: number, days = 9) =>
    normaliseReviewRequest(
      makeReviewRequest({ repo, number, createdAt: daysAgo(days) }),
    );

  /** A soon alert: below the cut, high severity. */
  const soonAlert = (repo: RepoRef, number: number) =>
    makeAlert({ number, repo, epssPercentage: 0.02, severity: "high" });

  const cov = (repo: RepoRef, state: string) => ({
    subject: coverageSubject(repo),
    payload: {
      repo: `${repo.owner}/${repo.name}`.toLowerCase(),
      state,
      archived: false,
    },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "board-"));
    store = SqliteStore.openForWrite(join(dir, "b.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("ranks a mixed estate into now, soon and quiet, in chain order", () => {
    const named = (prefix: string, n: number): RepoRef[] =>
      Array.from({ length: n }, (_, i) => ({
        owner: "no42-org",
        name: `${prefix}-${String.fromCharCode(97 + i)}`,
      }));
    const nowRepos = named("now", 2);
    const soonByAlert = named("soon", 3);
    const soonByReview = named("review", 3);
    const quiet = named("calm", 12);
    // repos.yaml order is deliberately not tier order.
    const watched = [...quiet, ...soonByReview, ...nowRepos, ...soonByAlert];

    sweep([
      ...nowRepos.map((repo, i) => ({
        repo,
        alerts: [makeAlert({ number: i + 1, repo, epssPercentage: 0.5 })],
      })),
      ...soonByAlert.map((repo, i) => ({
        repo,
        alerts: [soonAlert(repo, 10 + i)],
      })),
      ...[...soonByReview, ...quiet].map((repo) => ({ repo, alerts: [] })),
    ]);
    seed(
      "graphql-review-requests",
      "reviews",
      soonByReview.map((repo, i) => overdue(repo, 20 + i, 5 + i)),
    );

    const board = buildBoard(store, watched, NOW, DEPS);

    expect(board.summary).toEqual({
      watched: 20,
      now: 2,
      soon: 6,
      quiet: 12,
      unconfirmed: 0,
    });
    expect(board.rows.map((r) => [r.slug, r.tier])).toEqual([
      ["no42-org/now-a", "now"],
      ["no42-org/now-b", "now"],
      ["no42-org/soon-a", "soon"],
      ["no42-org/soon-b", "soon"],
      ["no42-org/soon-c", "soon"],
      // Lifted by a review alone: after every item-bearing row, by slug.
      ["no42-org/review-a", "soon"],
      ["no42-org/review-b", "soon"],
      ["no42-org/review-c", "soon"],
    ]);
    expect(board.quiet).toEqual(quiet.map((r) => `no42-org/${r.name}`));
    expect(board.unconfirmed).toEqual([]);
    expect(board.tiles).toEqual([
      tile("security", 5, 2),
      tile("ci", "unconfirmed"),
      tile("dependencies", "unconfirmed"),
      tile("pulls", "unconfirmed"),
      tile("issues", "unconfirmed"),
      tile("reviews", 3),
    ]);
  });

  it("orders a tier by the chain, not by slug", () => {
    // Same EPSS band; the severity term decides, and the slugs sort the
    // other way round so an alphabetical order cannot pass by accident.
    const low = { owner: "no42-org", name: "a-low" };
    const high = { owner: "no42-org", name: "z-high" };
    sweep([
      {
        repo: low,
        alerts: [
          makeAlert({
            number: 1,
            repo: low,
            epssPercentage: 0.02,
            severity: "low",
          }),
        ],
      },
      { repo: high, alerts: [soonAlert(high, 2)] },
    ]);

    const board = buildBoard(store, [low, high], NOW, DEPS);

    expect(board.rows.map((r) => [r.slug, r.tier])).toEqual([
      ["no42-org/z-high", "soon"],
      ["no42-org/a-low", "soon"],
    ]);
  });

  it("is all quiet with no rows, every slug in the quiet block and honest tiles", () => {
    // Every lane that exists confirmed nothing open, so its tile is a real
    // 0; the two topics with no lane read unconfirmed, never 0 (AD-28).
    sweep([
      { repo: REPO, alerts: [] },
      { repo: OTHER, alerts: [] },
    ]);
    seed("graphql-issues", "no42-org", []);
    seed("graphql-update-prs", "no42-org", []);
    seed("graphql-review-requests", "reviews", []);

    expect(buildBoard(store, [REPO, OTHER], NOW, DEPS)).toEqual({
      summary: { watched: 2, now: 0, soon: 0, quiet: 2, unconfirmed: 0 },
      tiles: [
        tile("security", 0),
        tile("ci", "unconfirmed"),
        tile("dependencies", 0),
        tile("pulls", "unconfirmed"),
        tile("issues", 0),
        tile("reviews", 0),
      ],
      rows: [],
      quiet: ["no42-org/twiki", "no42-org/quiet"],
      unconfirmed: [],
      unreadable: 0,
      collected: true,
      health: [
        ran("graphql-issues", "no42-org"),
        ran("graphql-review-requests", "reviews"),
        ran("graphql-update-prs", "no42-org"),
        ran("rest-org-dependabot", "no42-org"),
      ],
    } satisfies Board);
  });

  it("files a repository nothing has confirmed under unconfirmed, never under quiet", () => {
    // Quiet is a finding; a repository nobody has looked at has none
    // (AD-28). A repository whose only word is `not covered` has none either.
    const off = { owner: "no42-org", name: "off" };
    sweep([{ repo: REPO, alerts: [] }]);
    seed("coverage", "no42-org", [cov(off, "alerts_disabled")]);

    expect(buildBoard(store, [REPO, NEVER, off], NOW, DEPS)).toEqual({
      summary: { watched: 3, now: 0, soon: 0, quiet: 1, unconfirmed: 2 },
      tiles: [
        tile("security", 0),
        tile("ci", "unconfirmed"),
        tile("dependencies", "unconfirmed"),
        tile("pulls", "unconfirmed"),
        tile("issues", "unconfirmed"),
        tile("reviews", "unconfirmed"),
      ],
      rows: [],
      quiet: ["no42-org/twiki"],
      unconfirmed: ["no42-org/unseen", "no42-org/off"],
      unreadable: 0,
      collected: true,
      health: [
        ran("coverage", "no42-org"),
        ran("rest-org-dependabot", "no42-org"),
      ],
    } satisfies Board);
  });

  it("marks a tile with the items that put a repository in now, not the repository's items", () => {
    // Five security items; one of them is now. The now repository also holds
    // a soon alert, which must not count toward the marker.
    sweep([
      {
        repo: REPO,
        alerts: [
          makeAlert({ number: 1, repo: REPO, epssPercentage: 0.5 }),
          makeAlert({ number: 2, repo: REPO, epssPercentage: 0.02 }),
        ],
      },
      {
        repo: OTHER,
        alerts: [3, 4, 5].map((number) =>
          makeAlert({ number, repo: OTHER, epssPercentage: 0.02 }),
        ),
      },
    ]);

    const board = buildBoard(store, [REPO, OTHER], NOW, DEPS);

    expect(board.tiles[0]).toEqual(tile("security", 5, 1));
    expect(board.summary).toEqual({
      watched: 2,
      now: 1,
      soon: 1,
      quiet: 0,
      unconfirmed: 0,
    });
  });

  it("counts a tile without a now marker when nothing is now", () => {
    // Minor bumps: the smallest thing that ranks above least-known, so the
    // repository is soon and its Dependencies chip is on a row.
    sweep([{ repo: REPO, alerts: [] }]);
    seed(
      "graphql-update-prs",
      "no42-org",
      Array.from({ length: 7 }, (_, i) =>
        normalisePr(
          makeUpdatePr({
            number: 100 + i,
            repo: REPO,
            title: "Bump left-pad from 1.0.0 to 1.1.0",
          }),
        ),
      ),
    );

    const board = buildBoard(store, [REPO], NOW, DEPS);

    expect(board.tiles[2]).toEqual(tile("dependencies", 7));
    expect(
      board.rows.map((r) => [r.slug, r.tier, r.chips.dependencies]),
    ).toEqual([
      [
        "no42-org/twiki",
        "soon",
        linked(7, "/queue?repo=no42-org%2Ftwiki&topic=dependencies"),
      ],
    ]);
  });

  it("reads a topic with no queue kind as unconfirmed on the tile and every chip, and says why", () => {
    sweep([{ repo: REPO, alerts: [] }]);
    seed("graphql-review-requests", "reviews", [overdue(REPO, 4)]);

    const board = buildBoard(store, [REPO], NOW, DEPS);

    expect(board.tiles.filter((t) => t.count === "unconfirmed")).toEqual([
      tile("ci", "unconfirmed"),
      tile("dependencies", "unconfirmed"),
      tile("pulls", "unconfirmed"),
      tile("issues", "unconfirmed"),
    ]);
    expect(board.rows).toEqual([
      {
        slug: "no42-org/twiki",
        tier: "soon",
        reason: "pull request #4 open 9d, past the 3d review budget",
        chips: {
          security: ZERO,
          ci: UNSWEPT,
          dependencies: UNSWEPT,
          pulls: NO_LANE,
          issues: UNSWEPT,
          reviews: linked(1, "/reviews"),
        },
        signals: [{ topic: "reviews", text: "Reviews 1" }],
        signalsRest: {
          zero: ["security"],
          unconfirmed: ["ci", "dependencies", "pulls", "issues"],
        },
        freshness: "fresh",
        age: "5m ago",
      },
    ]);
  });

  describe("the CI chip and tile (Story 2.3)", () => {
    const ACTIONS_LANE = "rest-actions-runs";
    const CI = "/queue?repo=no42-org%2Ftwiki&topic=ci";
    // Forty-five minutes old: stale on the fifteen-minute sweep budget,
    // which tolerates two cadences, and fresh on the Actions lane's own
    // hourly one. Every case here therefore also proves the chip is judged
    // on the right cadence (AD-11).
    const CONFIRMED_AT = hoursAgo(0.75);

    const actions = (
      observations: { subject: unknown; payload: unknown }[],
      at = CONFIRMED_AT,
    ) => seed(ACTIONS_LANE, "no42-org", observations, at);

    const confirmation = (repo: RepoRef, workflows: number | null = 1) => ({
      subject: {
        type: "repository_actions",
        key: `${repo.owner}/${repo.name}`.toLowerCase(),
      },
      payload: {
        repo: `${repo.owner}/${repo.name}`.toLowerCase(),
        workflows,
        failing: 0,
      },
    });

    const brokenRun = (repo: RepoRef, over: Record<string, unknown> = {}) => ({
      subject: { type: "workflow_run", key: `WFR_${over.runNumber ?? 9}` },
      payload: {
        repo: `${repo.owner}/${repo.name}`.toLowerCase(),
        workflowId: 1,
        workflowName: "CI",
        runNumber: 9,
        status: "completed",
        conclusion: "failure",
        headBranch: "main",
        event: "push",
        htmlUrl: "https://github.com/no42-org/twiki/actions/runs/9",
        createdAt: hoursAgo(2),
        ...over,
      },
    });

    it("counts a red main on the chip and the tile, and marks it now", () => {
      sweep([{ repo: REPO, alerts: [] }]);
      actions([confirmation(REPO), brokenRun(REPO)]);

      const board = buildBoard(store, [REPO], NOW, DEPS);

      expect(board.rows).toEqual([
        {
          slug: "no42-org/twiki",
          tier: "now",
          reason: "workflow run #9: default branch workflow CI failed 2h ago",
          // The badge below is the alert lane's 5m, not this section's 45m,
          // and that is the documented rule rather than a loose fixture: a
          // row is badged by the NEWEST confirmation behind any chip showing
          // a number, and both the Security zero and the CI count are such
          // chips here. The CI item carries the Actions timestamp on its own
          // row in the queue, which is where a reader asks how old this
          // particular fact is.
          chips: {
            security: ZERO,
            ci: linked(1, CI),
            dependencies: UNSWEPT,
            pulls: NO_LANE,
            issues: UNSWEPT,
            reviews: UNSWEPT,
          },
          signals: [{ topic: "ci", text: "CI 1" }],
          signalsRest: {
            zero: ["security"],
            unconfirmed: ["dependencies", "pulls", "issues", "reviews"],
          },
          freshness: "fresh",
          age: "5m ago",
        },
      ]);
      // The count and the marker: every ci_failure is `now` by construction,
      // so a tile carrying a count with no marker would mean the tier rule
      // and the chip disagree about the same item.
      expect(board.tiles).toEqual([
        tile("security", 0),
        tile("ci", 1, 1),
        tile("dependencies", "unconfirmed"),
        tile("pulls", "unconfirmed"),
        tile("issues", "unconfirmed"),
        tile("reviews", "unconfirmed"),
      ]);
    });

    it("reads a confirmed clean repository as 0, never as unconfirmed", () => {
      sweep([{ repo: REPO, alerts: [] }]);
      actions([confirmation(REPO), brokenRun(REPO, { conclusion: "success" })]);
      seed("graphql-review-requests", "reviews", [overdue(REPO, 12)]);

      const board = buildBoard(store, [REPO], NOW, DEPS);

      expect(board.rows[0]?.chips.ci).toEqual(ZERO);
      expect(board.tiles[1]).toEqual(tile("ci", 0));
    });

    it("reads unconfirmed, never 0, with no confirmation for this repository", () => {
      sweep([{ repo: REPO, alerts: [] }]);
      // A clean, current full run of the lane, and a red main among its
      // rows - but no confirmation naming THIS repository. The lane is
      // bounded and yields (AD-24), so its run says nothing about a
      // repository it may never have opened: the chip must not read `0`.
      actions([brokenRun(REPO)]);
      seed("graphql-review-requests", "reviews", [overdue(REPO, 12)]);

      const board = buildBoard(store, [REPO], NOW, DEPS);

      expect(board.rows[0]?.chips.ci).toEqual(UNSWEPT);
      expect(board.tiles[1]).toEqual(tile("ci", "unconfirmed"));
    });

    it("reads unconfirmed when the lane has never completed a sweep either", () => {
      sweep([{ repo: REPO, alerts: [] }]);
      seed("graphql-review-requests", "reviews", [overdue(REPO, 12)]);

      const board = buildBoard(store, [REPO], NOW, DEPS);

      expect(board.rows[0]?.chips.ci).toEqual(UNSWEPT);
      expect(board.tiles[1]).toEqual(tile("ci", "unconfirmed"));
    });

    it("refuses to count from a confirmation that could not read what it found", () => {
      sweep([{ repo: REPO, alerts: [] }]);
      actions([confirmation(REPO, null), brokenRun(REPO)]);
      seed("graphql-review-requests", "reviews", [overdue(REPO, 12)]);

      const board = buildBoard(store, [REPO], NOW, DEPS);

      // The sweep reached this repository and could not read what it found.
      // That is an absence, not a zero, and no item is derived from the red
      // main behind it either: a broken build must never be rendered as a
      // green one.
      expect(board.rows[0]?.chips.ci).toEqual(UNSWEPT);
      expect(board.tiles[1]).toEqual(tile("ci", "unconfirmed"));
      expect(board.rows[0]?.tier).toBe("soon");
    });

    it("does not read a tombstoned confirmation as vouching", () => {
      // A tombstone is a retracted assertion, and it carries its payload
      // forward: read without the state guard it still says `workflows: 1`,
      // still passes the freshness check, and puts a confident count on a
      // repository the sweep has just said it can no longer speak for.
      sweep([{ repo: REPO, alerts: [] }]);
      const r = actions([confirmation(REPO), brokenRun(REPO)]);
      store.recordTombstones(r, CONFIRMED_AT, [
        { type: "repository_actions" as const, key: "no42-org/twiki" },
      ]);
      seed("graphql-review-requests", "reviews", [overdue(REPO, 12)]);

      const board = buildBoard(store, [REPO], NOW, DEPS);

      expect(board.rows[0]?.chips.ci).toEqual(UNSWEPT);
      expect(board.tiles[1]).toEqual(tile("ci", "unconfirmed"));
    });

    it("reads unconfirmed, not a zero, when the default branch cannot be resolved", () => {
      // `createApp` guards the resolver so one unreadable config cannot 500
      // the dashboard. A guard must not turn that error into a measured
      // zero: with no branch, nothing here knows which runs built main.
      sweep([{ repo: REPO, alerts: [] }]);
      actions([confirmation(REPO), brokenRun(REPO)]);
      seed("graphql-review-requests", "reviews", [overdue(REPO, 12)]);

      const board = buildBoard(store, [REPO], NOW, {
        ...DEPS,
        defaultBranchOf: () => null,
      });

      expect(board.rows[0]?.chips.ci).toEqual(
        absent("the default branch could not be resolved"),
      );
      expect(board.tiles[1]).toEqual(tile("ci", "unconfirmed"));
    });

    it("judges the confirmation on the hourly cadence, not the sweep's", () => {
      sweep([{ repo: REPO, alerts: [] }]);
      actions([confirmation(REPO), brokenRun(REPO)]);

      // The same store, judged on the fifteen-minute budget: the
      // half-hour-old confirmation is stale, so the chip and the item both
      // vanish. That is precisely the section that read stale within minutes
      // of a successful sweep before the lane got its own policy.
      const onSweepCadence = buildBoard(store, [REPO], NOW, {
        ...DEPS,
        actionsPolicy: POLICY,
      });

      // The red main is gone from the board entirely: no item, no row, and
      // the tile says `unconfirmed` rather than counting one.
      expect(onSweepCadence.rows).toEqual([]);
      expect(onSweepCadence.quiet).toEqual(["no42-org/twiki"]);
      expect(onSweepCadence.tiles[1]).toEqual(tile("ci", "unconfirmed"));
      // And on the lane's own cadence it is back, as `now`.
      expect(
        buildBoard(store, [REPO], NOW, DEPS).rows.map((r) => r.tier),
      ).toEqual(["now"]);
    });
  });

  describe("the Security chip (AD-28, AD-35)", () => {
    // A repository with nothing open is quiet and has no row, so each case
    // lifts it with an overdue review: the chip is then visible, and the
    // rationale names the review rather than anything the chip counts.
    const lift = () =>
      seed("graphql-review-requests", "reviews", [overdue(REPO, 12)]);
    const REASON = "pull request #12 open 9d, past the 3d review budget";

    it("reads not covered when coverage says alerts are switched off, and the alert counts nowhere", () => {
      // The alert would put the repository in now. Coverage says nobody may
      // count it, so it gives no tier, no rationale, no chip and no tile
      // (AD-28); the overdue review is what the row is about.
      sweep([
        { repo: REPO, alerts: [makeAlert({ number: 1, repo: REPO })] },
        { repo: OTHER, alerts: [] },
      ]);
      seed("coverage", "no42-org", [cov(REPO, "alerts_disabled")]);
      lift();

      const board = buildBoard(store, [REPO, OTHER], NOW, DEPS);

      expect(board.rows).toEqual([
        {
          slug: "no42-org/twiki",
          tier: "soon",
          reason: REASON,
          chips: {
            ...alertsOnly({
              state: "not-covered",
              count: 0,
              severity: null,
              href: null,
              reason: "Dependabot alerts are switched off for this repository",
            }),
            reviews: linked(1, "/reviews"),
          },
          // Not covered is a finding about the repository, so it is a
          // signal; the rest names what no sweep confirmed.
          signals: [
            { topic: "security", text: "Security not covered" },
            { topic: "reviews", text: "Reviews 1" },
          ],
          signalsRest: {
            zero: [],
            unconfirmed: ["ci", "dependencies", "pulls", "issues"],
          },
          freshness: "fresh",
          age: "5m ago",
        },
      ]);
      expect(board.tiles[0]).toEqual(tile("security", 0));
      expect(board.summary).toEqual({
        watched: 2,
        now: 0,
        soon: 1,
        quiet: 1,
        unconfirmed: 0,
      });
    });

    it("counts the alerts of a repository coverage says is covered", () => {
      sweep([{ repo: REPO, alerts: [soonAlert(REPO, 1)] }]);
      seed("coverage", "no42-org", [cov(REPO, "covered")]);

      const board = buildBoard(store, [REPO], NOW, DEPS);

      expect(board.rows).toEqual([
        {
          slug: "no42-org/twiki",
          tier: "soon",
          reason:
            "alert #1 left-pad: KEV status unknown, EPSS 2.0%, severity high, not an update, stuck state unknown",
          chips: alertsOnly(linked(1, SECURITY, "high")),
          signals: [{ topic: "security", text: "Security 1 high" }],
          signalsRest: { zero: [], unconfirmed: REST_TOPICS },
          freshness: "fresh",
          age: "5m ago",
        },
      ]);
      expect(board.tiles[0]).toEqual(tile("security", 1));
    });

    it("reads unconfirmed, never 0, when no sweep has confirmed the repository", () => {
      lift();

      expect(buildBoard(store, [REPO], NOW, DEPS).rows).toEqual([
        {
          slug: "no42-org/twiki",
          tier: "soon",
          reason: REASON,
          chips: { ...alertsOnly(UNSWEPT), reviews: linked(1, "/reviews") },
          signals: [{ topic: "reviews", text: "Reviews 1" }],
          signalsRest: {
            zero: [],
            unconfirmed: ["security", "ci", "dependencies", "pulls", "issues"],
          },
          freshness: "fresh",
          age: "5m ago",
        },
      ]);
    });

    it("reads a confirmed zero as 0 with no link", () => {
      sweep([{ repo: REPO, alerts: [] }]);
      lift();

      expect(buildBoard(store, [REPO], NOW, DEPS).rows).toEqual([
        {
          slug: "no42-org/twiki",
          tier: "soon",
          reason: REASON,
          chips: { ...alertsOnly(ZERO), reviews: linked(1, "/reviews") },
          signals: [{ topic: "reviews", text: "Reviews 1" }],
          signalsRest: {
            zero: ["security"],
            unconfirmed: ["ci", "dependencies", "pulls", "issues"],
          },
          freshness: "fresh",
          age: "5m ago",
        },
      ]);
    });

    it("links a count to the queue filtered by repository and topic, with the worst severity", () => {
      sweep([{ repo: REPO, alerts: [soonAlert(REPO, 1), soonAlert(REPO, 2)] }]);

      expect(buildBoard(store, [REPO], NOW, DEPS).rows).toEqual([
        {
          slug: "no42-org/twiki",
          tier: "soon",
          reason:
            "alert #1 left-pad: KEV status unknown, EPSS 2.0%, severity high, not an update, stuck state unknown",
          chips: alertsOnly(linked(2, SECURITY, "high")),
          signals: [{ topic: "security", text: "Security 2 high" }],
          signalsRest: { zero: [], unconfirmed: REST_TOPICS },
          freshness: "fresh",
          age: "5m ago",
        },
      ]);
    });

    it("counts the alert items, not the confirmation's number, and reports their worst severity", () => {
      // The confirmation says 9 / low; the rows say 3, worst critical. The
      // chip reads the rows the tier was judged on (AD-32).
      const alerts = [
        makeAlert({
          number: 1,
          repo: REPO,
          epssPercentage: 0.02,
          severity: "medium",
        }),
        makeAlert({
          number: 2,
          repo: REPO,
          epssPercentage: 0.02,
          severity: "critical",
        }),
        makeAlert({
          number: 3,
          repo: REPO,
          epssPercentage: 0.02,
          severity: "low",
        }),
      ];
      seed("rest-org-dependabot", "no42-org", [
        ...alerts.map(normalise),
        {
          subject: { type: "repository", key: "no42-org/twiki" },
          payload: {
            repo: "no42-org/twiki",
            openAlerts: 9,
            worstSeverity: "low",
          },
        },
      ]);

      const [row] = buildBoard(store, [REPO], NOW, DEPS).rows;

      expect(row?.chips.security).toEqual(linked(3, SECURITY, "critical"));
    });

    it("keeps a newly-clean repository fresh at 0, not permanently stale", () => {
      // It had an alert, the alert was fixed, and the sweep keeps confirming it.
      const r = seed(
        "rest-org-dependabot",
        "no42-org",
        [
          normalise(makeAlert({ number: 1, repo: REPO })),
          summariseRepo(REPO, [makeAlert({ number: 1, repo: REPO })]),
        ],
        "2026-08-16T11:00:00.000Z",
      );
      store.recordTombstones(r, AT, [
        alertSubject("dependabot_alert", REPO, 1),
      ]);
      store.recordObservations(r, AT, [summariseRepo(REPO, [])]);
      lift();

      const [row] = buildBoard(store, [REPO], NOW, DEPS).rows;

      // The alert is gone as a subject, not merely absent from the count.
      expect(
        store.current(alertSubject("dependabot_alert", REPO, 1))?.state,
      ).toBe("resolved");
      expect([row?.chips.security, row?.freshness, row?.age]).toEqual([
        ZERO,
        "fresh",
        "5m ago",
      ]);
    });

    it("goes stale when the collector stops rather than showing a stale count as current", () => {
      sweep(
        [{ repo: REPO, alerts: [soonAlert(REPO, 1)] }],
        "2026-08-16T09:00:00.000Z",
      );

      const [row] = buildBoard(store, [REPO], NOW, DEPS).rows;

      expect([
        row?.tier,
        row?.chips.security,
        row?.freshness,
        row?.age,
      ]).toEqual(["soon", linked(1, SECURITY, "high"), "stale", "3h ago"]);
    });

    it("does not read a tombstoned confirmation as confirmed", () => {
      const r = sweep([{ repo: REPO, alerts: [] }]);
      store.recordTombstones(r, "2026-08-16T11:56:00.000Z", [
        { type: "repository" as const, key: "no42-org/twiki" },
      ]);
      // Lifted by a review the lane has not vouched for, so nothing on the
      // row is confirmed and it carries no badge.
      store.recordObservations(r, AT, [overdue(REPO, 12)]);

      const [row] = buildBoard(store, [REPO], NOW, DEPS).rows;

      // A retracted assertion is not a zero. It is "we do not know".
      expect([row?.chips.security, row?.freshness, row?.age]).toEqual([
        UNSWEPT,
        "unknown",
        "never collected",
      ]);
    });

    it("matches a mixed-case repos.yaml entry to its confirmation and its items", () => {
      sweep([{ repo: REPO, alerts: [soonAlert(REPO, 1)] }]);

      const board = buildBoard(
        store,
        [{ owner: "No42-Org", name: "TWiki" }],
        NOW,
        DEPS,
      );

      expect(board.summary).toEqual({
        watched: 1,
        now: 0,
        soon: 1,
        quiet: 0,
        unconfirmed: 0,
      });
      expect(
        board.rows.map((r) => [r.slug, r.chips.security, r.freshness]),
      ).toEqual([["no42-org/twiki", linked(1, SECURITY, "high"), "fresh"]]);
    });

    it("does not blank a count merely because the coverage probe failed", () => {
      // `unknown` is not positive evidence of non-coverage (AD-28).
      sweep([{ repo: REPO, alerts: [soonAlert(REPO, 1)] }]);
      seed("coverage", "no42-org", [cov(REPO, "unknown")]);

      const [row] = buildBoard(store, [REPO], NOW, DEPS).rows;

      expect(row?.chips.security).toEqual(linked(1, SECURITY, "high"));
    });

    it("stops trusting coverage once its own attestation goes stale, and keeps the count", () => {
      // A week-old `alerts_disabled` is no longer evidence, any more than a
      // week-old `covered` would be (AD-28).
      sweep([{ repo: REPO, alerts: [soonAlert(REPO, 1)] }]);
      seed(
        "coverage",
        "no42-org",
        [cov(REPO, "alerts_disabled")],
        "2026-08-10T00:00:00.000Z",
      );

      const daily = { cadenceMs: 24 * 60 * 60_000 };
      const [row] = buildBoard(store, [REPO], NOW, {
        ...DEPS,
        coveragePolicy: daily,
      }).rows;

      expect(row?.chips.security).toEqual(linked(1, SECURITY, "high"));
    });

    it("judges coverage on its own daily cadence, not the sweep cadence", () => {
      // On the 15-minute sweep policy a three-hour-old attestation would read
      // stale and the `alerts_disabled` verdict would be lost.
      sweep([{ repo: REPO, alerts: [soonAlert(REPO, 1)] }]);
      seed(
        "coverage",
        "no42-org",
        [cov(REPO, "alerts_disabled")],
        "2026-08-16T09:00:00.000Z",
      );
      lift();

      const daily = { cadenceMs: 24 * 60 * 60_000 };
      const [row] = buildBoard(store, [REPO], NOW, {
        ...DEPS,
        coveragePolicy: daily,
      }).rows;

      expect(row?.chips.security).toEqual({
        state: "not-covered",
        count: 0,
        severity: null,
        href: null,
        reason: "Dependabot alerts are switched off for this repository",
      });
    });

    it("ignores a tombstoned coverage row rather than trusting it", () => {
      sweep([{ repo: REPO, alerts: [soonAlert(REPO, 1)] }]);
      const r = seed(
        "coverage",
        "no42-org",
        [cov(REPO, "alerts_disabled")],
        "2026-08-16T11:50:00.000Z",
      );
      store.recordTombstones(r, AT, [coverageSubject(REPO)]);

      const [row] = buildBoard(store, [REPO], NOW, DEPS).rows;

      expect(row?.chips.security).toEqual(linked(1, SECURITY, "high"));
    });
  });

  describe("the lane-attested chips (AD-11, AD-28)", () => {
    const minorPr = (number: number) =>
      normalisePr(
        makeUpdatePr({
          number,
          repo: REPO,
          title: "Bump left-pad from 1.0.0 to 1.1.0",
        }),
      );
    const issue = (number: number) =>
      normaliseIssue(makeRawIssue({ number, repo: REPO }));

    it("reads Dependencies, Issues and Reviews from their lanes' current attestations", () => {
      // Each chip is a count only once its lane vouched for the set: a
      // partial issue sweep may have skipped this very repository.
      sweep([{ repo: REPO, alerts: [] }]);
      seed("graphql-update-prs", "no42-org", [minorPr(7)]);
      seed("graphql-issues", "no42-org", [issue(3)], AT, "partial");
      seed("graphql-review-requests", "reviews", [
        overdue(REPO, 12),
        normaliseReviewRequest(
          makeReviewRequest({ repo: REPO, number: 13, createdAt: daysAgo(1) }),
        ),
      ]);

      expect(buildBoard(store, [REPO], NOW, DEPS).rows).toEqual([
        {
          slug: "no42-org/twiki",
          tier: "soon",
          reason:
            "update PR #7 left-pad: no CVE to check against KEV, no CVE to score, no advisory, minor bump, no Dependabot fix attempt on record",
          chips: {
            security: ZERO,
            ci: UNSWEPT,
            dependencies: linked(
              1,
              "/queue?repo=no42-org%2Ftwiki&topic=dependencies",
            ),
            pulls: NO_LANE,
            issues: UNSWEPT,
            reviews: linked(2, "/reviews"),
          },
          signals: [
            { topic: "dependencies", text: "Dependencies 1" },
            { topic: "reviews", text: "Reviews 2" },
          ],
          signalsRest: {
            zero: ["security"],
            unconfirmed: ["ci", "pulls", "issues"],
          },
          freshness: "fresh",
          age: "5m ago",
        },
      ]);
    });

    it("links a counted Issues chip and badges the row by its newest confirmation", () => {
      sweep([{ repo: REPO, alerts: [] }]);
      seed(
        "graphql-issues",
        "no42-org",
        [issue(3)],
        "2026-08-16T11:58:00.000Z",
      );
      seed("graphql-review-requests", "reviews", [overdue(REPO, 12)]);

      expect(buildBoard(store, [REPO], NOW, DEPS).rows).toEqual([
        {
          slug: "no42-org/twiki",
          tier: "soon",
          reason: "pull request #12 open 9d, past the 3d review budget",
          chips: {
            security: ZERO,
            ci: UNSWEPT,
            dependencies: UNSWEPT,
            pulls: NO_LANE,
            issues: linked(1, "/queue?repo=no42-org%2Ftwiki&topic=issues"),
            reviews: linked(1, "/reviews"),
          },
          signals: [
            { topic: "issues", text: "Issues 1" },
            { topic: "reviews", text: "Reviews 1" },
          ],
          signalsRest: {
            zero: ["security"],
            unconfirmed: ["ci", "dependencies", "pulls"],
          },
          // The issue sweep, three minutes newer than the alert sweep.
          freshness: "fresh",
          age: "2m ago",
        },
      ]);
    });

    it("badges a row confirmed by the issues lane alone by that lane, not as never collected", () => {
      seed("graphql-issues", "no42-org", [issue(3)]);
      // Lifted by a review no lane has vouched for.
      seed(
        "graphql-review-requests",
        "reviews",
        [overdue(REPO, 12)],
        AT,
        "failed",
      );

      expect(buildBoard(store, [REPO], NOW, DEPS).rows).toEqual([
        {
          slug: "no42-org/twiki",
          tier: "soon",
          reason: "pull request #12 open 9d, past the 3d review budget",
          chips: {
            security: UNSWEPT,
            ci: UNSWEPT,
            dependencies: UNSWEPT,
            pulls: NO_LANE,
            issues: linked(1, "/queue?repo=no42-org%2Ftwiki&topic=issues"),
            reviews: UNSWEPT,
          },
          signals: [{ topic: "issues", text: "Issues 1" }],
          signalsRest: {
            zero: [],
            unconfirmed: ["security", "ci", "dependencies", "pulls", "reviews"],
          },
          freshness: "fresh",
          age: "5m ago",
        },
      ]);
    });

    it("reads a lane whose last clean run went stale as unconfirmed, and says when", () => {
      // A days-old success is a claim nobody has renewed. The issue row is
      // still in the store, and the chip must not count it on that footing.
      sweep([{ repo: REPO, alerts: [] }]);
      seed("graphql-issues", "no42-org", [issue(3)], daysAgo(5));
      seed("graphql-review-requests", "reviews", [overdue(REPO, 12)]);

      expect(buildBoard(store, [REPO], NOW, DEPS).rows).toEqual([
        {
          slug: "no42-org/twiki",
          tier: "soon",
          reason: "pull request #12 open 9d, past the 3d review budget",
          chips: {
            security: ZERO,
            ci: UNSWEPT,
            dependencies: UNSWEPT,
            pulls: NO_LANE,
            issues: absent("last confirmed 5d ago"),
            reviews: linked(1, "/reviews"),
          },
          signals: [{ topic: "reviews", text: "Reviews 1" }],
          signalsRest: {
            zero: ["security"],
            unconfirmed: ["ci", "dependencies", "pulls", "issues"],
          },
          freshness: "fresh",
          age: "5m ago",
        },
      ]);
    });

    it("judges a lane on its own cadence when one is configured", () => {
      // The same five-day-old run, on a weekly cadence, is current.
      sweep([{ repo: REPO, alerts: [] }]);
      seed("graphql-issues", "no42-org", [issue(3)], daysAgo(5));
      seed("graphql-review-requests", "reviews", [overdue(REPO, 12)]);

      const [row] = buildBoard(store, [REPO], NOW, {
        ...DEPS,
        lanePolicies: { "graphql-issues": { cadenceMs: 7 * 24 * 60 * 60_000 } },
      }).rows;

      expect(row?.chips.issues).toEqual(
        linked(1, "/queue?repo=no42-org%2Ftwiki&topic=issues"),
      );
    });
  });

  it("counts a de-listed repository's items in no tile, row or summary", () => {
    const gone = { owner: "no42-org", name: "delisted" };
    sweep([
      { repo: REPO, alerts: [] },
      {
        repo: gone,
        alerts: [makeAlert({ number: 1, repo: gone, epssPercentage: 0.5 })],
      },
    ]);
    seed("graphql-issues", "no42-org", [
      normaliseIssue(makeRawIssue({ number: 3, repo: gone })),
    ]);
    seed("graphql-review-requests", "reviews", [overdue(gone, 4)]);

    expect(buildBoard(store, [REPO], NOW, DEPS)).toEqual({
      summary: { watched: 1, now: 0, soon: 0, quiet: 1, unconfirmed: 0 },
      tiles: [
        tile("security", 0),
        tile("ci", "unconfirmed"),
        tile("dependencies", "unconfirmed"),
        tile("pulls", "unconfirmed"),
        tile("issues", 0),
        tile("reviews", 0),
      ],
      rows: [],
      quiet: ["no42-org/twiki"],
      unconfirmed: [],
      unreadable: 0,
      collected: true,
      health: [
        ran("graphql-issues", "no42-org"),
        ran("graphql-review-requests", "reviews"),
        ran("rest-org-dependabot", "no42-org"),
      ],
    } satisfies Board);
  });

  it("carries the unreadable-row count for the page to state", () => {
    seed("rest-org-dependabot", "no42-org", [
      {
        subject: { type: "dependabot_alert", key: "no42-org/twiki#9" },
        payload: { number: 9, repo: "no42-org/twiki", cveId: 42 },
      },
      summariseRepo(REPO, []),
    ]);

    expect(buildBoard(store, [REPO], NOW, DEPS).unreadable).toBe(1);
  });

  describe("what the board does not know (#127)", () => {
    const RIPTIDE = { owner: "riptide-labs", name: "riptide" };
    const LOW = "; counts may be low";
    const FAILED_ALERTS = "alerts sweep failed for riptide-labs 3h ago";
    const STALE_3H = { age: "3h ago", freshness: "stale" as const };
    /** Every tile unconfirmed but Security, which is `security`. */
    const securityTiles = (security: Tile): Tile[] => [
      security,
      tile("ci", "unconfirmed"),
      tile("dependencies", "unconfirmed"),
      tile("pulls", "unconfirmed"),
      tile("issues", "unconfirmed"),
      tile("reviews", "unconfirmed"),
    ];
    const malformed = {
      subject: { type: "dependabot_alert" as const, key: "no42-org/twiki#9" },
      payload: { number: 9, repo: "no42-org/twiki", cveId: 42 },
    };

    it("warns on the tile whose lane failed, names the installation, and keeps the count", () => {
      sweep([{ repo: REPO, alerts: [soonAlert(REPO, 1)] }]);
      seed("rest-org-dependabot", "riptide-labs", [], hoursAgo(3), "failed");

      expect(buildBoard(store, [REPO, RIPTIDE], NOW, DEPS)).toEqual({
        summary: { watched: 2, now: 0, soon: 1, quiet: 0, unconfirmed: 1 },
        tiles: securityTiles(
          tile("security", 1, 0, [`${FAILED_ALERTS}${LOW}`]),
        ),
        rows: [
          {
            slug: "no42-org/twiki",
            tier: "soon",
            reason:
              "alert #1 left-pad: KEV status unknown, EPSS 2.0%, severity high, not an update, stuck state unknown",
            chips: alertsOnly(linked(1, SECURITY, "high")),
            signals: [{ topic: "security", text: "Security 1 high" }],
            signalsRest: { zero: [], unconfirmed: REST_TOPICS },
            freshness: "fresh",
            age: "5m ago",
          },
        ],
        quiet: [],
        unconfirmed: ["riptide-labs/riptide"],
        unreadable: 0,
        collected: true,
        health: [
          ran("rest-org-dependabot", "no42-org"),
          ran("rest-org-dependabot", "riptide-labs", "failed", STALE_3H),
        ],
      } satisfies Board);
    });

    it("says stalled for a run that never finished", () => {
      sweep([{ repo: REPO, alerts: [] }]);
      store.beginRun({
        lane: "rest-org-dependabot",
        installation: "riptide-labs",
        scope: "full",
        startedAt: hoursAgo(3),
      });

      expect(buildBoard(store, [REPO, RIPTIDE], NOW, DEPS)).toEqual({
        summary: { watched: 2, now: 0, soon: 0, quiet: 1, unconfirmed: 1 },
        tiles: securityTiles(
          tile("security", 0, 0, [
            "alerts sweep stalled for riptide-labs 3h ago; counts may be low",
          ]),
        ),
        rows: [],
        quiet: ["no42-org/twiki"],
        unconfirmed: ["riptide-labs/riptide"],
        unreadable: 0,
        collected: true,
        health: [
          ran("rest-org-dependabot", "no42-org"),
          ran("rest-org-dependabot", "riptide-labs", "stalled", STALE_3H),
        ],
      } satisfies Board);
    });

    it("carries one line per failed lane of a topic, in lane order, without a suffix under no count", () => {
      // Both dependency lanes failed: two lines on one tile, which is
      // itself unconfirmed since no update-prs sweep completed, so there is
      // no count for `counts may be low` to qualify.
      sweep([{ repo: REPO, alerts: [] }]);
      seed("graphql-update-status", "no42-org", [], AT, "failed");
      seed("graphql-update-prs", "no42-org", [], AT, "failed");

      const board = buildBoard(store, [REPO], NOW, DEPS);

      expect(board.tiles).toEqual([
        tile("security", 0),
        tile("ci", "unconfirmed"),
        tile("dependencies", "unconfirmed", 0, [
          "update PRs sweep failed for no42-org 5m ago",
          "update status sweep failed for no42-org 5m ago",
        ]),
        tile("pulls", "unconfirmed"),
        tile("issues", "unconfirmed"),
        tile("reviews", "unconfirmed"),
      ]);
    });

    it("leaves the installation off a lane that has only one", () => {
      // Reviews and the KEV catalogue run once for the estate, so `for
      // reviews` or `for cisa` would name nothing the reader can act on.
      sweep([{ repo: REPO, alerts: [] }]);
      seed("graphql-review-requests", "reviews", [], AT, "failed");
      seed("kev", "cisa", [], AT, "failed");

      expect(buildBoard(store, [REPO], NOW, DEPS)).toEqual({
        summary: { watched: 1, now: 0, soon: 0, quiet: 1, unconfirmed: 0 },
        tiles: [
          tile("security", 0, 0, [`KEV catalogue sweep failed 5m ago${LOW}`]),
          tile("ci", "unconfirmed"),
          tile("dependencies", "unconfirmed"),
          tile("pulls", "unconfirmed"),
          tile("issues", "unconfirmed"),
          tile("reviews", "unconfirmed", 0, [
            "review requests sweep failed 5m ago",
          ]),
        ],
        rows: [],
        quiet: ["no42-org/twiki"],
        unconfirmed: [],
        unreadable: 0,
        collected: true,
        health: [
          ran("graphql-review-requests", "reviews", "failed"),
          ran("kev", "cisa", "failed"),
          ran("rest-org-dependabot", "no42-org"),
        ],
      } satisfies Board);
    });

    it("judges a coverage run in flight on the coverage cadence, not the sweep's", () => {
      // Two hours in on a daily lane is running, not stalled: judged on the
      // fifteen-minute sweep policy it would warn on Security every render.
      sweep([{ repo: REPO, alerts: [] }]);
      store.beginRun({
        lane: "coverage",
        installation: "no42-org",
        scope: "full",
        startedAt: hoursAgo(2),
      });

      const daily = { cadenceMs: 24 * 60 * 60_000 };
      expect(
        buildBoard(store, [REPO], NOW, { ...DEPS, coveragePolicy: daily }),
      ).toEqual({
        summary: { watched: 1, now: 0, soon: 0, quiet: 1, unconfirmed: 0 },
        tiles: securityTiles(tile("security", 0)),
        rows: [],
        quiet: ["no42-org/twiki"],
        unconfirmed: [],
        unreadable: 0,
        collected: true,
        health: [
          ran("coverage", "no42-org", "running", { age: "2h ago" }),
          ran("rest-org-dependabot", "no42-org"),
        ],
      } satisfies Board);
    });

    it("does not warn for a failed hot run while the full run is current", () => {
      sweep([{ repo: REPO, alerts: [] }]);
      const hot = store.beginRun({
        lane: "rest-org-dependabot",
        installation: "no42-org",
        scope: "hot",
        startedAt: AT,
      });
      store.finishRun(hot, "failed", AT, "boom");

      expect(buildBoard(store, [REPO], NOW, DEPS)).toEqual({
        summary: { watched: 1, now: 0, soon: 0, quiet: 1, unconfirmed: 0 },
        tiles: securityTiles(tile("security", 0)),
        rows: [],
        quiet: ["no42-org/twiki"],
        unconfirmed: [],
        unreadable: 0,
        collected: true,
        health: [
          ran("rest-org-dependabot", "no42-org"),
          ran("rest-org-dependabot", "no42-org", "failed", {
            scope: "hot",
            detail: "boom",
          }),
        ],
      } satisfies Board);
    });

    it("does not warn for an installation no watched repository belongs to", () => {
      // The owner left repos.yaml; its dead lane row stays in the store and
      // the table, but it qualifies no count on this page.
      sweep([{ repo: REPO, alerts: [] }]);
      seed("rest-org-dependabot", "riptide-labs", [], hoursAgo(3), "failed");

      expect(buildBoard(store, [REPO], NOW, DEPS)).toEqual({
        summary: { watched: 1, now: 0, soon: 0, quiet: 1, unconfirmed: 0 },
        tiles: securityTiles(tile("security", 0)),
        rows: [],
        quiet: ["no42-org/twiki"],
        unconfirmed: [],
        unreadable: 0,
        collected: true,
        health: [
          ran("rest-org-dependabot", "no42-org"),
          ran("rest-org-dependabot", "riptide-labs", "failed", STALE_3H),
        ],
      } satisfies Board);
    });

    it("lists a lane the map does not know in the table and warns on no tile", () => {
      sweep([{ repo: REPO, alerts: [] }]);
      seed("retired-lane", "no42-org", [], AT, "failed");

      expect(buildBoard(store, [REPO], NOW, DEPS)).toEqual({
        summary: { watched: 1, now: 0, soon: 0, quiet: 1, unconfirmed: 0 },
        tiles: securityTiles(tile("security", 0)),
        rows: [],
        quiet: ["no42-org/twiki"],
        unconfirmed: [],
        unreadable: 0,
        collected: true,
        health: [
          ran("rest-org-dependabot", "no42-org"),
          ran("retired-lane", "no42-org", "failed"),
        ],
      } satisfies Board);
    });

    it("stays collected when every lane fails after a good sweep, and keeps the confirmed rows", () => {
      // The health table holds only the latest run per lane, so a bad tick
      // after a good one would otherwise read as an estate never swept.
      // The confirmations are still there; the rows show, stale, under
      // tiles that say every lane failed.
      sweep([{ repo: REPO, alerts: [soonAlert(REPO, 1)] }], hoursAgo(3));
      seed("graphql-issues", "no42-org", [], hoursAgo(3));
      seed("graphql-update-prs", "no42-org", [], hoursAgo(3));
      seed("graphql-review-requests", "reviews", [], hoursAgo(3));
      for (const [lane, installation] of [
        ["rest-org-dependabot", "no42-org"],
        ["graphql-issues", "no42-org"],
        ["graphql-update-prs", "no42-org"],
        ["graphql-review-requests", "reviews"],
      ] as const) {
        seed(lane, installation, [], AT, "failed");
      }

      expect(buildBoard(store, [REPO], NOW, DEPS)).toEqual({
        summary: { watched: 1, now: 0, soon: 1, quiet: 0, unconfirmed: 0 },
        tiles: [
          tile("security", 1, 0, [
            "alerts sweep failed for no42-org 5m ago; counts may be low",
          ]),
          tile("ci", "unconfirmed"),
          tile("dependencies", "unconfirmed", 0, [
            "update PRs sweep failed for no42-org 5m ago",
          ]),
          tile("pulls", "unconfirmed"),
          tile("issues", "unconfirmed", 0, [
            "issues sweep failed for no42-org 5m ago",
          ]),
          tile("reviews", "unconfirmed", 0, [
            "review requests sweep failed 5m ago",
          ]),
        ],
        rows: [
          {
            slug: "no42-org/twiki",
            tier: "soon",
            reason:
              "alert #1 left-pad: KEV status unknown, EPSS 2.0%, severity high, not an update, stuck state unknown",
            chips: alertsOnly(linked(1, SECURITY, "high")),
            signals: [{ topic: "security", text: "Security 1 high" }],
            signalsRest: { zero: [], unconfirmed: REST_TOPICS },
            freshness: "stale",
            age: "3h ago",
          },
        ],
        quiet: [],
        unconfirmed: [],
        unreadable: 0,
        collected: true,
        health: [
          ran("graphql-issues", "no42-org", "failed"),
          ran("graphql-review-requests", "reviews", "failed"),
          ran("graphql-update-prs", "no42-org", "failed"),
          ran("rest-org-dependabot", "no42-org", "failed"),
        ],
      } satisfies Board);
    });

    it("counts a partial completion as collected, and warns under its count", () => {
      // A partial sweep looked and may have skipped something: what it
      // confirmed stands, with the tile saying the count is a lower bound.
      // A detail, or the health view reads a same-stamp partial as in
      // flight; a real partial run always says what it skipped.
      seed(
        "rest-org-dependabot",
        "no42-org",
        [summariseRepo(REPO, [])],
        AT,
        "partial",
        "3 unreadable",
      );

      expect(buildBoard(store, [REPO], NOW, DEPS)).toEqual({
        summary: { watched: 1, now: 0, soon: 0, quiet: 1, unconfirmed: 0 },
        tiles: securityTiles(
          tile("security", 0, 0, [
            "alerts sweep partial for no42-org 5m ago; counts may be low",
          ]),
        ),
        rows: [],
        quiet: ["no42-org/twiki"],
        unconfirmed: [],
        unreadable: 0,
        collected: true,
        health: [
          ran("rest-org-dependabot", "no42-org", "partial", {
            detail: "3 unreadable",
          }),
        ],
      } satisfies Board);
    });

    it("counts a partial completion that confirmed nothing as collected", () => {
      seed("graphql-issues", "no42-org", [], AT, "partial", "3 unreadable");

      expect(buildBoard(store, [REPO], NOW, DEPS)).toEqual({
        summary: { watched: 1, now: 0, soon: 0, quiet: 0, unconfirmed: 1 },
        tiles: [
          tile("security", "unconfirmed"),
          tile("ci", "unconfirmed"),
          tile("dependencies", "unconfirmed"),
          tile("pulls", "unconfirmed"),
          tile("issues", "unconfirmed", 0, [
            "issues sweep partial for no42-org 5m ago",
          ]),
          tile("reviews", "unconfirmed"),
        ],
        rows: [],
        quiet: [],
        unconfirmed: ["no42-org/twiki"],
        unreadable: 0,
        collected: true,
        health: [
          ran("graphql-issues", "no42-org", "partial", {
            detail: "3 unreadable",
          }),
        ],
      } satisfies Board);
    });

    it("reads never collected everywhere while no sweep has ever completed", () => {
      // An empty store: no run at all.
      expect(buildBoard(store, [REPO, OTHER, NEVER], NOW, DEPS)).toEqual({
        summary: { watched: 3, now: 0, soon: 0, quiet: 0, unconfirmed: 3 },
        tiles: TOPICS_ORDER.map((topic) => never(topic)),
        rows: [],
        quiet: [],
        unconfirmed: ["no42-org/twiki", "no42-org/quiet", "no42-org/unseen"],
        unreadable: 0,
        collected: false,
        health: [],
      } satisfies Board);
    });

    it("does not count a failed sweep's rows as collected", () => {
      // The failed run wrote an alert and a row nothing can read before it
      // died, and confirmed no repository. Neither row is a finding: the
      // tiles read never collected, the failure warns on its tile with no
      // count to qualify, the unreadable row is still counted, and the
      // repository is unconfirmed, not quiet.
      seed(
        "rest-org-dependabot",
        "no42-org",
        [normalise(soonAlert(REPO, 1)), malformed],
        hoursAgo(3),
        "failed",
      );

      expect(buildBoard(store, [REPO], NOW, DEPS)).toEqual({
        summary: { watched: 1, now: 0, soon: 0, quiet: 0, unconfirmed: 1 },
        tiles: [
          never("security", ["alerts sweep failed for no42-org 3h ago"]),
          never("ci"),
          never("dependencies"),
          never("pulls"),
          never("issues"),
          never("reviews"),
        ],
        rows: [],
        quiet: [],
        unconfirmed: ["no42-org/twiki"],
        unreadable: 1,
        collected: false,
        health: [ran("rest-org-dependabot", "no42-org", "failed", STALE_3H)],
      } satisfies Board);
    });
  });

  it("lists every watched repository exactly once, so a missing one never means healthy", () => {
    sweep([
      {
        repo: REPO,
        alerts: [makeAlert({ number: 1, repo: REPO, epssPercentage: 0.5 })],
      },
      { repo: OTHER, alerts: [] },
    ]);

    const board = buildBoard(
      store,
      [REPO, OTHER, NEVER, { owner: "No42-Org", name: "TWIKI" }],
      NOW,
      DEPS,
    );

    expect(board.summary).toEqual({
      watched: 3,
      now: 1,
      soon: 0,
      quiet: 1,
      unconfirmed: 1,
    });
    expect([
      ...board.rows.map((r) => r.slug),
      ...board.quiet,
      ...board.unconfirmed,
    ]).toEqual(["no42-org/twiki", "no42-org/quiet", "no42-org/unseen"]);
  });
});
