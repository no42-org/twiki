---
name: gitricorder
description: Read-only attention dashboard for a maintainer watching up to 100 GitHub repositories. Server-rendered HTML, no UI framework; this DESIGN.md is the complete visual contract.
version: 1.0.0
status: final
updated: 2026-09-07
colors:
  # Light values first, dark pair suffixed -dark. Derived from the GitHub Primer
  # palette so the dashboard reads as a sibling of the pages it links to.
  bg: '#FFFFFF'
  bg-dark: '#0D1117'
  surface: '#F6F8FA'
  surface-dark: '#161B22'
  fg: '#1F2328'
  fg-dark: '#E6EDF3'
  muted: '#57606A'
  muted-dark: '#8B949E'
  border: '#D0D7DE'
  border-dark: '#30363D'
  link: '#0969DA'
  link-dark: '#4493F8'
  # Signal colors. Each carries one meaning and is never decorative.
  critical: '#CF222E'
  critical-dark: '#FF7B72'
  critical-tint: '#FFEBE9'
  critical-tint-dark: '#3A1214'
  high: '#BC4C00'
  high-dark: '#F0883E'
  warn: '#9A6700'
  warn-dark: '#D29922'
  warn-tint: '#FFF8C5'
  warn-tint-dark: '#2E2A12'
  ok: '#1A7F37'
  ok-dark: '#3FB950'
typography:
  # System font only. Sizes are rem so platform text scaling applies; the px
  # in comments are documentation values at a 15px root.
  title:
    fontFamily: 'system-ui, sans-serif'
    fontSize: 1.467rem
    fontWeight: '600'
    lineHeight: '1.25'
  section:
    fontFamily: 'system-ui, sans-serif'
    fontSize: 1.133rem
    fontWeight: '600'
    lineHeight: '1.3'
  body:
    fontFamily: 'system-ui, sans-serif'
    fontSize: 1rem
    fontWeight: '400'
    lineHeight: '1.5'
  small:
    fontFamily: 'system-ui, sans-serif'
    fontSize: 0.867rem
    fontWeight: '400'
    lineHeight: '1.4'
  label:
    fontFamily: 'system-ui, sans-serif'
    fontSize: 0.867rem
    fontWeight: '600'
    lineHeight: '1.2'
    letterSpacing: 0.04em
  count:
    fontFamily: 'system-ui, sans-serif'
    fontSize: 1.467rem
    fontWeight: '600'
    lineHeight: '1'
rounded:
  sm: 4px
  md: 6px
  full: 9999px
spacing:
  '1': 4px
  '2': 8px
  '3': 12px
  '4': 16px
  '6': 24px
  '8': 32px
  gutter: 16px
  content-max: 72rem
  nav-height: 2.75rem
components:
  focus-ring:
    outline: '2px solid {colors.link}'
    offset: 2px
  nav-bar:
    background: '{colors.surface}'
    foreground: '{colors.fg}'
    border-bottom: '1px solid {colors.border}'
    active-underline: '2px solid {colors.link}'
    height: '{spacing.nav-height}'
  page-summary:
    typography: '{typography.small}'
    foreground: '{colors.muted}'
  topic-tile:
    background: '{colors.surface}'
    border: '1px solid {colors.border}'
    radius: '{rounded.md}'
    count: '{typography.count}'
    label: '{typography.label}'
    label-foreground: '{colors.link}'
    label-decoration: 'underline'
    now-marker: '{typography.label}'
    now-marker-foreground: '{colors.critical}'
  tier-chip:
    radius: '{rounded.full}'
    typography: '{typography.label}'
    now-foreground: '{colors.critical}'
    now-background: '{colors.critical-tint}'
    soon-foreground: '{colors.warn}'
    soon-background: '{colors.warn-tint}'
    quiet-foreground: '{colors.muted}'
    quiet-background: 'transparent'
    quiet-border: '1px solid {colors.border}'
  freshness-badge:
    radius: '{rounded.full}'
    typography: '{typography.small}'
    border: '1px solid currentColor'
    fresh-foreground: '{colors.ok}'
    stale-foreground: '{colors.warn}'
    stale-weight: '600'
    unknown-foreground: '{colors.muted}'
    unknown-background: 'repeating-linear-gradient(45deg, {colors.surface} 0 4px, transparent 4px 8px)'
  count-chip:
    typography: '{typography.small}'
    radius: '{rounded.sm}'
    min-hit-area: 24px
    padding: '3px 6px'
    zero-foreground: '{colors.muted}'
    some-foreground: '{colors.fg}'
    critical-foreground: '{colors.critical}'
    critical-weight: '700'
    high-foreground: '{colors.high}'
    high-weight: '400'
    unconfirmed-foreground: '{colors.muted}'
    unconfirmed-style: 'italic'
  external-link:
    foreground: '{colors.link}'
    marker: '↗'
  repo-row:
    border-bottom: '1px solid {colors.border}'
    now-left-rule: '3px solid {colors.critical}'
    soon-left-rule: '3px solid {colors.warn}'
    padding-y: '{spacing.3}'
    phone-gap: '{spacing.2}'
  quiet-block:
    background: '{colors.surface}'
    border: '1px solid {colors.border}'
    radius: '{rounded.md}'
    padding: '{spacing.4}'
    typography: '{typography.small}'
  queue-row:
    border-bottom: '1px solid {colors.border}'
    rank-typography: '{typography.small}'
    rank-foreground: '{colors.muted}'
    padding-y: '{spacing.3}'
  filter-bar:
    typography: '{typography.small}'
    foreground: '{colors.link}'
    active-foreground: '{colors.fg}'
    active-underline: '2px solid {colors.link}'
    gap: '{spacing.4}'
    min-hit-area: 24px
  breadcrumb:
    typography: '{typography.small}'
    foreground: '{colors.muted}'
    separator: '›'
  repo-page-section:
    typography: '{typography.section}'
    margin-top: '{spacing.8}'
  review-row:
    border-bottom: '1px solid {colors.border}'
    padding-y: '{spacing.3}'
    waiting-typography: '{typography.small}'
  attestation-note:
    typography: '{typography.small}'
    foreground: '{colors.muted}'
    warn-foreground: '{colors.warn}'
    style: 'italic'
  policy-note:
    typography: '{typography.small}'
    foreground: '{colors.muted}'
    margin-top: '{spacing.8}'
  collection-health-table:
    header: '{typography.label}'
    ok-foreground: '{colors.ok}'
    partial-foreground: '{colors.warn}'
    running-foreground: '{colors.warn}'
    failed-foreground: '{colors.critical}'
    stalled-foreground: '{colors.critical}'
