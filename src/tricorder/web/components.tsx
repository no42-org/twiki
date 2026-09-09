/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

/* biome-ignore-all lint/a11y/noRedundantRoles: the table roles are implied by the elements at desktop width only; the phone cards restyle them to `display: block`, and a browser then drops the implied role. Stating it survives that (EXPERIENCE.md Accessibility Floor). */

import type { Child, FC, PropsWithChildren } from "hono/jsx";
import { joinNotes } from "../../core/coverage.js";
import { isBrokenVerdict, type RunVerdict } from "../../core/run-verdict.js";
import { safeUrl } from "../../core/safe-url.js";
import { foldSlug } from "../../core/slug.js";
import type { Tier } from "../../core/tier.js";
import { TOPICS, type Topic, topicOf } from "../../core/topics.js";
import type { SectionState } from "../attention/attestation.js";
import {
  type Board,
  type BoardRow,
  type Chip,
  chipText,
  type Tile,
} from "../attention/board.js";
import type { FilteredQueue, QueueFilter } from "../attention/filter.js";
import type { Freshness } from "../attention/freshness.js";
import type { CollectionHealth, HealthOutcome } from "../attention/health.js";
import {
  overviewPath,
  queueClearPath,
  queuePath,
  queueRepoPath,
  repoPath,
  reviewsPath,
} from "../attention/links.js";
import type { Queue, QueueItem } from "../attention/queue.js";
import type { RepoView } from "./repo-view.js";
import type { ReviewView } from "./review-view.js";
import {
  overviewTitle,
  queueTitle,
  repoTitle,
  reviewsTitle,
  unknownRepoTitle,
} from "./titles.js";
import { RADIUS, SPACE, TOKEN_STYLE, TYPE } from "./tokens.js";

// Server-rendered tables. There is no client-side interactivity layer in this
// build, deliberately: nothing here needs partial updates.
//
// Colors, sizes and spacing come from tokens.ts. Rules here name tokens only,
// so the contrast test in test/tokens.test.ts covers every text color the page
// can paint, including muted text over the hatch stripes. The one painted
// color in no pair is the border rule, which is decorative. No hex, no px for
// text, no shadow: the dashboard is an instrument.

