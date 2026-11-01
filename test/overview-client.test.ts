/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { REFUSAL_WORDS } from "../src/core/merge.js";
import {
  emptyFilters,
  FACETS,
  filterValues,
  formatState,
  nextSort,
  parseState,
  passes,
  readMergeReply,
  tableRow,
} from "../src/tricorder/web/overview-client.js";

const row = (over: Record<string, unknown> = {}) => ({
  kind: "SECURITY",
  severity: "CRITICAL",
  state: "FIX AVAILABLE",
  repo: "no42-org/blitsbom",
  ...over,
});

const filtered = (facets: Record<string, string[]>) => {
  const filters = emptyFilters();
  for (const [facet, values] of Object.entries(facets)) {
    for (const value of values) filters[facet]?.add(value);
  }
  return filters;
};

const COLUMNS = ["severity", "state", "repo", "id", "what", "age"];
const KNOWN = filtered({
  kind: ["SECURITY"],
  severity: ["CRITICAL", "HIGH"],
  state: ["FAILING"],
  repo: ["no42-org/blitsbom"],
});

describe("the overview's filters", () => {
  it("passes every row with no filter applied", () => {
    expect(passes(row(), emptyFilters())).toBe(true);
    expect(passes(row({ severity: "" }), emptyFilters())).toBe(true);
  });

  it("narrows across facets", () => {
    const both = filtered({
      severity: ["CRITICAL"],
      repo: ["no42-org/blitsbom"],
    });
    expect(passes(row(), both)).toBe(true);
    expect(passes(row({ repo: "no42-org/twiki" }), both)).toBe(false);
    expect(passes(row({ severity: "HIGH" }), both)).toBe(false);
  });

  it("widens within one facet", () => {
    const either = filtered({ severity: ["CRITICAL", "HIGH"] });
    expect(passes(row(), either)).toBe(true);
    expect(passes(row({ severity: "HIGH" }), either)).toBe(true);
    expect(passes(row({ severity: "MEDIUM" }), either)).toBe(false);
  });

  it("drops a row with no severity once a severity is filtered", () => {
    expect(
      passes(row({ severity: "" }), filtered({ severity: ["CRITICAL"] })),
    ).toBe(false);
  });
});

describe("the overview's sort", () => {
  const view = {
    group: "SECURITY",
    severity: "HIGH",
    severityRank: 3,
    state: "FIX AVAILABLE",
    repo: "no42-org/twiki",
    repoLabel: "twiki",
    id: "#9",
    what: "A fix",
    ageHours: 30,
  };

  it("keys the table on numbers where the words would sort alphabetically", () => {
    expect(tableRow(view)).toEqual({
      view,
      severity: 3,
      state: "FIX AVAILABLE",
      repo: "twiki",
      id: "#9",
      what: "A fix",
      age: 30,
    });
  });

  it("filters on the values the sort keys replaced", () => {
    expect(filterValues(view)).toEqual({
      kind: "SECURITY",
      severity: "HIGH",
      state: "FIX AVAILABLE",
      repo: "no42-org/twiki",
    });
    expect(filterValues({ ...view, severity: null }).severity).toBe("");
  });

  it("cycles first direction, reverse, then default", () => {
    expect(nextSort(null, "repo")).toEqual({ col: "repo", dir: 1 });
    expect(nextSort({ col: "repo", dir: 1 }, "repo")).toEqual({
      col: "repo",
      dir: -1,
    });
    expect(nextSort({ col: "repo", dir: -1 }, "repo")).toBeNull();
  });

  it.each(["severity", "age"])("starts %s descending", (col) => {
    expect(nextSort(null, col)).toEqual({ col, dir: -1 });
    expect(nextSort({ col, dir: -1 }, col)).toEqual({ col, dir: 1 });
    expect(nextSort({ col, dir: 1 }, col)).toBeNull();
  });

  it("restarts on a different column", () => {
    expect(nextSort({ col: "repo", dir: -1 }, "state")).toEqual({
      col: "state",
      dir: 1,
    });
  });
});

describe("the overview's query string", () => {
  it("round-trips filters and sort", () => {
    const filters = filtered({
      severity: ["CRITICAL", "HIGH"],
      repo: ["no42-org/blitsbom"],
    });
    const sort = { col: "age", dir: -1 };
    const query = formatState(filters, sort);
    expect(query).toBe(
      "?severity=CRITICAL&severity=HIGH&repo=no42-org%2Fblitsbom&sort=age&dir=desc",
    );
    const read = parseState(query, KNOWN, COLUMNS);
    expect(read.sort).toEqual(sort);
    for (const facet of FACETS) {
      expect(read.filters[facet]).toEqual(filters[facet]);
    }
  });

  it("is empty with nothing applied", () => {
    expect(formatState(emptyFilters(), null)).toBe("");
  });

  it("ignores a value nothing offers, an unknown column and a bad direction", () => {
    const read = parseState("?severity=NOPE&sort=nope&dir=asc", KNOWN, COLUMNS);
    expect(read.filters.severity?.size).toBe(0);
    expect(read.sort).toBeNull();
    expect(
      parseState("?sort=age&dir=sideways", KNOWN, COLUMNS).sort,
    ).toBeNull();
  });
});

describe("the answer to a merge click", () => {
  const read = (reply: unknown) => readMergeReply(reply, REFUSAL_WORDS);
  const answer = (body: unknown, status = 200) => ({
    status,
    ok: status < 300,
    body,
  });
  const refused = (reason: string) => ({ merged: false, reason });
  const FAILED = refused("The merge request failed");

  it.each(["merged", "already-merged"])("reads %s as merged", (outcome) => {
    expect(read(answer({ outcome }))).toEqual({ merged: true });
  });

  it("reads a refusal in the embedded words", () => {
    expect(
      read(answer({ outcome: "refused", refusal: "head-changed" })),
    ).toEqual(refused("New commits pushed"));
  });

  it("reads a request that got no answer as twiki being out of reach", () => {
    expect(read(null)).toEqual(refused("twiki is not reachable"));
  });

  it("reads a bare 403 as the loopback limit", () => {
    expect(read(answer(null, 403))).toEqual(
      refused("Merging is limited to this machine"),
    );
  });

  it.each([
    ["a bare 415", answer(null, 415)],
    ["a 400 with an error", answer({ error: "body must be JSON" }, 400)],
    ["a 500 that claims success", answer({ outcome: "merged" }, 500)],
    ["a 200 that is not JSON", answer(null)],
    ["an outcome nobody defined", answer({ outcome: "maybe" })],
    ["a refusal with no words", answer({ outcome: "refused", refusal: "new" })],
    [
      "a refusal naming an inherited key",
      answer({ outcome: "refused", refusal: "constructor" }),
    ],
  ])("reads %s as a refusal, not a merge", (_name, reply) => {
    expect(read(reply)).toEqual(FAILED);
  });
});
