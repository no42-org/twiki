/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { safeUrl } from "../../core/safe-url.js";
import { worstSeverity } from "../../core/severity.js";
import { foldSlug } from "../../core/slug.js";
import { topicOf } from "../../core/topics.js";
import type { Mode, RepoRef } from "../../core/types.js";
import {
  type BoardDeps,
  buildBoardWithSources,
  type Tile,
} from "../attention/board.js";
import { ageLabel } from "../attention/freshness.js";
import type { CollectionHealth } from "../attention/health.js";
import type { Queue, QueueItem } from "../attention/queue.js";
import type { ReleaseReading } from "../attention/release.js";
import type { StorePort } from "../store/port.js";
import { type MergeAction, mergeAction } from "./merge-action.js";
import { buildReviewView } from "./review-view.js";

// The overview's view model: three boxes and one table, built from the same
// readers every other surface uses, so it cannot disagree with them. Pure, so
// each row mapping can be tested without a server or a DOM.

export const GROUPS = ["SECURITY", "PULL REQUESTS", "RELEASE WORTHY"] as const;
export type Group = (typeof GROUPS)[number];

/** Highest first. The client sorts on these numbers, never on the word. */
const SEVERITY_RANK: Readonly<Record<string, number>> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

const SEVERITY_ORDER = [
  "CRITICAL",
  "HIGH",
  "MEDIUM",
  "LOW",
  "UNKNOWN",
  "UNGRADED",
];

const NO_CONFIRMATION = "no sweep has confirmed this";

const HOUR_MS = 3_600_000;
const DAY_HOURS = 24;

/** Upper bounds, in days, of the first four age steps. The fifth is the rest. */
const AGE_STEP_DAYS = [1, 4, 8, 31] as const;

export interface OverviewRow {
  key: string;
  group: Group;
  /** Upper case, or null where the item has no severity. */
  severity: string | null;
  severityRank: number | null;
  state: string;
  /** Folded `owner/name`, the filter value. */
  repo: string;
  /** What the table shows for `repo`, in the repository's own casing. */
  repoLabel: string;
  repoUrl: string | null;
  id: string;
  /** Where the ID leads, or null when no safe URL is known. */
  url: string | null;
  what: string;
  /** The row's merge icon. Null on rows that are not pull requests. */
  merge: MergeAction | null;
  /** Whole hours since the item opened, or null when unknown. */
  ageHours: number | null;
  /** 1 to 5, or 0 when the age is unknown. */
  ageStep: number;
  ageWords: string;
}

export interface OverviewBox {
  group: Group;
  /** Null when no sweep confirmed a number; `unconfirmed` says why not. */
  count: number | null;
  unconfirmed: string | null;
  breakdown: string;
  notes: string[];
  /** Something behind this box is unconfirmed, so the footer may not say all clear. */
  partial: boolean;
}

export interface OverviewHealth {
  allCurrent: boolean;
  /** The footer readout. */
  readout: string;
  /** The lower elbow's label. */
  status: string;
}

export interface Overview {
  boxes: OverviewBox[];
  rows: OverviewRow[];
  health: OverviewHealth;
}

export type OverviewDeps = BoardDeps;