export const STYLE = `${TOKEN_STYLE}
  @supports (font: -apple-system-body) { @media (hover: none) and (pointer: coarse) { html { font: -apple-system-body; } } }
  body { font-family: system-ui, sans-serif; font-size: ${TYPE.body.size}; line-height: ${TYPE.body.lineHeight}; color: var(--fg); background: var(--bg); margin: ${SPACE[8]} auto; max-width: ${SPACE.contentMax}; padding: 0 ${SPACE.gutter}; overflow-wrap: anywhere; }
  a { color: var(--link); }
  :focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }
  h1 { font-size: ${TYPE.title.size}; font-weight: ${TYPE.title.weight}; line-height: ${TYPE.title.lineHeight}; margin-bottom: ${SPACE[1]}; }
  h2 { font-size: ${TYPE.section.size}; font-weight: ${TYPE.section.weight}; line-height: ${TYPE.section.lineHeight}; margin-top: ${SPACE[8]}; }
  .sub { color: var(--muted); margin-top: 0; font-size: ${TYPE.small.size}; line-height: ${TYPE.small.lineHeight}; }
  table { border-collapse: collapse; width: 100%; margin: ${SPACE[6]} 0; }
  th, td { text-align: left; padding: ${SPACE[2]} ${SPACE[3]}; border-bottom: 1px solid var(--border); }
  th { font-size: ${TYPE.label.size}; font-weight: ${TYPE.label.weight}; line-height: ${TYPE.label.lineHeight}; letter-spacing: ${TYPE.label.tracking}; text-transform: uppercase; color: var(--muted); }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .badge { display: inline-block; font-size: ${TYPE.small.size}; line-height: ${TYPE.small.lineHeight}; padding: ${SPACE[1]} ${SPACE[2]}; border-radius: ${RADIUS.full}; border: 1px solid currentColor; }
  .fresh   { color: var(--ok); }
  .stale   { color: var(--warn); }
  .badge.stale { font-weight: 600; }
  .unknown { color: var(--muted); background: repeating-linear-gradient(45deg, var(--hatch) 0 4px, transparent 4px 8px); }
  .none  { color: var(--ok); }
  .ok    { color: var(--ok); }
  .crit  { color: var(--critical); }
  .never { color: var(--muted); font-style: italic; }
  .uncovered { color: var(--warn); font-style: italic; text-decoration: underline dotted; }
  .why { color: var(--muted); font-size: ${TYPE.small.size}; }
  .failed { color: var(--critical); font-weight: 600; }
  .partial { color: var(--warn); font-weight: 600; }
  .stalled { color: var(--critical); font-weight: 600; }
  .running { color: var(--muted); }
  .why-rank { color: var(--muted); font-size: ${TYPE.small.size}; }
  .kev-hit { color: var(--critical); font-weight: 700; }
  .policy-note { color: var(--muted); font-size: ${TYPE.small.size}; margin-top: ${SPACE[8]}; }
  .tier { display: inline-block; font-size: ${TYPE.small.size}; font-weight: 600; line-height: ${TYPE.small.lineHeight}; padding: ${SPACE[1]} ${SPACE[2]}; border-radius: ${RADIUS.full}; border: 1px solid transparent; vertical-align: middle; }
  .tier.now { color: var(--critical); background: var(--critical-tint); }
  .tier.soon { color: var(--warn); background: var(--warn-tint); }
  .tier.quiet { color: var(--muted); border-color: var(--border); }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
  .skip { position: absolute; top: 0; left: 0; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .skip:focus { left: ${SPACE.gutter}; width: auto; height: auto; overflow: visible; clip: auto; padding: ${SPACE[2]} ${SPACE[3]}; background: var(--surface); z-index: 2; }
  .lbl { display: none; }
  .lbl.hid { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); border: 0; }
  nav { margin-bottom: ${SPACE[4]}; font-size: ${TYPE.small.size}; }
  nav a { margin-right: ${SPACE[4]}; }
  nav.primary { display: flex; flex-wrap: wrap; align-items: center; min-height: ${SPACE.navHeight}; background: var(--surface); border-bottom: 1px solid var(--border); }
  nav.primary a[aria-current] { color: var(--fg); text-decoration: none; border-bottom: 2px solid var(--link); }
  .rendered { margin-left: auto; color: var(--muted); }
  @media (max-width: 639px) { nav.primary { position: sticky; top: 0; z-index: 1; margin: 0 -${SPACE.gutter}; padding: 0 ${SPACE.gutter}; } .rendered { flex-basis: 100%; } html { scroll-padding-top: calc(2 * ${SPACE.navHeight}); } }
  .tiles { display: grid; grid-template-columns: repeat(6, minmax(min-content, 1fr)); gap: ${SPACE[3]}; margin: ${SPACE[4]} 0 ${SPACE[6]}; }
  .tile { display: block; background: var(--surface); border: 1px solid var(--border); border-radius: ${RADIUS.md}; padding: ${SPACE[3]}; text-decoration: none; color: var(--fg); }
  .count { display: block; font-size: ${TYPE.count.size}; font-weight: ${TYPE.count.weight}; line-height: ${TYPE.count.lineHeight}; font-variant-numeric: tabular-nums; margin-bottom: ${SPACE[2]}; }
  .count.critical { color: var(--critical); }
  .count.unconfirmed { color: var(--muted); font-style: italic; }
  .now-marker { font-size: ${TYPE.label.size}; font-weight: ${TYPE.label.weight}; line-height: ${TYPE.label.lineHeight}; letter-spacing: ${TYPE.label.tracking}; color: var(--critical); }
  .label { display: block; font-size: ${TYPE.label.size}; font-weight: ${TYPE.label.weight}; line-height: ${TYPE.label.lineHeight}; letter-spacing: ${TYPE.label.tracking}; text-transform: uppercase; color: var(--link); text-decoration: underline; }
  .board tbody td, .board tbody th { border-bottom: 0; }
  .board tbody { border-bottom: 1px solid var(--border); }
  .board tr.repo td:first-child { padding-left: 9px; }
  .board tr.why th { padding: 0; width: 0; }
  .board tr.why td { padding: 0 ${SPACE[3]} ${SPACE[3]} 9px; }
  tbody.now tr.repo td:first-child { border-left: 3px solid var(--critical); }
  tbody.soon tr.repo td:first-child { border-left: 3px solid var(--warn); }
  tbody.now tr.why th { border-left: 3px solid var(--critical); }
  tbody.soon tr.why th { border-left: 3px solid var(--warn); }
  .board .signals, .signals-rest { display: none; }
  .slug { font-weight: 600; }
  .chip { display: inline-block; min-width: 24px; min-height: 24px; box-sizing: border-box; padding: 3px 6px; border-radius: ${RADIUS.sm}; font-size: ${TYPE.small.size}; line-height: ${TYPE.small.lineHeight}; font-variant-numeric: tabular-nums; }
  .chip.zero { color: var(--muted); }
  .chip.critical { color: var(--critical); font-weight: 700; }
  .chip.high { color: var(--high); font-weight: 400; }
  .chip.uncovered { color: var(--warn); font-style: normal; text-decoration: underline dotted; }
  .chip.unconfirmed { color: var(--muted); font-style: italic; }
  .attest { color: var(--muted); font-size: ${TYPE.small.size}; line-height: ${TYPE.small.lineHeight}; font-style: italic; margin: ${SPACE[2]} 0 0; }
  .attest.warn { color: var(--warn); }
  .shown { color: var(--muted); font-size: ${TYPE.small.size}; font-weight: 400; line-height: ${TYPE.small.lineHeight}; }
  .crumb { color: var(--muted); font-size: ${TYPE.small.size}; margin-bottom: ${SPACE[2]}; }
  .crumb a { margin-right: 0; }
  .legend { color: var(--muted); font-size: ${TYPE.small.size}; line-height: ${TYPE.small.lineHeight}; margin: 0; }
  .quiet { background: var(--surface); border: 1px solid var(--border); border-radius: ${RADIUS.md}; padding: ${SPACE[3]} ${SPACE[4]}; margin-top: ${SPACE[6]}; }
  .quiet summary { font-weight: 600; }
  .quiet p { margin: ${SPACE[2]} 0 0; font-size: ${TYPE.small.size}; line-height: 1.8; }
  .quiet a { margin-right: ${SPACE[3]}; }
  .filters { display: flex; flex-wrap: wrap; gap: ${SPACE[4]}; margin: ${SPACE[4]} 0 ${SPACE[2]}; font-size: ${TYPE.small.size}; line-height: ${TYPE.small.lineHeight}; }
  .filters a { display: inline-block; min-width: 24px; min-height: 24px; box-sizing: border-box; margin: 0; padding: ${SPACE[1]}; text-align: center; text-decoration: none; border-bottom: 2px solid transparent; }
  .filters a[aria-current] { color: var(--fg); border-bottom-color: var(--link); }
  .filter-state { margin: 0 0 ${SPACE[2]}; }
  .topic { font-size: ${TYPE.label.size}; font-weight: ${TYPE.label.weight}; line-height: ${TYPE.label.lineHeight}; letter-spacing: ${TYPE.label.tracking}; text-transform: uppercase; color: var(--muted); }
  @media (max-width: 639px) {
    .tiles { grid-template-columns: repeat(2, 1fr); }
    .count.unconfirmed, .count.never { font-size: ${TYPE.small.size}; line-height: ${TYPE.small.lineHeight}; }
    table.cards, table.cards tbody, table.cards tr, table.cards td { display: block; }
    table.cards thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    table.cards tr { border-bottom: 1px solid var(--border); padding: ${SPACE[3]} 0; }
    table.cards td { border: 0; padding: 2px 0; text-align: left; }
    table.cards .lbl { display: inline; font-size: ${TYPE.label.size}; font-weight: ${TYPE.label.weight}; line-height: ${TYPE.label.lineHeight}; letter-spacing: ${TYPE.label.tracking}; text-transform: uppercase; color: var(--muted); margin-right: ${SPACE[1]}; }
    .board tbody { padding: ${SPACE[3]} 0; }
    .board tbody.now { border-left: 3px solid var(--critical); padding-left: ${SPACE[3]}; }
    .board tbody.soon { border-left: 3px solid var(--warn); padding-left: ${SPACE[3]}; }
    table.board tr { border: 0; padding: 0; }
    .board tbody tr.repo td:first-child { border-left: 0; padding-left: 0; }
    .board tr.repo { display: flex; flex-wrap: wrap; gap: ${SPACE[2]}; align-items: baseline; }
    .board tr.repo td { padding: 0; }
    .board td.slug-cell { flex: 1 1 calc(100% - 6rem); }
    .board td.fresh-cell { flex-basis: 100%; }
    .board tr.why th { display: block; border-left: 0; }
    .board tr.why td { padding: ${SPACE[2]} 0 0; }
  }
  @media (min-width: 640px) and (max-width: 1023px) {
    .tiles { grid-template-columns: repeat(3, 1fr); }
    .board .c { display: none; }
    .board .signals { display: table-cell; }
    .signals-rest { display: inline; }
  }
`;

/**
 * Outcome word to style class, spelled out per outcome so a new member of
 * HealthOutcome fails to compile here rather than rendering unstyled. Running
 * stays muted on purpose: every tick shows a running lane, and amber on the
 * normal state would train the reader to ignore amber.
 */
const OUTCOME_CLASS: Readonly<Record<HealthOutcome, string>> = {
  ok: "ok",
  partial: "partial",
  failed: "failed",
  running: "running",
  stalled: "stalled",
};

/** Heading label per topic. TOPICS is exhaustive over Topic, so no fallback. */
const TOPIC_LABEL: Readonly<Record<Topic, string>> = Object.fromEntries(
  TOPICS.map((t) => [t.topic, t.label]),
) as Record<Topic, string>;

// Every table on these pages is one markup for every width. Under 640px CSS
// restyles it into stacked cards, and a browser that sees `display: block`
// on a table drops its semantics, so every part states its role outright
// and every cell carries its header word: painted on the card where the
// value alone would be a bare number, visually hidden where the value says
// what it is (EXPERIENCE.md Accessibility Floor). The two helpers below are
// the only way a header or a data cell is written, so no cell can miss its
// role or its label.

const Th: FC<PropsWithChildren<{ class?: string; colspan?: number }>> = ({
  class: cls,
  colspan,
  children,
}) => (
  <th class={cls} colspan={colspan} scope="col" role="columnheader">
    {children}
  </th>
);

/**
 * One data cell. `label` is the column's header text; `show` paints it on
 * the phone card, otherwise it is there for a screen reader only.
 */
const Td: FC<
  PropsWithChildren<{
    label: string;
    show?: boolean;
    class?: string;
    colspan?: number;
  }>
> = ({ label, show = false, class: cls, colspan, children }) => (
  <td class={cls} colspan={colspan} role="cell">
    <span class={show ? "lbl" : "lbl hid"}>{label}</span>
    {children}
  </td>
);

