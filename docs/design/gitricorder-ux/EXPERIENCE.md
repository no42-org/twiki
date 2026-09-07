---
name: gitricorder
version: 1.0.0
status: final
sources:
  - live deployment https://twiki.app.labmonkeys.space/ (inspected 2026-09-07)
  - src/tricorder/web/ (routes, queue ranking, repo view, review view)
  - AGENTS.md (architecture and honesty conventions)
updated: 2026-09-07
---

# gitricorder: Experience Spine

`DESIGN.md` is the visual identity reference.
Token names in braces below resolve there.
This spine owns information architecture, behavior, states and flows.
Both spines win over any mock on conflict.

## What changes from the deployed page

For the architect and story writers. Everything not listed here is unchanged from the deployment inspected on 2026-09-07.

- The repositories page becomes an overview: six topic tiles, repos ranked into `now`, `soon` and `quiet` tiers, quiet repos collapsed into one block, a tier legend.
- The queue gains topic and repo filters as query parameters, and three new item kinds: CI failures, plain pull requests, and code scanning and secret scanning alerts.
- Every GitHub link opens in a new tab with a visible marker and an announced name.
- The repo page gains a breadcrumb, a page summary, a tier chip, and section titles renamed to the topic vocabulary, with one new section, Pull requests.
- Document titles, landmarks, skip links, ARIA roles on phone cards, 24px hit areas and a rem type ramp are new on every page.
- Every color gets a dark value.

## Foundation

Multi-surface responsive web: desktop browser, tablet and phone, one HTML document per page.
Server-rendered with hono/jsx, no UI framework, no client-side JavaScript required for any behavior in this spine.
Every page renders fully offline inside a distroless image and makes zero network fetches.
Filtering and grouping are expressed as query parameters, so every view is a plain URL that a notification can deep-link to.
`[ASSUMPTION]` Progressive enhancement is allowed for conveniences only; nothing below depends on it.

Audience: one application maintainer who works on GitHub.
A notification in a messaging channel (Matrix today) pulls the maintainer's attention.
gitricorder is where that person lands to orient, then leaves for GitHub to act, then returns.
The dashboard is read-only and never mutates GitHub.

Scale target: up to 100 watched repositories across several organizations.

## Information Architecture

### Surfaces

| Surface | Path | Reached from | Purpose |
|---|---|---|---|
| Overview | `/` | Nav, notification link | Which repositories need attention, ranked. Topic tiles on top. |
| Queue | `/queue`, `/queue?topic=…`, `/queue?repo=…` | Nav, topic tile, repo row | What to deal with next across the estate, one ranked list, filterable by topic and repo. |
| Repo page | `/repo/:owner/:name` | Overview row, queue row, notification link | Everything known about one repository, grouped by topic in urgency order. |
| Reviews | `/reviews` | Nav, Reviews topic tile | Review requests waiting on the maintainer, including repositories outside the allowlist. |
| Collection health | `/` bottom section | Overview | Whether the numbers above can be trusted: lane, last run, outcome. |

Link behavior is owned by Component Patterns (Nav bar, Breadcrumb, External link, Queue row).

### Attention tiers

Computed per repository from its worst open item, using the existing rank chain (KEV, EPSS band, severity, bump size, stuck):

| Tier | Meaning | Enters when |
|---|---|---|
| `now` | Act today | Any item is KEV-listed, of critical severity or a secret scanning alert, or the default-branch workflow is red or stalled |
| `soon` | Act this week | Any high or medium alert, a stuck dependency-update PR, a review request waiting longer than the review budget, or a failed non-default-branch workflow |
| `quiet` | Nothing pressing | Only untriaged issues, low alerts, or nothing open |

Critical severity alone is enough for `now`.
A stale KEV catalogue changes the rationale, not the tier.
`[ASSUMPTION]` The tier boundaries above are a first cut derived from the current rank chain. The review budget is unspecified; suggest 3 days.

### Overview ordering

`now` repos first, then `soon`, each ordered by the rank chain, then the quiet block.
At 100 repositories with a typical estate the board is one screen of rows plus a short quiet block.
A one-line legend sits under the board: `now: act today · soon: act this week · quiet: nothing pressing`.

### Document titles

Spoken first by a screen reader after following a notification link:

