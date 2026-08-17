/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { FC } from "hono/jsx";
import type { Freshness } from "./freshness.js";
import type { CollectionHealth, RepoRow } from "./view.js";

// Server-rendered tables. There is no client-side interactivity layer in this
// build, deliberately: nothing here needs partial updates.

const STYLE = `
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 60rem; padding: 0 1rem; }
  h1 { font-size: 1.4rem; margin-bottom: .25rem; }
  .sub { color: #666; margin-top: 0; font-size: .9rem; }
  table { border-collapse: collapse; width: 100%; margin: 1.5rem 0; }
  th, td { text-align: left; padding: .45rem .6rem; border-bottom: 1px solid #8883; }
  th { font-weight: 600; font-size: .8rem; text-transform: uppercase; letter-spacing: .04em; color: #666; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .badge { font-size: .75rem; padding: .1rem .45rem; border-radius: .7rem; border: 1px solid; white-space: nowrap; }
  .fresh   { color: #1a7f37; border-color: #1a7f3755; }
  .stale   { color: #9a6700; border-color: #9a670055; background: #9a670012; }
  .unknown { color: #57606a; border-color: #57606a55; background: repeating-linear-gradient(45deg, #57606a08 0 4px, transparent 4px 8px); }
  .none  { color: #1a7f37; }
  .some  { font-weight: 600; }
  .crit  { color: #cf222e; }
  .high  { color: #bc4c00; }
  .never { color: #57606a; font-style: italic; }
  .failed { color: #cf222e; font-weight: 600; }
  .partial { color: #9a6700; font-weight: 600; }
  .stalled { color: #cf222e; font-weight: 600; }
  .running { color: #57606a; }
`;

export const FreshnessBadge: FC<{ freshness: Freshness; age: string }> = ({
  freshness,
  age,
}) => (
  <span class={`badge ${freshness}`} title={age}>
    {freshness === "unknown" ? "never collected" : `${freshness} · ${age}`}
  </span>
);

/**
 * The alert count.
 *
 * Three visually distinct states, which is the requirement: a real zero reads
 * as good news, a never-collected repository reads as a gap in our knowledge,
 * and neither can be mistaken for the other.
 */
export const AlertCount: FC<{ row: RepoRow }> = ({ row }) => {
  if (row.openAlerts === null) {
    return <span class="never">not collected</span>;
  }
  if (row.openAlerts === 0) {
    // Green only while the zero is current. A stale zero is a number we can no
    // longer vouch for, and painting it as good news is what the badge column
    // would then have to argue the reader out of.
    return (
      <span class={row.freshness === "fresh" ? "none" : undefined}>0</span>
    );
  }
  const severityClass =
    row.worstSeverity === "critical"
      ? "crit"
      : row.worstSeverity === "high"
        ? "high"
        : "";
  return (
    <span class={`some ${severityClass}`}>
      {row.openAlerts}
      {row.worstSeverity ? ` ${row.worstSeverity}` : ""}
    </span>
  );
};

export const Page: FC<{
  rows: RepoRow[];
  health: CollectionHealth[];
  generatedAt: string;
}> = ({ rows, health, generatedAt }) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>gitricorder</title>
      <style>{STYLE}</style>
    </head>
    <body>
      <h1>gitricorder</h1>
      <p class="sub">
        {rows.length} watched{" "}
        {rows.length === 1 ? "repository" : "repositories"}
        {" · rendered "}
        {generatedAt}
      </p>

      <table>
        <thead>
          <tr>
            <th>Repository</th>
            <th class="num">Open Dependabot alerts</th>
            <th>Last confirmed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.slug}>
              <td>{row.slug}</td>
              <td class="num">
                <AlertCount row={row} />
              </td>
              <td>
                <FreshnessBadge freshness={row.freshness} age={row.age} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style="font-size:1.1rem">Collection health</h2>
      <p class="sub">
        A dead lane is visible here rather than only in the logs.
      </p>
      {health.length === 0 ? (
        <p class="never">No collection has run yet.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Lane</th>
              <th>Installation</th>
              <th>Scope</th>
              <th>Outcome</th>
              <th>Last run</th>
            </tr>
          </thead>
          <tbody>
            {health.map((h) => (
              <tr key={`${h.lane}|${h.installation}|${h.scope}`}>
                <td>{h.lane}</td>
                <td>{h.installation}</td>
                <td>{h.scope}</td>
                <td class={h.outcome === "ok" ? "" : h.outcome}>
                  {h.outcome}
                  {h.detail ? ` · ${h.detail}` : ""}
                </td>
                <td>
                  <FreshnessBadge freshness={h.freshness} age={h.age} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </body>
  </html>
);