/**
 * Every link that leaves gitricorder.
 *
 * The maintainer acts on GitHub and comes back; a link that replaced this tab
 * would lose the page and its scroll position on every item. So: a new tab,
 * no opener, a visible marker joined to the text by a narrow no-break space
 * (U+202F, which cannot break, so no wrapper rule is needed), and a spoken
 * suffix so a screen reader hears where the link goes. The href goes through
 * safeUrl here, so a caller passes whatever the store holds and gets plain
 * text back when it is not a GitHub URL. Nothing else writes `<a target>`
 * (AD-40).
 */
export const ExternalLink: FC<
  PropsWithChildren<{ href: string | null | undefined }>
> = ({ href, children }) => {
  const safe = safeUrl(href);
  if (safe === null) {
    return <>{children}</>;
  }
  return (
    <a href={safe} target="_blank" rel="noopener noreferrer">
      {children}
      <span class="ext" aria-hidden="true">
        {"\u202F\u2197"}
      </span>
      <span class="sr-only">, opens GitHub in a new tab</span>
    </a>
  );
};

/**
 * The attention tier as a pill: always a word plus a color, never a color
 * alone. `now` and `soon` sit on their tint; `quiet` is ringed, because a
 * wash on the normal state would train the reader to ignore washes. The
 * hidden prefix gives a screen reader the noun the sighted reader gets from
 * position (AD-29).
 */
export const TierChip: FC<{ tier: Tier }> = ({ tier }) => (
  <span class={`tier ${tier}`}>
    <span class="sr-only">attention tier: </span>
    {tier}
  </span>
);

export const FreshnessBadge: FC<{ freshness: Freshness; age: string }> = ({
  freshness,
  age,
}) => (
  <span class={`badge ${freshness}`} title={age}>
    {freshness === "unknown" ? "never collected" : `${freshness} · ${age}`}
  </span>
);

/**
 * One count chip (AD-35).
 *
 * Four states, each a word plus a color, none mistakable for another: a
 * confirmed zero is muted, a count carries its worst severity in weight, a
 * topic GitHub is not watching reads `not covered`, and a topic no completed
 * sweep confirmed reads `unconfirmed`, never `0` (AD-28). Only a count is a
 * link, and a linked chip is at least 24px square. The signals cell passes
 * its own `text`, the same words with the topic in front.
 */
const CountChip: FC<{ chip: Chip; text?: string }> = ({
  chip,
  text = chipText(chip),
}) => {
  switch (chip.state) {
    case "not-covered":
      return (
        <span class="chip uncovered" title={chip.reason ?? undefined}>
          {text}
        </span>
      );
    case "unconfirmed":
      return (
        <span class="chip unconfirmed" title={chip.reason ?? undefined}>
          {text}
        </span>
      );
    case "zero":
      return <span class="chip zero">{text}</span>;
    case "count": {
      const weight =
        chip.severity === "critical"
          ? " critical"
          : chip.severity === "high"
            ? " high"
            : "";
      return chip.href === null ? (
        <span class={`chip${weight}`}>{text}</span>
      ) : (
        <a class={`chip${weight}`} href={chip.href}>
          {text}
        </a>
      );
    }
  }
};

/**
 * A lane of this tile's topic failed or stalled, so the count is a lower
 * bound. Said on the tile, where the reader looks, and not only in the
 * health table at the foot of the page (#127).
 */
const TileWarnings: FC<{ tile: Tile }> = ({ tile }) => (
  <>
    {tile.warnings.map((line) => (
      <p key={line} class="attest warn">
        {line}
      </p>
    ))}
  </>
);

/**
 * One topic tile. The count turns critical, with a `· N now` marker, only
 * when an item of this topic put a repository in `now`. A topic no sweep has
 * confirmed reads `unconfirmed` in the count's place, says which absence
 * that is, and is not a link: the filter behind it has nothing to show.
 * Before the first completed sweep every tile reads `never collected`; the
 * note under the board says where to look.
 */
const TopicTile: FC<{ tile: Tile }> = ({ tile }) =>
  // A div rather than a span for the non-link tile: the warning lines are
  // paragraphs, which phrasing content may not hold.
  tile.count === "never collected" ? (
    <div class="tile">
      <span class="count never">never collected</span>
      <span class="label">{tile.label}</span>
      <TileWarnings tile={tile} />
    </div>
  ) : tile.count === "unconfirmed" ? (
    <div class="tile">
      <span class="count unconfirmed">unconfirmed</span>
      <span class="label">{tile.label}</span>
      <span class="attest">{tile.reason}</span>
      <TileWarnings tile={tile} />
    </div>
  ) : (
    <a class="tile" href={tile.href}>
      {tile.nowCount > 0 ? (
        <span class="count critical">
          {tile.count} <span class="now-marker">· {tile.nowCount} now</span>
        </span>
      ) : (
        <span class="count">{tile.count}</span>
      )}
      <span class="label">{tile.label}</span>
      <TileWarnings tile={tile} />
    </a>
  );

/**
 * Rows the store holds but nothing could read. One sentence for every page
 * that shows counts, so the overview and the queue cannot word the same
 * gap two ways: a count over unreadable rows is a lower bound, and the
 * page must say so before it says anything is quiet (AD-28).
 */
const UnreadableNote: FC<{ count: number }> = ({ count }) =>
  count > 0 ? (
    <p class="failed">
      {count} stored {count === 1 ? "item" : "items"} could not be read and{" "}
      {count === 1 ? "is" : "are"} not shown. This list is incomplete.
    </p>
  ) : null;

/**
 * The one page shell.
 *
 * Both pages used to carry their own copy of the html/head/nav chrome, which
 * meant a nav link or a meta fix had to land twice and a missed copy shipped
 * divergent pages. The content is the `main` landmark and the page's policy
 * note is a `footer` outside it, so a screen reader finds the caveat as
 * `contentinfo` rather than as content.
 *
 * The skip links come first in the body, so they are the first Tab stops.
 * On the overview each targets a block heading the page already labels;
 * elsewhere the one link targets the named list region. Never the top of
 * `main`: a keyboard user passes a 100-row board in one keystroke. The nav
 * is the `navigation` landmark named "primary", marks the current page, and
 * carries the rendered-at time as text, once per page. Under 640px it
 * sticks, the time takes its own row so the bar is always two rows, and
 * `html { scroll-padding-top }` is set to twice the row height, since
 * without script nothing can measure the bar (DESIGN.md).
 */
const Layout: FC<
  PropsWithChildren<{
    title: string;
    /** Which nav link is this page. A repo page is none of them. */
    current: "overview" | "queue" | "reviews" | null;
    generatedAt: string;
    skips: readonly { href: string; label: string }[];
    footer?: string;
  }>
> = ({ title, current, generatedAt, skips, footer, children }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <style>{STYLE}</style>
    </head>
    <body>
      {skips.map((skip) => (
        <a key={skip.href} class="skip" href={skip.href}>
          {skip.label}
        </a>
      ))}
      <nav class="primary" aria-label="primary">
        <a
          href={overviewPath()}
          aria-current={current === "overview" ? "page" : undefined}
        >
          overview
        </a>
        <a
          href={queueClearPath()}
          aria-current={current === "queue" ? "page" : undefined}
        >
          queue
        </a>
        <a
          href={reviewsPath()}
          aria-current={current === "reviews" ? "page" : undefined}
        >
          reviews
        </a>
        <span class="rendered">
          rendered <time datetime={generatedAt}>{generatedAt}</time>
        </span>
      </nav>
      <main id="main">{children}</main>
      {footer === undefined ? null : (
        <footer class="policy-note">{footer}</footer>
      )}
    </body>
  </html>
);