| Surface | `<title>` |
|---|---|
| Overview | `2 now, 6 soon · gitricorder` or `nothing pressing · gitricorder` |
| Queue | `queue · dependencies · gitricorder`; `queue · gitricorder` when unfiltered |
| Repo page | `riptide-labs/riptide · soon · gitricorder` |
| Reviews | `reviews · 2 waiting · gitricorder` |

### Topic vocabulary

Used identically in tiles, query parameters, repo-page section titles and queue filter labels, in this order:

| Topic | `topic=` | Contains |
|---|---|---|
| Security | `security` | Dependabot alerts, code scanning alerts, secret scanning alerts |
| CI | `ci` | Failed or stalled workflow runs on the default branch |
| Dependencies | `dependencies` | Dependency-update pull requests (Dependabot, Renovate) |
| Pull requests | `pulls` | Open pull requests that are not dependency updates |
| Issues | `issues` | Untriaged issues |
| Reviews | `reviews` | Review requests addressed to the maintainer |

These six words replace the five existing repo page section titles `Security alerts`, `Actions status`, `Dependency-update pull requests`, `Untriaged issues` and `Review requests`.
Pull requests is new.
`[ASSUMPTION]` Code scanning, secret scanning, plain pull requests and CI failures are not in the queue store today. The spine treats them as queue kinds; the collectors are an architecture concern.

→ Composition reference: `mockups/key-overview.html` (desktop and phone frames of the overview), `mockups/key-queue.html` (queue filtered to dependencies), `mockups/key-repo.html` (repo page, desktop and phone).

## Voice and Tone

Microcopy. Brand voice lives in `DESIGN.md` Brand & Style.

| Do | Don't |
|---|---|
| "What to deal with next" | "Your action items" |
| "3 repositories need attention now" | "3 critical repositories!" |
| "not confirmed by any completed sweep" | an empty table |
| "Dependabot alerts are switched off for this repository" | "0 alerts" |
| "KEV catalogue 2026.09.04 · 18h ago" | "Up to date" |
| "17 repositories are quiet" | "17 repositories are healthy" |
| "Nothing needs attention." and "Nothing waiting on you." (existing) | "All clear!" |
| Rank rationale as one plain sentence: "in CISA KEV, severity critical, update stuck 12d" | A numeric score |
| Lowercase nav and tier words: `overview`, `now`, `soon`, `quiet` | Title-case buttons and exclamation marks |

The dashboard states what it knows and how it knows it.
It never claims a repository is healthy, only that nothing pressing is known.

## Component Patterns

Behavioral. Visual specs live in `DESIGN.md` Components under the same names, in the same order.

