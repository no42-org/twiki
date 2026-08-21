/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { FC, PropsWithChildren } from "hono/jsx";
import type { Freshness } from "./freshness.js";
import type { Queue } from "./queue.js";
import type { RepoView, SectionState } from "./repo-view.js";
import type { ReviewView } from "./review-view.js";
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
        <a href="/reviews">reviews</a>
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
              <a href={`/repo/${row.slug}`}>{row.slug}</a>
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
      {" · "}
      {queue.items.filter((i) => i.kind === "issue").length} untriaged issues
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
                ) : item.kind === "issue" ? (
                  <span class="badge">issue</span>
                ) : null}{" "}
                {item.htmlUrl ? (
                  <a href={item.htmlUrl}>
                    {item.repo}#{item.number}
                  </a>
                ) : (
                  `${item.repo}#${item.number}`
                )}
                {item.packageName ? ` · ${item.packageName}` : ""}
                {item.title ? ` · ${item.title}` : ""}
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

/**
 * One section's heading plus its standing.
 *
 * The standing is the point of the component. An empty section means one of
 * two entirely different things - we looked and there is nothing, or no lane
 * has vouched for this repository - and the reader must never have to guess
 * which (AD-28).
 */
const Section: FC<{
  title: string;
  state: SectionState;
  count: number;
  empty: string;
}> = ({ title, state, count, empty }) => (
  <p class="sub">
    <strong>{title}</strong>{" "}
    {state.attested ? (
      <>
        <FreshnessBadge freshness={state.freshness} age={state.age} />{" "}
        {count === 0 ? empty : `${count} shown`}
      </>
    ) : count > 0 ? (
      // Rows collected by an earlier sweep, which the latest one did not
      // confirm. Saying "never collected" over a table of them would be
      // false; the rows carry their own freshness in the table below.
      <span class="stale">
        {count} collected earlier; the latest sweep did not confirm them
      </span>
    ) : (
      // No rows AND no clean sweep. Deliberately not "never collected": the
      // store keeps only the latest run per lane, so an earlier clean sweep
      // cannot be ruled out from here. What is certain is that nothing
      // currently vouches for this section.
      <span class="never">not confirmed by any completed sweep</span>
    )}
  </p>
);

/**
 * The per-repository page (CAP-7): every lane's signals for one repository,
 * each carrying its own freshness.
 */
