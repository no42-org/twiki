/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

/* biome-ignore-all lint/a11y/noRedundantRoles: the table roles are implied by the elements at desktop width only; the phone cards restyle them to `display: block`, and a browser then drops the implied role. Stating it survives that (EXPERIENCE.md Accessibility Floor). */

import type { Child, FC, PropsWithChildren } from "hono/jsx";
import { FEATURE_LABELS, joinNotes } from "../../core/coverage.js";
import { isBrokenVerdict, type RunVerdict } from "../../core/run-verdict.js";
import { safeUrl } from "../../core/safe-url.js";
import type { Tier } from "../../core/tier.js";
import { TOPICS, type Topic } from "../../core/topics.js";
import type { SectionState } from "../attention/attestation.js";
import type { Freshness } from "../attention/freshness.js";
import { overviewPath } from "../attention/links.js";
import type { RepoView } from "./repo-view.js";
import { repoTitle, unknownRepoTitle } from "./titles.js";
import { RADIUS, SPACE, TOKEN_STYLE, TYPE } from "./tokens.js";

// The repository page: server-rendered tables with no client-side layer,
// deliberately, because nothing here needs partial updates. The overview has
// its own page in overview-page.tsx.
//
// Colors, sizes and spacing come from tokens.ts. Rules here name tokens only,
// so the contrast test in test/tokens.test.ts covers every text color the page
// can paint, including muted text over the hatch stripes. The one painted
// color in no pair is the border rule, which is decorative. No hex, no px for
// text, no shadow: the dashboard is an instrument.
//

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
  td.num, .badge { overflow-wrap: normal; white-space: nowrap; }
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
  .count.critical { color: var(--critical); }
  .count.unconfirmed { color: var(--muted); font-style: italic; }
  .label { display: block; font-size: ${TYPE.label.size}; font-weight: ${TYPE.label.weight}; line-height: ${TYPE.label.lineHeight}; letter-spacing: ${TYPE.label.tracking}; text-transform: uppercase; color: var(--link); text-decoration: underline; }
  .slug { font-weight: 600; }
  .chip { display: inline-block; min-width: 24px; min-height: 24px; box-sizing: border-box; padding: 3px 6px; border-radius: ${RADIUS.sm}; font-size: ${TYPE.small.size}; line-height: ${TYPE.small.lineHeight}; font-variant-numeric: tabular-nums; }
  .chip.zero { color: var(--muted); }
  .chip.critical { color: var(--critical); font-weight: 700; }
  .chip.high { color: var(--high); font-weight: 400; }
  .chip.uncovered { color: var(--warn); font-style: normal; text-decoration: underline dotted; }
  .chip.unconfirmed { color: var(--muted); font-style: italic; }
  .chip.untracked { color: var(--muted); font-style: normal; border: 1px dashed var(--muted); }
  .attest { color: var(--muted); font-size: ${TYPE.small.size}; line-height: ${TYPE.small.lineHeight}; font-style: italic; margin: ${SPACE[2]} 0 0; }
  .attest.warn { color: var(--warn); }
  .shown { color: var(--muted); font-size: ${TYPE.small.size}; font-weight: 400; line-height: ${TYPE.small.lineHeight}; }
  .crumb { color: var(--muted); font-size: ${TYPE.small.size}; margin-bottom: ${SPACE[2]}; }
  .crumb a { margin-right: 0; }
  .topic { font-size: ${TYPE.label.size}; font-weight: ${TYPE.label.weight}; line-height: ${TYPE.label.lineHeight}; letter-spacing: ${TYPE.label.tracking}; text-transform: uppercase; color: var(--muted); }
  @media (max-width: 639px) {
    .count.unconfirmed, .count.never { font-size: ${TYPE.small.size}; line-height: ${TYPE.small.lineHeight}; }
    table.cards, table.cards tbody, table.cards tr, table.cards td { display: block; }
    table.cards thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
    table.cards tr { border-bottom: 1px solid var(--border); padding: ${SPACE[3]} 0; }
    table.cards td { border: 0; padding: 2px 0; text-align: left; }
    table.cards .lbl { display: inline; font-size: ${TYPE.label.size}; font-weight: ${TYPE.label.weight}; line-height: ${TYPE.label.lineHeight}; letter-spacing: ${TYPE.label.tracking}; text-transform: uppercase; color: var(--muted); margin-right: ${SPACE[1]}; }
  }