---

## Brand & Style

gitricorder is an instrument, not a product.
It is read by one maintainer, usually in the minute after a notification arrives.
Its only job is to say which of up to a hundred repositories needs a hand right now, and why.
The visual posture is a quiet control room: mostly text, tabular numbers, a small number of strong signal colors that mean exactly one thing each, and nothing that moves or decorates.

The palette is deliberately borrowed from GitHub Primer.
Every link out of gitricorder lands on a GitHub page.
Sharing its colors for critical, high, warn and ok means the reader does not relearn the meaning of red or amber on arrival.

The dashboard already speaks in careful sentences about what it does not know: `not covered`, `not confirmed by any completed sweep`, `never collected`.
The visual system protects that honesty.
An empty section never looks clean by accident; it looks attested or it looks unknown.

## Colors

Every color exists in a light and a dark pair.
Light values apply on bare `:root`; dark values apply under `prefers-color-scheme: dark`.
Today the deployed page declares `color-scheme: light dark` but hard-codes light hex values.
That is the bug this section fixes.

- **`bg` / `surface`** are the page ground and the one raised tone used for the nav bar, topic tiles and the quiet block. No third tone.
- **`fg` / `muted`** are body text and secondary text. `muted` carries rank rationale, rendered-at timestamps, attestation notes and zero counts.
- **`border`** is the only line color. It is decorative: table rules, tile edges, the nav rule, the ring on a quiet chip. At 1.5:1 contrast it never carries meaning and never marks an interactive boundary on its own. Interactive things get an underline or a link-colored label instead.
- **`link`** is used for internal and external links alike, and for the focus ring. External links add the `{components.external-link.marker}` glyph after the text. They do not get a separate color.
- **`critical`** means act now. KEV-listed advisory, critical severity, a secret scanning alert, a red default-branch workflow. Also used on the `now` tier chip, the left rule of a `now` repo row and the `now` marker in a topic tile. `critical-tint` is its background wash and is never used without `critical` text beside it.
- **`high`** means high severity on an alert. Text only, no wash.
- **`warn`** means stale, partial or soon. Freshness badges past budget, the `soon` tier, uncovered repositories, partial lane runs, a failed-lane attestation line. `warn-tint` is its wash and is used only behind the `soon` tier chip.
- **`ok`** means fresh or zero. It is the calm color. It is never used to celebrate.

Color is never the only carrier.
Every signal color sits next to a word: `2 high`, `failed`, `stale · 3h ago`, `not covered`, `1 now`.
`high` and `warn` are metamers under deuteranopia.
`critical` and `ok` collapse under it in the dark theme.
Hue is therefore redundant by design, and weight carries the severity step alongside the word: `critical` counts are weight 700, `high` counts weight 400.

Contrast, measured with the WCAG 2.x formula on the hex values above. These numbers are the record:

