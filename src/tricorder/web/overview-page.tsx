/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { FC } from "hono/jsx";
import type { Assets } from "./assets.js";
import { AGE_STEPS, LCARS_COLORS as C } from "./lcars-tokens.js";
import type { Overview, OverviewBox, OverviewRow } from "./overview-view.js";
import { overviewTitle } from "./titles.js";

// The LCARS overview. Labels are LCARS caps in Antonio; sentences, repository
// names and IDs stay in mixed case, because a repository name is an identifier
// and condensed caps are hard to read at sentence length. The frame's slotted
// label inherits the corner's own gold unless told otherwise, hence the
// explicit ink on it.

const AGE_STEP_RULES = AGE_STEPS.map(
  (color, i) => `.segs i.on:nth-child(${i + 1}) { background: ${color}; }`,
).join("\n");

const STYLE = `
  body { margin: 0; background: ${C.ground}; color: ${C.text}; font-family: Antonio, "Arial Narrow", sans-serif; }
  lcars-frame { --lcars-frame-height: 100dvh; --lcars-sidebar-width: 200px; }
  .brand { color: ${C.ink}; font-size: 30px; line-height: 1; letter-spacing: .06em; white-space: nowrap; align-self: center; }
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
  .chip { all: unset; cursor: pointer; display: inline-flex; align-items: center; gap: 8px; padding: 2px 6px 2px 12px; border-radius: 14px; background: ${C.lilac}; color: ${C.ink}; font-size: 16px; letter-spacing: .04em; overflow-wrap: anywhere; }
  .chip.repo { font: 500 14px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0; text-transform: none; }
  .chip .x { display: inline-grid; place-items: center; flex: none; width: 18px; height: 18px; border-radius: 50%; background: ${C.ink}; color: ${C.lilac}; }
  .chip .x svg { display: block; width: 10px; height: 10px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; }
  #clear { all: unset; cursor: pointer; color: ${C.ice}; font-size: 17px; }
  /* A scroll container clips what paints outside it, so the focus outline
     needs room inside it. */
  .table-wrap { overflow-x: auto; padding-inline: 4px; margin-inline: -4px; }
  @media (max-width: 599px) { .table-wrap { max-width: calc(100vw - 32px); } }
  table { width: 100%; border-collapse: collapse; font-size: 19px; letter-spacing: .02em; }
  th { text-align: left; padding: 4px 10px 4px 0; font-weight: 400; font-size: 16px; border-bottom: 2px solid ${C.lilac}; }
  .sort { all: unset; cursor: pointer; color: ${C.lilac}; letter-spacing: .08em; white-space: nowrap; }
  .sort:hover { color: ${C.text}; }
  .dir { display: inline-block; width: 14px; margin-left: 4px; color: ${C.gold}; }
  td { padding: 7px 10px 7px 0; vertical-align: middle; border-bottom: 1px solid ${C.rule}; }
  td.r { white-space: nowrap; text-transform: none; font: 500 15px ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0; }
  td.d { text-transform: none; font: 400 16px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0; color: ${C.text}; min-width: 16rem; overflow-wrap: anywhere; }
  td.i { white-space: nowrap; }
  /* One box for both cells, because the icon would otherwise set the repository line apart. */
  .line { display: flex; align-items: center; min-height: 24px; }
  .num { color: ${C.ice}; font: 500 15px ui-monospace, SFMono-Regular, Menlo, monospace; text-decoration: underline; text-underline-offset: 3px; text-transform: none; }
  a.num:hover { color: ${C.text}; }
  span.num { text-decoration: none; }
  td.g { white-space: nowrap; }
  .pill { all: unset; cursor: pointer; display: inline-block; min-width: 72px; text-align: center; padding: 1px 10px; border-radius: 12px; color: ${C.ink}; font-size: 16px; white-space: nowrap; background: ${C.lilac}; }
  /* Antonio sits low in its line box, so equal padding alone leaves caps below
     center. Trimming the box to the capitals makes the padding equal around
     what is visible. */
  @supports (text-box: trim-both cap alphabetic) {
    .pill { padding-block: 6px; text-box: trim-both cap alphabetic; }
    .chip:not(.repo) .label { text-box: trim-both cap alphabetic; }
  }
  /* The same states as lcars-button: brighter on hover, brighter and pressed in when active. */
  .pill:hover, .chip:hover { filter: brightness(1.2); }
  .pill:active, .chip:active, .pill[aria-pressed="true"] { filter: brightness(1.4); transform: scale(0.98); }
  .CRITICAL, .FAILING { background: ${C.critical}; }
  .HIGH { background: ${C.high}; }
  .MEDIUM { background: ${C.medium}; }
  .LOW, .UNKNOWN { background: ${C.low}; }
  .vh { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
  .gh { display: inline-grid; place-items: center; width: 24px; height: 24px; margin-right: 6px; color: ${C.muted}; }
  .gh:hover { color: ${C.ice}; }
  .rb { all: unset; cursor: pointer; color: ${C.gold}; }
  .rb:hover, .rb[aria-pressed="true"] { text-decoration: underline; text-underline-offset: 3px; }
  .age { display: inline-flex; align-items: center; gap: 10px; }
  .segs { display: inline-flex; gap: 2px; }
  .segs i { width: 12px; height: 14px; background: ${C.rule}; }
  .segs i:first-child { border-radius: 7px 0 0 7px; }
  .segs i:last-child { border-radius: 0 7px 7px 0; }
  ${AGE_STEP_RULES}
  .words { font: 400 15px system-ui, sans-serif; text-transform: none; letter-spacing: 0; color: ${C.text}; min-width: 62px; }
  .tile:focus-visible, .pill:focus-visible, .rb:focus-visible, .chip:focus-visible, #clear:focus-visible, .sort:focus-visible, .num:focus-visible, .gh:focus-visible { outline: 2px solid ${C.ice}; outline-offset: 2px; }
  .empty { padding: 16px 0; font: 16px system-ui, sans-serif; text-transform: none; color: ${C.muted}; }
`;

