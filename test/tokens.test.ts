/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { createApp } from "../src/tricorder/web/app.js";
import { STYLE } from "../src/tricorder/web/components.js";
import {
  COLOR_NAMES,
  contrast,
  DARK,
  DOCUMENTED_MIN,
  LIGHT,
  luminance,
  SPACE,
  TEXT_PAIRS,
  TOKEN_STYLE,
  TYPE,
} from "../src/tricorder/web/tokens.js";

const AA_TEXT = 4.5;

describe("design tokens (DESIGN.md Colors)", () => {
  it("defines every color in both palettes as #RRGGBB", () => {
    for (const name of COLOR_NAMES) {
      expect(LIGHT[name]).toMatch(/^#[0-9A-F]{6}$/);
      expect(DARK[name]).toMatch(/^#[0-9A-F]{6}$/);
      expect(LIGHT[name]).not.toBe(DARK[name]);
    }
  });

  it("computes luminance and contrast per WCAG 2.x", () => {
    expect(luminance("#FFFFFF")).toBeCloseTo(1, 6);
    expect(luminance("#000000")).toBeCloseTo(0, 6);
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 6);
    expect(contrast("#000000", "#FFFFFF")).toBeCloseTo(21, 6);
    expect(() => luminance("#FFF")).toThrow(/not #RRGGBB/);
  });

  it.each([
    ["light", LIGHT],
    ["dark", DARK],
  ] as const)("%s text pairs reach AA for normal text", (_theme, palette) => {
    for (const [text, ground] of TEXT_PAIRS) {
      const ratio = contrast(palette[text], palette[ground]);
      expect(ratio, `${text} on ${ground}`).toBeGreaterThanOrEqual(AA_TEXT);
    }
  });

  it.each([
    ["light", LIGHT, 0],
    ["dark", DARK, 1],
  ] as const)(
    "%s pairs do not fall below the ratios DESIGN.md records",
    (_theme, palette, i) => {
      for (const [text, ground] of TEXT_PAIRS) {
        const key = `${text}/${ground}` as const;
        const documented = DOCUMENTED_MIN[key]?.[i];
        if (documented === undefined) {
          throw new Error(`${key} has no documented ratio in DOCUMENTED_MIN`);
        }
        const ratio = contrast(palette[text], palette[ground]);
        // Records are rounded to one decimal, so allow half a step of
        // rounding. A palette edit that costs more than that fails here even
        // if it still passes AA. Lightening warn or warn-tint drops 4.52
        // under 4.5 and fails.
        expect(ratio, key).toBeGreaterThanOrEqual(documented - 0.05);
      }
    },
  );

  it("emits light values on :root and dark values under the media query", () => {
    expect(TOKEN_STYLE).toContain(`--bg: ${LIGHT.bg};`);
    expect(TOKEN_STYLE).toContain(
      `@media (prefers-color-scheme: dark) { :root { --bg: ${DARK.bg};`,
    );
    expect(TOKEN_STYLE).toContain("color-scheme: light dark");
  });
});

describe("page style (DESIGN.md Typography, Layout, Components)", () => {
  let dir: string;
  let store: SqliteStore;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tokens-"));
    store = SqliteStore.openForWrite(join(dir, "w.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const render = async (path: string): Promise<string> => {
    const app = createApp({
      defaultBranchOf: () => "main",
      store,
      watched: [{ owner: "no42-org", name: "twiki" }],
      policy: { cadenceMs: 15 * 60_000 },
      now: () => new Date("2026-09-07T12:00:00.000Z"),
    });
    const res = await app.request(path);
    expect(res.status).toBe(200);
    return res.text();
  };

  // Anchored at a line start and fully escaped, so `.stale` cannot match
  // `.badge.stale` and a dot cannot act as a wildcard.
  const rule = (selector: string): string => {
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(?:^|\\n)\\s*${escaped}\\s*\\{([^}]*)\\}`).exec(
      STYLE,
    );
    expect(m, selector).not.toBeNull();
    return m?.[1] ?? "";
  };

  it.each(["/", "/queue", "/reviews", "/repo/no42-org/twiki"])(
    "%s paints from tokens only and loads nothing from the network",
    async (path) => {
      const html = await render(path);
      const m = /<style>([\s\S]*?)<\/style>/.exec(html);
      expect(m, "one inline style block").not.toBeNull();
      const style = m?.[1] ?? "";
      expect(style).toBe(STYLE);

      // Every hex on the page lives in the token block; component rules name
      // custom properties. Strip the token block and nothing may remain.
      const rules = style.replace(TOKEN_STYLE, "");
      expect(rules).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(rules).toContain("var(--fg)");
      expect(rules).toContain("background: var(--bg)");

      // Distroless, offline: no script, no external stylesheet, font or import.
      expect(html).not.toMatch(/<script/i);
      expect(html).not.toMatch(/<link/i);
      expect(style).not.toMatch(/@import|url\(/);
      expect(html.slice(0, html.indexOf("</head>"))).not.toMatch(/https?:\/\//);
    },
  );

  it("sets text in rem so platform text scaling applies", () => {
    const sizes = [...STYLE.matchAll(/font-size: ([^;]+);/g)].map((m) => m[1]);
    expect(sizes.length).toBeGreaterThan(5);
    for (const size of sizes) {
      expect(size, `font-size ${size}`).toMatch(/rem$/);
    }
    expect(STYLE).toContain("max-width: 72rem");
    expect(STYLE).toContain(
      ":focus-visible { outline: 2px solid var(--link); outline-offset: 2px; }",
    );
    expect(STYLE).not.toMatch(/scroll-margin-top/);
    // Only touch devices take the platform body style; desktop Safari would
    // otherwise resolve it to 13px while every other browser sits at 16px.
    expect(STYLE).toContain(
      "@supports (font: -apple-system-body) { @media (hover: none) and (pointer: coarse) { html { font: -apple-system-body; } } }",
    );
    expect(STYLE).not.toMatch(/font-size: 100%/);
  });

  it("styles the freshness badge as an outline pill with no wash on stale", () => {
    expect(rule(".badge")).toContain("border: 1px solid currentColor");
    expect(rule(".badge")).toContain("border-radius: 9999px");
    expect(rule(".badge")).toContain("display: inline-block");
    expect(rule(".stale")).toContain("color: var(--warn)");
    expect(rule(".stale")).not.toContain("font-weight");
    expect(rule(".badge.stale")).toContain("font-weight: 600");
    expect(rule(".stale")).not.toContain("background");
    expect(rule(".unknown")).toContain("repeating-linear-gradient");
    expect(rule(".unknown")).toContain("var(--hatch)");
    expect(rule(".fresh")).toContain("color: var(--ok)");
  });

  it("carries severity in weight on count chips only, independent of rule order", () => {
    expect(rule(".chip.critical")).toContain("color: var(--critical)");
    expect(rule(".chip.critical")).toContain("font-weight: 700");
    expect(rule(".chip.high")).toContain("color: var(--high)");
    expect(rule(".chip.high")).toContain("font-weight: 400");
    // A plain count carries no weight of its own, and the severity word in
    // an alert table is a color, not a weight.
    expect(rule(".chip")).not.toContain("font-weight");
    expect(rule(".crit")).not.toContain("font-weight");
  });

  it("gives every chip state a word plus a color, and linked chips a 24px hit area", () => {
    expect(rule(".chip")).toContain("display: inline-block");
    expect(rule(".chip")).toContain("min-width: 24px");
    expect(rule(".chip")).toContain("min-height: 24px");
    expect(rule(".chip.zero")).toContain("color: var(--muted)");
    expect(rule(".chip.zero")).not.toContain("font-style");
    expect(rule(".chip.unconfirmed")).toContain("color: var(--muted)");
    expect(rule(".chip.unconfirmed")).toContain("font-style: italic");
    expect(rule(".chip.uncovered")).toContain("color: var(--warn)");
    expect(rule(".chip.uncovered")).toContain(
      "text-decoration: underline dotted",
    );
    // Italics belong to attestation notes and `unconfirmed` only.
    expect(rule(".chip.uncovered")).not.toContain("font-style: italic");
  });

  it("paints the tier as a left rule on board rows and the now marker in critical", () => {
    expect(rule("tbody.now tr.repo td:first-child")).toContain(
      "border-left: 3px solid var(--critical)",
    );
    expect(rule("tbody.soon tr.repo td:first-child")).toContain(
      "border-left: 3px solid var(--warn)",
    );
    expect(rule(".count.critical")).toContain("color: var(--critical)");
    expect(rule(".now-marker")).toContain("color: var(--critical)");
    expect(rule(".count.unconfirmed")).toContain("font-style: italic");
    expect(rule(".count")).toContain("font-variant-numeric: tabular-nums");
    // Tiles and the quiet block sit on the surface, ringed by the border,
    // which never carries meaning.
    expect(rule(".tile")).toContain("background: var(--surface)");
    expect(rule(".quiet")).toContain("background: var(--surface)");
  });

  it("styles attestation notes in italic muted, warn when a count may be low, and the breadcrumb", () => {
    expect(rule(".attest")).toContain("color: var(--muted)");
    expect(rule(".attest")).toContain("font-style: italic");
    expect(rule(".attest.warn")).toContain("color: var(--warn)");
    // The warn variant changes the color only; the italic stays.
    expect(rule(".attest.warn")).not.toContain("font-style");
    expect(rule(".crumb")).toContain("color: var(--muted)");
    // DESIGN.md sets the breadcrumb in `small`, not body size.
    expect(rule(".crumb")).toContain("font-size: 0.867rem");
    // `N shown` is a plain count beside a heading, not a second heading.
    expect(rule(".shown")).toContain("font-weight: 400");
    expect(rule(".shown")).toContain("color: var(--muted)");
  });

  it("colors every collection-health outcome, with running kept muted", () => {
    expect(rule(".ok")).toContain("color: var(--ok)");
    expect(rule(".partial")).toContain("color: var(--warn)");
    expect(rule(".failed")).toContain("color: var(--critical)");
    expect(rule(".stalled")).toContain("color: var(--critical)");
    // A running lane in amber would train the reader to ignore amber.
    expect(rule(".running")).toContain("color: var(--muted)");
  });

  it("sticks the primary nav on phones only, with the scroll offset on html and none on headings", () => {
    // DESIGN.md Layout: the bar sticks under 640px and `html` carries its
    // height as scroll-padding. Nothing can measure the bar without script,
    // so the phone bar is made deterministic instead: the rendered-at time
    // takes a row of its own, every row is at least nav-height tall, and
    // the offset is twice that. No rule at desktop width, and headings
    // carry no `scroll-margin-top`, which would add to the offset.
    const { navHeight, gutter } = SPACE;
    expect(STYLE).toContain(
      `@media (max-width: 639px) { nav.primary { position: sticky; top: 0; z-index: 1; margin: 0 -${gutter}; padding: 0 ${gutter}; } .rendered { flex-basis: 100%; } html { scroll-padding-top: calc(2 * ${navHeight}); } }`,
    );
    expect(STYLE).not.toMatch(/max-width: 359px/);
    expect(rule("nav.primary")).not.toContain("position");
    expect(rule("nav.primary")).not.toContain("line-height");
    expect(rule("nav.primary")).toContain(`min-height: ${navHeight}`);
    expect(rule("nav.primary")).toContain("align-items: center");
    expect(rule("nav.primary")).toContain("flex-wrap: wrap");
    expect(rule("nav.primary")).toContain("background: var(--surface)");
    expect(rule("nav.primary")).toContain("display: flex");
    expect(rule(".rendered")).toContain("margin-left: auto");
    expect(rule("nav.primary a[aria-current]")).toContain(
      "border-bottom: 2px solid var(--link)",
    );
    expect(STYLE).not.toMatch(/scroll-margin-top/);
  });

  it("hides a skip link until it is focused, then shows it top-left on the surface", () => {
    expect(rule(".skip")).toContain("position: absolute");
    expect(rule(".skip")).toContain("width: 1px");
    expect(rule(".skip")).toContain("clip: rect(0 0 0 0)");
    expect(rule(".skip:focus")).toContain("width: auto");
    expect(rule(".skip:focus")).toContain("clip: auto");
    expect(rule(".skip:focus")).toContain("background: var(--surface)");
    // Inset by the gutter, so the focus ring is not clipped at the edge.
    expect(rule(".skip:focus")).toContain(`left: ${SPACE.gutter}`);
    // Above the sticky nav's `z-index: 1`, or the bar would cover the link
    // the moment it appears.
    expect(rule(".skip:focus")).toContain("z-index: 2");
    // The focus ring is the global one; nothing here removes it.
    expect(rule(".skip:focus")).not.toContain("outline");
  });

  // Story 1.9 (#131): one markup for every width, restyled by CSS alone.
  describe("cards, grid and breakpoints (DESIGN.md Responsive)", () => {
    /** The multi-line media block that opens with `prelude`. */
    const media = (prelude: string): string => {
      const start = STYLE.indexOf(`${prelude} {\n`);
      expect(start, prelude).toBeGreaterThan(-1);
      return STYLE.slice(start, STYLE.indexOf("\n  }\n", start));
    };

    it("uses white-space: nowrap on the external-link glyph and the visually hidden clip only", () => {
      // A nowrap anywhere else is a horizontal scroller waiting for a long
      // value. Every rule carrying one is found and its selector checked.
      const users = [
        ...STYLE.matchAll(/([^{};]*)\{[^{}]*white-space: nowrap[^{}]*\}/g),
      ].map((m) => (m[1] ?? "").trim());
      expect(users).toContain(".sr-only");
      for (const selector of users) {
        expect([".ext", ".sr-only"], selector).toContain(selector);
      }
      // The skip link carried one; it is 1px wide until focused, and a
      // wrap inside a clipped box paints nothing.
      expect(rule(".skip")).not.toContain("white-space");
      expect(rule(".lbl.hid")).not.toContain("white-space");
    });

    it("breaks at 640px and 1024px and nowhere else", () => {
      const queries = STYLE.match(/@media \((?:max|min)-width[^{]*/g) ?? [];
      expect(queries.length).toBeGreaterThanOrEqual(3);
      for (const query of queries) {
        expect([
          "@media (max-width: 639px) ",
          "@media (min-width: 640px) and (max-width: 1023px) ",
        ]).toContain(query);
      }
      expect(STYLE).not.toMatch(/overflow-x/);
      // One unbreakable token wider than its box, a long slug, a scoped
      // package or a title, would otherwise widen a card at 320px and a
      // table column at any width. On the body, so the rationale line and
      // the repo heading are covered as well as every cell; it breaks a
      // word only when nothing else fits.
      expect(rule("body")).toContain("overflow-wrap: anywhere");
    });

    it("carries a header word in every cell, hidden beside the real header and painted on a card", () => {
      // Off at desktop width, where the column header is on screen; on a
      // card it is the label, in the header's own type; `hid` clips it for
      // a screen reader, with the same clip as .sr-only.
      expect(rule(".lbl")).toBe(" display: none; ");
      expect(rule(".lbl.hid")).toBe(
        " position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); border: 0; ",
      );
      expect(media("@media (max-width: 639px)")).toContain(
        `table.cards .lbl { display: inline; font-size: ${TYPE.label.size}; font-weight: ${TYPE.label.weight}; line-height: ${TYPE.label.lineHeight}; letter-spacing: ${TYPE.label.tracking}; text-transform: uppercase; color: var(--muted); margin-right: ${SPACE[1]}; }`,
      );
    });

    it("stacks every table into cards and the tiles into two columns under 640px", () => {
      const phone = media("@media (max-width: 639px)");
      expect(phone).toContain(
        ".tiles { grid-template-columns: repeat(2, 1fr); }",
      );
      expect(phone).toContain(
        "table.cards, table.cards tbody, table.cards tr, table.cards td { display: block; }",
      );
      // The header row leaves the screen, not the tree.
      expect(phone).toContain(
        "table.cards thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }",
      );
      expect(phone).not.toMatch(/thead[^{]*\{[^}]*display: none/);
      expect(phone).toContain(
        "table.cards td { border: 0; padding: 2px 0; text-align: left; }",
      );
      // The board card: the tier paints the card's left rule, slug and tier
      // share the first line, the chips wrap at an 8px gap, the freshness
      // takes a line, and the rationale row comes last.
      expect(phone).toContain(
        `.board tbody.now { border-left: 3px solid var(--critical); padding-left: ${SPACE[3]}; }`,
      );
      expect(phone).toContain(
        `.board tbody.soon { border-left: 3px solid var(--warn); padding-left: ${SPACE[3]}; }`,
      );
      expect(phone).toContain(
        ".board tbody tr.repo td:first-child { border-left: 0; padding-left: 0; }",
      );
      expect(phone).toContain(
        `.board tr.repo { display: flex; flex-wrap: wrap; gap: ${SPACE[2]}; align-items: baseline; }`,
      );
      expect(phone).toContain(
        ".board td.slug-cell { flex: 1 1 calc(100% - 6rem); }",
      );
      expect(phone).toContain(".board td.fresh-cell { flex-basis: 100%; }");
      expect(phone).toContain(`.board tr.why td { padding: ${SPACE[2]} 0 0; }`);
      // A word in a tile's count is set small on a phone: `unconfirmed` in
      // the count size is wider than half of 320px.
      expect(phone).toContain(
        `.count.unconfirmed, .count.never { font-size: ${TYPE.small.size}; line-height: ${TYPE.small.lineHeight}; }`,
      );
    });

    it("collapses the chip columns into one signals cell and the tiles into three columns between 640px and 1023px", () => {
      expect(media("@media (min-width: 640px) and (max-width: 1023px)")).toBe(
        "@media (min-width: 640px) and (max-width: 1023px) {\n" +
          "    .tiles { grid-template-columns: repeat(3, 1fr); }\n" +
          "    .board .c { display: none; }\n" +
          "    .board .signals { display: table-cell; }\n" +
          "    .signals-rest { display: inline; }",
      );
      // Off on every other width, including the phone card, where the
      // generic `td { display: block }` would otherwise win.
      expect(rule(".board .signals, .signals-rest")).toBe(" display: none; ");
    });
  });

  it("keeps a space between a review link and its not-watched badge", async () => {
    // inline-block trims a leading space inside the span, so the separator
    // must be a text node outside it.
    const html = await render("/reviews");
    expect(html).not.toMatch(/<\/a><span class="badge unknown">/);
  });
});