| Token | Light on `bg` | Light on `surface` | Dark on `bg-dark` | Dark on `surface-dark` |
|---|---|---|---|---|
| `fg` | 15.8 | 14.8 | 16.0 | 14.6 |
| `muted` | 6.4 | 6.0 | 6.2 | 5.6 |
| `critical` | 5.4 | 5.0 | 7.5 | 6.9 |
| `high` | 5.0 | 4.7 | 7.5 | 6.8 |
| `warn` | 4.9 | 4.6 | 7.5 | 6.9 |
| `ok` | 5.1 | 4.8 | 7.4 | 6.8 |
| `link` | 5.2 | 4.9 | 6.1 | 5.6 |

All pass AA for normal text.
Wash pairs: `critical` on `critical-tint` 4.7 light and 6.5 dark; `warn` on `warn-tint` 4.52 light and 5.7 dark.
The light `warn` wash passes with no headroom. Do not lighten `warn-tint` or `warn`.
The focus ring passes 3:1 non-text contrast on both grounds in both themes (5.2 on `bg` and 4.9 on `surface` in light; 6.1 on `bg-dark` and 5.6 on `surface-dark`).

## Typography

One family, the system stack.
The image is distroless and the page must render with zero network fetches, so no web font is ever loaded.
Sizes are rem.
The root follows the platform body size (`-apple-system-body` on iOS, `1rem` elsewhere) so a user who asked for larger text gets it on every phone.
Documentation values below assume a 15px root.

| Role | Size | Use |
|---|---|---|
| `title` | 22px | Page heading, once per page. The repository slug on a repo page. |
| `section` | 17px | Section headings on the repo page, one per topic. |
| `body` | 15px | Table cells and item titles. |
| `small` | 13px | Freshness badges, attestation notes, the rendered-at line, rank rationale. |
| `label` | 13px | Uppercase table headers, topic-tile labels, tier chips. Always paired with `letterSpacing`. |
| `count` | 22px | The big number inside a topic tile. Tabular numerals. |

Rules: all numerals in tables and tiles use `font-variant-numeric: tabular-nums`.
Repository slugs are set in `body` weight 600, never in monospace.
No italics except the attestation note and the `unconfirmed` chip, where italic is the visual cue for "this is about what we know, not about the repo".
`white-space: nowrap` is allowed only on the external-link marker and the word before it.
Everything else wraps so text spacing overrides do not clip.

## Layout & Spacing

A 4px scale: 4, 8, 12, 16, 24, 32.
Content sits in a single centered column of `{spacing.content-max}` (72rem), widened from today's 60rem so a 100-row attention board fits six count columns without wrapping on a laptop.
Page gutter is `{spacing.gutter}` on every side.
The page body never scrolls horizontally at any width from 320px up.
Anything wider than the viewport wraps.

Breakpoint names and widths (behavior per breakpoint lives in EXPERIENCE.md Responsive & Platform):

| Name | Width |
|---|---|
| `phone` | < 640px |
| `tablet` | 640 to 1023px |
| `desktop` | ≥ 1024px |

Vertical rhythm: sections separated by `{spacing.8}`, rows by `{spacing.3}` of padding, tile grid gap `{spacing.3}`.
Wherever the nav bar is sticky, `html` sets `scroll-padding-top` to the rendered nav height, so a focused or fragment-targeted heading is never hidden under the bar.
Headings carry no `scroll-margin-top`; the two offsets are additive and would land a heading one bar height too low.
`{spacing.nav-height}` is the one-line height. Below about 360px the nav wraps to two lines and the offset follows the rendered height, not the token.

## Elevation & Depth

None.
There are no shadows and no layered panels.
Depth is expressed by two tones only: `bg` for content and `surface` for chrome and tiles.
A `now` or `soon` repo row is raised by a 3px left rule in its signal color, not by a shadow or a filled background.

## Shapes

`rounded.sm` (4px) on count chips, and on topic tiles on phones.
`rounded.md` (6px) on topic tiles and the quiet block.
`rounded.full` on tier chips and freshness badges, matching the existing pill badge.
Tables have square corners.
The pill is reserved for things that describe state (fresh, stale, now, soon).
Rectangles hold content.

## Components

Visual specs only. Triggers, markup and behavior live in EXPERIENCE.md Component Patterns under the same names, in the same order.