/**
 * The overview's policy note. Tiers are buckets over the queue's order, so
 * the note names the same local policy the queue does: a reader must not
 * take `now` for a standard's verdict any more than a rank.
 */
/**
 * The chain in the reader's words, and all six terms of it: a note that
 * lists five invites exactly the belief the ranking module's own comment
 * warns about, that the chain is shorter than it is.
 */
const CHAIN_IN_WORDS =
  "a broken default branch, then CISA KEV listing, then EPSS, then severity, then update size, then whether GitHub could prepare the update";

const OVERVIEW_POLICY = `Tiers are buckets over the ordering of the queue, which is a local policy: ${CHAIN_IN_WORDS}. It is not SSVC and not any published standard.`;

const QUEUE_POLICY = `Ordering is a local policy: ${CHAIN_IN_WORDS}. It is not SSVC and not any published standard.`;

const REPO_POLICY =
  "Every value carries its own freshness, because each lane confirms on its own cadence. A section that no lane has vouched for says so rather than showing an empty table.";

const REVIEWS_POLICY =
  "Review requests are collected wherever they land, not only in watched repositories, because a request is a claim on your attention either way. Rows marked not watched carry nothing else from this dashboard: no alerts, no coverage, no build status.";

/** The one skip link on every page but the overview; `#list` exists on each. */
const LIST_SKIP = [{ href: "#list", label: "skip to list" }] as const;

/**
 * The overview (AD-32): the attention board, then collection health.
 *
 * Every number on it comes from one `Board`, built from one queue, so the
 * tiles, the rows and the summary cannot disagree. The board table gives
 * each repository its own `tbody`: the repo row and the rationale row under
 * a hidden `why` header are one group, and the tier paints the group's left
 * rule. Quiet repositories fold into one block and every one of them is a
 * link; a missing repository would be indistinguishable from a healthy one.
 *
 * What the page does not know is said where the reader looks (#127):
 * a failed lane on its tile, unreadable rows under the summary, and before
 * the first completed sweep one note in the board's place, pointing at the
 * health table, which is the same read the tiles were warned from.
 */
export const Page: FC<{
  board: Board;
  generatedAt: string;
}> = ({ board, generatedAt }) => (
  <Layout
    title={overviewTitle(board.summary, board.collected, board.unreadable)}
    current="overview"
    generatedAt={generatedAt}
    // The quiet block renders only once something has been collected, so
    // before that the link to it would lead nowhere and is not offered.
    skips={[
      { href: "#board", label: "skip to board" },
      ...(board.collected
        ? [{ href: "#quiet", label: "skip to quiet repositories" }]
        : []),
      { href: "#health", label: "skip to collection health" },
    ]}
    footer={OVERVIEW_POLICY}
  >
    <h1>gitricorder</h1>
    <p class="sub">
      {board.summary.watched} watched{" "}
      {board.summary.watched === 1 ? "repository" : "repositories"}
      {board.collected ? (
        <>
          {" · "}
          {board.summary.now} {board.summary.now === 1 ? "needs" : "need"}{" "}
          attention now
          {" · "}
          {board.summary.soon} soon
          {" · "}
          {board.summary.quiet} quiet
          {board.summary.unconfirmed > 0
            ? ` · ${board.summary.unconfirmed} unconfirmed`
            : ""}
        </>
      ) : (
        " · nothing collected yet"
      )}
    </p>
    <UnreadableNote count={board.unreadable} />

    <nav class="tiles" aria-label="topics">
      {board.tiles.map((tile) => (
        <TopicTile key={tile.topic} tile={tile} />
      ))}
    </nav>

    <h2 id="board">What needs attention</h2>
    {!board.collected ? (
      // No sweep has ever completed, so there is no row, no quiet block and
      // no legend to show: none of them would be a finding (AD-28).
      <p class="attest">
        nothing collected yet; see <a href="#health">Collection health</a>
      </p>
    ) : (
      <BoardBody board={board} />
    )}

    <h2 id="health">Collection health</h2>
    <p class="sub">A dead lane is visible here rather than only in the logs.</p>
    {board.health.length === 0 ? (
      <p class="never">No collection has run yet.</p>
    ) : (
      <HealthTable health={board.health} />
    )}
  </Layout>
);

/** The rows, the legend, the quiet block and the unconfirmed list. */
const BoardBody: FC<{ board: Board }> = ({ board }) => (
  <>
    {board.rows.length === 0 ? (
      // Only when the board can vouch for it: with a repository nobody has
      // confirmed, or a row nobody could read, "nothing" is not a finding.
      board.unconfirmed.length === 0 && board.unreadable === 0 ? (
        <p class="sub">No repository needs attention right now.</p>
      ) : null
    ) : (
      <table class="board cards" role="table">
        <thead role="rowgroup">
          <tr role="row">
            <Th colspan={2}>Repository</Th>
            <Th>Tier</Th>
            {/* The tablet's one cell in place of six columns; CSS shows it
                and hides the `c` columns between 640px and 1023px only. */}
            <Th class="signals">Signals</Th>
            {TOPICS.map((t) => (
              <Th key={t.topic} class="c">
                {t.label}
              </Th>
            ))}
            <Th>Last confirmed</Th>
          </tr>
        </thead>
        {board.rows.map((row) => (
          <tbody key={row.slug} class={row.tier} role="rowgroup">
            <tr class="repo" role="row">
              <Td class="slug-cell" colspan={2} label="Repository">
                <a class="slug" href={repoPath(row.slug)}>
                  {row.slug}
                </a>
              </Td>
              <Td class="tier-cell" label="Tier">
                <TierChip tier={row.tier} />
              </Td>
              <Td class="signals" label="Signals">
                {row.signals.map((s, i) => (
                  <>
                    {i > 0 ? " · " : ""}
                    <CountChip
                      key={s.topic}
                      chip={row.chips[s.topic]}
                      text={s.text}
                    />
                  </>
                ))}
              </Td>
              {TOPICS.map((t) => (
                <Td key={t.topic} class="c" label={t.label} show>
                  <CountChip chip={row.chips[t.topic]} />
                </Td>
              ))}
              <Td class="fresh-cell" label="Last confirmed">
                <FreshnessBadge freshness={row.freshness} age={row.age} />
              </Td>
            </tr>
            <tr class="why" role="row">
              <th scope="row" role="rowheader">
                <span class="sr-only">why</span>
              </th>
              <Td colspan={9} label="why">
                <span class="why">
                  {row.reason}
                  {/* The reason is on the chip's title too, but a title is
                      never the sole carrier; the sentence says it. Same for
                      the caveat: what the scanners said about a repository
                      whose count still stands reaches the reader here, not
                      only on hover. */}
                  {row.chips.security.state === "not-covered"
                    ? ` · security not covered: ${row.chips.security.reason}`
                    : ""}
                  {row.chips.security.caveat === null
                    ? ""
                    : ` · ${row.chips.security.caveat}`}
                  <SignalsRest rest={row.signalsRest} />
                </span>
              </Td>
            </tr>
          </tbody>
        ))}
      </table>
    )}
    <p class="legend">
      now: act today · soon: act this week · quiet: nothing pressing
    </p>

    {/* Folded on every width: a native details cannot follow the viewport
        without script, and the quiet ones are the ones to fold away. */}
    <details class="quiet">
      <summary id="quiet">
        {board.quiet.length}{" "}
        {board.quiet.length === 1 ? "repository is" : "repositories are"} quiet
      </summary>
      <p>
        {board.quiet.map((slug, i) => (
          <>
            {i > 0 ? " " : ""}
            <a key={slug} href={repoPath(slug)}>
              {slug}
            </a>
          </>
        ))}
      </p>
    </details>
    {board.unconfirmed.length > 0 ? (
      <p class="attest" id="unconfirmed">
        {board.unconfirmed.length}{" "}
        {board.unconfirmed.length === 1 ? "repository" : "repositories"} not yet
        confirmed by any completed sweep:{" "}
        {board.unconfirmed.map((slug, i) => (
          <>
            {i > 0 ? " " : ""}
            <a key={slug} href={repoPath(slug)}>
              {slug}
            </a>
          </>
        ))}
      </p>
    ) : null}
  </>
);