export const RepoPage: FC<{ view: RepoView; generatedAt: string }> = ({
  view,
  generatedAt,
}) => (
  <Layout title={`gitricorder · ${view.slug}`}>
    <h1>{view.slug}</h1>
    <p class="sub">
      {view.notCovered ? (
        <span class="uncovered">
          not covered{view.coverageReason ? `: ${view.coverageReason}` : ""}
        </span>
      ) : (
        <>
          <FreshnessBadge
            freshness={view.summary.freshness}
            age={view.summary.age}
          />{" "}
          {view.summary.openAlerts === null
            ? "alert count not collected"
            : `${view.summary.openAlerts} open alerts`}
          {view.summary.worstSeverity
            ? `, worst ${view.summary.worstSeverity}`
            : ""}
        </>
      )}
      {" · rendered "}
      {generatedAt}
    </p>

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

    {view.notCovered ? (
      // Suppressed as a whole, not just the count. Rows collected before
      // coverage was withdrawn would otherwise be listed directly beneath a
      // header saying we have no count to give, each contradicting the
      // other (AD-28).
      <p class="sub">
        <strong>Security alerts</strong>{" "}
        <span class="uncovered">
          no count and no list: {view.coverageReason ?? "not covered"}
        </span>
      </p>
    ) : (
      <Section
        title="Security alerts"
        state={view.summary}
        count={view.alerts.length}
        empty="none open"
      />
    )}
    {!view.notCovered && view.alerts.length > 0 ? (
      <table>
        <thead>
          <tr>
            <th>Alert</th>
            <th>Severity</th>
            <th>Package</th>
            <th>Last confirmed</th>
          </tr>
        </thead>
        <tbody>
          {view.alerts.map((a) => (
            <tr key={`alert-${a.number}`}>
              <td>
                {a.htmlUrl ? (
                  <a href={a.htmlUrl}>#{a.number}</a>
                ) : (
                  `#${a.number}`
                )}
                {a.advisory ? ` · ${a.advisory}` : ""}
              </td>
              <td class={a.severity === "critical" ? "crit" : ""}>
                {a.severity}
              </td>
              <td>{a.packageName ?? "unknown"}</td>
              <td>
                <FreshnessBadge freshness={a.freshness} age={a.age} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : null}

    <Section
      title="Dependency-update pull requests"
      state={view.prSection}
      count={view.updatePrs.length}
      empty="none open"
    />
    {view.updatePrs.length > 0 ? (
      <table>
        <thead>
          <tr>
            <th>Pull request</th>
            <th>Package</th>
            <th>Bump</th>
            <th>Last confirmed</th>
          </tr>
        </thead>
        <tbody>
          {view.updatePrs.map((p) => (
            <tr key={`pr-${p.number}`}>
              <td>
                {p.htmlUrl ? (
                  <a href={p.htmlUrl}>#{p.number}</a>
                ) : (
                  `#${p.number}`
                )}{" "}
                {p.title}
              </td>
              <td>{p.packageName ?? "unknown"}</td>
              <td>{p.bump ?? "unknown"}</td>
              <td>
                <FreshnessBadge freshness={p.freshness} age={p.age} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : null}

    <Section
      title="Actions status"
      state={view.actionsSection}
      count={view.runs.length}
      empty="no runs recorded"
    />
    {view.runs.length > 0 ? (
      <table>
        <thead>
          <tr>
            <th>Workflow</th>
            <th>Result</th>
            <th>Branch</th>
            <th>Last confirmed</th>
          </tr>
        </thead>
        <tbody>
          {view.runs.map((r) => (
            <tr key={`run-${r.workflowName}-${r.runNumber}`}>
              <td>
                {r.htmlUrl ? (
                  <a href={r.htmlUrl}>{r.workflowName}</a>
                ) : (
                  r.workflowName
                )}{" "}
                <span class="why">#{r.runNumber}</span>
              </td>
              <td class={r.conclusion === "failure" ? "crit" : ""}>
                {/* A run still going has no conclusion yet, which is a state
                    to show rather than a gap to paper over. */}
                {r.conclusion ?? `${r.status}, no result yet`}
              </td>
              <td>{r.headBranch ?? "unknown"}</td>
              <td>
                <FreshnessBadge freshness={r.freshness} age={r.age} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : null}

    <Section
      title="Untriaged issues"
      state={view.issueSection}
      count={view.issues.length}
      empty="none open"
    />
    {view.issues.length > 0 ? (
      <table>
        <thead>
          <tr>
            <th>Issue</th>
            <th>Opened by</th>
            <th>Last confirmed</th>
          </tr>
        </thead>
        <tbody>
          {view.issues.map((i) => (
            <tr key={`issue-${i.number}`}>
              <td>
                {i.htmlUrl ? (
                  <a href={i.htmlUrl}>#{i.number}</a>
                ) : (
                  `#${i.number}`
                )}{" "}
                {i.title}
              </td>
              <td>{i.author}</td>
              <td>
                <FreshnessBadge freshness={i.freshness} age={i.age} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : null}

    <Section
      title="Review requests"
      state={view.reviewSection}
      count={view.reviews.length}
      empty="none waiting on you"
    />
    {view.reviews.length > 0 ? (
      <table>
        <thead>
          <tr>
            <th>Pull request</th>
            <th>Opened by</th>
            <th>Also asked</th>
            <th>Last confirmed</th>
          </tr>
        </thead>
        <tbody>
          {view.reviews.map((r) => (
            <tr key={r.key}>
              <td>
                {r.htmlUrl ? (
                  <a href={r.htmlUrl}>#{r.number}</a>
                ) : (
                  `#${r.number}`
                )}{" "}
                {r.title}
              </td>
              <td>{r.author}</td>
              <td>
                {r.requestedReviewers.length > 1
                  ? `${r.requestedReviewers.length - 1} others`
                  : "just you"}
              </td>
              <td>
                <FreshnessBadge freshness={r.freshness} age={r.age} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : null}

    <p class="policy-note">
      Every value carries its own freshness, because each lane confirms on its
      own cadence. A section that no lane has vouched for says so rather than
      showing an empty table.
    </p>
  </Layout>
);

/** Shown for a repository that is not in repos.yaml, which is the universe. */
export const UnknownRepoPage: FC<{ slug: string }> = ({ slug }) => (
  <Layout title="gitricorder · unknown repository">
    <h1>{slug}</h1>
    <p class="never">
      This repository is not in the watched set, so nothing has ever been
      collected for it. Add it to repos.yaml to start collecting.
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
  <Layout title="gitricorder reviews">
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
      {" · rendered "}
      {generatedAt}
    </p>

    {view.unreadable > 0 ? (
      <p class="failed">
        {view.unreadable} stored {view.unreadable === 1 ? "row" : "rows"} could
        not be read and {view.unreadable === 1 ? "is" : "are"} not shown. This
        list is incomplete.
      </p>
    ) : null}

    {view.attested && view.rows.length === 0 ? (
      <p class="none">Nothing waiting on you.</p>
    ) : null}

    {view.rows.length > 0 ? (
      <table>
        <thead>
          <tr>
            <th>Pull request</th>
            <th>Opened by</th>
            <th>Also asked</th>
            <th>Last confirmed</th>
          </tr>
        </thead>
        <tbody>
          {view.rows.map((r) => (
            <tr key={r.key}>
              <td>
                {r.htmlUrl ? (
                  <a href={r.htmlUrl}>
                    {r.repo}#{r.number}
                  </a>
                ) : (
                  `${r.repo}#${r.number}`
                )}
                {r.watched ? null : (
                  // Said on every row rather than once at the top: this
                  // repository has no coverage, no alert sweep and no
                  // freshness behind it beyond this one line.
                  <span class="badge unknown"> not watched</span>
                )}
                <div class="why">{r.title}</div>
              </td>
              <td>{r.author}</td>
              <td>
                {r.requestedReviewers.length > 1
                  ? `${r.requestedReviewers.length - 1} others`
                  : "just you"}
              </td>
              <td>
                <FreshnessBadge freshness={r.freshness} age={r.age} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    ) : null}

    <p class="policy-note">
      Review requests are collected wherever they land, not only in watched
      repositories, because a request is a claim on your attention either way.
      Rows marked not watched carry nothing else from this dashboard: no alerts,
      no coverage, no build status.
    </p>
  </Layout>
);
