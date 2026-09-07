/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { CoverageState } from "../../core/coverage.js";
import { coverageReason, isCovered } from "../../core/coverage.js";
import { compareRankings } from "../../core/rank.js";
import type { SeverityReading } from "../../core/severity.js";
import { watchKey } from "../../core/slug.js";
import { type Tier, tier } from "../../core/tier.js";
import { TOPICS, type Topic, topicOf } from "../../core/topics.js";
import type { RepoRef } from "../../core/types.js";
import {
  LANE as COVERAGE_LANE,
  type CoverageObservation,
} from "../collect/coverage.js";
import { LANE as ISSUE_LANE } from "../collect/issues.js";
import {
  REVIEWS_INSTALLATION,
  LANE as REVIEWS_LANE,
} from "../collect/review-requests.js";
import { LANE as UPDATE_PR_LANE } from "../collect/update-prs.js";
import type { CurrentValue, StorePort } from "../store/port.js";
import { latestFullRun } from "./attestation.js";
import {
  ageLabel,
  type Freshness,
  type FreshnessPolicy,
  freshness,
} from "./freshness.js";
import { buildCollectionHealth, type CollectionHealth } from "./health.js";
import { laneTopic } from "./lane-topics.js";
import { topicPath } from "./links.js";
import type { QueueItem } from "./queue.js";
import {
  type AttentionDeps,
  attentionByRepo,
  type RepoAttention,
} from "./tiers.js";

// The attention board (AD-32, AD-35): everything the overview shows, built
// once per request from one queue.
//
// Six topic tiles, the `now` and `soon` rows with one count chip per topic,
// and the quiet repositories, all read the same `attentionByRepo` result. A
// tile that disagreed with the rows beneath it would be two computations
// wearing one page, which is the defect this module exists to remove.

export interface BoardDeps extends AttentionDeps {
  /** The coverage lane runs daily, so it is judged on its own cadence (AD-11). */
  coveragePolicy?: FreshnessPolicy;
  /** Per-lane cadences for the attesting lanes. A lane absent here is judged on `policy`. */
  lanePolicies?: Readonly<Record<string, FreshnessPolicy>>;
}

/**
 * One count chip.
 *
 * Precedence per AD-35: `not-covered` (Security only, coverage says off)
 * over `unconfirmed` (no completed, current sweep for that topic on this
 * repository) over a count. A confirmed zero is a real `zero`. Absence never
 * renders as a number (AD-28).
 */
export interface Chip {
  state: "zero" | "count" | "not-covered" | "unconfirmed";
  /** The count. Zero unless the state is `count`. */
  count: number;
  /** The worst severity among the counted items; Security only. */
  severity: SeverityReading | null;
  /** Where the chip leads. Null for zero, unconfirmed and not covered. */
  href: string | null;
  /**
   * Why there is no count: the coverage reason for `not-covered`, and for
   * `unconfirmed` which of the two absences it is (no collector for the
   * topic yet, or a lane that has not completed a current sweep here).
   * Null when there is a count.
   */
  reason: string | null;
}

export interface Tile {
  topic: Topic;
  label: string;
  href: string;
  /**
   * The confirmed chips' counts summed across watched repositories, or
   * `unconfirmed`; `never collected` on every tile while no sweep has ever
   * completed (#127).
   */
  count: number | "unconfirmed" | "never collected";
  /** Items whose own tier is `now`, among repositories whose chip is a count. */
  nowCount: number;
  /** Why the tile is `unconfirmed`. Null when it carries a count. */
  reason: string | null;
  /**
   * One line per lane of this topic whose latest run failed or stalled, in
   * health-table order: `alerts sweep failed for riptide-labs 3h ago; counts
   * may be low`. The count above it is then a lower bound, and the tile
   * says so where the reader looks rather than only at the foot of the page.
   */
  warnings: string[];
}

/** One chip carrying a finding, worded for the tablet's signals cell. */
export interface Signal {
  topic: Topic;
  /** The topic word then the chip's text: `Security 2 high`, `Issues 3`. */
  text: string;
}

