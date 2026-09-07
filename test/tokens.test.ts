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
  TEXT_PAIRS,
  TOKEN_STYLE,
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
    expect(rule(".some.crit")).toContain("font-weight: 700");
    expect(rule(".some.high")).toContain("font-weight: 400");
    // No bare `.some` rule at all: a plain count carries no weight of its own.
    expect(STYLE).not.toMatch(/(?:^|\n)\s*\.some\s*\{/);
    expect(rule(".crit")).not.toContain("font-weight");
    expect(rule(".high")).not.toContain("font-weight");
  });

  it("colors every collection-health outcome, with running kept muted", () => {
    expect(rule(".ok")).toContain("color: var(--ok)");
    expect(rule(".partial")).toContain("color: var(--warn)");
    expect(rule(".failed")).toContain("color: var(--critical)");
    expect(rule(".stalled")).toContain("color: var(--critical)");
    // A running lane in amber would train the reader to ignore amber.
    expect(rule(".running")).toContain("color: var(--muted)");
  });

  it("keeps a space between a review link and its not-watched badge", async () => {
    // inline-block trims a leading space inside the span, so the separator
    // must be a text node outside it.
    const html = await render("/reviews");
    expect(html).not.toMatch(/<\/a><span class="badge unknown">/);
  });
});