- **Focus ring.** `{components.focus-ring}`. A 2px `link` outline at 2px offset on every focusable element, both themes. Never removed, never replaced by a color change alone.
- **Nav bar.** `{components.nav-bar}`. One line, `{spacing.nav-height}` tall: `overview`, `queue`, `reviews`, then the rendered-at time right-aligned in `small` `muted`. The current page is underlined with `active-underline`. Sticks to the top on phones only.
- **Page summary.** `{components.page-summary}`. One `small` `muted` sentence under the title.
- **Topic tile.** `{components.topic-tile}`. A bordered box with a `count` number above a `label`. The label is `link` colored and underlined, so the tile reads as a link without relying on its border. A tile with a `now` item shows its number in `critical` followed by a `now-marker` word, for example `5 · 1 now`. Above zero without `now` the number is `fg`; zero is `muted`. Tiles size to their content; no fixed width.
- **Tier chip.** `{components.tier-chip}`. Pill with the words `now`, `soon` or `quiet`. `now` and `soon` sit on their tint. `quiet` has no fill and keeps a decorative 1px `border` ring. Text plus color, never color alone.
- **Freshness badge.** `{components.freshness-badge}`. Pill with a 1px `currentColor` outline reading `fresh · 2m ago`, `stale · 36h ago`, `never collected`. Stale is `warn` at weight 600 with no wash. Unknown is `muted` on the hatched `unknown-background`, the visual "we do not know". Not interactive.
- **Count chip.** `{components.count-chip}`. A short text such as `2 high`, `1 critical`, `0`, `not covered` or `unconfirmed`. Zero is `muted`. The worst severity present picks the color and weight: critical 700, high 400. `not covered` keeps the dotted underline in `warn`. `unconfirmed` is italic `muted`. When a chip is a link it is `inline-block` with `padding` `3px 6px` and a `min-hit-area` of 24px in both directions.
- **External link.** `{components.external-link}`. Link text, a thin space and `↗`, with the last word and the glyph set `nowrap`. The glyph is `aria-hidden`.
- **Repo row.** `{components.repo-row}`. Slug, tier chip, one count chip per topic, freshness badge, then a `muted` `small` rationale line. `now` rows carry `now-left-rule`, `soon` rows `soon-left-rule`, quiet rows no rule. On phones the row becomes a card whose chips wrap as inline content with `phone-gap` between lines. On tablets the six chips collapse into one `signals` cell of wrapped `small` text.
- **Quiet block.** `{components.quiet-block}`. A `surface` box with a `border`, `rounded.md` corners and `spacing.4` padding. A `body` lead sentence, then slugs as `small` links separated by `spacing.3`, wrapping freely. On phones the lead sentence is a `details` summary.
- **Queue row.** `{components.queue-row}`. Rank number in `muted` `small` tabular numerals, topic word in `label`, slug in `body` weight 600, item reference as an external link, title in `body`, rationale beneath in `muted` `small`, freshness badge right-aligned. No left rule. Urgency is carried by order and by the words in the rationale.
- **Filter bar.** `{components.filter-bar}`. One line of `small` links: `all` then the six topics in vocabulary order. The active filter is `fg` with `active-underline`; the rest are `link`. Each link has a 24px minimum hit area. Wraps on phones.
- **Breadcrumb.** `{components.breadcrumb}`. `small` `muted` line above the title: `overview › owner/name`. The first segment is a link, the last is plain text.
- **Repo page section.** `{components.repo-page-section}`. Section title in `section`, its own freshness badge beside it and `N shown` in `muted` `small`. Followed by a table or an attestation note.
- **Review row.** `{components.review-row}`. Slug in `body` weight 600, item reference as an external link, title, requested-from names in `small`, waiting age in `small` `muted`, freshness badge, and the existing `not watched` badge styled as a `muted` freshness badge.
- **Attestation note.** `{components.attestation-note}`. Italic `small` sentence. `muted` by default; `warn-foreground` when it warns that a count may be low because a lane failed.
- **Policy note.** `{components.policy-note}`. The existing `small` `muted` paragraph at the foot of the queue and repo pages. Unchanged.
- **Collection health table.** `{components.collection-health-table}`. Existing table with `label` headers. Outcome words colored `ok` for `ok`, `warn` for `partial` and `running`, `critical` for `failed` and `stalled`.

## Do's and Don'ts

| Do | Don't |
|---|---|
| Give every color both a light and a dark value | Hard-code a light hex under `color-scheme: light dark` |
| Put a word next to every signal color | Rely on red alone to mean critical or `now` |
| Mark external links with `↗` and keep them `link` colored | Invent a second link color for GitHub |
| Use `surface` for chrome and tiles only | Add a third background tone or any shadow |
| Keep the system font, rem sizes and zero network fetches | Load a web font, icon font or CDN stylesheet, or pin text to px |
| Let a quiet repo look quiet: no rule, `muted` zeros | Paint green on rows that are merely fine |
| Show `not covered`, `unconfirmed` or an attestation note where data is absent | Render an empty table or a `0` that looks like zero problems |
| One signal wash per row: the tier chip's | Put a second tinted pill beside a tier chip |
| Give every link an underline or a link-colored label | Let a 1.5:1 `border` be the only sign that something is clickable |
