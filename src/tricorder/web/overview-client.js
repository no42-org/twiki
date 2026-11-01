/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// The overview's rows, filters and merge clicks. The server hands over every row
// as data and <lcars-table> draws and sorts them, so with this switched off there
// is no table and nothing can be merged. A merge click is the one thing here that
// asks the server to act. No imports, because the browser loads this file exactly as written. The pure
// half is exported for the unit suite.

/** The four filter facets, in badge order. Each is also a query parameter. */
export const FACETS = ["kind", "severity", "state", "repo"];

/** The table's sort keys, each also a value of the `sort` query parameter. */
const COLUMNS = ["severity", "state", "repo", "id", "what", "age"];

/** Columns whose first click is descending: the urgent end comes first. */
const FIRST_DESCENDING = new Set(["severity", "age"]);

const GITHUB_MARK =
  "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z";

const MERGE_MARK =
  "M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-4.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5ZM5 3.25a.75.75 0 1 0 0 .005V3.25Z";

export function emptyFilters() {
  return Object.fromEntries(FACETS.map((facet) => [facet, new Set()]));
}

/** Values of one facet widen; different facets narrow. */
export function passes(row, filters) {
  return FACETS.every(
    (facet) => filters[facet].size === 0 || filters[facet].has(row[facet]),
  );
}

/**
 * One table row. The table sorts on these keys, so severity is its rank and age
 * its hours: as words they would sort alphabetically. `view` is the row as the
 * server sent it.
 */
export function tableRow(view) {
  return {
    view,
    severity: view.severityRank,
    state: view.state,
    repo: view.repoLabel,
    id: view.id,
    what: view.what,
    age: view.ageHours,
  };
}

/** What `passes` reads: filter values, which are not the sort keys. */
export function filterValues(view) {
  return {
    kind: view.group,
    severity: view.severity ?? "",
    state: view.state,
    repo: view.repo,
  };
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

/**
 * What a reply to POST /merge means for its row. `reply` is null when no answer
 * came, and its `body` null when the answer was not JSON. Only a reply that says
 * so reads as merged: anything else is a refusal, in `words` where it has any.
 */
export function readMergeReply(reply, words) {
  if (reply === null) return { merged: false, reason: words.unreachable };
  if (reply.status === 403) {
    return { merged: false, reason: "Merging is limited to this machine" };
  }
  const outcome = reply.ok ? reply.body?.outcome : undefined;
  if (outcome === "merged" || outcome === "already-merged") {
    return { merged: true };
  }
  const word = outcome === "refused" ? words[reply.body.refusal] : undefined;
  return {
    merged: false,
    reason: typeof word === "string" ? word : "The merge request failed",
  };
}

async function postMerge(repo, number) {
  try {
    const response = await fetch("/merge", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, number }),
    });
    const body = await response.json().catch(() => null);
    return { status: response.status, ok: response.ok, body };
  } catch {
    return null;
  }
}

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value !== undefined) node.setAttribute(name, value);
  }
  node.append(...children);
  return node;
}

function mark(path) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("fill", "currentColor");
  svg.setAttribute("aria-hidden", "true");
  const shape = document.createElementNS(ns, "path");
  shape.setAttribute("d", path);
  svg.append(shape);
  return svg;
}

function mergeIcon(view) {
  return element(
    "button",
    {
      type: "button",
      class: "merge",
      "data-repo": view.repo,
      "data-number": view.id.slice(1),
      "aria-label": `Merge ${view.id} in ${view.repoLabel}`,
      title: "Merge",
    },
    mark(MERGE_MARK),
  );
}

function githubLink(view) {
  return element(
    "a",
    {
      class: "gh",
      href: view.repoUrl,
      target: "_blank",
      rel: "noopener noreferrer",
      title: "Open on GitHub",
    },
    element("span", { class: "vh" }, `Open ${view.repoLabel} on GitHub in a new tab`),
    mark(GITHUB_MARK),
  );
}

function idLabel(view) {
  if (view.url === null) return element("span", { class: "num" }, view.id);
  return element(
    "a",
    {
      class: "num",
      href: view.url,
      target: "_blank",
      rel: "noopener noreferrer",
      "aria-label": `Open ${view.id} in ${view.repoLabel} on GitHub in a new tab`,
      title: "Open on GitHub",
    },
    view.id,
  );
}