`;

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
    current: "overview" | null;
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

const REPO_POLICY =
  "Every value carries its own freshness, because each lane confirms on its own cadence. A section that no lane has vouched for says so rather than showing an empty table.";

/** The one skip link on every page but the overview; `#list` exists on each. */
const LIST_SKIP = [{ href: "#list", label: "skip to list" }] as const;

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

/**
 * What this page calls each scanner's findings, in prose.
 *
 * Built from `FEATURE_LABELS`, which is the one place a feature is named for
 * a reader, so the sentences below cannot drift from the coverage notes
 * beside them. The head noun differs per feature because the things differ -
 * a scanner produces findings, secret scanning produces alerts - and the
 * column headings above the tables are the same two nouns capitalised.
 *
 * `leaked secrets` used to be a fifth name for the third feature, appearing
 * nowhere else on the page and in four tests only as a string asserted
 * absent. One noun per feature, learned once.
 */
const CODE_SCANNING_NOUN = `${FEATURE_LABELS.code_scanning} findings`;
const SECRET_SCANNING_NOUN = `${FEATURE_LABELS.secret_scanning} alerts`;

/**
 * What the Security section may claim when it has no rows.
 *
 * The section lists three kinds, and a kind can be missing for three
 * different reasons of which only one is a measurement:
 *
 *   we looked and found none      a zero, and the only thing this sentence
 *                                 may name
 *   coverage withdrew it          we were not allowed to look
 *   no completed sweep vouched    nothing looked
 *
 * A kind is named here only in the first case. The other two are absences of
 * evidence, and "no code scanning findings in this repository" over a lane
 * that has never run is the confident zero this page exists to refuse
 * (AD-28) - it was doing exactly that for any repository whose Dependabot
 * lane had confirmed and whose scanner lanes had not. Both absences carry
 * their own paragraph below the tables, so dropping the kind from this
 * sentence loses the reader nothing.
 *
 * The alert half of the attestation test is redundant today and is written
 * anyway: `SectionBody` renders this string only when `state.attested`, which
 * IS the alert lane's confirmation, so that term cannot currently be false
 * here. Verified by reading that branch, not assumed - and a reader of this
 * function should not have to know it to see the rule.
 */
function securityEmpty(view: RepoView): string {
  const measured = [
    view.alertsWithdrawn || !view.summary.attested ? null : "open alerts",
    view.codeScanningWithdrawn || !view.codeScanningAttested
      ? null
      : CODE_SCANNING_NOUN,
    view.secretScanningWithdrawn || !view.secretScanningAttested
      ? null
      : SECRET_SCANNING_NOUN,
  ].filter((kind): kind is string => kind !== null);
  // Reachable, and the common shape of a young estate: Dependabot confirmed
  // off while both scanners are covered and neither lane has swept yet. The
  // whole-section suppression does not fire there, because `securityStanding`
  // reads a covered scanner as `counted`.
  return measured.length === 0
    ? "nothing here is measured: every kind this section lists is either not" +
        " covered or not yet swept"
    : `no ${measured.join(" or ")} in this repository`;
}

/**
 * What the section is not listing BECAUSE COVERAGE WITHDREW IT, named. Empty
 * when it lists all three kinds.
 *
 * The sentence these names go into says "not collected", never "switched
 * off", and the difference is the point. The flags behind them are `isOff`,
 * which is positive evidence that a feature is not covered - and that covers
 * `unreachable`, `archived` and `repo_disabled` as well as `feature_off`. A
 * repository whose probe answered `403 Resource not accessible by
 * integration` may have the feature perfectly on and our token merely short
 * of scope, and telling its operator a switch is off sends them to a setting
 * that is fine. "Not collected" is true of every one of those states, because
 * it describes what THIS page did rather than what GitHub is doing.
 *
 * Nor "not covered", which is the count chip's own word for a different fact:
 * there it means every counted feature is off and the whole section is
 * suppressed, and reusing it for one feature would make the two read as one
 * state. WHICH state it is rides in the header's sub-line, where every
 * coverage answer for this repository already is.
 */