| Component | Use | Behavioral rules |
|---|---|---|
| Focus ring | Every focusable element | Always visible on keyboard focus. Never the only change of state. |
| Nav bar | Every page | `<nav aria-label="primary">`. Current page marked `aria-current="page"`; on a repo page no nav item is current and the breadcrumb names the parent. Sticky on phone only, with `scroll-padding-top` set so anchored headings are never hidden under it. |
| Page summary | Overview, repo page, queue | Overview counts tiers: `20 watched repositories · 2 need attention now · 6 soon · 12 quiet`. Repo page states open alerts and worst severity: `2 open alerts, worst high`. Queue keeps the existing counts and KEV catalogue line. Real text, never `title` only. |
| Topic tile | Overview top | One link per topic to `/queue?topic=…`; the Reviews tile links to `/reviews`. Count is the number of open items in that topic across all repos. The `now` marker appears when any of those items belongs to a `now` repo, and reads how many: `5 · 1 now`. Tiles wrap into a grid, never a horizontal scroller. |
| Tier chip | Overview row, repo page header | Text `now`, `soon` or `quiet`, preceded by visually hidden `attention tier:`. The meaning is visible once per page in the legend line under the board. `title` may repeat it but is never the sole carrier. Not interactive. |
| Freshness badge | Every table and header | Unchanged behavior: derived from verified time and lane cadence. `title` holds the exact age and the visible text holds the rounded age. |
| Count chip | Overview row, repo page sections | Reads the worst severity and a count: `2 high`, `1 critical`, `0`, `not covered`, `unconfirmed`. `0` is only shown when a completed sweep attested zero. `unconfirmed` replaces the existing `not collected` word and is never rendered as `0`. `not covered` and `unconfirmed` carry the reason as a visible attestation note on the repo page; `title` is never the sole carrier of the reason. |
| External link | Anywhere | `target="_blank" rel="noopener noreferrer"`, visible `↗` marked `aria-hidden`, accessible name ends with "opens GitHub in a new tab". |
| Repo row | Overview | Slug links to the repo page. Each non-zero count chip links to `/queue?repo=owner/name&topic=…`. The rationale line names the single worst item and why, in a cell headed `why` (visually hidden header). Rows never expand inline. Tablet `signals` cell: a wrapped list of the non-zero chips, each prefixed by its topic word, `Security 2 high · Dependencies 1 · Issues 3`; zero and unconfirmed chips move to the rationale line. |
| Quiet block | Overview | Lead sentence `N repositories are quiet`, then every quiet slug as a link. Collapsed by default under a native `<details>` on phone, open on desktop. |
| Queue row | Queue | Rank number, topic word, slug link (internal), item reference link (external, new tab), title, rank rationale, freshness. Filter state shown as a sentence above the table: `Security items in riptide-labs/riptide · 2 shown · clear`. |
| Filter bar | Queue | `<nav aria-label="topic filter">` with `all` plus the six topics in vocabulary order. Current filter marked `aria-current="true"`. Query parameters only; no client script. |
| Breadcrumb | Repo page | `<nav aria-label="breadcrumb">`. Overview link internal, current repo plain text. |
| Repo page section | Repo page | Fixed order, the six topics in vocabulary order. Each header carries its own freshness badge and `N shown`. Empty sections render an attestation note, never nothing. Columns: Security `Alert · Severity · Package · Last confirmed`; CI `Workflow · Result · Branch · Last confirmed`; Dependencies `PR · Package · Linked alert · Last confirmed`; Pull requests `PR · Title · Opened by · Last confirmed`; Issues `Issue · Opened by · Last confirmed`; Reviews `PR · Requested from · Waiting · Last confirmed`. First column is the external link. |
| Review row | Reviews | Slug is an internal link only when the repo is watched; `not watched` badge otherwise. Item reference external. Sorted oldest request first, unchanged from today. |
| Attestation note | Any empty or partial section | Sentence explaining absence: switched off, not collected, not confirmed by a completed sweep, or KEV catalogue unavailable. Takes the `warn` variant when it warns that a count may be low. |
| Policy note | Queue, repo page foot | Existing paragraph, unchanged. Wrapped in the `contentinfo` landmark. |
| Collection health table | Overview bottom | One row per lane and installation. Failed and stalled rows appear first. |

→ Composition reference: every row above except Review row and Policy note is illustrated in `mockups/key-overview.html`, `mockups/key-queue.html` or `mockups/key-repo.html`. The Reviews surface is unchanged and has no mock.

## State Patterns

| State | Surface | Treatment |
|---|---|---|
| Everything quiet | Overview | Every tile shows a `muted` zero. Board reads `No repository needs attention right now.` followed by the quiet block and the freshness of the newest sweep. |
| Nothing collected yet | Overview, Queue, Reviews | Tiles show `never collected`. Board is replaced by one attestation note pointing at the Collection health table. Queue and Reviews keep the existing `not confirmed by any completed sweep` header state. |
| Empty unfiltered list | Queue, Reviews | Existing sentences, unchanged: `Nothing needs attention.` and `Nothing waiting on you.` |
| Filter with no matches | Queue | `No security items open. Clear filter.` where the second sentence is the link. |
| Unknown filter value | Queue | `?topic=` or `?repo=` outside the vocabulary or the allowlist renders the no-matches sentence with the clear link, status 200, never 500. |
| Store rows unreadable | Overview, Queue, Repo page, Reviews | Existing sentence kept and shown above the list: `N stored items could not be read and are not shown. This list is incomplete.` On the overview it also sits under the page summary so tier counts are not read as complete. |
| Rows without an attesting sweep | Repo page section | Rows are shown with their own stale badges under a `warn` attestation note: `N collected earlier; the latest sweep did not confirm them` (existing sentence). |
| KEV catalogue stale | Queue, Repo page Security | Existing subhead sentence retained: `KEV catalogue unavailable, so KEV status ranks as unknown`. Tier computation treats KEV as unknown; critical severity still promotes to `now` on its own. |
| Lane failed or stalled | Overview | Topic tile for the affected topic gets a `warn` attestation line: `alerts sweep failed 3h ago; counts may be low`. |
| Repo not covered for a topic | Overview row, Repo page | Count chip reads `not covered`; repo page section shows the reason as an attestation note. |
| Unknown repo | `/repo/…` | Existing 404 page. Adds a link back to overview. |
| Repo outside allowlist with review request | Reviews | Existing `not watched` badge; slug is not a link to a repo page because there is none. |
| Stale everything | Every page | Freshness badges go `stale`; no banner. Rendered-at line stays honest. |
| Clock skew | Any badge | Existing behavior: `stale` with the skew explanation in `title` and the visible text `stale · clock skew`. |

