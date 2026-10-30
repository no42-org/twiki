/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// The overview's filters and sort. The server renders every row, so this only
// hides and reorders what is already in the page: with it switched off the
// table is complete and unfiltered. No imports, because the browser loads this
// file exactly as written. The pure half is exported for the unit suite.

/** The four filter facets, in badge order. Each is also a query parameter. */
export const FACETS = ["kind", "severity", "state", "repo"];

/** Columns whose first click is descending: the urgent end comes first. */
const FIRST_DESCENDING = new Set(["severity", "age"]);

const NUMERIC_COLUMNS = new Set(["severity", "age"]);

export function emptyFilters() {
  return Object.fromEntries(FACETS.map((facet) => [facet, new Set()]));
}

/** Values of one facet widen; different facets narrow. */
export function passes(row, filters) {
  return FACETS.every(
    (facet) => filters[facet].size === 0 || filters[facet].has(row[facet]),
  );
}

/** Empty values sort last in both directions, so `dir` never reaches them. */
export function compareRows(a, b, sort) {
  const x = a[sort.col];
  const y = b[sort.col];
  const emptyX = x === null || x === "";
  const emptyY = y === null || y === "";
  if (emptyX || emptyY) return Number(emptyX) - Number(emptyY);
  const order = NUMERIC_COLUMNS.has(sort.col)
    ? x - y
    : String(x).localeCompare(String(y), "en", {
        numeric: true,
        sensitivity: "base",
      });
  return order * sort.dir;
}

/** First direction, reverse, then back to the default order. */
export function nextSort(sort, col) {
  const first = FIRST_DESCENDING.has(col) ? -1 : 1;
  if (sort?.col !== col) return { col, dir: first };
  return sort.dir === first ? { col, dir: -first } : null;
}

/**
 * Read filters and sort from a query string. A value no row or box offers is
 * dropped, so a stale bookmark lands on the page rather than on nothing.
 */
export function parseState(search, known, columns) {
  const params = new URLSearchParams(search);
  const filters = emptyFilters();
  for (const facet of FACETS) {
    for (const value of params.getAll(facet)) {
      if (known[facet].has(value)) filters[facet].add(value);
    }
  }
  const col = params.get("sort");
  const dir = params.get("dir");
  const sort =
    col !== null && columns.includes(col) && (dir === "asc" || dir === "desc")
      ? { col, dir: dir === "asc" ? 1 : -1 }
      : null;
  return { filters, sort };
}

export function formatState(filters, sort) {
  const params = new URLSearchParams();
  for (const facet of FACETS) {
    for (const value of filters[facet]) params.append(facet, value);
  }
  if (sort !== null) {
    params.set("sort", sort.col);
    params.set("dir", sort.dir > 0 ? "asc" : "desc");
  }
  const text = params.toString();
  return text === "" ? "" : `?${text}`;
}

/** Drawn, because a text × sits wherever the font puts it. A constant. */
const CROSS =
  '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M2 2l6 6M8 2l-6 6"/></svg>';

function rowFrom(element) {
  const data = element.dataset;
  return {
    element,
    kind: data.kind,
    severity: data.severity ?? "",
    state: data.state,
    repo: data.repo,
    // What the sort reads: the same columns, as sortable values.
    label: data.label,
    id: data.id,
    what: data.what,
    age: data.age === undefined ? null : Number(data.age),
    rank: data.rank === undefined ? null : Number(data.rank),
  };
}

/** A sort column's value lives under a different name than its filter. */
function sortable(row) {
  return {
    severity: row.rank,
    state: row.state,
    repo: row.label,
    id: row.id,
    what: row.what,
    age: row.age,
  };
}

function start() {
  const body = document.getElementById("rows");
  const table = document.getElementById("overview-table");
  const bar = document.getElementById("filter-bar");
  const empty = document.getElementById("no-matches");
  const rows = [...body.querySelectorAll("tr")].map((tr) => rowFrom(tr));
  const headers = [...document.querySelectorAll("th[data-col]")];
  const columns = headers.map((th) => th.dataset.col);
  const pressable = () => [...document.querySelectorAll("button[data-facet]")];
  const known = emptyFilters();
  const labels = new Map();
  for (const button of pressable()) {
    known[button.dataset.facet].add(button.dataset.value);
    labels.set(
      `${button.dataset.facet}:${button.dataset.value}`,
      button.dataset.label ?? button.dataset.value,
    );
  }
  let { filters, sort } = parseState(location.search, known, columns);

  function badge(facet, value) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = facet === "repo" ? "chip repo" : "chip";
    button.dataset.remove = facet;
    button.dataset.value = value;
    const label = labels.get(`${facet}:${value}`) ?? value;
    button.setAttribute("aria-label", `Remove filter ${label}`);
    const text = document.createElement("span");
    text.className = "label";
    text.textContent = label;
    const cross = document.createElement("span");
    cross.className = "x";
    cross.setAttribute("aria-hidden", "true");
    cross.innerHTML = CROSS;
    button.append(text, cross);
    return button;
  }

  function render() {
    const visible = rows.filter((row) => passes(row, filters));
    for (const row of rows) row.element.hidden = !visible.includes(row);
    const ordered =
      sort === null
        ? rows
        : rows.slice().sort((a, b) => compareRows(sortable(a), sortable(b), sort));
    body.append(...ordered.map((row) => row.element));
    table.hidden = visible.length === 0;
    empty.hidden = visible.length > 0;
    for (const button of pressable()) {
      const on = filters[button.dataset.facet].has(button.dataset.value);
      button.setAttribute("aria-pressed", String(on));
    }
    for (const th of headers) {
      const active = sort?.col === th.dataset.col;
      if (active) {
        th.setAttribute("aria-sort", sort.dir > 0 ? "ascending" : "descending");
      } else {
        th.removeAttribute("aria-sort");
      }
      th.querySelector(".dir").textContent = active
        ? sort.dir > 0
          ? "▲"
          : "▼"
        : "";
    }
    const count = document.createElement("span");
    count.textContent = `${visible.length} ITEMS`;
    const badges = FACETS.flatMap((facet) =>
      [...filters[facet]].map((value) => badge(facet, value)),
    );
    bar.replaceChildren(count, ...badges);
    if (badges.length > 0) {
      const clear = document.createElement("button");
      clear.type = "button";
      clear.id = "clear";
      clear.textContent = "CLEAR FILTER";
      bar.append(clear);
    }
    const query = formatState(filters, sort);
    history.replaceState(null, "", `${location.pathname}${query}`);
  }

  document.addEventListener("click", (event) => {
    const target = event.target.closest("button");
    if (target === null) return;
    if (target.id === "clear") {
      filters = emptyFilters();
    } else if (target.dataset.remove !== undefined) {
      filters[target.dataset.remove].delete(target.dataset.value);
    } else if (target.dataset.facet !== undefined) {
      const set = filters[target.dataset.facet];
      const { value } = target.dataset;
      if (set.has(value)) set.delete(value);
      else set.add(value);
    } else if (target.dataset.sort !== undefined) {
      sort = nextSort(sort, target.dataset.sort);
    } else {
      return;
    }
    render();
  });

  render();
}

if (typeof document !== "undefined") start();