function securityWithheld(view: RepoView): string[] {
  return [
    view.alertsWithdrawn ? FEATURE_LABELS.dependabot : null,
    view.codeScanningWithdrawn ? CODE_SCANNING_NOUN : null,
    view.secretScanningWithdrawn ? SECRET_SCANNING_NOUN : null,
  ].filter((kind): kind is string => kind !== null);
}

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
            // All three kinds, because the heading's `N shown` must equal the
            // rows under it: three tables, one section, one count.
            count={
              view.alerts.length +
              view.codeScanning.length +
              view.secretScanning.length
            }
            // The Dependabot rows only: the heading's badge is that lane's.
            attestedCount={view.alerts.length}
            empty={securityEmpty(view)}
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
            {/* Its own table again, and for the sharper version of the same
              reason: a secret has no package, no severity and no ref, and
              the two columns that matter - what leaked and whether the token
              still works - are on neither table above. The display name is
              the only name of the finding that ever reaches this page; the
              credential was never mapped, stored or logged (#158). */}
            {view.secretScanning.length === 0 ? null : (
              <table class="cards" role="table">
                <thead role="rowgroup">
                  <tr role="row">
                    <Th>Secret scanning</Th>
                    <Th>Type</Th>
                    <Th>Validity</Th>
                    <Th>Last confirmed</Th>
                  </tr>
                </thead>
                <tbody role="rowgroup">
                  {view.secretScanning.map((sec) => (
                    <tr key={`secret-${sec.number}`} role="row">
                      <Td label="Secret scanning">
                        <ExternalLink href={sec.htmlUrl}>
                          #{sec.number}
                        </ExternalLink>
                        {/* Only where GitHub REPORTED it. Null, false and
                          absent are the other three states and none of them
                          is a report of a public leak. */}
                        {sec.publiclyLeaked ? " · publicly leaked" : ""}
                      </Td>
                      <Td label="Type" show>
                        {sec.secretType ?? "unknown"}
                      </Td>
                      <Td label="Validity" show>
                        {sec.validity}
                      </Td>
                      <Td label="Last confirmed">
                        {/* The section header attests the Dependabot lane, so
                          these rows carry their own standing, exactly as the
                          code scanning rows above do (AD-28). */}
                        {view.secretScanningAttested ? (
                          <FreshnessBadge
                            freshness={sec.freshness}
                            age={sec.age}
                          />
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
          {/* A feature confirmed off has its rows dropped from the tables
            above, exactly as the chip drops them from its count. Saying so
            is the difference between a row that is absent and one we
            withheld; the reason itself is in the header's sub-line, where
            every coverage answer for this repository already is. */}
          {securityWithheld(view).length === 0 ? null : (
            <p class="attest">
              {securityWithheld(view).join(" and ")} not listed: not collected
              for this repository, for the reason above
            </p>
          )}
          {/* Which of the listed findings the queue declines to rank, said
            once, about the queue and about NOTHING ELSE.
            
            It used to end "and the count above does not include them", which
            was wrong twice over: the count directly above is the section
            heading's `N shown`, which counts every row in these tables and
            therefore does include them; and the page header's `N open alerts`
            excludes them only while a queue item survives to be counted, so
            in the fallback case - where the header reads the lanes' own
            confirmations - it includes them too. No claim about a count is
            the only claim that is true in both. */}
          {view.codeScanning.filter((c) => !c.onDefaultBranch).length ===
          0 ? null : (
            <p class="attest">
              {view.codeScanning.filter((c) => !c.onDefaultBranch).length} of
              these are not on the default branch, so the queue does not rank
              them
            </p>
          )}
          {/* The section's heading attests the Dependabot lane alone, which is
            deliberate (#156). This is what stops that heading speaking for a
            lane it never ran: with no `repository_code_scanning`
            confirmation, code scanning is unconfirmed here, and the absence
            of findings above must not read as a measured zero (AD-28). */}
          {/* The LANE's silence, which is a different fact from the
            FEATURE's - coverage says whether GitHub is scanning at all, this
            says whether anything of ours has looked. Withheld once the
            paragraph above has already said the feature's rows are not
            collected here, because two paragraphs about one feature is
            noise rather than honesty, and the overview's chip withholds the
            same note under the same condition. */}
          {view.codeScanningAttested || view.codeScanningWithdrawn ? null : (
            <p class="attest">
              {FEATURE_LABELS.code_scanning}: not confirmed by any completed
              sweep
            </p>
          )}
          {/* And the same for the third lane, under the same two conditions
            (#158): with no `repository_secret_scanning` confirmation nothing
            has swept this repository for credentials and an empty table must
            not read as a measured zero (AD-28) - unless the feature is
            withdrawn, in which case the paragraph above has already said so
            and this one would repeat it. */}
          {view.secretScanningAttested ||
          view.secretScanningWithdrawn ? null : (
            <p class="attest">
              {FEATURE_LABELS.secret_scanning}: not confirmed by any completed
              sweep
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
      return (
        <Section
          topic={topic}
          state={view.pullsSection}
          count={view.pulls.length}
          empty="no open pull requests in this repository"
        >
          <table class="cards" role="table">
            <thead role="rowgroup">
              <tr role="row">
                <Th>PR</Th>
                <Th>Title</Th>
                <Th>Opened by</Th>
                <Th>Last confirmed</Th>
              </tr>
            </thead>
            <tbody role="rowgroup">
              {view.pulls.map((p) => (
                <tr key={`pull-${p.number}`} role="row">
                  <Td label="PR">
                    <ExternalLink href={p.htmlUrl}>#{p.number}</ExternalLink>
                  </Td>
                  <Td label="Title" show>
                    {p.title}
                  </Td>
                  <Td label="Opened by" show>
                    {p.author}
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
      <ReleaseSection view={view} />
    </section>
  </Layout>
);

/**
 * What would go into a release (#196). Its own component and not a `Section`:
 * Release is not a Topic, so it has no queue filter and no label in TOPICS.
 * Every state says which absence it is; `unconfirmed` never reads as
 * "nothing to release" (AD-28).
 */
const ReleaseSection: FC<{ view: RepoView }> = ({ view }) => {
  const r = view.releaseSection;
  const verdict = r.verdict;
  return (
    <>
      <h2 id="release">
        Release{" "}
        {r.cell.state === "not-tracked" ? null : (
          <FreshnessBadge freshness={r.freshness} age={r.age} />
        )}
      </h2>
      {r.cell.state === "not-tracked" ? (
        <p class="attest">Not tracked: release: false in repos.yaml.</p>
      ) : verdict === null ? (
        <p class="attest">
          Release readiness has no current, complete reading for this repository
          {r.cell.state === "unconfirmed" ? ` (${r.cell.reason})` : ""}, so
          whether anything is worth releasing is unknown.
        </p>
      ) : (
        <>
          <p class="attest">
            {verdict.tag === null
              ? "no tag yet"
              : `latest tag ${verdict.tag}${r.tagAge === null ? "" : ` (${r.tagAge})`}`}
          </p>
          {verdict.truncated ? (
            <p class="attest warn">
              More commits exist than were read, so the improvements below are a
              lower bound.
            </p>
          ) : null}
          {!verdict.ready ? (
            <p class="attest">
              {verdict.tag === null
                ? "Nothing worth releasing yet."
                : `Nothing worth releasing since ${verdict.tag}.`}
            </p>
          ) : (
            <>
              {verdict.securityFixes.length === 0 ? null : (
                <table class="cards" role="table">
                  <thead role="rowgroup">
                    <tr role="row">
                      <Th>Security fix</Th>
                      <Th>Package</Th>
                      <Th>Severity</Th>
                      <Th>Fixed</Th>
                    </tr>
                  </thead>
                  <tbody role="rowgroup">
                    {verdict.securityFixes.map((a) => (
                      <tr key={`fix-${a.number}`} role="row">
                        <Td label="Security fix">
                          <ExternalLink href={a.htmlUrl}>
                            {a.ghsaId ?? a.cveId ?? `#${a.number}`}
                          </ExternalLink>
                        </Td>
                        <Td label="Package" show>
                          {a.packageName ?? "unknown"}
                        </Td>
                        <Td label="Severity" show>
                          {a.severity}
                        </Td>
                        <Td label="Fixed" show>
                          {a.fixedAt.slice(0, 10)}
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {verdict.improvements.length === 0 ? null : (
                <table class="cards" role="table">
                  <thead role="rowgroup">
                    <tr role="row">
                      <Th>Improvement</Th>
                      <Th>Kind</Th>
                      <Th>Commit</Th>
                    </tr>
                  </thead>
                  <tbody role="rowgroup">
                    {verdict.improvements.map((c) => (
                      <tr key={`commit-${c.sha}`} role="row">
                        <Td label="Improvement">{c.subject}</Td>
                        <Td label="Kind" show>
                          {c.kind}
                        </Td>
                        <Td label="Commit" show>
                          <ExternalLink href={c.url}>
                            {c.sha.slice(0, 7)}
                          </ExternalLink>
                        </Td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </>
      )}
    </>
  );
};

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