→ Composition reference: `mockups/key-overview.html` shows Lane failed, Repo not covered and Stale everything; `mockups/key-queue.html` second frame shows Filter with no matches; `mockups/key-repo.html` shows Rows without an attesting sweep.

## Interaction Primitives

Mouse and touch first, keyboard fully equivalent.

- Every navigation is a plain link. Slug, tile and chip stay in the tab. An item reference opens GitHub in a new tab and leaves gitricorder, including its scroll position, untouched.
- Browser back always returns to the previous gitricorder view with its filter intact, because filter state lives in the URL.
- `Tab` walks rows in reading order. A `now` row has up to seven stops (slug, six chips, nothing else). The skip links exist so a keyboard user can pass a 100-row board in one keystroke.
- Every interactive target is at least 24px by 24px, including count chips and filter links, on every surface.

Banned everywhere: automatic page refresh that resets scroll, infinite scroll, hover-only affordances, modals, client-side routing, any control that requires JavaScript, horizontal scrolling of the page body, and any link to GitHub that replaces the gitricorder tab.

`[ASSUMPTION]` Auto-refresh is banned rather than specified. If wanted later, it must preserve scroll and filter and is out of scope here.

## Accessibility Floor

Behavioral. Contrast targets live in `DESIGN.md` Colors. This section is the audit checklist; where a rule is also on a component row, this list wins on wording.

- WCAG 2.2 AA on all surfaces, light and dark.
- Every table has `<th scope="col">`. When a table is restyled with any `display` other than `table` (the phone cards), every `table`, `tr`, `th` and `td` carries the matching explicit ARIA role (`table`, `row`, `columnheader`, `cell`) so semantics survive. Every cell keeps its header text as a visible label, or a visually hidden one when the content already names itself. No cell is exempt.
- Tier and severity are always a word plus a color, never a color alone. The tier legend is visible text once per page.
- External links announce their behavior: accessible name pattern `riptide#17, opens GitHub in a new tab`.
- Landmarks: `primary` nav, `breadcrumb` nav, `topic filter` nav, `main`, and `contentinfo` for the policy note.
- Every page has skip links, visible on focus, in this order: `skip to board` (overview) or `skip to list` (other pages), `skip to quiet repositories` (overview), `skip to collection health` (overview). Each targets the heading of that block, not the top of `main`.
- The rendered-at time and every attestation reason are real text, never only a `title` attribute.
- Text sizes are rem and follow the platform text size. 200% zoom on desktop and 320px viewports both reflow without horizontal scrolling.
- The rationale cell in a repo row has a header (`why`) so it is not read under `Repository`.
- No motion anywhere, so no reduced-motion handling is needed.

## Responsive & Platform

Breakpoint widths are owned by `DESIGN.md` Layout & Spacing.

| Breakpoint | Overview | Queue | Repo page |
|---|---|---|---|
| `phone` | Tiles wrap into two columns and three rows. Repo rows become cards: slug and tier on line one, count chips wrapped as inline content on the following lines, rationale last. Quiet block collapsed. | Rows become cards; rank number leads. Filter bar wraps. | Sections stack; each table becomes cards. Breadcrumb stays. |
| `tablet` | Tiles in two rows of three. Table keeps slug, tier, the `signals` cell (see Repo row), freshness. | Full table minus the freshness column, which moves into the rationale line. | Full tables. |
| `desktop` | Full table: slug, tier, six count columns, freshness, rationale beneath. Tiles in one row of six. | Full table. | Full tables. |

Phone is a first-class reading surface because the notification usually arrives there.
Acting still happens on GitHub, so gitricorder on a phone must get the maintainer to the right GitHub page in two taps: notification link to repo page, item link to GitHub.

→ Composition reference: the phone frames in `mockups/key-overview.html` and `mockups/key-repo.html`.

## Inspiration & Anti-patterns

