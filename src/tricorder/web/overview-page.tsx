/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { FC } from "hono/jsx";
import { REFUSAL_WORDS } from "../../core/merge.js";
import type { Assets } from "./assets.js";
import { AGE_STEPS, LCARS_COLORS as C } from "./lcars-tokens.js";
import type { Overview, OverviewBox } from "./overview-view.js";
import { overviewTitle } from "./titles.js";

// The LCARS overview. Labels are LCARS caps in Antonio; sentences, repository
// names and IDs stay in mixed case, because a repository name is an identifier
// and condensed caps are hard to read at sentence length.

const AGE_STEP_RULES = AGE_STEPS.map(
  (color, i) => `.segs i.on:nth-child(${i + 1}) { background: ${color}; }`,
).join("\n");

const STYLE = `
  body { margin: 0; background: ${C.ground}; color: ${C.text}; font-family: Antonio, "Arial Narrow", sans-serif; }
  lcars-frame { --lcars-frame-height: 100dvh; --lcars-sidebar-width: 200px; }
  .brand { font-size: 30px; line-height: 1; letter-spacing: .06em; white-space: nowrap; align-self: center; }
  .nav { display: flex; flex-direction: column; gap: 6px; }
  .tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: 14px; margin-bottom: 16px; }
  .tile { all: unset; box-sizing: border-box; cursor: pointer; padding: 12px 18px; border-radius: 26px 8px 8px 26px; background: ${C.tile}; border-left: 18px solid var(--c); display: grid; gap: 2px; min-width: 0; }
  .tile:hover { background: ${C.tileHover}; }
  .tile[aria-pressed="true"] { background: var(--c); color: ${C.ink}; }
  .tile .name { font-size: 20px; letter-spacing: .06em; }
  .tile .count { font-size: 52px; line-height: 1.05; font-variant-numeric: tabular-nums; }
  .tile .count.word { font-size: 28px; line-height: 1.9; }
  .tile .split { font-size: 18px; color: ${C.muted}; letter-spacing: .03em; }
  .tile .note { font: 13px system-ui, sans-serif; text-transform: none; color: ${C.muted}; overflow-wrap: anywhere; }
  .tile[aria-pressed="true"] .split, .tile[aria-pressed="true"] .note { color: ${C.ink}; }
  .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 10px; min-height: 32px; margin-bottom: 6px; font-size: 19px; color: ${C.gold}; letter-spacing: .05em; }
  lcars-chip { --lcars-font-size-xs: 16px; max-width: 100%; }
  /* The chip uppercases its slot, and a repository name is an identifier. */
  lcars-chip.repo span:not(.vh) { font: 500 14px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0; text-transform: none; white-space: normal; overflow-wrap: anywhere; }
  #clear { all: unset; cursor: pointer; color: ${C.ice}; font-size: 17px; }
  lcars-table { flex: 1 1 auto; min-height: 12rem; --lcars-font-size-sm: 19px; --lcars-font-size-xs: 16px; }
  @media (max-width: 599px) { lcars-table { max-width: calc(100vw - 32px); } }
  /* From here to the end of the sheet, the rules also style the table's cells:
     the client adopts this whole sheet into the table's shadow root. */
  td { padding: 7px 10px 7px 0; vertical-align: middle; text-transform: none; }
  .d { display: block; font: 400 16px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0; color: ${C.text}; min-width: 16rem; overflow-wrap: anywhere; }
  /* One box for both cells, because the icon would otherwise set the repository line apart. */
  .line { display: flex; align-items: center; min-height: 24px; }
  .num { color: ${C.ice}; font: 500 15px ui-monospace, SFMono-Regular, Menlo, monospace; text-decoration: underline; text-underline-offset: 3px; text-transform: none; }
  a.num:hover { color: ${C.text}; }
  span.num { text-decoration: none; }
  .pill { all: unset; cursor: pointer; display: inline-block; min-width: 72px; text-align: center; padding: 1px 10px; border-radius: 12px; color: ${C.ink}; font-size: 16px; white-space: nowrap; background: ${C.lilac}; }
  /* The same states as lcars-button: brighter on hover, brighter and pressed in when active. */
  .pill:hover { filter: brightness(var(--lcars-hover-brightness)); }
  .pill:active, .pill[aria-pressed="true"] { filter: brightness(var(--lcars-active-brightness)); transform: scale(var(--lcars-active-scale)); }
  .CRITICAL, .FAILING { background: ${C.critical}; }
  .HIGH { background: ${C.high}; }
  .MEDIUM { background: ${C.medium}; }
  .LOW, .UNKNOWN { background: ${C.low}; }
  .READY, .MERGED { background: ${C.go}; }
  .vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .gh { display: inline-grid; place-items: center; width: 24px; height: 24px; margin-right: 6px; color: ${C.muted}; }
  .gh:hover { color: ${C.ice}; }
  .merge { all: unset; cursor: pointer; display: inline-grid; place-items: center; width: 24px; height: 24px; margin-right: 6px; color: ${C.go}; }
  .merge:hover { filter: brightness(var(--lcars-hover-brightness)); }
  .merge:active { filter: brightness(var(--lcars-active-brightness)); transform: scale(var(--lcars-active-scale)); }
  .merge[aria-disabled="true"], .merge[aria-busy="true"] { color: ${C.muted}; filter: none; transform: none; }
  .merge[aria-disabled="true"] { cursor: not-allowed; }
  .merge[aria-busy="true"] { cursor: progress; }
  /* An ID with no icon beside it starts where the iconed IDs do. */
  tbody:has(.merge) .num:first-child { margin-left: 30px; }
  .rb { all: unset; cursor: pointer; color: ${C.gold}; font-size: 15px; font-weight: 500; }
  .rb:hover, .rb[aria-pressed="true"] { text-decoration: underline; text-underline-offset: 3px; }
  .age { display: inline-flex; align-items: center; gap: 10px; }
  .segs { display: inline-flex; gap: 2px; }
  .segs i { width: 12px; height: 14px; background: ${C.rule}; }
  .segs i:first-child { border-radius: 7px 0 0 7px; }
  .segs i:last-child { border-radius: 0 7px 7px 0; }
  ${AGE_STEP_RULES}
  .words { font: 400 15px system-ui, sans-serif; text-transform: none; letter-spacing: 0; color: ${C.text}; min-width: 62px; }
  .tile:focus-visible, .pill:focus-visible, .rb:focus-visible, #clear:focus-visible, .num:focus-visible, .gh:focus-visible, .merge:focus-visible { outline: 2px solid ${C.ice}; outline-offset: 2px; }
  .empty { padding: 16px 0; font: 16px system-ui, sans-serif; text-transform: none; color: ${C.muted}; }
`;