const BOX_COLOR: Readonly<Record<OverviewBox["group"], string>> = {
  SECURITY: C.critical,
  "PULL REQUESTS": C.lilac,
  "RELEASE WORTHY": C.ice,
};

const COLUMNS = [
  ["severity", "SEVERITY"],
  ["state", "STATE"],
  ["repo", "REPOSITORY"],
  ["id", "ID"],
  ["what", "WHAT AND IMPACT"],
  ["age", "AGE"],
] as const;

const GITHUB_MARK =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z";

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

const Pill: FC<{ facet: string; value: string; extra?: string }> = ({
  facet,
  value,
  extra,
}) => (
  <button
    type="button"
    class={`pill ${extra ?? ""}`}
    data-facet={facet}
    data-value={value}
    aria-pressed="false"
    aria-label={`Filter by ${facet} ${value}`}
  >
    {value}
  </button>
);

const Age: FC<{ row: OverviewRow }> = ({ row }) => (
  <span class="age">
    <span class="segs" aria-hidden="true">
      {[1, 2, 3, 4, 5].map((step) => (
        <i key={step} class={step <= row.ageStep ? "on" : undefined} />
      ))}
    </span>
    <span class="words">{row.ageWords}</span>
  </span>
);

const Row: FC<{ row: OverviewRow }> = ({ row }) => (
  <tr
    data-kind={row.group}
    data-severity={row.severity ?? undefined}
    data-rank={row.severityRank ?? undefined}
    data-state={row.state}
    data-repo={row.repo}
    data-label={row.repoLabel}
    data-id={row.id}
    data-what={row.what}
    data-age={row.ageHours ?? undefined}
  >
    <td>
      {row.severity === null ? null : (
        <Pill facet="severity" value={row.severity} extra={row.severity} />
      )}
    </td>
    <td>
      <Pill
        facet="state"
        value={row.state}
        extra={row.state === "FAILING" ? "FAILING" : undefined}
      />
    </td>
    <td class="r">
      <span class="line">
        {row.repoUrl === null ? null : (
          <a
            class="gh"
            href={row.repoUrl}
            target="_blank"
            rel="noopener noreferrer"
            title="Open on GitHub"
          >
            <span class="vh">Open {row.repoLabel} on GitHub in a new tab</span>
            <svg
              viewBox="0 0 16 16"
              width="16"
              height="16"
              fill="currentColor"
              aria-hidden="true"
            >
              <path d={GITHUB_MARK} />
            </svg>
          </a>
        )}
        <button
          type="button"
          class="rb"
          data-facet="repo"
          data-value={row.repo}
          data-label={row.repoLabel}
          aria-pressed="false"
          aria-label={`Filter by repository ${row.repoLabel}`}
        >
          {row.repoLabel}
        </button>
      </span>
    </td>
    <td class="i">
      <span class="line">
        {row.url === null ? (
          <span class="num">{row.id}</span>
        ) : (
          <a
            class="num"
            href={row.url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={`Open ${row.id} in ${row.repoLabel} on GitHub in a new tab`}
            title="Open on GitHub"
          >
            {row.id}
          </a>
        )}
      </span>
    </td>
    <td class="d">{row.what}</td>
    <td class="g">
      <Age row={row} />
    </td>
  </tr>
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
      <style dangerouslySetInnerHTML={{ __html: STYLE }} />
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
        <div slot="main">
          <div class="tiles">
            {view.boxes.map((box) => (
              <Box key={box.group} box={box} />
            ))}
          </div>
          <div class="bar" id="filter-bar">
            <span>{view.rows.length} ITEMS</span>
          </div>
          <div class="table-wrap">
            <table id="overview-table">
              <thead>
                <tr>
                  {COLUMNS.map(([col, label]) => (
                    <th key={col} data-col={col} scope="col">
                      <button type="button" class="sort" data-sort={col}>
                        {label}
                        <span class="dir" aria-hidden="true" />
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody id="rows">
                {view.rows.map((row) => (
                  <Row key={row.key} row={row} />
                ))}
              </tbody>
            </table>
          </div>
          <p class="empty" id="no-matches" hidden>
            No items match these filters. Remove one to see more.
          </p>
        </div>
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
