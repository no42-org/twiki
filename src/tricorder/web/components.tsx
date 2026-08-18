/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { FC, PropsWithChildren } from "hono/jsx";
import type { Freshness } from "./freshness.js";
import type { Queue } from "./queue.js";
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
  .uncovered { color: #9a6700; font-style: italic; text-decoration: underline dotted; }
  .why { color: #666; font-size: .85em; }
  .failed { color: #cf222e; font-weight: 600; }
  .partial { color: #9a6700; font-weight: 600; }
  .stalled { color: #cf222e; font-weight: 600; }
  .running { color: #57606a; }
  .why-rank { color: #57606a; font-size: .85em; }
  .kev-hit { color: #cf222e; font-weight: 700; }
  .policy-note { color: #57606a; font-size: .85em; margin-top: 2rem; }
  nav { margin-bottom: 1rem; font-size: .9rem; }
  nav a { margin-right: 1rem; }
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
  // Coverage first: a repository nobody is watching has no count, and saying
  // "not collected" would blame the collector for GitHub's setting (AD-28).
  if (row.coverage !== null && row.coverage !== "covered") {
    return (
      <span class="uncovered" title={row.coverageReason ?? undefined}>
        not covered
      </span>
    );
  }
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

/**
 * The one page shell.
 *
 * Both pages used to carry their own copy of the html/head/nav chrome, which
 * meant a nav link or a meta fix had to land twice and a missed copy shipped
 * divergent pages.
 */
const Layout: FC<PropsWithChildren<{ title: string }>> = ({
  title,
  children,
}) => (
  <html lang="en">
    <head>
      <meta charset="utf-8" />
      <meta name="viewport" content="width=device-width, initial-scale=1" />
      <title>{title}</title>
      <style>{STYLE}</style>
    </head>
    <body>
      <nav>
        <a href="/">repositories</a>
        <a href="/queue">queue</a>
      </nav>
      {children}
    </body>
  </html>
);

export const Page: FC<{
  rows: RepoRow[];
  health: CollectionHealth[];
  generatedAt: string;
}> = ({ rows, health, generatedAt }) => (
  <Layout title="gitricorder">
    <h1>gitricorder</h1>
    <p class="sub">
      {rows.length} watched {rows.length === 1 ? "repository" : "repositories"}
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
            <td>
              {row.slug}
              {row.coverageReason ? (
                <div class="why">{row.coverageReason}</div>
              ) : null}
            </td>
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
    <p class="sub">A dead lane is visible here rather than only in the logs.</p>
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
  </Layout>
);

/**
 * The ranked queue (CAP-6).
 *
 * Every row shows the reason it ranks where it does, and every value carries
 * its own freshness. The ordering is labelled a LOCAL POLICY because AD-20
 * binds the UI here: it is not SSVC, not CVSS, and naming a standard it does
 * not implement would borrow authority the chain has not earned.
 */
export const QueuePage: FC<{ queue: Queue; generatedAt: string }> = ({
  queue,
  generatedAt,
}) => (
  <Layout title="gitricorder queue">
    <h1>What to deal with next</h1>
    <p class="sub">
      {queue.items.filter((i) => i.kind === "alert").length} open alerts
      {" · "}
      {queue.items.filter((i) => i.kind === "update_pr").length} update PRs
      {" · KEV catalogue "}
      {queue.kev.usable
        ? `${queue.kev.version ?? "?"} · ${queue.kev.age}`
        : "unavailable, so KEV status ranks as unknown"}
      {" · rendered "}
      {generatedAt}
    </p>

    {queue.unreadable > 0 ? (
      <p class="failed">
        {queue.unreadable} stored {queue.unreadable === 1 ? "item" : "items"}{" "}
        could not be read and {queue.unreadable === 1 ? "is" : "are"} not shown.
        This list is incomplete.
      </p>
    ) : null}

    {queue.items.length === 0 ? (
      <p class="none">Nothing needs attention.</p>
    ) : (
      <table>
        <thead>
          <tr>
            <th>#</th>
            <th>Item</th>
            <th>Why it ranks here</th>
            <th>Last confirmed</th>
          </tr>
        </thead>
        <tbody>
          {queue.items.map((item, i) => (
            <tr key={item.key}>
              <td class="num">{i + 1}</td>
              <td>
                {item.kind === "update_pr" ? (
                  <span class="badge">PR</span>
                ) : null}{" "}
                {item.htmlUrl ? (
                  <a href={item.htmlUrl}>
                    {item.repo}#{item.number}
                  </a>
                ) : (
                  `${item.repo}#${item.number}`
                )}
                {item.packageName ? ` · ${item.packageName}` : ""}
                {item.advisory ? ` · ${item.advisory}` : ""}
              </td>
              <td>
                <div class={item.kevListed ? "kev-hit" : "why-rank"}>
                  {item.explanation}
                </div>
              </td>
              <td>
                <FreshnessBadge freshness={item.freshness} age={item.age} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    )}

    <p class="policy-note">
      Ordering is a local policy: CISA KEV listing, then EPSS, then severity,
      then update size. It is not SSVC and not any published standard.
    </p>
  </Layout>
);