const BOX_COLOR: Readonly<Record<OverviewBox["group"], string>> = {
  SECURITY: C.critical,
  "PULL REQUESTS": C.lilac,
  "RELEASE WORTHY": C.ice,
};

// For the client, which has no imports: a refused row reads these same words.
const REFUSAL_WORDS_JSON = JSON.stringify(REFUSAL_WORDS);

const Box: FC<{ box: OverviewBox }> = ({ box }) => (
  <button
    type="button"
    class="tile"
    style={`--c:${BOX_COLOR[box.group]}`}
    data-facet="kind"
    data-value={box.group}
    aria-pressed="false"
  >
    <span class="name">{box.group}</span>
    {box.count === null ? (
      <span class="count word">{box.unconfirmed}</span>
    ) : (
      <span class="count">{box.count}</span>
    )}
    <span class="split">{box.breakdown}</span>
    {box.notes.map((note) => (
      <span key={note} class="note">
        {note}
      </span>
    ))}
  </button>
);

export const OverviewPage: FC<{ view: Overview; assets: Assets }> = ({
  view,
  assets,
}) => (
  <html lang="en" data-lcars-theme="tng">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{overviewTitle(view.boxes)}</title>
      <link rel="stylesheet" href={assets["lcars.css"]?.href} />
      {/* Raw, because JSX escapes the quotes in the selectors and font stacks,
          which silently drops those rules. STYLE is a constant. */}
      <style id="overview-style" dangerouslySetInnerHTML={{ __html: STYLE }} />
      <script src={assets["lcars.iife.js"]?.href} />
      <script type="module" src={assets["overview-client.js"]?.href} />
    </head>
    <body>
      <lcars-frame theme="tng" main-label="OVERVIEW" sidebar-label="NAVIGATION">
        <lcars-elbow slot="elbow-tl" orientation="top-left">
          <span slot="label" class="brand">
            GITRICORDER
          </span>
        </lcars-elbow>
        <div slot="top-bar">FLEET STATUS</div>
        <div slot="sidebar" class="nav">
          <lcars-button color="primary" active sound="none">
            OVERVIEW
          </lcars-button>
        </div>
        {/* Slotted one by one, because a wrapper would need to pass the
            table's flex sizing on. */}
        <div slot="main" class="tiles">
          {view.boxes.map((box) => (
            <Box key={box.group} box={box} />
          ))}
        </div>
        {/* Empty until a merge answers: a live region must exist first. */}
        <p slot="main" class="vh" id="merge-status" aria-live="polite" />
        <div slot="main" class="bar" id="filter-bar">
          <span>{view.rows.length} ITEMS</span>
        </div>
        <noscript slot="main">
          <p class="empty">The table needs JavaScript.</p>
        </noscript>
        <lcars-table
          slot="main"
          id="overview-table"
          label="Overview"
          color="secondary"
          header-style="rule"
          data-rows={JSON.stringify(view.rows)}
          data-refusals={REFUSAL_WORDS_JSON}
        />
        <p slot="main" class="empty" id="no-matches" hidden>
          No items match these filters. Remove one to see more.
        </p>
        <div slot="footer-readout">{view.health.readout}</div>
        <lcars-elbow
          slot="elbow-bl"
          orientation="bottom-left"
          label={view.health.status}
        />
      </lcars-frame>
    </body>
  </html>
);