/**
 * What the tablet's signals cell leaves out, on the rationale line: the
 * topics confirmed at zero and the ones no sweep confirmed, so narrowing
 * the row never turns an absence into silence (AD-28). Shown by CSS on
 * tablet only; nothing when every chip is a signal.
 */
const SignalsRest: FC<{ rest: BoardRow["signalsRest"] }> = ({ rest }) => {
  const list = (topics: Topic[]) =>
    topics.map((t) => TOPIC_LABEL[t]).join(", ");
  const parts = [
    ...(rest.zero.length > 0 ? [`zero: ${list(rest.zero)}`] : []),
    ...(rest.unconfirmed.length > 0
      ? [`unconfirmed: ${list(rest.unconfirmed)}`]
      : []),
  ];
  return parts.length === 0 ? null : (
    <span class="signals-rest">{` · ${parts.join(" · ")}`}</span>
  );
};

/**
 * The latest run per lane, installation and scope. Row key, order and
 * columns are the table's contract: the rows arrive sorted by that key, so
 * the table does not reshuffle between refreshes.
 */
const HealthTable: FC<{ health: CollectionHealth[] }> = ({ health }) => (
  <table class="cards" role="table">
    <thead role="rowgroup">
      <tr role="row">
        <Th>Lane</Th>
        <Th>Installation</Th>
        <Th>Scope</Th>
        <Th>Outcome</Th>
        <Th>Last run</Th>
      </tr>
    </thead>
    <tbody role="rowgroup">
      {health.map((h) => (
        <tr key={`${h.lane}|${h.installation}|${h.scope}`} role="row">
          <Td label="Lane" show>
            {h.lane}
          </Td>
          <Td label="Installation" show>
            {h.installation}
          </Td>
          <Td label="Scope" show>
            {h.scope}
          </Td>
          <Td class={OUTCOME_CLASS[h.outcome]} label="Outcome" show>
            {h.outcome}
            {h.detail ? ` · ${h.detail}` : ""}
          </Td>
          <Td label="Last run" show>
            <FreshnessBadge freshness={h.freshness} age={h.age} />
          </Td>
        </tr>
      ))}
    </tbody>
  </table>
);

/**
 * One queue row: rank, topic, repository, item, rationale, freshness.
 *
 * The repository is a link only while it is watched; a de-listed one has
 * no page, and a link to a 404 would say the dashboard knows something it
 * does not. The item link leaves for GitHub in a new tab.
 */
const QueueRow: FC<{ item: QueueItem; rank: number; linked: boolean }> = ({
  item,
  rank,
  linked,
}) => {
  const slug = foldSlug(item.repo);
  return (
    <tr role="row">
      <Td class="num" label="#" show>
        {rank}
      </Td>
      <Td class="topic" label="Topic">
        {topicOf(item.kind)}
      </Td>
      <Td label="Repository">
        {linked ? (
          <a class="slug" href={repoPath(slug)}>
            {slug}
          </a>
        ) : (
          <span class="slug">{slug}</span>
        )}
      </Td>
      <Td label="Item">
        {item.kind === "update_pr" ? (
          <span class="badge">PR</span>
        ) : item.kind === "issue" ? (
          <span class="badge">issue</span>
        ) : item.kind === "code_scanning" ? (
          // A code scanning `#21` and a Dependabot `#21` are different things
          // in the same repository's number space, and the rationale beside
          // them both starts with a word the reader has to parse. The badge
          // is what tells them apart at a glance.
          <span class="badge">scan</span>
        ) : item.kind === "ci_failure" ? (
          // A run number looks exactly like an issue or pull request number,
          // and the rationale beside it calls the thing a workflow run: the
          // badge is what stops the reader taking `#9` for a pull request
          // and following it expecting one.
          <span class="badge">run</span>
        ) : null}{" "}
        <ExternalLink href={item.htmlUrl}>
          {item.repo}#{item.number}
        </ExternalLink>
        {item.packageName ? ` · ${item.packageName}` : ""}
        {item.title ? ` · ${item.title}` : ""}
        {item.advisory ? ` · ${item.advisory}` : ""}
      </Td>
      <Td label="Why it ranks here">
        <div class={item.kevListed ? "kev-hit" : "why-rank"}>
          {item.explanation}
        </div>
      </Td>
      <Td label="Last confirmed">
        <FreshnessBadge freshness={item.freshness} age={item.age} />
      </Td>
    </tr>
  );
};

const QueueHead: FC = () => (
  <thead role="rowgroup">
    <tr role="row">
      <Th>#</Th>
      <Th>Topic</Th>
      <Th>Repository</Th>
      <Th>Item</Th>
      <Th>Why it ranks here</Th>
      <Th>Last confirmed</Th>
    </tr>
  </thead>
);

/**
 * The ranked queue (CAP-6), filtered by topic and repository (AD-39).
 *
 * Every row shows the reason it ranks where it does, and every value carries
 * its own freshness. The filter lives in the URL and nowhere else: the bar
 * is links, the sentence says what is shown, and `clear` is a link back to
 * the whole queue. The summary counts the allowlisted estate whatever the
 * filter, so `0 open alerts` is never the filter's zero (AD-28, AD-32). The
 * ordering is labelled a LOCAL POLICY because AD-20 binds the UI here: it
 * is not SSVC, not CVSS, and naming a standard it does not implement would
 * borrow authority the chain has not earned.
 */
