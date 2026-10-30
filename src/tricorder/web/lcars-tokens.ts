/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// The overview's colors. One dark palette, because LCARS is black: the
// repository page keeps its own light and dark tokens in tokens.ts. The age
// bar's five steps carry no meaning alone, since the words sit beside them.

export const LCARS_COLORS = {
  ground: "#000000",
  tile: "#15110C",
  tileHover: "#241D14",
  rule: "#332B22",
  text: "#F4E9D8",
  muted: "#CBBFAE",
  gold: "#FF9900",
  lilac: "#CC99CC",
  ice: "#99CCFF",
  critical: "#FF5555",
  high: "#FF9966",
  medium: "#FFCC66",
  low: "#CBBFAE",
  ink: "#000000",
} as const;

/** The age bar, youngest step first. */
export const AGE_STEPS = [
  "#99CCFF",
  "#B7A8E0",
  "#DD88BB",
  "#F26D88",
  "#FF5555",
] as const;

type Color = keyof typeof LCARS_COLORS;

/** Text on ground, each of which must reach WCAG AA. */
export const LCARS_TEXT_PAIRS: ReadonlyArray<readonly [Color, Color]> = [
  ["text", "ground"],
  ["muted", "ground"],
  ["gold", "ground"],
  ["lilac", "ground"],
  ["ice", "ground"],
  ["text", "tile"],
  ["muted", "tile"],
  ["text", "tileHover"],
  ["muted", "tileHover"],
  ["ink", "critical"],
  ["ink", "high"],
  ["ink", "medium"],
  ["ink", "low"],
  ["ink", "lilac"],
  ["ink", "ice"],
  ["ink", "gold"],
];
