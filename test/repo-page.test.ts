/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RANK_POLICY } from "../src/core/rank.js";
import { normalise } from "../src/tricorder/collect/dependabot-alerts.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { createApp } from "../src/tricorder/web/app.js";
import { buildRepoView } from "../src/tricorder/web/repo-view.js";
import { makeAlert } from "./fakes.js";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const SWEEP = { cadenceMs: 15 * 60_000 };
const REPO = { owner: "no42-org", name: "twiki" };
const DEPS = { policy: SWEEP };

describe("the per-repository view (CAP-7)", () => {
  let dir: string;
  let store: SqliteStore;

  const run = (
    lane: string,
    outcome: "ok" | "partial" | "failed" = "ok",
    at = "2026-08-20T11:55:00.000Z",
  ) => {
    const r = store.beginRun({
      lane,
      installation: "no42-org",
      scope: "full",
      startedAt: at,
    });
    store.finishRun(r, outcome, at);
    return r;
  };

  const seed = (
    lane: string,
    payloads: { subject: never; payload: never }[],
  ) => {
    const r = store.beginRun({
      lane,
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", payloads);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "repopage-"));
    store = SqliteStore.openForWrite(join(dir, "r.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("distinguishes an empty section from one nobody has collected", () => {
    // The whole point of the page. The issue lane ran clean and found
    // nothing; the Actions lane has never run at all. Both sections are
    // empty, and they must not read the same way (AD-28).
    run("graphql-issues", "ok");

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.issues).toEqual([]);
    expect(view.issueSection.attested).toBe(true);
    expect(view.runs).toEqual([]);
    expect(view.actionsSection.attested).toBe(false);
  });

  it("refuses to call a partial run an attestation", () => {
    // A partial sweep skipped something, and it may have been exactly this
    // repository: its silence proves nothing.
    run("graphql-update-prs", "partial");

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.prSection.attested).toBe(false);
  });

  it("shows a repository's alerts with per-row freshness", () => {
    seed("rest-org-dependabot", [
      normalise(makeAlert({ number: 2, severity: "critical" })),
      normalise(makeAlert({ number: 1 })),
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.alerts.map((a) => a.number)).toEqual([1, 2]);
    expect(view.alerts[1]?.severity).toBe("critical");
    expect(view.alerts[0]?.freshness).toBe("fresh");
  });

  it("keeps another repository's rows off the page", () => {
    // Node-keyed subjects carry no owner in the key, so the payload decides.
    // Without that check a PR from a sibling repository would appear here.
    seed("graphql-update-prs", [
      {
        subject: { type: "dependency_update_pr", key: "PR_mine" },
        payload: {
          repo: "no42-org/twiki",
          number: 1,
          title: "Bump x from 1.0.0 to 1.0.1",
          author: "dependabot",
          htmlUrl: "https://github.com/no42-org/twiki/pull/1",
          createdAt: "2026-08-20T00:00:00.000Z",
          packageName: "x",
          bump: "patch",
        },
      },
      {
        subject: { type: "dependency_update_pr", key: "PR_theirs" },
        payload: {
          repo: "no42-org/other",
          number: 2,
          title: "Bump y from 1.0.0 to 1.0.1",
          author: "dependabot",
          htmlUrl: "https://github.com/no42-org/other/pull/2",
          createdAt: "2026-08-20T00:00:00.000Z",
          packageName: "y",
          bump: "patch",
        },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.updatePrs.map((p) => p.number)).toEqual([1]);
  });

  it("matches the repository whatever casing the payload carries", () => {
    // Subject keys are folded (AD-22) but payload casing comes from GitHub,
    // and a case miss would empty the whole section silently.
    seed("graphql-issues", [
      {
        subject: { type: "issue", key: "I_1" },
        payload: {
          repo: "No42-Org/TWiki",
          number: 5,
          title: "Crash on startup",
          author: "someone",
          htmlUrl: "https://github.com/no42-org/twiki/issues/5",
          createdAt: "2026-08-20T00:00:00.000Z",
        },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.issues.map((i) => i.number)).toEqual([5]);
  });

  it("counts rows it cannot attribute rather than dropping them", () => {
    // A malformed node-keyed row has no readable repository, so it can be
    // neither claimed by this page nor ruled out of it. Skipping it silently
    // would leave the page looking complete while a row belonging to this
    // very repository went missing.
    seed("graphql-issues", [
      {
        subject: { type: "issue", key: "I_bad" },
        payload: { repo: 42, number: "five" },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.issues).toEqual([]);
    expect(view.unattributable).toBe(1);
  });

  it("shows a run still going as having no result yet, not as passing", () => {
    seed("rest-actions-runs", [
      {
        subject: { type: "workflow_run", key: "WFR_1" },
        payload: {
          repo: "no42-org/twiki",
          workflowId: 1,
          workflowName: "CI",
          runNumber: 9,
          status: "in_progress",
          conclusion: null,
          headBranch: "main",
          event: "push",
          htmlUrl: "https://github.com/no42-org/twiki/actions/runs/9",
          createdAt: "2026-08-20T00:00:00.000Z",
        },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.runs[0]?.conclusion).toBeNull();
    expect(view.runs[0]?.status).toBe("in_progress");
  });

  it("suppresses the alert count for a repository that is not covered", () => {
    seed("coverage", [
      {
        subject: { type: "repository_coverage", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", state: "alerts_disabled" },
      },
    ] as never[]);
    seed("rest-org-dependabot", [
      {
        subject: { type: "repository", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", openAlerts: 0, worstSeverity: null },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    // A zero beside "not covered" invites the reader to believe it (AD-28).
    expect(view.coverage).toBe("alerts_disabled");
    expect(view.summary.openAlerts).toBeNull();
  });
});

describe("the per-repository page", () => {
  let dir: string;
  let store: SqliteStore;

  const app = () =>
    createApp({
      store,
      watched: [REPO],
      policy: SWEEP,
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "repopagehttp-"));
    store = SqliteStore.openForWrite(join(dir, "p.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves a watched repository, with the sections it has not collected named", async () => {
    const r = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      normalise(makeAlert({ number: 7, severity: "critical" })),
    ]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const res = await app().request("/repo/no42-org/twiki");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("no42-org/twiki");
    expect(html).toContain("#7");
    expect(html).toContain("critical");
    // The lanes that never ran say so, rather than showing empty tables.
    expect(html).toContain("no lane has vouched for this yet");
    // And the capability with no lane at all is named outright.
    expect(html).toContain("no lane collects review requests yet");
  });

  it("answers 404 for a repository outside the watched set", async () => {
    // repos.yaml is the universe (AD-10). Rendering empty sections for an
    // unwatched repository would be a page full of confident nothings.
    const res = await app().request("/repo/no42-org/not-watched");
    const html = await res.text();

    expect(res.status).toBe(404);
    expect(html).toContain("not in the watched set");
  });

  it("finds a watched repository whatever casing the reader types", async () => {
    const res = await app().request("/repo/No42-Org/TWiki");
    expect(res.status).toBe(200);
  });

  it("links every repository on the list page to its own page", async () => {
    const html = await (await app().request("/")).text();
    expect(html).toContain('href="/repo/no42-org/twiki"');
  });
});