/** The age parts of a row, from when the item opened. */
export function ageOf(
  openedAt: string | null | undefined,
  now: Date,
): Pick<OverviewRow, "ageHours" | "ageStep" | "ageWords"> {
  const opened = openedAt ? new Date(openedAt).getTime() : Number.NaN;
  // A date in the future is a wrong clock, and an age of nothing would read
  // as a brand-new item.
  if (Number.isNaN(opened) || opened > now.getTime()) {
    return { ageHours: null, ageStep: 0, ageWords: "unknown" };
  }
  const ageHours = Math.floor((now.getTime() - opened) / HOUR_MS);
  const days = Math.floor(ageHours / DAY_HOURS);
  const step = AGE_STEP_DAYS.findIndex((limit) => days < limit);
  return {
    ageHours,
    ageStep: step === -1 ? AGE_STEP_DAYS.length + 1 : step + 1,
    ageWords:
      ageHours < 1
        ? "under 1 hour"
        : days < 1
          ? plural(ageHours, "hour")
          : plural(days, "day"),
  };
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function sentence(parts: readonly (string | null)[]): string {
  return parts.filter((p) => p !== null).join(" ");
}

/** Which repositories have an open update PR for which package. */
function updatePrIndex(items: readonly QueueItem[]): Set<string> {
  const index = new Set<string>();
  for (const item of items) {
    if (item.kind === "update_pr" && item.packageName !== null) {
      index.add(`${foldSlug(item.repo)}|${item.packageName.toLowerCase()}`);
    }
  }
  return index;
}

function securityState(item: QueueItem, updatePrs: Set<string>): string {
  if (item.kind === "secret_scanning") return "ROTATE";
  if (item.kind !== "alert") return "OPEN";
  const name = item.packageName?.toLowerCase();
  if (name !== undefined && updatePrs.has(`${foldSlug(item.repo)}|${name}`)) {
    return "UPDATE PR";
  }
  const patched = item.dependency?.firstPatchedVersion;
  if (patched === undefined) return "OPEN";
  return patched === null ? "NO FIX" : "FIX AVAILABLE";
}

function dependencyWords(item: QueueItem): string {
  const direct = item.dependency?.relationship === "direct";
  const scope = item.dependency?.scope;
  if (scope === "development") {
    return direct ? "Direct dev dependency only." : "Dev dependency only.";
  }
  if (scope === "runtime") {
    return direct ? "Direct runtime dependency." : "Runtime dependency.";
  }
  return "Dependency scope unknown.";
}

function kevWords(item: QueueItem, queue: Queue): string {
  if (item.kevListed) return "Known exploited.";
  return queue.kev.usable ? "Not in CISA KEV." : "KEV status unknown.";
}

function securityWhat(item: QueueItem, queue: Queue): string {
  if (item.kind === "secret_scanning") {
    return `${item.title ?? "Secret"} exposed. Rotate the credential.`;
  }
  if (item.kind === "code_scanning") {
    return `Code scanning finding: ${item.title ?? "unnamed rule"}.`;
  }
  const patched = item.dependency?.firstPatchedVersion;
  return sentence([
    `${item.packageName ?? "Unnamed package"}${item.advisory === null ? "" : ` (${item.advisory})`}.`,
    dependencyWords(item),
    kevWords(item, queue),
    patched ? `Fix in ${patched}.` : null,
  ]);
}

function repoParts(repo: string): Pick<OverviewRow, "repo" | "repoUrl"> {
  return {
    repo: foldSlug(repo),
    repoUrl: safeUrl(`https://github.com/${repo}`),
  };
}

function nameOf(repo: string): string {
  return repo.slice(repo.indexOf("/") + 1);
}

function securityRow(
  item: QueueItem,
  queue: Queue,
  updatePrs: Set<string>,
  now: Date,
): OverviewRow {
  const severity =
    item.displaySeverity === null || item.displaySeverity === "n/a"
      ? null
      : item.displaySeverity.toUpperCase();
  return {
    key: item.key,
    group: "SECURITY",
    severity,
    severityRank: severity === null ? null : (SEVERITY_RANK[severity] ?? null),
    state: securityState(item, updatePrs),
    ...repoParts(item.repo),
    repoLabel: nameOf(item.repo),
    id: `#${item.number}`,
    url: item.htmlUrl,
    what: securityWhat(item, queue),
    merge: null,
    ...ageOf(item.openedAt, now),
  };
}

function pullRow(
  item: QueueItem,
  state: string,
  what: string,
  merge: MergeAction,
  now: Date,
): OverviewRow {
  return {
    key: item.key,
    group: "PULL REQUESTS",
    severity: null,
    severityRank: null,
    state,
    ...repoParts(item.repo),
    repoLabel: nameOf(item.repo),
    id: `#${item.number}`,
    url: item.htmlUrl,
    what,
    merge,
    ...ageOf(item.openedAt, now),
  };
}

function failingWhat(item: QueueItem): string {
  return item.kind === "update_pr"
    ? `Update ${item.packageName ?? "of a dependency"} is stuck: ${item.explanation}.`
    : `${item.title ?? "Pull request"}. Checks failing.`;
}

function readyWhat(item: QueueItem): string {
  return item.kind === "update_pr"
    ? `Update ${item.packageName ?? "of a dependency"}. Checks passed.`
    : `${item.title ?? "Pull request"}. Checks passed.`;
}

function releaseRow(
  repo: RepoRef,
  reading: Extract<ReleaseReading, { state: "confirmed" }>,
  now: Date,
): OverviewRow {
  const { verdict, tagDate } = reading;
  const slug = `${repo.owner}/${repo.name}`;
  const fixes = verdict.securityFixes;
  const worst = worstSeverity(fixes.map((a) => a.severity));
  const severity = worst === null ? null : worst.toUpperCase();
  const since =
    verdict.tag === null ? "with no tag yet" : `since ${verdict.tag}`;
  const kinds = ["breaking", "feat", "fix", "perf"]
    .map((kind) => ({
      kind,
      n: verdict.improvements.filter((c) => c.kind === kind).length,
    }))
    .filter(({ n }) => n > 0)
    .map(({ kind, n }) => `${n} ${kind}`);
  const changes = verdict.improvements.length;
  return {
    key: `release:${slug}`,
    group: "RELEASE WORTHY",
    severity,
    severityRank: severity === null ? null : (SEVERITY_RANK[severity] ?? null),
    state: fixes.length > 0 ? "SECURITY FIX" : "CHANGES",
    ...repoParts(slug),
    repoLabel: repo.name,
    id: verdict.tag ?? "no tag",
    url: safeUrl(
      verdict.tag === null
        ? `https://github.com/${slug}/commits`
        : `https://github.com/${slug}/compare/${encodeURIComponent(verdict.tag)}...HEAD`,
    ),
    what: sentence([
      fixes.length > 0
        ? `${plural(fixes.length, "security alert")} fixed ${since}.`
        : null,
      changes > 0
        ? `${plural(changes, "change")} ${since}: ${kinds.join(", ")}.`
        : null,
    ]),
    merge: null,
    ...ageOf(tagDate, now),
  };
}

function tally(
  rows: readonly OverviewRow[],
  label: (r: OverviewRow) => string,
  order: readonly string[],
): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(label(row), (counts.get(label(row)) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort(([a], [b]) => order.indexOf(a) - order.indexOf(b))
    .map(([word, n]) => `${n} ${word}`)
    .join(" / ");
}

/** One lane a box stands on, and what it says about itself. */
interface BoxSource {
  confirmed: boolean;
  word: string;
  reason: string;
  warnings: readonly string[];
}

function tileSource(tile: Tile | undefined): BoxSource {
  return {
    confirmed: typeof tile?.count === "number",
    word: (typeof tile?.count === "string"
      ? tile.count
      : "unconfirmed"
    ).toUpperCase(),
    reason: tile?.reason ?? NO_CONFIRMATION,
    warnings: tile?.warnings ?? [],
  };
}

/**
 * A box's number, or the reason it has none: absence is never a zero (AD-28).
 * With rows to show, the rows are the number and a gap goes beside it, so a
 * box never says unconfirmed above items listed under it.
 */
function boxFrom(
  group: Group,
  rows: readonly OverviewRow[],
  breakdown: string,
  sources: readonly BoxSource[],
  extra: readonly string[] = [],
): OverviewBox {
  const gaps = sources.filter((source) => !source.confirmed);
  const warnings = sources.flatMap((source) => source.warnings);
  const first = gaps[0];
  if (rows.length === 0 && first !== undefined) {
    return {
      group,
      count: null,
      unconfirmed: first.word,
      breakdown: first.reason,
      notes: [...warnings, ...extra],
      partial: true,
    };
  }
  return {
    group,
    count: rows.length,
    unconfirmed: null,
    breakdown,
    notes: [...gaps.map((gap) => gap.reason), ...warnings, ...extra],
    partial: gaps.length > 0 || extra.length > 0,
  };
}

function releaseBox(
  rows: readonly OverviewRow[],
  readings: ReadonlyMap<string, ReleaseReading>,
): OverviewBox {
  const group = "RELEASE WORTHY";
  const known = [...readings.values()];
  const open = known.filter(
    (r): r is Extract<ReleaseReading, { state: "unconfirmed" }> =>
      r.state === "unconfirmed",
  );
  const breakdown = tally(
    rows,
    (r) => (r.state === "CHANGES" ? "CHANGES" : "SECURITY"),
    ["SECURITY", "CHANGES"],
  );
  if (open.length > 0 && !known.some((r) => r.state === "confirmed")) {
    return {
      group,
      count: null,
      unconfirmed: "UNCONFIRMED",
      breakdown: open[0]?.reason ?? "",
      notes: [],
      partial: true,
    };
  }
  return {
    group,
    count: rows.length,
    unconfirmed: null,
    breakdown,
    notes: open.length > 0 ? [`${open.length} unconfirmed`] : [],
    partial: open.length > 0,
  };
}

function healthOf(
  health: readonly CollectionHealth[],
  newestAge: string | null,
  boxes: readonly OverviewBox[],
  redBranches: readonly string[],
): OverviewHealth {
  if (health.length === 0) {
    return {
      allCurrent: false,
      readout: "NOTHING COLLECTED YET",
      status: "NO DATA",
    };
  }
  const behind = [
    ...new Set(
      health
        .filter(
          (h) =>
            h.freshness !== "fresh" ||
            (h.outcome !== "ok" && h.outcome !== "running"),
        )
        .map((h) => h.lane),
    ),
  ];
  // A lane that has never run has no health row, so its box is the only sign.
  const waiting = boxes.filter((box) => box.partial);
  const problems = [
    // Not a box of its own, and it tops the ranking chain, so it may not sit
    // behind an all-clear.
    redBranches.length > 0
      ? `RED DEFAULT BRANCH: ${redBranches.join(", ")}`
      : null,
    behind.length > 0 ? `LANES NOT CURRENT: ${behind.join(", ")}` : null,
    waiting.length > 0
      ? `NOT CONFIRMED: ${waiting.map((box) => box.group).join(", ")}`
      : null,
  ].filter((problem) => problem !== null);
  if (problems.length > 0) {
    return {
      allCurrent: false,
      readout: problems.join(" // "),
      status: redBranches.length > 0 ? "RED MAIN" : "CHECK LANES",
    };
  }
  return {
    allCurrent: true,
    readout: `ALL LANES CURRENT // LAST SWEEP ${newestAge ?? "UNKNOWN"}`,
    status: "SYS OK",
  };
}

export function buildOverview(
  store: StorePort,
  watched: readonly RepoRef[],
  now: Date,
  deps: OverviewDeps,
  merge: { mode: Mode; configured: boolean },
): Overview {
  const board = buildBoardWithSources(store, watched, now, deps);
  const reviews = buildReviewView(store, watched, now, deps.policy);
  const { items, queue, release, scopedHealth } = board;

  const updatePrs = updatePrIndex(items);
  const security = items
    .filter((item) => topicOf(item.kind) === "security")
    .map((item) => securityRow(item, queue, updatePrs, now));

  // `items` only holds repositories on the allowlist: the board filters the
  // queue to them at src/tricorder/attention/board.ts:565.
  const itemAction = (item: QueueItem) =>
    mergeAction({ ...merge, watched: true, facts: item.merge });
  const failing = items
    .filter((item) => item.stuck)
    .map((item) =>
      pullRow(item, "FAILING", failingWhat(item), itemAction(item), now),
    );
  // One pull request, one row: a failing one that also waits on your review
  // says so in its sentence rather than counting twice.
  const failingByPull = new Map(
    failing.map((row) => [`${row.repo}${row.id}`, row]),
  );
  const unasked = reviews.rows.filter((r) => {
    const row = failingByPull.get(`${foldSlug(r.repo)}#${r.number}`);
    if (row !== undefined) row.what = `${row.what} Your review requested.`;
    return row === undefined;
  });
  const pullKey = (repo: string, number: number) =>
    `${foldSlug(repo)}#${number}`;
  const pullsByKey = new Map(
    items
      .filter((item) => item.merge !== null)
      .map((item) => [pullKey(item.repo, item.number), item]),
  );
  const asked = unasked.map(
    (r): OverviewRow => ({
      key: `review:${r.key}`,
      group: "PULL REQUESTS",
      severity: null,
      severityRank: null,
      state: "REVIEW",
      ...repoParts(r.repo),
      // Requests land outside the allowlist, where the name alone may not
      // say whose repository it is.
      repoLabel: r.watched ? nameOf(r.repo) : r.repo,
      id: `#${r.number}`,
      url: r.htmlUrl,
      what: `${r.title}. Your review requested.`,
      // A request outside the allowlist has no queue item.
      merge: mergeAction({
        ...merge,
        watched: r.watched,
        facts: pullsByKey.get(pullKey(r.repo, r.number))?.merge ?? null,
      }),
      ...ageOf(r.createdAt, now),
    }),
  );
  // Also one row per pull request: a request is the stronger ask.
  const requested = new Set(reviews.rows.map((r) => pullKey(r.repo, r.number)));
  const ready = items
    .filter(
      (item) =>
        !item.stuck &&
        item.merge?.checks === "passed" &&
        !requested.has(pullKey(item.repo, item.number)),
    )
    .map((item) =>
      pullRow(item, "READY", readyWhat(item), itemAction(item), now),
    );
  const pulls = [...failing, ...asked, ...ready];

  const repos = new Map(
    watched.map((r) => [foldSlug(`${r.owner}/${r.name}`), r]),
  );
  const releases: OverviewRow[] = [];
  for (const [slug, reading] of release) {
    const repo = repos.get(slug);
    if (
      repo !== undefined &&
      reading.state === "confirmed" &&
      reading.verdict.ready
    ) {
      releases.push(releaseRow(repo, reading, now));
    }
  }

  const tileOf = (topic: Tile["topic"]) =>
    board.tiles.find((t) => t.topic === topic);
  const newest = store
    .latestRunPerKey()
    .map((r) => r.verifiedAt)
    .sort()
    .at(-1);

  const reviewSource: BoxSource = {
    confirmed: reviews.attested,
    word: "UNCONFIRMED",
    reason: "review requests not confirmed by a completed sweep",
    warnings: [],
  };
  const unconfirmedRepos = board.unconfirmed.length;
  const boxes = [
    boxFrom(
      "SECURITY",
      security,
      tally(security, (r) => r.severity ?? "UNGRADED", SEVERITY_ORDER),
      [tileSource(tileOf("security"))],
      [
        ...(unconfirmedRepos > 0
          ? [
              `${unconfirmedRepos} ${unconfirmedRepos === 1 ? "repository" : "repositories"} not confirmed`,
            ]
          : []),
        ...(board.unreadable > 0
          ? [`${plural(board.unreadable, "row")} could not be read`]
          : []),
      ],
    ),
    boxFrom(
      "PULL REQUESTS",
      pulls,
      tally(pulls, (r) => r.state, ["FAILING", "REVIEW", "READY"]),
      [
        tileSource(tileOf("pulls")),
        tileSource(tileOf("dependencies")),
        reviewSource,
      ],
      reviews.unreadable > 0
        ? [`${plural(reviews.unreadable, "review row")} could not be read`]
        : [],
    ),
    releaseBox(releases, release),
  ];

  return {
    boxes,
    rows: [...security, ...pulls, ...releases],
    health: healthOf(
      scopedHealth,
      newest === undefined ? null : ageLabel(newest, now).toUpperCase(),
      boxes,
      [
        ...new Set(
          items
            .filter((item) => item.kind === "ci_failure")
            .map((item) => nameOf(item.repo)),
        ),
      ],
    ),
  };
}