function ageCell(view) {
  const steps = [1, 2, 3, 4, 5].map((step) =>
    element("i", { class: step <= view.ageStep ? "on" : undefined }),
  );
  return element(
    "span",
    { class: "age" },
    element("span", { class: "segs", "aria-hidden": "true" }, ...steps),
    element("span", { class: "words" }, view.ageWords),
  );
}

function start() {
  const table = document.getElementById("overview-table");
  const bar = document.getElementById("filter-bar");
  const empty = document.getElementById("no-matches");
  const mergeStatus = document.getElementById("merge-status");
  const rows = JSON.parse(table.dataset.rows).map(tableRow);
  // Every filter control so far, because a filtered-out row keeps its cells.
  const pressable = new Set(document.querySelectorAll("button[data-facet]"));
  const known = emptyFilters();
  const labels = new Map();
  for (const button of pressable) {
    known[button.dataset.facet].add(button.dataset.value);
  }
  for (const { view } of rows) {
    if (view.severity !== null) known.severity.add(view.severity);
    known.state.add(view.state);
    known.repo.add(view.repo);
    labels.set(`repo:${view.repo}`, view.repoLabel);
  }
  const refusalWords = JSON.parse(table.dataset.refusals);
  let { filters, sort } = parseState(location.search, known, COLUMNS);

  // The cells live in the table's shadow root, where the page's sheet stops.
  const cellStyle = new CSSStyleSheet();
  cellStyle.replaceSync(document.getElementById("overview-style").textContent);
  table.shadowRoot.adoptedStyleSheets.push(cellStyle);

  function filterButton(facet, value, attributes, ...children) {
    const button = element(
      "button",
      {
        type: "button",
        "data-facet": facet,
        "data-value": value,
        "aria-pressed": String(filters[facet].has(value)),
        ...attributes,
      },
      ...children,
    );
    pressable.add(button);
    return button;
  }

  function pill(facet, value, color) {
    return filterButton(
      facet,
      value,
      {
        class: `pill ${color ?? ""}`,
        "aria-label": `Filter by ${facet} ${value}`,
      },
      value,
    );
  }

  table.columns = [
    {
      key: "severity",
      label: "SEVERITY",
      sortable: true,
      render: ({ view }) =>
        view.severity === null
          ? ""
          : pill("severity", view.severity, view.severity),
    },
    {
      key: "state",
      label: "STATE",
      sortable: true,
      render: (row) => {
        const { state } = row.view;
        const color =
          state === "FAILING" || state === "READY" ? state : undefined;
        row.statePill = pill("state", state, color);
        return row.statePill;
      },
    },
    {
      key: "repo",
      label: "REPOSITORY",
      sortable: true,
      mono: true,
      render: ({ view }) =>
        element(
          "span",
          { class: "line" },
          ...(view.repoUrl === null ? [] : [githubLink(view)]),
          filterButton(
            "repo",
            view.repo,
            {
              class: "rb",
              "data-label": view.repoLabel,
              "aria-label": `Filter by repository ${view.repoLabel}`,
            },
            view.repoLabel,
          ),
        ),
    },
    {
      key: "id",
      label: "ID",
      sortable: true,
      render: (row) => {
        row.idLabel = idLabel(row.view);
        return element(
          "span",
          { class: "line" },
          ...(row.view.merge?.enabled ? [mergeIcon(row.view)] : []),
          row.idLabel,
        );
      },
    },
    {
      key: "what",
      label: "WHAT AND IMPACT",
      sortable: true,
      wrap: true,
      render: ({ view }) => element("span", { class: "d" }, view.what),
    },
    {
      key: "age",
      label: "AGE",
      sortable: true,
      render: ({ view }) => ageCell(view),
    },
  ];

  function badge(facet, value) {
    const chip = document.createElement("lcars-chip");
    if (facet === "repo") chip.className = "repo";
    chip.dataset.remove = facet;
    chip.dataset.value = value;
    chip.setAttribute("color", "lilac");
    chip.setAttribute("removable", "");
    chip.setAttribute("pressed", "");
    const label = labels.get(`${facet}:${value}`) ?? value;
    chip.setAttribute("remove-label", `Remove filter ${label}`);
    // The chip's body also removes, and its slot is the only way to name it.
    const prefix = document.createElement("span");
    prefix.className = "vh";
    prefix.textContent = "Remove filter ";
    const text = document.createElement("span");
    text.textContent = label;
    chip.append(prefix, text);
    return chip;
  }

  function render() {
    const visible = rows.filter(({ view }) =>
      passes(filterValues(view), filters),
    );
    // A new array each time: the table does not see one changed in place.
    table.rows = visible;
    table.sortKey = sort?.col ?? "";
    table.sortDirection = sort?.dir < 0 ? "descending" : "ascending";
    table.hidden = visible.length === 0;
    empty.hidden = visible.length > 0;
    for (const button of pressable) {
      const on = filters[button.dataset.facet].has(button.dataset.value);
      button.setAttribute("aria-pressed", String(on));
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

  async function markMerged(button) {
    const row = rows.find(
      ({ view }) =>
        view.repo === button.dataset.repo &&
        view.id === `#${button.dataset.number}`,
    );
    const focused = button.getRootNode().activeElement === button;
    row.view.state = "MERGED";
    row.state = "MERGED";
    const pill = row.statePill;
    pill.dataset.value = "MERGED";
    pill.className = "pill MERGED";
    pill.setAttribute("aria-label", "Filter by state MERGED");
    pill.textContent = "MERGED";
    button.remove();
    render();
    // After the update, because moving a row drops its focus.
    await table.updateComplete;
    if (focused) row.idLabel.focus();
  }

  // Only a refused click gets here. Dimmed with aria-disabled, so a keyboard can
  // still reach the reason.
  function dimIcon(button, reason) {
    button.setAttribute("aria-disabled", "true");
    button.title = reason;
    button.setAttribute(
      "aria-label",
      `Cannot merge #${button.dataset.number}: ${reason}`,
    );
  }

  async function merge(button) {
    if (
      button.getAttribute("aria-disabled") === "true" ||
      button.getAttribute("aria-busy") === "true"
    ) {
      return;
    }
    button.setAttribute("aria-busy", "true");
    const { repo, number } = button.dataset;
    const reply = await postMerge(repo, Number(number));
    const result = readMergeReply(reply, refusalWords);
    button.removeAttribute("aria-busy");
    if (result.merged) await markMerged(button);
    else dimIcon(button, result.reason);
    // The overview spans repositories, so the number alone would not say which.
    mergeStatus.textContent = result.merged
      ? `${repo}#${number} merged`
      : `Cannot merge ${repo}#${number}: ${result.reason}`;
  }

  document.addEventListener("click", (event) => {
    // The first of the path, because the event retargets at the table's edge.
    const target = event.composedPath()[0].closest?.("button");
    if (target === null || target === undefined) return;
    if (target.classList.contains("merge")) {
      merge(target);
      return;
    }
    if (target.id === "clear") {
      filters = emptyFilters();
    } else if (target.dataset.facet !== undefined) {
      const set = filters[target.dataset.facet];
      const { value } = target.dataset;
      if (set.has(value)) set.delete(value);
      else set.add(value);
    } else {
      return;
    }
    render();
  });

  // The table has already sorted its own way: this puts the cycle back.
  table.addEventListener("lcars-sort", ({ detail }) => {
    sort = nextSort(sort, detail.key);
    render();
  });

  // The chip's body is a toggle of its own, but a badge only ever goes away.
  // Every badge is rebuilt, so focus moves to the one that took this one's place.
  const removeBadge = async ({ target }) => {
    const index = [...bar.querySelectorAll("lcars-chip")].indexOf(target);
    filters[target.dataset.remove].delete(target.dataset.value);
    render();
    const chips = bar.querySelectorAll("lcars-chip");
    const next = chips[index] ?? chips[index - 1];
    await next?.updateComplete;
    next?.focus();
  };
  bar.addEventListener("lcars-remove", removeBadge);
  bar.addEventListener("lcars-toggle", removeBadge);

  render();
}

if (typeof document !== "undefined") start();