export interface BoardRow {
  slug: string;
  tier: Tier;
  /** The rationale, one sentence. */
  reason: string;
  chips: Record<Topic, Chip>;
  /**
   * The chips that say something, in topic order, for the one signals cell
   * the tablet layout shows in place of six columns: a count, or `not
   * covered`, which is a finding about the repository rather than a gap in
   * ours. A confirmed zero and an unconfirmed topic are not signals; they
   * go to `signalsRest`, so the cell reads what needs attention and the
   * rationale line still says what was checked and what was not (AD-28).
   */
  signals: Signal[];
  signalsRest: { zero: Topic[]; unconfirmed: Topic[] };
  /**
   * The newest confirmation behind any of this row's confirmed chips: the
   * alert lane's repository confirmation or an attesting lane's run.
   * `unknown` only when nothing confirmed anything here.
   */
  freshness: Freshness;
  age: string;
}

export interface Board {
  summary: {
    watched: number;
    now: number;
    soon: number;
    quiet: number;
    unconfirmed: number;
  };
  tiles: Tile[];
  /** `now` rows first, then `soon`, each in chain order. */
  rows: BoardRow[];
  /** Quiet repositories that at least one sweep confirmed, in allowlist order. */
  quiet: string[];
  /**
   * Repositories nothing has confirmed: quiet only in the sense that nobody
   * has looked, which is not quiet at all (AD-28). Never folded into `quiet`.
   */
  unconfirmed: string[];
  /** Queue rows that could not be read. Carried for the page to state (#127). */
  unreadable: number;
  /**
   * Whether anything has ever been collected: true when any latest-per-lane
   * health row has outcome `ok` or `partial`, or when any `present`
   * repository confirmation exists. The health table keeps only the latest
   * run per lane, so an estate whose lanes all failed once after good
   * sweeps still holds its confirmations and stays collected. False is the
   * empty store, or one holding nothing but failures and in-flight runs:
   * nothing on the board is then a finding, and the page says `nothing
   * collected yet` instead.
   */
  collected: boolean;
  /**
   * The latest run per lane, installation and scope, from the same read the
   * tile warnings come from, so the table and the tiles cannot disagree.
   */
  health: CollectionHealth[];
}

/** The two absences an `unconfirmed` chip or tile can stand for. */
export const NO_COLLECTOR = "no collector for this topic yet";
export const NO_SWEEP = "not confirmed by any completed sweep";

/** A chip with no count behind it. */
function absent(state: "unconfirmed" | "not-covered", reason: string): Chip {
  return { state, count: 0, severity: null, href: null, reason };
}

/** A confirmed count: `zero` when nothing is open, linked otherwise. */
function counted(
  count: number,
  severity: SeverityReading | null,
  href: string,
): Chip {
  return count === 0
    ? { state: "zero", count: 0, severity: null, href: null, reason: null }
    : { state: "count", count, severity, href, reason: null };
}

const confirmed = (chip: Chip): boolean =>
  chip.state === "zero" || chip.state === "count";

/**
 * The words on a chip. One place, so the column chip and the signals cell
 * cannot spell a count two ways (AD-32).
 */
export function chipText(chip: Chip): string {
  switch (chip.state) {
    case "not-covered":
      return "not covered";
    case "unconfirmed":
      return "unconfirmed";
    case "zero":
      return "0";
    case "count":
      return chip.severity === null
        ? `${chip.count}`
        : `${chip.count} ${chip.severity}`;
  }
}

/** Split a row's chips into the signals cell and the rationale's remainder. */
function signalsOf(
  chips: Record<Topic, Chip>,
): Pick<BoardRow, "signals" | "signalsRest"> {
  const signals: Signal[] = [];
  const zero: Topic[] = [];
  const unconfirmed: Topic[] = [];
  for (const { topic, label } of TOPICS) {
    const chip = chips[topic];
    if (chip.state === "zero") zero.push(topic);
    else if (chip.state === "unconfirmed") unconfirmed.push(topic);
    else signals.push({ topic, text: `${label} ${chipText(chip)}` });
  }
  return { signals, signalsRest: { zero, unconfirmed } };
}

/** What a lane's latest full run on an installation lets a chip say. */
interface LaneStanding {
  /** An `ok` run exists and is still fresh on the lane's own cadence. */
  current: boolean;
  verifiedAt: string | null;
  policy: FreshnessPolicy;
  /** Why not current; null when it is. */
  reason: string | null;
}

/** A confirmation that may badge a row: when it was made, and on what cadence. */
interface Source {
  verifiedAt: string;
  policy: FreshnessPolicy;
}

/**
 * Build the board.
 *
 * Tiers and counts cover allowlisted repositories only, matched by
 * `watchKey` (AD-32): an item whose repository was de-listed is in the queue
 * but in no group, so it reaches no tile, row or summary.
 */