export const QueuePage: FC<{
  queue: Queue;
  filtered: FilteredQueue;
  filter: QueueFilter;
  generatedAt: string;
}> = ({ queue, filtered, filter, generatedAt }) => {
  // `all` is current only on the unfiltered topic dimension; an unknown
  // topic is current nowhere, so the bar does not claim a filter it is not
  // applying.
  const current =
    filter.topic?.topic ?? (filter.unknownTopic === null ? "all" : null);
  const repoRef = filter.repoRef;
  return (
    <Layout
      title={queueTitle(filter)}
      current="queue"
      generatedAt={generatedAt}
      skips={LIST_SKIP}
      footer={QUEUE_POLICY}
    >
      <h1>What to deal with next</h1>
      <p class="sub">
        {filtered.counted.filter((i) => i.kind === "alert").length} open alerts
        {" · "}
        {/* One count per queue kind. A kind listed in the table and missing
            here reads as three zeros above the row a reader came for, which
            is what this line did to the first red main it ever showed. */}
        {filtered.counted.filter((i) => i.kind === "ci_failure").length} broken
        builds
        {" · "}
        {filtered.counted.filter((i) => i.kind === "update_pr").length} update
        PRs
        {" · "}
        {filtered.counted.filter((i) => i.kind === "issue").length} untriaged
        issues
        {" · KEV catalogue "}
        {queue.kev.usable
          ? `${queue.kev.version ?? "?"} · ${queue.kev.age}`
          : "unavailable, so KEV status ranks as unknown"}
      </p>

      <UnreadableNote count={queue.unreadable} />

      {/* The bar narrows topics within an active repository filter rather
          than silently widening back to the estate; `all` keeps the repo. */}
      <nav class="filters" aria-label="topic filter">
        <a
          href={repoRef === null ? queueClearPath() : queueRepoPath(repoRef)}
          aria-current={current === "all" ? "true" : undefined}
        >
          all
        </a>
        {TOPICS.filter((t) => t.query !== null).map((t) => (
          <a
            key={t.topic}
            href={queuePath(t.topic, repoRef ?? undefined)}
            aria-current={current === t.topic ? "true" : undefined}
          >
            {t.query}
          </a>
        ))}
        <a href={reviewsPath()}>reviews</a>
      </nav>

      {/* One named region on every render, filtered or not, so `skip to
          list` always lands on something a screen reader announces. */}
      <section id="list" aria-label="queue">
        {filtered.empty !== null ? (
          <p class="filter-state">
            {filtered.empty} <a href={queueClearPath()}>Clear filter.</a>
          </p>
        ) : filtered.sentence !== null ? (
          <p class="filter-state">
            {filtered.sentence}
            {" · "}
            <a href={queueClearPath()}>clear</a>
          </p>
        ) : null}

        {filtered.shown.length > 0 ? (
          <table class="cards" role="table">
            <QueueHead />
            <tbody role="rowgroup">
              {filtered.shown.map((item, i) => (
                <QueueRow key={item.key} item={item} rank={i + 1} linked />
              ))}
            </tbody>
          </table>
        ) : filtered.empty !== null ? null : filtered.delisted.length > 0 ? (
          <p class="none">Nothing needs attention in watched repositories.</p>
        ) : (
          <p class="none">Nothing needs attention.</p>
        )}
      </section>

      {filtered.delisted.length > 0 ? (
        // Still open on GitHub, no longer in repos.yaml: listed so they are
        // not silently lost, counted nowhere so they inflate nothing.
        <>
          <h2>no longer watched</h2>
          <table class="cards" role="table">
            <QueueHead />
            <tbody role="rowgroup">
              {filtered.delisted.map((item, i) => (
                <QueueRow
                  key={item.key}
                  item={item}
                  rank={i + 1}
                  linked={false}
                />
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </Layout>
  );
};

/**
 * One repo-page section: heading, standing, and the table when there is one.
 *
 * The standing is the point of the component. An empty section means one of
 * two entirely different things - we looked and there is nothing, or no lane
 * has vouched for this repository - and the reader must never have to guess
 * which (AD-28). So the heading always carries the section's own freshness
 * and how many rows are shown, an attested empty is a sentence rather than
 * an empty table, and rows no completed sweep confirmed sit under a note
 * that says so. A suppressed section (Security under withdrawn coverage)
 * has no count to state, so its heading carries none. The label and the
 * heading id come from TOPICS (AD-32), so this page cannot spell a topic
 * differently from the overview; the ids are the anchors Story 1.8's skip
 * links will target.
 */
type SectionProps = { topic: Topic; state: SectionState } & (
  | {
      /**
       * A note that replaces the table and the standing altogether, for a
       * section the page refuses to list.
       */
      suppressed: string;
    }
  | {
      suppressed?: undefined;
      /** Rows in the table below, which is also what `N shown` says. */
      count: number;
      /**
       * How many of those rows this section's own attestation speaks for.
       * Defaults to all of them, which is every section but Security: its
       * heading attests the Dependabot lane alone, so the "collected earlier,
       * not confirmed" warning may only count that lane's rows, or it would
       * say so directly above a code scanning row wearing a fresh badge from
       * its own lane.
       */
      attestedCount?: number;
      /** The sentence for an attested empty. */
      empty: string;
      children?: Child;
    }
);

const Section: FC<SectionProps> = (props) => (
  <>
    <h2 id={props.topic}>
      {TOPIC_LABEL[props.topic]}{" "}
      <FreshnessBadge freshness={props.state.freshness} age={props.state.age} />
      {props.suppressed === undefined ? (
        <>
          {" "}
          <span class="shown">{props.count} shown</span>
        </>
      ) : null}
    </h2>
    {props.suppressed !== undefined ? (
      <p class="attest">{props.suppressed}</p>
    ) : (
      <SectionBody
        {...props}
        attestedCount={props.attestedCount ?? props.count}
      />
    )}
  </>
);

const SectionBody: FC<{
  state: SectionState;
  count: number;
  attestedCount: number;
  empty: string;
  children?: Child;
}> = ({ state, count, attestedCount, empty, children }) => (
  <>
    {state.attested ? (
      count === 0 ? (
        <p class="attest">{empty}</p>
      ) : (
        children
      )
    ) : attestedCount > 0 ? (
      // Rows collected by an earlier sweep, which the latest one did not
      // confirm. Saying "never collected" over a table of them would be
      // false; the rows carry their own freshness in the table below.
      <>
        <p class="attest warn">
          {attestedCount} collected earlier; the latest sweep did not confirm
          them
        </p>
        {children}
      </>
    ) : count > 0 ? (
      // Rows this section's own attestation says nothing about, because they
      // came from another lane: the Security section's badge is the
      // Dependabot lane's, and the code scanning rows beneath it carry their
      // own per-row badge. Listed with no warning above them rather than
      // under a sentence about a sweep that never spoke for them.
      children
    ) : (
      // No rows AND no clean sweep. Deliberately not "never collected": the
      // store keeps only the latest run per lane, so an earlier clean sweep
      // cannot be ruled out from here. What is certain is that nothing
      // currently vouches for this section.
      <p class="attest">not confirmed by any completed sweep</p>
    )}
  </>
);

/**
 * One topic's section on the repo page, with the columns EXPERIENCE.md fixes.
 *
 * A switch over the topic rather than six components listed by hand, so the
 * order on the page is TOPICS' order and nothing else (AD-32): a section
 * cannot be forgotten or moved without the exhaustiveness check noticing.
 */
/**
 * The word the Result cell shows for a verdict, or null to let GitHub speak.
 *
 * The cell is worded by the same verdict that colours it (#144). Only the
 * hung case needs a word of our own: a run that has sat unfinished past the
 * threshold has no conclusion to print, so the cell used to read
 * `in_progress, no result yet` in red - the colour asserting broken and the
 * words asserting unknown, on one row.
 *
 * Everywhere else GitHub's own word IS the verdict, and it is the more
 * precise of the two: `timed_out` says more than `failed` would, and a run
 * that is simply still going says it has not finished. Null means exactly
 * that, and the cell falls through to the raw conclusion.
 *
 * A `Record` keyed by the verdict type rather than a comparison against the
 * one literal that needs handling: a verdict added to `RunVerdict` later is a
 * build failure here, which is what stops #144 being reopened silently by a
 * new broken state that nothing gave a word to.
 */
const VERDICT_WORDS: Record<RunVerdict, string | null> = {
  hung: "hung",
  failed: null,
  passed: null,
  other: null,
};

const RepoSection: FC<{ topic: Topic; view: RepoView }> = ({ topic, view }) => {
  switch (topic) {
    case "security":
      return view.notCovered ? (
        // Suppressed as a whole, not just the count. Rows collected before
        // coverage was withdrawn would otherwise be listed directly beneath
        // a header saying we have no count to give, each contradicting the
        // other (AD-28).
        <Section
          topic={topic}
          state={view.summary}
          // Every reason, not the first: two features can be off for
          // different reasons, and dropping either leaves the section
          // explaining the one it kept and silent about the other (#152).
          // Never empty here: this branch needs Dependabot off, which always
          // has a note.
          suppressed={joinNotes(view.coverageReasons)}
        />
      ) : (
        <>
          <Section
            topic={topic}
            state={view.summary}
            // Both kinds, because the heading's `N shown` must equal the rows
            // under it: two tables, one section, one count.
            count={view.alerts.length + view.codeScanning.length}
            // The Dependabot rows only: the heading's badge is that lane's.
            attestedCount={view.alerts.length}
            empty="no open alerts or code scanning findings in this repository"
          >
            <table class="cards" role="table">
              <thead role="rowgroup">
                <tr role="row">
                  <Th>Alert</Th>
                  <Th>Severity</Th>
                  <Th>Package</Th>
                  <Th>Last confirmed</Th>
                </tr>
              </thead>
              <tbody role="rowgroup">
                {view.alerts.map((a) => (
                  <tr key={`alert-${a.number}`} role="row">
                    <Td label="Alert">
                      <ExternalLink href={a.htmlUrl}>#{a.number}</ExternalLink>
                      {a.advisory ? ` · ${a.advisory}` : ""}
                    </Td>
                    <Td
                      class={a.severity === "critical" ? "crit" : undefined}
                      label="Severity"
                      show
                    >
                      {a.severity}
                    </Td>
                    <Td label="Package" show>
                      {a.packageName ?? "unknown"}
                    </Td>
                    <Td label="Last confirmed">
                      <FreshnessBadge freshness={a.freshness} age={a.age} />
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
            {/* Its own table, not extra rows in the one above: a code scanning
              finding has no package and a Dependabot alert has no ref, so one
              table would carry a column that is blank for half its rows. The
              ref is a column because this list is unfiltered - the queue
              ranks only the default-branch findings, and a reader looking at
              one it declined must be able to see why (#156). */}
            {view.codeScanning.length === 0 ? null : (
              <table class="cards" role="table">
                <thead role="rowgroup">
                  <tr role="row">
                    <Th>Code scanning</Th>
                    <Th>Severity</Th>
                    <Th>Tool</Th>
                    <Th>Ref</Th>
                    <Th>Last confirmed</Th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {view.codeScanning.map((c) => (
                    <tr key={`scan-${c.number}`} role="row">
                      <Td label="Code scanning">
                        <ExternalLink href={c.htmlUrl}>
                          #{c.number}
                        </ExternalLink>
                        {c.ruleId ? ` · ${c.ruleId}` : ""}
                      </Td>
                      <Td
                        class={c.severity === "critical" ? "crit" : undefined}
                        label="Severity"
                        show
                      >
                        {c.severity}
                      </Td>
                      <Td label="Tool" show>
                        {c.tool ?? "unknown"}
                      </Td>
                      <Td label="Ref" show>
                        {c.ref ?? "unknown"}
                        {c.onDefaultBranch ? "" : " (not ranked)"}
                      </Td>
                      <Td label="Last confirmed">
                        {/* The section header attests the Dependabot lane, so
                          these rows carry their own standing: with no
                          `repository_code_scanning` confirmation nothing has
                          vouched for them, and a freshness word would claim
                          an attestation nobody made (AD-28). */}
                        {view.codeScanningAttested ? (
                          <FreshnessBadge freshness={c.freshness} age={c.age} />
                        ) : (
                          <span class="badge unknown">unconfirmed</span>
                        )}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </Section>
          {/* The section's heading attests the Dependabot lane alone, which is
            deliberate (#156). This is what stops that heading speaking for a
            lane it never ran: with no `repository_code_scanning`
            confirmation, code scanning is unconfirmed here, and the absence
            of findings above must not read as a measured zero (AD-28). */}
          {view.codeScanningAttested ? null : (
            <p class="attest">
              code scanning: not confirmed by any completed sweep
            </p>
          )}
        </>
      );
    case "ci":
      return (
        <Section
          topic={topic}
          state={view.actionsSection}
          count={view.runs.length}
          empty="no workflow runs in this repository"
        >
          <table class="cards" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <Th>Workflow</Th>
                <Th>Result</Th>
                <Th>Branch</Th>
                <Th>Last confirmed</Th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {view.runs.map((r) => (
                // Keyed by the run's node id: two workflows may share a
                // display name and a re-run shares its run number, so the
                // pair collides exactly where the sort used to tie.
                <tr key={`run-${r.key}`} role="row">
                  <Td label="Workflow">
                    <ExternalLink href={r.htmlUrl}>
                      {r.workflowName}
                    </ExternalLink>{" "}
                    <span class="why">#{r.runNumber}</span>
                  </Td>
                  <Td
                    // From the verdict, not from `conclusion === "failure"`:
                    // a `timed_out` or `startup_failure` run is a broken
                    // build and so is one that never finished, and the lane
                    // already counts all three. Reading the raw word here
                    // let the page render in normal weight what the lane had
                    // counted as failing, on the same rows of the same page.
                    class={isBrokenVerdict(r.verdict) ? "crit" : undefined}
                    label="Result"
                    show
                  >
                    {VERDICT_WORDS[r.verdict] ??
                      r.conclusion ??
                      `${r.status}, no result yet`}
                  </Td>
                  <Td label="Branch" show>
                    {r.headBranch ?? "unknown"}
                  </Td>
                  <Td label="Last confirmed">
                    <FreshnessBadge freshness={r.freshness} age={r.age} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      );
    case "dependencies":
      return (
        <Section
          topic={topic}
          state={view.prSection}
          count={view.updatePrs.length}
          empty="no update pull requests in this repository"
        >
          <table class="cards" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <Th>PR</Th>
                <Th>Package</Th>
                <Th>Linked alert</Th>
                <Th>Last confirmed</Th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {view.updatePrs.map((p) => (
                <tr key={`pr-${p.number}`} role="row">
                  <Td label="PR">
                    <ExternalLink href={p.htmlUrl}>#{p.number}</ExternalLink>{" "}
                    {p.title}
                  </Td>
                  <Td label="Package" show>
                    {p.packageName ?? "unknown"}
                  </Td>
                  <Td label="Linked alert" show>
                    {/* From the update statuses that name this PR, or the
                        honest absence of any: not the package heuristic.
                        Under withdrawn coverage the page lists no alerts,
                        so it names none here either (AD-28). */}
                    {view.alertsWithdrawn
                      ? "alerts not covered"
                      : p.linkedAlerts.length === 0
                        ? "none on record"
                        : p.linkedAlerts.map((n) => `#${n}`).join(", ")}
                  </Td>
                  <Td label="Last confirmed">
                    <FreshnessBadge freshness={p.freshness} age={p.age} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      );
    case "pulls":
      // No lane until Epic 3, so never attested and never a table: the
      // section reads `not confirmed by any completed sweep`, never `0`.
      return (
        <Section
          topic={topic}
          state={view.pullsSection}
          count={view.pulls.length}
          empty="no open pull requests in this repository"
        />
      );
    case "issues":
      return (
        <Section
          topic={topic}
          state={view.issueSection}
          count={view.issues.length}
          empty="no untriaged issues in this repository"
        >
          <table class="cards" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <Th>Issue</Th>
                <Th>Opened by</Th>
                <Th>Last confirmed</Th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {view.issues.map((i) => (
                <tr key={`issue-${i.number}`} role="row">
                  <Td label="Issue">
                    <ExternalLink href={i.htmlUrl}>#{i.number}</ExternalLink>{" "}
                    {i.title}
                  </Td>
                  <Td label="Opened by" show>
                    {i.author}
                  </Td>
                  <Td label="Last confirmed">
                    <FreshnessBadge freshness={i.freshness} age={i.age} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      );
    case "reviews":
      return (
        <Section
          topic={topic}
          state={view.reviewSection}
          count={view.reviews.length}
          empty="no review requests in this repository"
        >
          <table class="cards" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <Th>PR</Th>
                <Th>Requested from</Th>
                <Th>Waiting</Th>
                <Th>Last confirmed</Th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {view.reviews.map((r) => (
                <tr key={r.key} role="row">
                  <Td label="PR">
                    <ExternalLink href={r.htmlUrl}>#{r.number}</ExternalLink>{" "}
                    {r.title}
                  </Td>
                  <Td label="Requested from" show>
                    {r.requestedReviewers.length === 0
                      ? "unknown"
                      : r.requestedReviewers.join(", ")}
                  </Td>
                  <Td label="Waiting" show>
                    {r.waiting}
                  </Td>
                  <Td label="Last confirmed">
                    <FreshnessBadge freshness={r.freshness} age={r.age} />
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      );
  }
};

/**
 * The per-repository page (CAP-7): every lane's signals for one repository,
 * grouped by topic in the vocabulary's order, each section carrying its own
 * freshness. The breadcrumb is the way back, and no nav link is current:
 * this page is under the overview, not one of the three.
 */
export const RepoPage: FC<{ view: RepoView; generatedAt: string }> = ({
  view,
  generatedAt,
}) => (
  <Layout
    title={repoTitle(view.slug, view.summary.tier)}
    current={null}
    generatedAt={generatedAt}
    skips={LIST_SKIP}
    footer={REPO_POLICY}
  >
    <nav class="crumb" aria-label="breadcrumb">
      <a href={overviewPath()}>overview</a> › {view.slug}
    </nav>
    <header>
      <h1>
        {view.slug} <TierChip tier={view.summary.tier} />
      </h1>
      <p class="sub">
        {view.notCovered ? (
          <span class="uncovered">
            not covered: {joinNotes(view.coverageReasons)}
          </span>
        ) : (
          <>
            <FreshnessBadge
              freshness={view.summary.freshness}
              age={view.summary.age}
            />{" "}
            {view.summary.openAlerts === null
              ? "alert count not collected"
              : view.summary.openAlerts === 0
                ? "no open alerts"
                : `${view.summary.openAlerts} open alerts`}
            {view.summary.worstSeverity
              ? `, worst ${view.summary.worstSeverity}`
              : ""}
            {/* What the count does NOT speak for. Beside the number, never
                instead of it: nothing collects the scanners' findings yet, so
                withholding the Dependabot count over a scanner's state would
                hide live alerts behind an unrelated feature (#152). */}
            {view.coverageReasons.length === 0
              ? ""
              : ` · ${joinNotes(view.coverageReasons)}`}
          </>
        )}
        {view.notCovered ? null : (
          // Withheld beside "not covered" for the reason the list below is:
          // the rationale names a row this page has just refused to count,
          // and each half would contradict the other (AD-28). The tier
          // itself stands; it is the queue's verdict, not this page's.
          <>
            {" · "}
            <span class="why">{view.summary.tierReason}</span>
          </>
        )}
      </p>
    </header>

    {view.unreadable > 0 || view.unattributable > 0 ? (
      <p class="failed">
        {view.unreadable > 0
          ? `${view.unreadable} stored row(s) for this repository could not be read. `
          : ""}
        {view.unattributable > 0
          ? `${view.unattributable} stored row(s) could not be read at all, so whether they belong to this repository is unknown. `
          : ""}
        This page may be incomplete.
      </p>
    ) : null}

    <section id="list" aria-label="repository sections">
      {TOPICS.map((t) => (
        <RepoSection key={t.topic} topic={t.topic} view={view} />
      ))}
    </section>
  </Layout>
);

const UNKNOWN_REPO_POLICY =
  "Only repositories listed in repos.yaml have a page; nothing is discovered.";

/**
 * Shown for a repository that is not in repos.yaml, which is the universe.
 * There is no list on it, so nothing to skip to.
 */
export const UnknownRepoPage: FC<{ slug: string; generatedAt: string }> = ({
  slug,
  generatedAt,
}) => (
  <Layout
    title={unknownRepoTitle()}
    current={null}
    generatedAt={generatedAt}
    skips={[]}
    footer={UNKNOWN_REPO_POLICY}
  >
    <h1>{slug}</h1>
    <p class="never">
      This repository is not in the watched set, so nothing has ever been
      collected for it. Add it to repos.yaml to start collecting.
    </p>
    <p>
      <a href={overviewPath()}>back to the overview</a>
    </p>
  </Layout>
);

/**
 * The review-request page (CAP-5).
 *
 * Its own page, not a section of the queue, because these rows are the one
 * thing collected without the allowlist filter: most of them are in
 * repositories nobody watches, and nothing behind those has the coverage or
 * freshness discipline every row on the queue carries. Each says which it
 * is, so the reader never has to guess.
 */
export const ReviewsPage: FC<{ view: ReviewView; generatedAt: string }> = ({
  view,
  generatedAt,
}) => (
  <Layout
    title={reviewsTitle(view.rows.length, view.attested)}
    current="reviews"
    generatedAt={generatedAt}
    skips={LIST_SKIP}
    footer={REVIEWS_POLICY}
  >
    <h1>Waiting on your review</h1>
    <p class="sub">
      {view.attested ? (
        <>
          <FreshnessBadge
            freshness={view.attestedFreshness}
            age={view.attestedAge}
          />{" "}
          {view.rows.length} open
        </>
      ) : (
        <span class="never">not confirmed by any completed sweep</span>
      )}
    </p>

    {view.unreadable > 0 ? (
      <p class="failed">
        {view.unreadable} stored {view.unreadable === 1 ? "row" : "rows"} could
        not be read and {view.unreadable === 1 ? "is" : "are"} not shown. This
        list is incomplete.
      </p>
    ) : null}

    <section id="list" aria-label="review requests">
      {view.rows.length === 0 ? (
        // An empty list and an unconfirmed one are different facts (AD-28),
        // and the region says which rather than landing a reader on silence.
        view.attested ? (
          <p class="none">Nothing waiting on you.</p>
        ) : (
          <p class="attest">not confirmed by any completed sweep</p>
        )
      ) : null}

      {view.rows.length > 0 ? (
        <table class="cards" role="table">
          <thead role="rowgroup">
            <tr role="row">
              <Th>Pull request</Th>
              <Th>Opened by</Th>
              <Th>Requested from</Th>
              <Th>Waiting</Th>
              <Th>Last confirmed</Th>
            </tr>
          </thead>
          <tbody role="rowgroup">
            {view.rows.map((r) => (
              <tr key={r.key} role="row">
                <Td label="Pull request">
                  <ExternalLink href={r.htmlUrl}>
                    {r.repo}#{r.number}
                  </ExternalLink>
                  {r.watched ? null : (
                    // Said on every row rather than once at the top: this
                    // repository has no coverage, no alert sweep and no
                    // freshness behind it beyond this one line.
                    <>
                      {" "}
                      <span class="badge unknown">not watched</span>
                    </>
                  )}
                  <div class="why">{r.title}</div>
                </Td>
                <Td label="Opened by" show>
                  {r.author}
                </Td>
                <Td label="Requested from" show>
                  {/* The reviewers themselves, not a count. GraphQL reports a
                    TEAM request by its slug, so counting produced "just
                    you" for a pull request nobody had asked the reader for
                    personally. */}
                  {r.requestedReviewers.length === 0
                    ? "unknown"
                    : r.requestedReviewers.join(", ")}
                </Td>
                <Td label="Waiting" show>
                  {r.waiting}
                </Td>
                <Td label="Last confirmed">
                  <FreshnessBadge freshness={r.freshness} age={r.age} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  </Layout>
);
