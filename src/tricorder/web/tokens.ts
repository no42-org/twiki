/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// Design tokens for the gitricorder pages. One source for the colors, the
// type ramp and the spacing scale; the style block in components.tsx is
// generated from these maps and the contrast test reads them directly, so a
// color cannot drift between the page and the test.
//
// Every color has a light and a dark value. The palette is Primer-derived so
// the dashboard reads as a sibling of the GitHub pages it links to. Each
// signal color carries one meaning: critical means act now, high is a high
// severity, warn is stale or soon, ok is fresh. Never lighten warn or
// warn-tint: warn on warn-tint passes AA with no headroom.

export const COLOR_NAMES = [
  "bg",
  "surface",
  "fg",
  "muted",
  "border",
  "link",
  "critical",
  "critical-tint",
  "high",
  "warn",
  "warn-tint",
  "ok",
] as const;

export type ColorName = (typeof COLOR_NAMES)[number];

export type Palette = Readonly<Record<ColorName, string>>;

export const LIGHT: Palette = {
  bg: "#FFFFFF",
  surface: "#F6F8FA",
  fg: "#1F2328",
  muted: "#57606A",
  border: "#D0D7DE",
  link: "#0969DA",
  critical: "#CF222E",
  "critical-tint": "#FFEBE9",
  high: "#BC4C00",
  warn: "#9A6700",
  "warn-tint": "#FFF8C5",
  ok: "#1A7F37",
};

export const DARK: Palette = {
  bg: "#0D1117",
  surface: "#161B22",
  fg: "#E6EDF3",
  muted: "#8B949E",
  border: "#30363D",
  link: "#4493F8",
  critical: "#FF7B72",
  "critical-tint": "#3A1214",
  high: "#F0883E",
  warn: "#D29922",
  "warn-tint": "#2E2A12",
  ok: "#3FB950",
};

/**
 * Text-on-ground pairs that must reach WCAG AA for normal text (4.5:1) in
 * both themes. The tint pairs are the washes behind a signal word. The
 * contrast test walks this list against both palettes.
 */
export const TEXT_PAIRS: ReadonlyArray<readonly [ColorName, ColorName]> = [
  ["fg", "bg"],
  ["fg", "surface"],
  ["muted", "bg"],
  ["muted", "surface"],
  ["critical", "bg"],
  ["critical", "surface"],
  ["high", "bg"],
  ["high", "surface"],
  ["warn", "bg"],
  ["warn", "surface"],
  ["ok", "bg"],
  ["ok", "surface"],
  ["link", "bg"],
  ["link", "surface"],
  ["critical", "critical-tint"],
  ["warn", "warn-tint"],
];

/**
 * The ratios DESIGN.md records for each text pair, light then dark, rounded
 * to one decimal. The contrast test fails when a pair drops below its
 * record, not only below the AA floor, so a palette edit that quietly costs
 * contrast is caught even when it still passes AA.
 */
export const DOCUMENTED_MIN: Readonly<
  Partial<
    Record<`${ColorName}/${ColorName}`, readonly [light: number, dark: number]>
  >
> = {
  "fg/bg": [15.8, 16.0],
  "fg/surface": [14.8, 14.6],
  "muted/bg": [6.4, 6.2],
  "muted/surface": [6.0, 5.6],
  "critical/bg": [5.4, 7.5],
  "critical/surface": [5.0, 6.9],
  "high/bg": [5.0, 7.5],
  "high/surface": [4.7, 6.8],
  "warn/bg": [4.9, 7.5],
  "warn/surface": [4.6, 6.9],
  "ok/bg": [5.1, 7.4],
  "ok/surface": [4.8, 6.8],
  "link/bg": [5.2, 6.1],
  "link/surface": [4.9, 5.6],
  "critical/critical-tint": [4.7, 6.5],
  "warn/warn-tint": [4.5, 5.7],
};

/** The focus ring is non-text and needs 3:1 against both grounds. */
export const NON_TEXT_PAIRS: ReadonlyArray<readonly [ColorName, ColorName]> = [
  ["link", "bg"],
  ["link", "surface"],
];

/**
 * Type ramp in rem. The page sets the root to the platform body text style
 * where the browser offers one (`font: -apple-system-body` on iOS), so a user
 * who asked for larger text gets it; the px in comments are the documentation
 * values at a 15px root.
 */
export const TYPE = {
  title: { size: "1.467rem", weight: 600, lineHeight: 1.25 }, // 22px
  section: { size: "1.133rem", weight: 600, lineHeight: 1.3 }, // 17px
  body: { size: "1rem", weight: 400, lineHeight: 1.5 }, // 15px
  small: { size: "0.867rem", weight: 400, lineHeight: 1.4 }, // 13px
  label: { size: "0.867rem", weight: 600, lineHeight: 1.2, tracking: "0.04em" }, // 13px
  count: { size: "1.467rem", weight: 600, lineHeight: 1 }, // 22px
} as const;

/** 4px spacing scale plus the named layout values. */
export const SPACE = {
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  6: "24px",
  8: "32px",
  gutter: "16px",
  contentMax: "72rem",
  navHeight: "2.75rem",
} as const;

export const RADIUS = { sm: "4px", md: "6px", full: "9999px" } as const;

/** Relative luminance per WCAG 2.x, from a `#RRGGBB` string. */
export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  const digits = m?.[1];
  if (digits === undefined) {
    throw new Error(`token color is not #RRGGBB: ${hex}`);
  }
  const channel = (i: number): number => {
    const v = Number.parseInt(digits.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio between two `#RRGGBB` colors, 1 to 21. */
export function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

/** The `:root` custom-property block for one palette. */
function declarations(p: Palette): string {
  return COLOR_NAMES.map((n) => `--${n}: ${p[n]};`).join(" ");
}

/**
 * The token half of the page style: light on bare :root, dark under the
 * media query. Component rules in components.tsx reference these names only.
 */
export const TOKEN_STYLE = `
  :root { color-scheme: light dark; ${declarations(LIGHT)} }
  @media (prefers-color-scheme: dark) { :root { ${declarations(DARK)} } }
`;