export function buildBoard(
  store: StorePort,
  watched: readonly RepoRef[],
  now: Date,
  deps: BoardDeps,
): Board {
  // One entry per distinct slug: two allowlist lines folding to the same
  // repository are one repository, as they are in every lane (AD-33).
  const repos = new Map<string, RepoRef>();
  for (const repo of watched) {
    const slug = watchKey(repo);
    if (!repos.has(slug)) repos.set(slug, repo);
  }

  // The repository confirmation is the source of truth for "did we look".
  // Deriving it from alert rows cannot work: a healthy repository has none,
  // and a newly-clean one stops having its rows updated the moment they are
  // tombstoned, so both would read as never collected. Only `present` rows:
  // a tombstoned confirmation is a retracted assertion.
  const confirmations = new Map<string, CurrentValue>();
  for (const value of store.currentByType("repository")) {
    if (value.state === "present") confirmations.set(value.subject.key, value);
  }

  // One read of collection health for the whole page: the tile warnings and
  // the table at the foot come from it (#127). A lane whose latest full
  // sweep failed, stalled or came back partial warns on its topic's tile,
  // because the count above it is then a lower bound and a low count reads
  // as a quiet estate.
  // Coverage is judged on its own cadence here as everywhere else, or a
  // daily run in flight past the sweep cadence would read stalled.
  const health = buildCollectionHealth(store, now, deps.policy, {
    ...deps.lanePolicies,
    [COVERAGE_LANE]:
      deps.coveragePolicy ?? deps.lanePolicies?.[COVERAGE_LANE] ?? deps.policy,
  });
  const collected =
    health.some((h) => h.outcome === "ok" || h.outcome === "partial") ||
    confirmations.size > 0;
  const owners = new Set(
    [...repos.values()].map((repo) => repo.owner.toLowerCase()),
  );
  const warnings = new Map<Topic, string[]>();
  for (const h of health) {
    // Every outcome but a clean one and a run still inside its budget: a
    // partial sweep is a lower bound exactly as a failed one is.
    if (h.outcome === "ok" || h.outcome === "running") continue;
    // A hot run is a subset; the full run is what vouches for the count.
    if (h.scope !== "full") continue;
    // A lane this map does not know is a programming error, caught by the
    // test that walks every LANE export; here it must not 500 the page, and
    // the health table still lists the row.
    const lane = laneTopic(h.lane);
    if (lane === undefined) continue;
    // A per-installation lane failing on an owner nobody watches any more
    // would otherwise warn on every render until the row is purged.
    if (lane.installation === null && !owners.has(h.installation.toLowerCase()))
      continue;
    const where = lane.installation === null ? ` for ${h.installation}` : "";
    const line = `${lane.word} sweep ${h.outcome}${where} ${h.age}`;
    warnings.set(lane.topic, [...(warnings.get(lane.topic) ?? []), line]);
  }
  /**
   * The topic's warning lines. `counts may be low` is appended only under a
   * count: a tile reading `unconfirmed` or `never collected` has none.
   */
  const warningsFor = (topic: Topic, counted: boolean): string[] =>
    (warnings.get(topic) ?? []).map((line) =>
      counted ? `${line}; counts may be low` : line,
    );

  // Coverage is trusted only while its own attestation is fresh. If the
  // coverage lane dies and somebody then switches Dependabot off, a cached
  // `covered` would keep the page showing a confident zero (AD-28).
  const coverage = new Map<string, CoverageState>();
  for (const value of store.currentByType("repository_coverage")) {
    if (value.state !== "present") continue;
    const attested = freshness(
      value.verifiedAt,
      now,
      deps.coveragePolicy ?? deps.policy,
    );
    coverage.set(
      value.subject.key,
      attested === "fresh"
        ? (value.payload as CoverageObservation).state
        : "unknown",
    );
  }
  // Suppressed only on POSITIVE evidence of non-coverage. `unknown` is not
  // such evidence: blanking on it would let one rate-limited probe wipe
  // correct counts off the page (AD-28). Decided before tiering, so the
  // alert nobody may count cannot also be the reason a row is `now`.
  const notCovered = new Set<string>();
  for (const [slug, state] of coverage) {
    if (!isCovered(state) && state !== "unknown") notCovered.add(slug);
  }

  const { byRepo, queue } = attentionByRepo(
    store,
    watched,
    now,
    deps,
    notCovered,
  );

  // Nothing has ever been collected. No count on this page would be a
  // finding, so none is offered (AD-28): every tile reads `never collected`,
  // no row or quiet block is built, and every repository is unconfirmed.
  // The page replaces the board with one note pointing at the health table.
  if (!collected) {
    return {
      summary: {
        watched: repos.size,
        now: 0,
        soon: 0,
        quiet: 0,
        unconfirmed: repos.size,
      },
      tiles: TOPICS.map(({ topic, label }) => ({
        topic,
        label,
        href: topicPath(topic),
        count: "never collected",
        nowCount: 0,
        reason: null,
        warnings: warningsFor(topic, false),
      })),
      rows: [],
      quiet: [],
      unconfirmed: [...repos.keys()],
      unreadable: queue.unreadable,
      collected,
      health,
    };
  }

  // A lane's standing on an installation, asked once per lane and owner
  // rather than once per repository and chip. Only an `ok` run that is
  // still fresh on the lane's own cadence lets a chip show a number: a
  // days-old success is a claim nobody has renewed (AD-11, AD-28).
  const standings = new Map<string, LaneStanding>();
  const standing = (lane: string, installation: string): LaneStanding => {
    const key = `${lane}|${installation}`;
    let result = standings.get(key);
    if (result === undefined) {
      const policy = deps.lanePolicies?.[lane] ?? deps.policy;
      const run = latestFullRun(store, lane, installation);
      if (run?.outcome !== "ok") {
        result = { current: false, verifiedAt: null, policy, reason: NO_SWEEP };
      } else if (freshness(run.verifiedAt, now, policy) === "fresh") {
        result = {
          current: true,
          verifiedAt: run.verifiedAt,
          policy,
          reason: null,
        };
      } else {
        result = {
          current: false,
          verifiedAt: null,
          policy,
          reason: `last confirmed ${ageLabel(run.verifiedAt, now)}`,
        };
      }
      standings.set(key, result);
    }
    return result;
  };
  const reviews = standing(REVIEWS_LANE, REVIEWS_INSTALLATION);

  /** The chips of one repository, and the confirmations that produced them. */
  const chipsFor = (
    repo: RepoRef,
    slug: string,
    attention: RepoAttention,
  ): { chips: Record<Topic, Chip>; sources: Source[] } => {
    const owner = repo.owner.toLowerCase();
    const sources: Source[] = [];
    const ofKind = (kind: QueueItem["kind"]): number =>
      attention.items.filter((item) => item.kind === kind).length;
    const fromLane = (
      lane: LaneStanding,
      topic: Topic,
      count: number,
    ): Chip => {
      if (!lane.current) return absent("unconfirmed", lane.reason ?? NO_SWEEP);
      if (lane.verifiedAt !== null) {
        sources.push({ verifiedAt: lane.verifiedAt, policy: lane.policy });
      }
      return counted(count, null, topicPath(topic, repo));
    };

    const covered = coverage.get(slug);
    const confirmation = confirmations.get(slug);
    let security: Chip;
    if (notCovered.has(slug) && covered !== undefined) {
      security = absent("not-covered", coverageReason(covered) ?? NO_SWEEP);
    } else if (confirmation !== undefined) {
      sources.push({
        verifiedAt: confirmation.verifiedAt,
        policy: deps.policy,
      });
      security = counted(
        attention.openAlerts,
        attention.worstSeverity,
        topicPath("security", repo),
      );
    } else {
      security = absent("unconfirmed", NO_SWEEP);
    }

    return {
      chips: {
        security,
        // No lane yet (Epics 2 and 3), so no sweep has confirmed anything:
        // `unconfirmed`, never `0` (AD-28).
        ci: absent("unconfirmed", NO_COLLECTOR),
        dependencies: fromLane(
          standing(UPDATE_PR_LANE, owner),
          "dependencies",
          ofKind("update_pr"),
        ),
        pulls: absent("unconfirmed", NO_COLLECTOR),
        issues: fromLane(
          standing(ISSUE_LANE, owner),
          "issues",
          ofKind("issue"),
        ),
        reviews: fromLane(reviews, "reviews", attention.openReviews),
      },
      sources,
    };
  };

  // Chips for every repository, quiet ones included: a quiet repository has
  // no row, but its chip states still say whether a topic was confirmed
  // anywhere, which is what the tile reads, and whether anything confirmed
  // the repository at all, which is what keeps it out of `quiet`.
  const chipsBySlug = new Map<string, Record<Topic, Chip>>();
  const judged: { row: BoardRow; first: QueueItem | null }[] = [];
  const quiet: string[] = [];
  const unconfirmed: string[] = [];
  for (const [slug, repo] of repos) {
    const attention = byRepo.get(slug);
    if (attention === undefined) continue;
    const { chips, sources } = chipsFor(repo, slug, attention);
    chipsBySlug.set(slug, chips);
    if (attention.tier === "quiet") {
      // Quiet is a finding. A repository nothing has confirmed has no
      // finding, and filing it under quiet would say "nothing pressing"
      // about something nobody has looked at (AD-28).
      (TOPICS.some((t) => confirmed(chips[t.topic]))
        ? quiet
        : unconfirmed
      ).push(slug);
      continue;
    }
    // The row is badged by the newest confirmation behind any chip it
    // shows a number on, judged on that confirmation's own cadence.
    const newest = sources.reduce<Source | null>(
      (best, s) =>
        best === null || s.verifiedAt.localeCompare(best.verifiedAt) > 0
          ? s
          : best,
      null,
    );
    judged.push({
      first: attention.first,
      row: {
        slug,
        tier: attention.tier,
        reason: attention.reason,
        chips,
        ...signalsOf(chips),
        freshness:
          newest === null
            ? "unknown"
            : freshness(newest.verifiedAt, now, newest.policy),
        age: ageLabel(newest?.verifiedAt ?? null, now),
      },
    });
  }

  // `now` before `soon`; within a tier, the chain order of the item that
  // gave the repository its tier, with rows lifted by a review alone after
  // every item-bearing row; then the slug, so ties never reshuffle.
  const TIER_INDEX: Record<Tier, number> = { now: 0, soon: 1, quiet: 2 };
  judged.sort((a, b) => {
    const byTier = TIER_INDEX[a.row.tier] - TIER_INDEX[b.row.tier];
    if (byTier !== 0) return byTier;
    if (a.first !== null && b.first !== null) {
      const byChain = compareRankings(a.first.ranking, b.first.ranking);
      if (byChain !== 0) return byChain;
    } else if (a.first !== null) {
      return -1;
    } else if (b.first !== null) {
      return 1;
    }
    return a.row.slug.localeCompare(b.row.slug);
  });
  const rows = judged.map((j) => j.row);

  // A tile sums the chips that carry a number, and its `now` marker counts
  // only items of repositories whose chip for the topic is a count: an item
  // no chip may count cannot be counted one level up either (AD-28). A
  // topic reads `unconfirmed` while no watched repository has a confirmed
  // chip for it: every CI and Pull requests tile today, and every tile
  // before the first sweep.
  const tiles: Tile[] = TOPICS.map(({ topic, label, kinds }) => {
    const chips = [...chipsBySlug.entries()].map(([slug, c]) => ({
      slug,
      chip: c[topic],
    }));
    if (!chips.some(({ chip }) => confirmed(chip))) {
      return {
        topic,
        label,
        href: topicPath(topic),
        count: "unconfirmed",
        nowCount: 0,
        reason:
          kinds.length === 0 && topic !== "reviews" ? NO_COLLECTOR : NO_SWEEP,
        warnings: warningsFor(topic, false),
      };
    }
    const countedSlugs = new Set(
      chips.filter(({ chip }) => chip.state === "count").map((c) => c.slug),
    );
    const nowCount = [...countedSlugs]
      .flatMap((slug) => byRepo.get(slug)?.items ?? [])
      .filter((item) => topicOf(item.kind) === topic)
      .filter((item) => tier(item.ranking, deps.cutRank) === "now").length;
    return {
      topic,
      label,
      href: topicPath(topic),
      count: chips.reduce((sum, { chip }) => sum + chip.count, 0),
      nowCount,
      reason: null,
      warnings: warningsFor(topic, true),
    };
  });

  return {
    summary: {
      watched: repos.size,
      now: rows.filter((r) => r.tier === "now").length,
      soon: rows.filter((r) => r.tier === "soon").length,
      quiet: quiet.length,
      unconfirmed: unconfirmed.length,
    },
    tiles,
    rows,
    quiet,
    unconfirmed,
    unreadable: queue.unreadable,
    collected,
    health,
  };
}