- **Kept from the current gitricorder:** the honesty states (`not covered`, `not confirmed by any completed sweep`, hatched unknown, unreadable-rows banner), the rank rationale sentence per row, the KEV catalogue line, and the Primer-derived colors.
- **Lifted from GitHub's own notification inbox:** grouping by repository with a per-repo reason, and the rule that leaving the list opens the target in another tab.
- **Lifted from pager-style dashboards:** the three-tier vocabulary `now` / `soon` / `quiet`, and putting failed collection lanes before the numbers they would corrupt.
- **Rejected: a numeric health score per repo.** It hides the reason. The rationale sentence stays.
- **Rejected: a SPA with live updates.** It would require client JavaScript, break plain URLs and steal scroll position on refresh.
- **Rejected: separate pages per topic.** The queue with a topic filter is the same information with one URL scheme.
- **Rejected: showing all 100 repos as equal rows.** The quiet block is the scaling device.
- **Rejected: a horizontally scrolling tile strip on phones.** iOS draws no scrollbar, so the last tile would be invisible.

## Key Flows

### Flow 1: Notification on the phone (Indigo, maintainer of 20 repositories across three orgs, 07:40, phone in hand)

1. A Matrix message says a new critical Dependabot alert landed in `riptide-labs/riptide` and links to its gitricorder repo page.
2. Indigo taps the link. The tab title reads `riptide-labs/riptide · now · gitricorder`. The page opens with the breadcrumb, the slug in the `title` type size, a `now` tier chip and the summary `2 open alerts, worst critical`.
3. The Security section is first. The new alert row reads `#19 · CVE-2026-… ↗`, `critical`, package, `in CISA KEV`, `fresh · 4m ago`.
4. Indigo taps the item reference. GitHub opens in a new tab on the Dependabot alert page.
5. **Climax:** after reading the advisory Indigo switches back to the gitricorder tab. It is still on the repo page, still scrolled to Security, and the CI section directly below shows the default branch is green. Nothing to rebuild, one PR to merge later. Indigo pockets the phone.

Failure: the KEV catalogue is stale. The tier chip stays `now` because the alert is critical on its own. The Security header carries the existing sentence that KEV ranks as unknown, and the rationale reads `severity critical, KEV status unknown` instead of `in CISA KEV`.

### Flow 2: Weekly sweep on the desktop (Indigo, Monday 09:15, laptop, coffee)

1. Indigo opens the overview. Tiles read Security `5 · 1 now`, CI `1 · 1 now`, Dependencies 7, Pull requests 3, Issues 25, Reviews 2.
2. The board shows two `now` rows and six `soon` rows. Below them: `12 repositories are quiet`.
3. The first `now` row is `no42-org/blitsbom` with rationale `default branch workflow failed 2h ago`. Indigo clicks the CI count chip. The queue opens filtered to CI in blitsbom.
4. The single row links to the workflow run. Indigo opens it in a new tab, reads the log, finds a flaky test.
5. Back in the still-open gitricorder tab, Indigo clicks the Dependencies tile. The queue shows seven update PRs ranked by their linked alerts. Indigo opens the top three in new tabs with three clicks.
6. **Climax:** four GitHub tabs are open, and the gitricorder tab is exactly where it was, with the Dependencies filter in the URL. Indigo merges the three PRs on GitHub, closes those tabs, and presses reload on gitricorder. The Dependencies tile now reads 4. The sweep took ten minutes.

Failure: the alerts lane failed overnight. The Security tile shows a `warn` attestation line, and the Collection health table lists the failed lane first with its last run time. Indigo trusts the CI and PR numbers and treats the security count as a lower bound.

### Flow 3: Something that should never wait (Indigo, Wednesday 14:00, tablet)

1. A secret scanning alert is opened in `no42-org/dn42-mmdb`, a repository that was quiet this morning.
2. On the next sweep the repo enters the `now` tier. The overview row shows a `1 critical` chip under Security and the rationale `secret scanning alert, opened 12m ago`.
3. The Security tile on the overview reads `6 · 2 now`.
4. Indigo taps the row's Security chip, then the item reference. GitHub opens the secret scanning alert in a new tab.
5. **Climax:** the secret is revoked on GitHub. The gitricorder tab is still on the filtered queue. On reload the row is gone and `no42-org/dn42-mmdb` is back in the quiet block.

Failure: secret scanning is not enabled on the repository. The Security count chip reads `not covered` and the repo page Security section says so in an attestation note, so the absence is visible rather than silent.
