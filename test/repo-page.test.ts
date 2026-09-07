/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_RANK_POLICY, epssRank } from "../src/core/rank.js";
import { KEV_SUBJECT } from "../src/core/subject.js";
import { normalise } from "../src/tricorder/collect/dependabot-alerts.js";
import { LANE as KEV_LANE } from "../src/tricorder/collect/kev.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { createApp } from "../src/tricorder/web/app.js";
import { buildRepoView } from "../src/tricorder/web/repo-view.js";
import { makeAlert, primaryNav } from "./fakes.js";

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

  const seedAt = (
    lane: string,
    at: string,
    payloads: { subject: never; payload: never }[],
  ) => {
    const r = store.beginRun({
      lane,
      installation: "no42-org",
      scope: "full",
      startedAt: at,
    });
    store.recordObservations(r, at, payloads);
    store.finishRun(r, "ok", at);
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

  it("judges Actions by this repository's own sweep, not the lane's", () => {
    // A bounded sweep reaches some repositories and yields before others.
    // A lane-wide verdict would mark a repository the sweep DID reach as
    // unconfirmed because a different one was missed - or, worse, confirm
    // one it never reached at all.
    const r = store.beginRun({
      lane: "rest-actions-runs",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "repository_actions", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", workflows: 0, failing: 0 },
      },
    ] as never[]);
    // The sweep yielded, so the LANE run is partial.
    store.finishRun(r, "partial", "2026-08-20T11:55:00.000Z", "yielded");

    const reached = buildRepoView(store, REPO, NOW, DEPS);
    const missed = buildRepoView(
      store,
      { owner: "no42-org", name: "never-reached" },
      NOW,
      DEPS,
    );

    // Reached: its own confirmation stands, so "no workflows" is a fact.
    expect(reached.actionsSection.attested).toBe(true);
    // Not reached: nothing vouches for it, and the page says so.
    expect(missed.actionsSection.attested).toBe(false);
  });

  it("does not vouch for Actions on a confirmation it could not read", () => {
    // The sweep reached this repository and could not read what it found.
    // Rendering that as a fresh "no runs recorded" would be a confident
    // zero stated with more confidence than before the confirmation
    // existed (AD-28).
    seed("rest-actions-runs", [
      {
        subject: { type: "repository_actions", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", workflows: null, failing: null },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.actionsSection.attested).toBe(false);
  });

  it("does not keep badging a stale Actions confirmation as vouched for", () => {
    // Same rule the coverage lookup applies: a lane that died days ago must
    // not keep presenting its last word as though it were this hour's.
    seedAt("rest-actions-runs", "2026-08-18T00:00:00.000Z", [
      {
        subject: { type: "repository_actions", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", workflows: 2, failing: 0 },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, {
      policy: SWEEP,
      actionsPolicy: { cadenceMs: 60 * 60_000 },
    });

    expect(view.actionsSection.attested).toBe(false);
  });

  it("refuses to call a partial run an attestation", () => {
    // A partial sweep skipped something, and it may have been exactly this
    // repository: its silence proves nothing.
    run("graphql-update-prs", "partial");

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.prSection.attested).toBe(false);
  });

  it("never attests the Pull requests section before its lane exists", () => {
    // Whatever the other lanes did, nothing collects plain pull requests
    // yet, and the view says so rather than borrowing a sibling's verdict.
    run("graphql-issues", "ok");
    run("graphql-update-prs", "ok");

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.pulls).toEqual([]);
    expect(view.pullsSection).toEqual({
      attested: false,
      freshness: "unknown",
      age: "never collected",
    });
  });

  const PRS = [
    {
      subject: { type: "dependency_update_pr", key: "PR_1" },
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
      subject: { type: "dependency_update_pr", key: "PR_2" },
      payload: {
        repo: "no42-org/twiki",
        number: 2,
        title: "Bump y from 1.0.0 to 1.0.1",
        author: "dependabot",
        htmlUrl: "https://github.com/no42-org/twiki/pull/2",
        createdAt: "2026-08-20T00:00:00.000Z",
        packageName: "y",
        bump: "patch",
      },
    },
  ] as never[];

  it("links an update PR to every alert whose status names it, in numeric order", () => {
    seed("graphql-update-status", [
      // Two alerts share PR 1. Numeric order, not string order: "10" sorts
      // before "9" as text.
      {
        subject: { type: "dependabot_update_status", key: "no42-org/twiki#10" },
        payload: {
          repo: "no42-org/twiki",
          alertNumber: 10,
          update: { pullRequestNumber: 1, error: null },
        },
      },
      {
        subject: { type: "dependabot_update_status", key: "no42-org/twiki#9" },
        payload: {
          repo: "no42-org/twiki",
          alertNumber: 9,
          update: { pullRequestNumber: 1, error: "later attempt failed" },
        },
      },
      // A sibling repository's status naming the same PR number must not
      // link here: status keys carry the repository, and the key decides.
      {
        subject: { type: "dependabot_update_status", key: "no42-org/other#3" },
        payload: {
          repo: "no42-org/other",
          alertNumber: 3,
          update: { pullRequestNumber: 2, error: null },
        },
      },
      // Malformed: skipped, not counted, and the PR it might have named
      // reads as none.
      {
        subject: { type: "dependabot_update_status", key: "no42-org/twiki#4" },
        payload: { repo: "no42-org/twiki", alertNumber: "four" },
      },
      // Key and payload disagree on the alert number: corrupt, counted as
      // unreadable like an alert whose key and payload disagree, and not
      // believed about PR 2.
      {
        subject: { type: "dependabot_update_status", key: "no42-org/twiki#5" },
        payload: {
          repo: "no42-org/twiki",
          alertNumber: 6,
          update: { pullRequestNumber: 2, error: null },
        },
      },
    ] as never[]);
    seed("graphql-update-prs", PRS);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.updatePrs.map((p) => [p.number, p.linkedAlerts])).toEqual([
      [1, [9, 10]],
      [2, []],
    ]);
    expect(view.unreadable).toBe(1);
  });

  it("forgets a link once the alert's status is tombstoned", () => {
    // The status lane reconciles closed alerts away; a PR must not keep
    // naming an alert the store no longer holds.
    seed("graphql-update-status", [
      {
        subject: { type: "dependabot_update_status", key: "no42-org/twiki#7" },
        payload: {
          repo: "no42-org/twiki",
          alertNumber: 7,
          update: { pullRequestNumber: 1, error: null },
        },
      },
    ] as never[]);
    seed("graphql-update-prs", PRS);
    const gone = store.beginRun({
      lane: "graphql-update-status",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:56:00.000Z",
    });
    store.recordTombstones(gone, "2026-08-20T11:56:00.000Z", [
      { type: "dependabot_update_status", key: "no42-org/twiki#7" },
    ]);
    store.finishRun(gone, "ok", "2026-08-20T11:56:00.000Z");

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.updatePrs.map((p) => [p.number, p.linkedAlerts])).toEqual([
      [1, []],
      [2, []],
    ]);
  });

  const review = (key: string, number: number, createdAt: string) => ({
    subject: { type: "review_request", key },
    payload: {
      repo: "no42-org/twiki",
      number,
      title: "Wire the thing",
      author: "someone-else",
      htmlUrl: `https://github.com/no42-org/twiki/pull/${number}`,
      createdAt,
      requestedReviewers: ["indigo423"],
    },
  });

  it("lists review requests oldest first, each waiting since its own createdAt", () => {
    // Sorted as /reviews sorts, not by PR number: the Waiting column only
    // reads sensibly oldest-first, and the wait is the request's age, not
    // the sweep's.
    seed("graphql-review-requests", [
      review("RR_1", 9, "2026-08-18T12:00:00.000Z"),
      review("RR_2", 12, "2026-08-16T12:00:00.000Z"),
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.reviews.map((r) => [r.number, r.waiting, r.age])).toEqual([
      [12, "4d ago", "5m ago"],
      [9, "2d ago", "5m ago"],
    ]);
  });

  it("says a wait it cannot measure is unknown, not never collected", () => {
    // `never collected` is a sentence about sweeps, and this row was
    // plainly collected; its date is what is unreadable.
    seed("graphql-review-requests", [
      review("RR_1", 9, "not a date"),
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.reviews.map((r) => r.waiting)).toEqual(["unknown"]);
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

  it("keeps a sibling repository's alerts off the page", () => {
    // Alerts are read per installation, so every repository the owner has
    // comes back in the same query. Without the per-repository check the
    // page would show a neighbour's alerts as this repository's.
    seed("rest-org-dependabot", [
      normalise(makeAlert({ number: 1 })),
      normalise(
        makeAlert({
          number: 2,
          repo: { owner: "no42-org", name: "other" },
        }),
      ),
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.alerts.map((a) => a.number)).toEqual([1]);
  });

  it("drops a non-https link but keeps the row", () => {
    // The first store-derived href on this page, and hono/jsx renders a
    // `javascript:` scheme verbatim.
    seed("graphql-issues", [
      {
        subject: { type: "issue", key: "I_evil" },
        payload: {
          repo: "no42-org/twiki",
          number: 6,
          title: "Looks fine",
          author: "someone",
          htmlUrl: "javascript:alert(1)",
          createdAt: "2026-08-20T00:00:00.000Z",
        },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.issues).toHaveLength(1);
    expect(view.issues[0]?.htmlUrl).toBeNull();
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
    // The tier reads the same folded slug, or the header would say "no open
    // items" above a listed issue.
    expect(view.summary.tierReason).toMatch(/^issue #5: /);
  });

  it("does not let an unreadable review request mark this page incomplete", () => {
    // Review requests are collected estate-wide by design - 38 of 40
    // measured were in repositories nobody watches - so one corrupt
    // third-party row would otherwise mark EVERY watched repository's page
    // incomplete. The /reviews page counts them instead, where they belong.
    seed("graphql-review-requests", [
      {
        subject: { type: "review_request", key: "RR_bad" },
        payload: { repo: 42, number: "nine" },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.unattributable).toBe(0);
    expect(view.reviews).toEqual([]);
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

  it("does not read a stale coverage attestation as loss of coverage", () => {
    // `unknown` is what a stale attestation degrades to, not evidence that
    // GitHub stopped watching. Treating it as not-covered would let one dead
    // coverage lane blank correct counts off every page in the estate.
    seedAt("coverage", "2026-08-18T00:00:00.000Z", [
      {
        subject: { type: "repository_coverage", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", state: "covered" },
      },
    ] as never[]);
    seed("rest-org-dependabot", [
      {
        subject: { type: "repository", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          openAlerts: 3,
          worstSeverity: "high",
        },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, {
      policy: SWEEP,
      coveragePolicy: { cadenceMs: 24 * 60 * 60_000 },
    });

    expect(view.coverage).toBe("unknown");
    expect(view.notCovered).toBe(false);
    expect(view.summary.openAlerts).toBe(3);
  });

  it("attributes an unreadable alert by its key, not the whole installation", () => {
    // Alert keys are owner/name#number, so a row too malformed to read still
    // says whose it is. Counting before that check made one corrupt row in a
    // sibling repository mark every page in the org incomplete.
    seed("rest-org-dependabot", [
      {
        subject: { type: "dependabot_alert", key: "no42-org/other#9" },
        payload: { number: "nine", repo: 42 },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.unreadable).toBe(0);
    expect(
      buildRepoView(store, { owner: "no42-org", name: "other" }, NOW, DEPS)
        .unreadable,
    ).toBe(1);
  });

  it("counts an alert whose key and payload disagree", () => {
    // Both are written from one RepoRef at ingest, so a disagreement is
    // corruption. Skipping it silently would hide a row we refuse to
    // believe; it is counted instead.
    seed("rest-org-dependabot", [
      {
        subject: { type: "dependabot_alert", key: "no42-org/twiki#3" },
        payload: {
          ...(normalise(makeAlert({ number: 3 })).payload as object),
          repo: "no42-org/somewhere-else",
        },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.alerts).toEqual([]);
    expect(view.unreadable).toBe(1);
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

  /** One alert beside a KEV catalogue, so its KEV term is checked, not unknown. */
  const seedKevAndAlert = (
    alert: Parameters<typeof makeAlert>[0],
    cveIds = ["CVE-0000-0000"],
    kevAt = "2026-08-20T11:55:00.000Z",
  ) => {
    const kev = store.beginRun({
      lane: KEV_LANE,
      installation: "cisa",
      scope: "full",
      startedAt: kevAt,
    });
    store.recordObservations(kev, kevAt, [
      {
        subject: KEV_SUBJECT,
        payload: { version: "2026.08.20", released: kevAt, cveIds },
      },
    ]);
    store.finishRun(kev, "ok", kevAt);
    const r = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      normalise(makeAlert(alert)),
    ]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");
  };

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
      normalise(
        makeAlert({
          number: 7,
          severity: "critical",
          htmlUrl: "https://github.com/no42-org/twiki/security/dependabot/7",
        }),
      ),
      normalise(
        makeAlert({
          number: 8,
          cveId: "CVE-2026-0002",
          packageName: "is-odd",
          htmlUrl: "https://github.com/no42-org/twiki/security/dependabot/8",
        }),
      ),
      {
        subject: { type: "repository", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          openAlerts: 2,
          worstSeverity: "critical",
        },
      } as never,
    ]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const res = await app().request("/repo/no42-org/twiki");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("no42-org/twiki");
    // The whole Security table: the link, the advisory, the severity word
    // painted critical only when it is, the package, the row's freshness.
    const link = (n: number) =>
      `<a href="https://github.com/no42-org/twiki/security/dependabot/${n}" target="_blank" rel="noopener noreferrer">#${n}<span class="ext" aria-hidden="true">\u202F\u2197</span><span class="sr-only">, opens GitHub in a new tab</span></a>`;
    const fresh =
      '<td><span class="badge fresh" title="5m ago">fresh · 5m ago</span></td>';
    expect(html).toContain(
      '<h2 id="security">Security <span class="badge fresh" title="5m ago">fresh · 5m ago</span> <span class="shown">2 shown</span></h2>' +
        "<table><thead><tr><th>Alert</th><th>Severity</th><th>Package</th><th>Last confirmed</th></tr></thead>" +
        "<tbody>" +
        `<tr><td>${link(7)} · CVE-2026-0001</td><td class="crit">critical</td><td>left-pad</td>${fresh}</tr>` +
        `<tr><td>${link(8)} · CVE-2026-0002</td><td class="">high</td><td>is-odd</td>${fresh}</tr>` +
        "</tbody></table>",
    );
    // The lanes that never ran say so, rather than showing empty tables -
    // and say it without claiming more than the store can support.
    expect(html).toContain("not confirmed by any completed sweep");
    // Review requests have a lane now (CAP-5), so the section behaves like
    // every other one: unconfirmed until a sweep says otherwise, and the
    // heading says so itself rather than leaving it to a table.
    expect(html).toContain(
      '<h2 id="reviews">Reviews <span class="badge unknown" title="never collected">never collected</span> <span class="shown">0 shown</span></h2>' +
        '<p class="attest">not confirmed by any completed sweep</p>',
    );
  });

  it("does not list alerts under a header saying it has no count", async () => {
    // Coverage withdrawn while the alert lane is failing, so its rows are
    // still present. Printing "no count" and then twelve alerts beneath it
    // has each half contradicting the other (AD-28).
    const r = store.beginRun({
      lane: "coverage",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "repository_coverage", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", state: "alerts_disabled" },
      },
      normalise(makeAlert({ number: 7 })),
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const html = await (await app().request("/repo/no42-org/twiki")).text();

    expect(html).toContain("not covered");
    // The section's whole standing: the heading still carries the alert
    // lane's badge (no repository confirmation here, so never collected)
    // but no count, because a section with no count to give must not say
    // `0 shown` (AD-28); the coverage reason is the attestation note, and
    // no table follows it.
    expect(html).toContain(
      '<h2 id="security">Security <span class="badge unknown" title="never collected">never collected</span></h2>' +
        '<p class="attest">Dependabot alerts are switched off for this repository</p>' +
        '<h2 id="ci">',
    );
    // The stale row is not listed beneath the suppression.
    expect(html).not.toContain("#7");
  });

  it("does not claim never-collected over rows it is showing", async () => {
    // A clean sweep yesterday, a partial one today: the rows stand, but the
    // latest sweep did not confirm them. "No lane has vouched for this" over
    // a table of three issues is simply false.
    const ok = store.beginRun({
      lane: "graphql-issues",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:50:00.000Z",
    });
    store.recordObservations(ok, "2026-08-20T11:50:00.000Z", [
      {
        subject: { type: "issue", key: "I_1" },
        payload: {
          repo: "no42-org/twiki",
          number: 5,
          title: "Crash on startup",
          author: "someone",
          htmlUrl: "https://github.com/no42-org/twiki/issues/5",
          createdAt: "2026-08-20T00:00:00.000Z",
        },
      },
    ] as never[]);
    store.finishRun(ok, "ok", "2026-08-20T11:50:00.000Z");
    const partial = store.beginRun({
      lane: "graphql-issues",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:56:00.000Z",
    });
    store.finishRun(partial, "partial", "2026-08-20T11:56:00.000Z", "degraded");

    const html = await (await app().request("/repo/no42-org/twiki")).text();

    expect(html).toContain("#5");
    // Scoped to the issues section: other sections on this page genuinely
    // have no completed sweep, and asserting over the whole document would
    // pass on their text instead of this one's.
    const section = html.slice(
      html.indexOf('<h2 id="issues">'),
      html.indexOf('<h2 id="reviews">'),
    );
    expect(section).toContain(
      '<h2 id="issues">Issues <span class="badge fresh" title="4m ago">fresh · 4m ago</span> <span class="shown">1 shown</span></h2>' +
        '<p class="attest warn">1 collected earlier; the latest sweep did not confirm them</p>' +
        "<table><thead><tr><th>Issue</th><th>Opened by</th><th>Last confirmed</th></tr></thead>" +
        "<tbody><tr><td>" +
        '<a href="https://github.com/no42-org/twiki/issues/5" target="_blank" rel="noopener noreferrer">#5<span class="ext" aria-hidden="true">\u202F\u2197</span><span class="sr-only">, opens GitHub in a new tab</span></a> Crash on startup' +
        "</td><td>someone</td>" +
        // The row's own freshness is the clean sweep's, not the partial's.
        '<td><span class="badge fresh" title="10m ago">fresh · 10m ago</span></td>' +
        "</tr></tbody></table>",
    );
    expect(section).not.toContain("not confirmed by any completed sweep");
  });

  it("renders an attested empty Issues section as its own sentence", async () => {
    const r = store.beginRun({
      lane: "graphql-issues",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const html = await (await app().request("/repo/no42-org/twiki")).text();

    expect(html).toContain(
      '<h2 id="issues">Issues <span class="badge fresh" title="5m ago">fresh · 5m ago</span> <span class="shown">0 shown</span></h2>' +
        '<p class="attest">no untriaged issues in this repository</p>' +
        '<h2 id="reviews">',
    );
  });

  it("renders the CI section from this repository's runs, a running one with no result yet", async () => {
    const r = store.beginRun({
      lane: "rest-actions-runs",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    const run = (over: Record<string, unknown>) => ({
      subject: { type: "workflow_run", key: `WFR_${over.runNumber}` },
      payload: {
        repo: "no42-org/twiki",
        workflowId: 1,
        headBranch: "main",
        event: "push",
        createdAt: "2026-08-20T00:00:00.000Z",
        ...over,
      },
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "repository_actions", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", workflows: 2, failing: 1 },
      },
      run({
        workflowName: "Release",
        runNumber: 3,
        status: "completed",
        conclusion: "failure",
        headBranch: "v1.2.0",
        htmlUrl: "https://github.com/no42-org/twiki/actions/runs/3",
      }),
      run({
        workflowName: "CI",
        runNumber: 9,
        status: "in_progress",
        conclusion: null,
        htmlUrl: "https://github.com/no42-org/twiki/actions/runs/9",
      }),
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const html = await (await app().request("/repo/no42-org/twiki")).text();

    const link = (n: number, name: string) =>
      `<a href="https://github.com/no42-org/twiki/actions/runs/${n}" target="_blank" rel="noopener noreferrer">${name}<span class="ext" aria-hidden="true">\u202F\u2197</span><span class="sr-only">, opens GitHub in a new tab</span></a> <span class="why">#${n}</span>`;
    const fresh =
      '<td><span class="badge fresh" title="5m ago">fresh · 5m ago</span></td>';
    expect(html).toContain(
      '<h2 id="ci">CI <span class="badge fresh" title="5m ago">fresh · 5m ago</span> <span class="shown">2 shown</span></h2>' +
        "<table><thead><tr><th>Workflow</th><th>Result</th><th>Branch</th><th>Last confirmed</th></tr></thead>" +
        "<tbody>" +
        // Workflows in name order; a run still going says so rather than
        // passing, and a failure is painted as one.
        `<tr><td>${link(9, "CI")}</td><td class="">in_progress, no result yet</td><td>main</td>${fresh}</tr>` +
        `<tr><td>${link(3, "Release")}</td><td class="crit">failure</td><td>v1.2.0</td>${fresh}</tr>` +
        "</tbody></table>",
    );
  });

  it("leads with a breadcrumb back to the overview", async () => {
    const html = await (await app().request("/repo/no42-org/twiki")).text();

    expect(html).toContain(
      '<main id="main"><nav class="crumb" aria-label="breadcrumb"><a href="/">overview</a> › no42-org/twiki</nav><header>',
    );
  });

  it("groups everything by topic, in the vocabulary's order, under the vocabulary's labels", async () => {
    // Six headings in TOPICS order, each with its own badge and count, and
    // the five titles the page used to carry appear nowhere on it.
    const html = await (await app().request("/repo/no42-org/twiki")).text();

    const headings = [...html.matchAll(/<h2 id="[^"]*">.*?<\/h2>/g)].map(
      (m) => m[0],
    );
    const unswept = (id: string, label: string) =>
      `<h2 id="${id}">${label} <span class="badge unknown" title="never collected">never collected</span> <span class="shown">0 shown</span></h2>`;
    expect(headings).toEqual([
      unswept("security", "Security"),
      unswept("ci", "CI"),
      unswept("dependencies", "Dependencies"),
      unswept("pulls", "Pull requests"),
      unswept("issues", "Issues"),
      unswept("reviews", "Reviews"),
    ]);
    for (const old of [
      "Security alerts",
      "Dependency-update pull requests",
      "Actions status",
      "Untriaged issues",
      "Review requests",
    ]) {
      expect(html).not.toContain(old);
    }
  });

  it("says the Pull requests section is unconfirmed, never that it is empty", async () => {
    // No lane collects plain pull requests until Epic 3. A `0` here would
    // be a count nobody took (AD-28); the section says exactly what it
    // knows, which is nothing yet.
    const html = await (await app().request("/repo/no42-org/twiki")).text();

    expect(html).toContain(
      '<h2 id="pulls">Pull requests <span class="badge unknown" title="never collected">never collected</span> <span class="shown">0 shown</span></h2>' +
        '<p class="attest">not confirmed by any completed sweep</p>' +
        '<h2 id="issues">',
    );
  });

  it("renders an attested empty section as a sentence, not an empty table", async () => {
    const r = store.beginRun({
      lane: "graphql-review-requests",
      installation: "reviews",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const html = await (await app().request("/repo/no42-org/twiki")).text();

    expect(html).toContain(
      '<h2 id="reviews">Reviews <span class="badge fresh" title="5m ago">fresh · 5m ago</span> <span class="shown">0 shown</span></h2>' +
        '<p class="attest">no review requests in this repository</p>' +
        "</section></main>",
    );
  });

  it("links an update PR to the alert whose status names it, or says none is on record", async () => {
    // The precise join, not the package heuristic: `#7` beside a PR means
    // GitHub said the PR was opened for alert 7, and `none on record` means
    // no status says so, which is a different fact from "not linked".
    const r = store.beginRun({
      lane: "graphql-update-status",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "dependabot_update_status", key: "no42-org/twiki#7" },
        payload: {
          repo: "no42-org/twiki",
          alertNumber: 7,
          update: { pullRequestNumber: 1, error: null },
        },
      },
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");
    const prs = store.beginRun({
      lane: "graphql-update-prs",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(prs, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "dependency_update_pr", key: "PR_1" },
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
        subject: { type: "dependency_update_pr", key: "PR_2" },
        payload: {
          repo: "no42-org/twiki",
          number: 2,
          title: "Bump y from 1.0.0 to 2.0.0",
          author: "dependabot",
          htmlUrl: "https://github.com/no42-org/twiki/pull/2",
          createdAt: "2026-08-20T00:00:00.000Z",
          packageName: "y",
          bump: "major",
        },
      },
    ] as never[]);
    store.finishRun(prs, "ok", "2026-08-20T11:55:00.000Z");

    const html = await (await app().request("/repo/no42-org/twiki")).text();

    const link = (n: number) =>
      `<a href="https://github.com/no42-org/twiki/pull/${n}" target="_blank" rel="noopener noreferrer">#${n}<span class="ext" aria-hidden="true">\u202F\u2197</span><span class="sr-only">, opens GitHub in a new tab</span></a>`;
    const fresh =
      '<td><span class="badge fresh" title="5m ago">fresh · 5m ago</span></td>';
    expect(html).toContain(
      '<h2 id="dependencies">Dependencies <span class="badge fresh" title="5m ago">fresh · 5m ago</span> <span class="shown">2 shown</span></h2>' +
        "<table><thead><tr><th>PR</th><th>Package</th><th>Linked alert</th><th>Last confirmed</th></tr></thead>" +
        "<tbody>" +
        `<tr><td>${link(1)} Bump x from 1.0.0 to 1.0.1</td><td>x</td><td>#7</td>${fresh}</tr>` +
        `<tr><td>${link(2)} Bump y from 1.0.0 to 2.0.0</td><td>y</td><td>none on record</td>${fresh}</tr>` +
        "</tbody></table>",
    );
  });

  it("says how long each review request has waited, from the request's own age", async () => {
    const r = store.beginRun({
      lane: "graphql-review-requests",
      installation: "reviews",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "review_request", key: "RR_1" },
        payload: {
          repo: "no42-org/twiki",
          number: 9,
          title: "Wire the thing",
          author: "someone-else",
          htmlUrl: "https://github.com/no42-org/twiki/pull/9",
          createdAt: "2026-08-16T12:00:00.000Z",
          requestedReviewers: ["indigo423", "other"],
        },
      },
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const html = await (await app().request("/repo/no42-org/twiki")).text();

    expect(html).toContain(
      '<h2 id="reviews">Reviews <span class="badge fresh" title="5m ago">fresh · 5m ago</span> <span class="shown">1 shown</span></h2>' +
        "<table><thead><tr><th>PR</th><th>Requested from</th><th>Waiting</th><th>Last confirmed</th></tr></thead>" +
        "<tbody><tr><td>" +
        '<a href="https://github.com/no42-org/twiki/pull/9" target="_blank" rel="noopener noreferrer">#9<span class="ext" aria-hidden="true">\u202F\u2197</span><span class="sr-only">, opens GitHub in a new tab</span></a> Wire the thing' +
        "</td><td>indigo423, other</td><td>4d ago</td>" +
        '<td><span class="badge fresh" title="5m ago">fresh · 5m ago</span></td>' +
        "</tr></tbody></table>",
    );
  });

  it("puts the policy note in a footer outside main", async () => {
    const html = await (await app().request("/repo/no42-org/twiki")).text();

    expect(html).toContain(
      '</main><footer class="policy-note">Every value carries its own freshness, because each lane confirms on its own cadence. A section that no lane has vouched for says so rather than showing an empty table.</footer>',
    );
  });

  it("keeps showing the count when the coverage attestation goes stale", async () => {
    // The bug this pins was in the RENDERER, not the view model: it
    // re-derived "not covered" as anything-but-covered, which swallows
    // `unknown` - the state a stale coverage attestation degrades to. Two
    // days of a dead coverage lane would have blanked the count on every
    // page while the list page still showed it.
    const old = store.beginRun({
      lane: "coverage",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-18T00:00:00.000Z",
    });
    store.recordObservations(old, "2026-08-18T00:00:00.000Z", [
      {
        subject: { type: "repository_coverage", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", state: "covered" },
      },
    ] as never[]);
    store.finishRun(old, "ok", "2026-08-18T00:00:00.000Z");

    const fresh = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(fresh, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "repository", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          openAlerts: 3,
          worstSeverity: "high",
        },
      },
    ] as never[]);
    store.finishRun(fresh, "ok", "2026-08-20T11:55:00.000Z");

    const withDailyCoverage = createApp({
      store,
      watched: [REPO],
      policy: SWEEP,
      lanePolicies: { coverage: { cadenceMs: 24 * 60 * 60_000 } },
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });
    const html = await (
      await withDailyCoverage.request("/repo/no42-org/twiki")
    ).text();

    expect(html).toContain("3 open alerts");
    expect(html).not.toContain("not covered");
    expect(html).not.toContain("no count and no list");
  });

  it("carries the tier chip and the summary sentence in its header", async () => {
    // The whole header, not one attribute of it: the chip, its hidden
    // prefix, the sentence and the rationale all come from one computation
    // over the same rows (AD-29, AD-32), and a test that looked only at the
    // chip would let the sentence beside it drift.
    const r = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      normalise(
        makeAlert({
          number: 1,
          cveId: "CVE-2026-0001",
          epssPercentage: 0.5,
          severity: "high",
        }),
      ),
      normalise(
        makeAlert({
          number: 2,
          cveId: "CVE-2026-0002",
          epssPercentage: 0.02,
          severity: "medium",
        }),
      ),
      {
        subject: { type: "repository", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          openAlerts: 9,
          worstSeverity: "low",
        },
      },
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const html = await (await app().request("/repo/no42-org/twiki")).text();

    const header = html.slice(
      html.indexOf("<header>"),
      html.indexOf("</header>") + "</header>".length,
    );
    expect(header).toBe(
      "<header>" +
        '<h1>no42-org/twiki <span class="tier now"><span class="sr-only">attention tier: </span>now</span></h1>' +
        '<p class="sub">' +
        '<span class="badge fresh" title="5m ago">fresh · 5m ago</span> ' +
        // Counted from the rows shown, not the confirmation's 9 / low.
        "2 open alerts, worst high · " +
        '<span class="why">alert #1 left-pad: KEV status unknown, EPSS 50.0%, severity high, not an update, stuck state unknown</span>' +
        "</p>" +
        "</header>",
    );
  });

  it("reads no open alerts as words, and an uncollected count as a gap", async () => {
    // A confirmed zero and a never-collected count are different pictures
    // (AD-28), and neither may render as the digit 0.
    const unseen = await (await app().request("/repo/no42-org/twiki")).text();
    expect(unseen).toContain('<span class="tier quiet">');
    expect(unseen).toContain("alert count not collected");

    const r = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "repository", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", openAlerts: 0, worstSeverity: null },
      },
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const confirmed = await (
      await app().request("/repo/no42-org/twiki")
    ).text();
    expect(confirmed).toContain("no open alerts");
    expect(confirmed).not.toContain("0 open alerts");
  });

  it("ranks the header with the cut it was given", async () => {
    // Deleting `cutRank` from the route's deps keeps the default 0.1 and
    // this alert at 0.2 reads now; the top band makes it soon.
    seedKevAndAlert({ number: 1, epssPercentage: 0.2 });

    const html = await (
      await createApp({
        store,
        watched: [REPO],
        policy: SWEEP,
        rankPolicy: DEFAULT_RANK_POLICY,
        cutRank: epssRank(0.5, DEFAULT_RANK_POLICY.epssBands),
        now: () => NOW,
      }).request("/repo/no42-org/twiki")
    ).text();

    expect(html).toContain('<span class="tier soon">');
  });

  it("budgets reviews with the days it was given", async () => {
    // Five days waiting: overdue on the default budget, inside ten.
    const r = store.beginRun({
      lane: "graphql-review-requests",
      installation: "reviews",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "review_request", key: "RR_1" },
        payload: {
          repo: "no42-org/twiki",
          number: 9,
          title: "Wire the thing",
          author: "someone-else",
          htmlUrl: "https://github.com/no42-org/twiki/pull/9",
          createdAt: "2026-08-15T12:00:00.000Z",
          requestedReviewers: ["indigo423"],
        },
      },
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const html = await (
      await createApp({
        store,
        watched: [REPO],
        policy: SWEEP,
        rankPolicy: DEFAULT_RANK_POLICY,
        reviewBudgetDays: 10,
        now: () => NOW,
      }).request("/repo/no42-org/twiki")
    ).text();

    expect(html).toContain('<span class="tier quiet">');
  });

  it("judges the KEV catalogue on the KEV lane's cadence, not the sweep's", async () => {
    // An hour-old catalogue is stale on the 15-minute sweep policy, which
    // makes every KEV verdict unknown and this listed alert merely soon.
    seedKevAndAlert(
      { number: 1, cveId: "CVE-2021-44228", epssPercentage: 0.001 },
      ["CVE-2021-44228"],
      "2026-08-20T11:00:00.000Z",
    );

    const html = await (
      await createApp({
        store,
        watched: [REPO],
        policy: SWEEP,
        lanePolicies: { [KEV_LANE]: { cadenceMs: 24 * 60 * 60_000 } },
        rankPolicy: DEFAULT_RANK_POLICY,
        now: () => NOW,
      }).request("/repo/no42-org/twiki")
    ).text();

    expect(html).toContain('<span class="tier now">');
  });

  it("answers 404 for a repository outside the watched set", async () => {
    // repos.yaml is the universe (AD-10). Rendering empty sections for an
    // unwatched repository would be a page full of confident nothings.
    const res = await app().request("/repo/no42-org/not-watched");
    const html = await res.text();

    expect(res.status).toBe(404);
    expect(html).toContain("<title>unknown repository · gitricorder</title>");
    expect(html).toContain("not in the watched set");
    // And a way back, so a mistyped slug is not a dead end.
    expect(html).toContain('<p><a href="/">back to the overview</a></p>');
    // No list on it, so nothing to skip to; the nav still says the time,
    // and the page keeps its contentinfo landmark like every other.
    expect(html).toContain(`<body>${NAV}<main id="main">`);
    expect(html).toContain(
      '</main><footer class="policy-note">Only repositories listed in repos.yaml have a page; nothing is discovered.</footer>',
    );
  });

  // Story 1.8 (#129): a repo page is under the overview, not one of the
  // three nav links, so nothing in the nav is current here.
  const NAV = primaryNav(null, "2026-08-20T12:00:00.000Z");

  it("names the repository and its tier in the title, marks no nav link current, and skips to the list", async () => {
    seedKevAndAlert({ number: 1, epssPercentage: 0.5 });
    const html = await (await app().request("/repo/no42-org/twiki")).text();

    expect(html).toContain("<title>no42-org/twiki · now · gitricorder</title>");
    expect(html).toContain(
      '<body><a class="skip" href="#list">skip to list</a>' +
        NAV +
        '<main id="main"><nav class="crumb" aria-label="breadcrumb">',
    );
    // Nowhere in the body, not only in the primary nav. The style block
    // names the attribute in a selector, so the head is excluded.
    expect(html.slice(html.indexOf("<body>"))).not.toContain("aria-current");
    // The six sections are the list the skip link lands on.
    expect(html).toContain(
      '</header><section id="list" aria-label="repository sections"><h2 id="security">',
    );
    expect(html).toContain('</section></main><footer class="policy-note">');
    // The rendered-at time is in the nav only.
    expect(html.match(/<time /g)).toHaveLength(1);
    expect(html).not.toContain("· rendered");
  });

  it("carries the tier the chip shows, quiet included", async () => {
    const html = await (await app().request("/repo/no42-org/twiki")).text();
    expect(html).toContain(
      "<title>no42-org/twiki · quiet · gitricorder</title>",
    );
    expect(html).toContain('<span class="tier quiet">');
  });

  it("finds a watched repository whatever casing the reader types", async () => {
    const res = await app().request("/repo/No42-Org/TWiki");
    expect(res.status).toBe(200);
  });

  it("links every repository on the list page to its own page", async () => {
    // A completed sweep with an open alert, so the repository has a row:
    // before the first completed sweep the overview lists nothing.
    seedKevAndAlert({ number: 1 });
    const html = await (await app().request("/")).text();
    expect(html).toContain('href="/repo/no42-org/twiki"');
  });
});
