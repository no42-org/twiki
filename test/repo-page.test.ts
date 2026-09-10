/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Octokit } from "@octokit/rest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isDefaultBranchRun } from "../src/core/branch.js";
import { DEFAULT_RANK_POLICY, epssRank } from "../src/core/rank.js";
import { redact } from "../src/core/redact.js";
import { KEV_SUBJECT } from "../src/core/subject.js";
import { OctokitGitHub } from "../src/github/octokit-adapter.js";
import {
  normalise as normaliseScan,
  summariseRepo as summariseScanRepo,
} from "../src/tricorder/collect/code-scanning.js";
import { normalise } from "../src/tricorder/collect/dependabot-alerts.js";
import { LANE as KEV_LANE } from "../src/tricorder/collect/kev.js";
import {
  collectOrgSecretScanning,
  normalise as normaliseSecret,
  summariseRepo as summariseSecretRepo,
} from "../src/tricorder/collect/secret-scanning.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { createApp } from "../src/tricorder/web/app.js";
import {
  buildRepoView,
  compareRunRows,
  type RepoRunRow,
} from "../src/tricorder/web/repo-view.js";
import {
  makeAlert,
  makeCodeScanningAlert,
  makeSecretScanningAlert,
  primaryNav,
} from "./fakes.js";

const NOW = new Date("2026-08-20T12:00:00.000Z");
const SWEEP = { cadenceMs: 15 * 60_000 };
const REPO = { owner: "no42-org", name: "twiki" };
/** What the endpoint answers when the App may not read it at all (#152). */
const NOT_ACCESSIBLE = "Resource not accessible by integration";
/** GitHub's measured body when secret scanning is switched off (#152). */
const SECRETS_OFF = "Secret scanning is disabled on this repository.";
const HOURLY = { cadenceMs: 60 * 60_000 };
const DEPS = {
  policy: SWEEP,
  actionsPolicy: HOURLY,
  defaultBranch: "main",
};

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

    const view = buildRepoView(store, REPO, NOW, DEPS);

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

  /** One completed run of CI on main, written by the sweep at `at`. */
  const actionsSweepAt = (at: string) =>
    seedAt("rest-actions-runs", at, [
      {
        subject: { type: "repository_actions", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", workflows: 1, failing: 0 },
      },
      {
        subject: { type: "workflow_run", key: "WFR_9" },
        payload: {
          repo: "no42-org/twiki",
          workflowId: 1,
          workflowName: "CI",
          runNumber: 9,
          status: "completed",
          conclusion: "success",
          headBranch: "main",
          event: "push",
          htmlUrl: "https://github.com/no42-org/twiki/actions/runs/9",
          createdAt: "2026-08-20T00:00:00.000Z",
        },
      },
    ] as never[]);

  it("judges a run row on the Actions cadence, like the section above it", () => {
    // Row and section come out of the SAME hourly sweep, so they cannot be
    // allowed to disagree about it. Judged on the fifteen-minute sweep budget
    // the row went stale after thirty minutes beneath a heading still
    // vouching for that very sweep, and beneath a queue that ranked it (#154).
    //
    // Forty-five minutes, not the twenty minutes the issue quotes: twenty is
    // inside BOTH budgets, so a test at that age reads fresh whichever policy
    // the row uses and could never have caught this.
    actionsSweepAt("2026-08-20T11:15:00.000Z");

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.runs.map((r) => [r.key, r.freshness, r.age])).toEqual([
      ["WFR_9", "fresh", "45m ago"],
    ]);
    expect(view.actionsSection).toEqual({
      attested: true,
      freshness: "fresh",
      age: "45m ago",
    });
  });

  it("calls a run row stale on the Actions cadence while the sweep budget is still fresh", () => {
    // The other half, and it has to be the other DIRECTION, not merely an
    // older row: with the Actions lane the slower of the two, any age that
    // is stale hourly is stale on the sweep budget as well, so the test
    // passes whichever policy the row reads. Here the Actions cadence is the
    // TIGHTER one - five minutes against the sweep's fifteen - and the row is
    // twenty minutes old: past the hourly lane's two cadences, still inside
    // the sweep's. The row must read stale, which it can only do by taking
    // the Actions budget rather than the sweep budget or the looser of the
    // two.
    actionsSweepAt("2026-08-20T11:40:00.000Z");

    const view = buildRepoView(store, REPO, NOW, {
      ...DEPS,
      actionsPolicy: { cadenceMs: 5 * 60_000 },
    });

    expect(view.runs.map((r) => [r.key, r.freshness, r.age])).toEqual([
      ["WFR_9", "stale", "20m ago"],
    ]);
    expect(view.actionsSection).toEqual({
      attested: false,
      freshness: "stale",
      age: "20m ago",
    });
  });

  it("orders the run list totally: workflow, then main, then run number", () => {
    // The lane retains up to two rows per workflow now, so a sort on the
    // workflow name alone ties and leaves the two halves in whatever order
    // the store happened to return. Default branch first, because a failure
    // on main is the one a reader came for.
    const row = (over: Record<string, unknown>) => ({
      subject: { type: "workflow_run", key: `WFR_${over.runNumber}` },
      payload: {
        repo: "no42-org/twiki",
        workflowId: 1,
        workflowName: "CI",
        status: "completed",
        conclusion: "success",
        headBranch: "main",
        event: "push",
        htmlUrl: "https://github.com/no42-org/twiki/actions/runs/1",
        createdAt: "2026-08-20T00:00:00.000Z",
        ...over,
      },
    });
    seed("rest-actions-runs", [
      row({ workflowName: "Release", runNumber: 1 }),
      row({ runNumber: 10, headBranch: "feature/x" }),
      row({ runNumber: 9 }),
      // A second workflow that happens to share a display name, both on
      // main: the run number is what breaks the next tie.
      row({ workflowId: 2, runNumber: 4 }),
      // And a third sharing the name AND the run number, which GitHub allows
      // because run numbers count per workflow. Nothing but the subject key
      // separates these two, so without it the order is whatever the store
      // returned and moves between renders - and the JSX key collides the
      // same way.
      {
        ...row({ workflowId: 3, runNumber: 4 }),
        subject: { type: "workflow_run", key: "WFR_dup" },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, {
      ...DEPS,
      defaultBranch: "main",
    });

    expect(
      view.runs.map((r) => [r.workflowName, r.headBranch, r.runNumber]),
    ).toEqual([
      ["CI", "main", 9],
      // The tie the subject key breaks: `WFR_4` before `WFR_dup`.
      ["CI", "main", 4],
      ["CI", "main", 4],
      ["CI", "feature/x", 10],
      ["Release", "main", 1],
    ]);
    // Stated as keys too, because the pair above is indistinguishable in the
    // columns a reader sees and an unstable order would still match it.
    expect(view.runs.map((r) => r.key)).toEqual([
      "WFR_9",
      "WFR_4",
      "WFR_dup",
      "WFR_10",
      "WFR_1",
    ]);
  });

  it("puts a broken run first within its bucket, under the default-branch rule", () => {
    // Two terms, and their order matters. Within one bucket the run that did
    // not go green is the one a reader came for, so it leads; but the term
    // sits BELOW the default-branch rule, so a failed feature branch stays
    // under a green main rather than climbing over it.
    const row = (over: Record<string, unknown>) => ({
      subject: { type: "workflow_run", key: `WFR_${over.runNumber}` },
      payload: {
        repo: "no42-org/twiki",
        workflowId: 1,
        workflowName: "CI",
        status: "completed",
        conclusion: "success",
        headBranch: "main",
        event: "push",
        htmlUrl: "https://github.com/no42-org/twiki/actions/runs/1",
        createdAt: "2026-08-20T00:00:00.000Z",
        ...over,
      },
    });
    seed("rest-actions-runs", [
      // A rerun of main that passed, newer than the failure it has not
      // replaced: the run number alone would bury the red one.
      row({ runNumber: 11 }),
      row({ runNumber: 10, conclusion: "failure" }),
      // A hung run on main, judged by age against the two-hour threshold and
      // broken though it never said `failure`. Newest of the three, so this
      // also pins that broken-ness is read before the run number.
      row({
        runNumber: 12,
        status: "in_progress",
        conclusion: null,
        createdAt: "2026-08-20T00:00:00.000Z",
      }),
      // Failed, on a feature branch. Below every main row whatever it says.
      row({ runNumber: 20, headBranch: "feature/x", conclusion: "failure" }),
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, {
      ...DEPS,
      defaultBranch: "main",
    });

    expect(
      view.runs.map((r) => [r.headBranch, r.runNumber, r.verdict]),
    ).toEqual([
      ["main", 12, "hung"],
      ["main", 10, "failed"],
      ["main", 11, "passed"],
      ["feature/x", 20, "failed"],
    ]);
  });

  it("derives the header tier from the repository's DECLARED branch", () => {
    // The page's tier now comes from a queue that reads the branch, not just
    // from alerts. With the resolver silently answering `main`, a repository
    // that declares `master` read `quiet` on its own page while the overview
    // read `now` from the very same rows.
    const run = (over: Record<string, unknown>) => ({
      subject: { type: "workflow_run", key: `WFR_${over.runNumber}` },
      payload: {
        repo: "no42-org/twiki",
        workflowId: 1,
        workflowName: "CI",
        status: "completed",
        conclusion: "failure",
        event: "push",
        htmlUrl: "https://github.com/no42-org/twiki/actions/runs/9",
        createdAt: "2026-08-20T10:00:00.000Z",
        ...over,
      },
    });
    seed("rest-actions-runs", [
      {
        subject: { type: "repository_actions", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", workflows: 1, failing: 1 },
      },
      run({ runNumber: 9, headBranch: "master" }),
    ] as never[]);

    const declared = buildRepoView(store, REPO, NOW, {
      ...DEPS,
      defaultBranch: "master",
    });

    expect(declared.summary.tier).toBe("now");
    expect(declared.summary.tierReason).toBe(
      "workflow run #9: default branch workflow CI failed 2h ago",
    );

    // On `main` the very same row is a side branch and gives no item, and a
    // resolver that could not say at all must reach the same answer rather
    // than guessing `main` was right.
    for (const branch of ["main", null]) {
      const other = buildRepoView(store, REPO, NOW, {
        ...DEPS,
        defaultBranch: branch,
      });
      expect([other.summary.tier, other.summary.tierReason]).toEqual([
        "quiet",
        "no open items",
      ]);
    }
  });

  it("keeps a failed feature branch off the tier and out of the queue (#141)", () => {
    // The repository page lists it, because a reader looking at this
    // repository wants to see it. Nothing else does: it is not a statement
    // about main, so it gives no item and no tier.
    seed("rest-actions-runs", [
      {
        subject: { type: "repository_actions", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", workflows: 1, failing: 0 },
      },
      {
        subject: { type: "workflow_run", key: "WFR_20" },
        payload: {
          repo: "no42-org/twiki",
          workflowId: 1,
          workflowName: "CI",
          runNumber: 20,
          status: "completed",
          conclusion: "failure",
          headBranch: "feature/x",
          event: "push",
          htmlUrl: "https://github.com/no42-org/twiki/actions/runs/20",
          createdAt: "2026-08-20T10:00:00.000Z",
        },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, {
      ...DEPS,
      defaultBranch: "main",
    });

    expect(view.runs.map((r) => [r.headBranch, r.verdict])).toEqual([
      ["feature/x", "failed"],
    ]);
    expect(view.summary.tier).toBe("quiet");
    expect(view.summary.tierReason).toBe("no open items");
  });

  it("sorts a fork's pull request below the genuine default-branch run (#141)", () => {
    // Driven through buildRepoView rather than by handing compareRunRows a
    // predicate the test wrote: the thing that can regress is the wiring in
    // repo-view, and a test that supplies its own predicate cannot see that.
    const row = (over: Record<string, unknown>) => ({
      subject: { type: "workflow_run", key: `WFR_${String(over.event)}` },
      payload: {
        repo: "no42-org/twiki",
        workflowId: 1,
        workflowName: "CI",
        headBranch: "main",
        event: "push",
        status: "completed",
        conclusion: "success",
        htmlUrl: "https://github.com/no42-org/twiki/actions/runs/1",
        createdAt: "2026-08-20T00:00:00.000Z",
        ...over,
      },
    });
    // Same workflow, same run number, both saying `main`. Only the event
    // separates a build of main from a stranger's proposed merge.
    seed("rest-actions-runs", [
      row({ runNumber: 7, event: "pull_request", conclusion: "failure" }),
      row({ runNumber: 7, event: "push" }),
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.runs.map((x) => x.event)).toEqual(["push", "pull_request"]);
  });

  it("never returns 0 for two different rows", () => {
    // The comparator asserted directly, because its last term is invisible
    // through buildRepoView: `currentByType` already returns rows in
    // subject-key order and `Array.sort` is stable, so dropping the term
    // still renders correctly - until the store's ORDER BY changes. A
    // comparator documented as total must be total on its own.
    const row = (over: Partial<RepoRunRow>): RepoRunRow => ({
      key: "WFR_1",
      workflowName: "CI",
      runNumber: 4,
      status: "completed",
      conclusion: "success",
      event: "push",
      verdict: "passed",
      headBranch: "main",
      htmlUrl: null,
      freshness: "fresh",
      age: "5m ago",
      ...over,
    });
    const onDefault = (r: RepoRunRow) => r.headBranch === "main";
    const a = row({ key: "WFR_1" });
    // Same name, same run number, same bucket: only the key differs, which
    // is exactly the pair GitHub allows and the old sort tied on.
    const b = row({ key: "WFR_2" });

    expect(compareRunRows(a, b, onDefault)).toBeLessThan(0);
    expect(compareRunRows(b, a, onDefault)).toBeGreaterThan(0);
    // And it is a comparator, not a one-way rule: a row against itself ties.
    expect(compareRunRows(a, a, onDefault)).toBe(0);
  });

  it("orders by the repository's declared default branch, not by `main`", () => {
    // On a repository that declares master, a run on main is a side branch.
    const row = (over: Record<string, unknown>) => ({
      subject: { type: "workflow_run", key: `WFR_${over.runNumber}` },
      payload: {
        repo: "no42-org/twiki",
        workflowId: 1,
        workflowName: "CI",
        status: "completed",
        conclusion: "success",
        event: "push",
        htmlUrl: "https://github.com/no42-org/twiki/actions/runs/1",
        createdAt: "2026-08-20T00:00:00.000Z",
        ...over,
      },
    });
    seed("rest-actions-runs", [
      row({ runNumber: 9, headBranch: "main" }),
      row({ runNumber: 8, headBranch: "master" }),
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, {
      ...DEPS,
      defaultBranch: "master",
    });

    expect(view.runs.map((r) => [r.headBranch, r.runNumber])).toEqual([
      ["master", 8],
      ["main", 9],
    ]);
  });

  it("refuses a run row whose guarded fields are the wrong shape", () => {
    // `workflowId` and `createdAt` are what the lane's buckets, the confirm
    // window and `runVerdict` read: a row answering undefined for either
    // would be filed into a bucket of its own and never superseded. The two
    // nullable fields are checked because the page prints them. All four are
    // counted as unreadable rather than forwarded.
    const complete = {
      repo: "no42-org/twiki",
      workflowId: 1,
      workflowName: "CI",
      runNumber: 9,
      status: "completed",
      conclusion: "success",
      headBranch: "main",
      event: "push",
      htmlUrl: "https://github.com/no42-org/twiki/actions/runs/9",
      createdAt: "2026-08-20T00:00:00.000Z",
    };
    const { workflowId: _id, ...noWorkflowId } = complete;
    const { createdAt: _at, ...noCreatedAt } = complete;
    seed("rest-actions-runs", [
      { subject: { type: "workflow_run", key: "WFR_1" }, payload: complete },
      {
        subject: { type: "workflow_run", key: "WFR_2" },
        payload: noWorkflowId,
      },
      {
        subject: { type: "workflow_run", key: "WFR_3" },
        payload: noCreatedAt,
      },
      {
        subject: { type: "workflow_run", key: "WFR_4" },
        // Null is legal here - a run still going has no conclusion - but a
        // number is not, and forwarding it would have the page print `42`
        // as a result word.
        payload: { ...complete, conclusion: 42 },
      },
      {
        subject: { type: "workflow_run", key: "WFR_5" },
        payload: { ...complete, headBranch: 42 },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.runs.map((r) => r.runNumber)).toEqual([9]);
    expect(view.unattributable).toBe(4);
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
      ...DEPS,
      coveragePolicy: { cadenceMs: 24 * 60 * 60_000 },
    });

    expect(view.notCovered).toBe(false);
    expect(view.coverageReasons).toEqual([]);
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

  it("keeps the alert count when a SCANNER is off, and says what is off", () => {
    // The renegotiated rule (#152): secret scanning off, code scanning
    // answering `no analysis found`, Dependabot covered. The alert count is
    // Dependabot's, so a scanner may not withdraw it - it rides beside it as
    // a caveat. The same one fact the overview keys on, so the two agree.
    const body = "Secret scanning is disabled on this repository.";
    seed("coverage", [
      {
        subject: { type: "repository_coverage", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          state: "covered",
          codeScanning: { state: "unknown", reason: "no analysis found" },
          secretScanning: { state: "feature_off", reason: body },
        },
      },
    ] as never[]);
    seed("rest-org-dependabot", [
      normalise(makeAlert({ number: 7, epssPercentage: 0.9 })),
      {
        subject: { type: "repository", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          openAlerts: 3,
          worstSeverity: "high",
        },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.notCovered).toBe(false);
    expect(view.summary.openAlerts).toBe(1);
    // The tier the alerts earned survives. Withdrawing the count would have
    // taken this with it, hiding a repository that needs attention behind a
    // feature nothing collects findings for yet.
    expect(view.summary.tier).toBe("now");
    // What GitHub said about each scanner, neither dropped, and nothing
    // invented for the one it did not say was disabled.
    expect(view.coverageReasons).toEqual([
      `secret scanning: ${body}`,
      "code scanning: no analysis found",
    ]);
  });

  it("withdraws the count and the tier when DEPENDABOT is off", () => {
    // The other half of the renegotiated rule, so the pair pins which fact
    // decides: Dependabot off suppresses its own alerts before tiering.
    seed("coverage", [
      {
        subject: { type: "repository_coverage", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          state: "alerts_disabled",
          // Every feature confirmed off, in the states a real probe reaches:
          // code scanning has no `feature_off` mapping at all, so GitHub
          // refusing the endpoint is what an off scanner looks like here.
          codeScanning: { state: "unreachable", reason: NOT_ACCESSIBLE },
          secretScanning: { state: "feature_off", reason: SECRETS_OFF },
        },
      },
    ] as never[]);
    seed("rest-org-dependabot", [
      normalise(makeAlert({ number: 7, epssPercentage: 0.9 })),
      {
        subject: { type: "repository", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          openAlerts: 3,
          worstSeverity: "high",
        },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.notCovered).toBe(true);
    expect(view.summary.openAlerts).toBeNull();
    // Suppressed before tiering, so the alert gives no tier either. The same
    // alert reads `now` in the sibling case above.
    expect(view.summary.tier).toBe("quiet");
  });

  it("withdraws Dependabot's alerts alone when only Dependabot is off", () => {
    // The first of the two mixed cases. Swapping the suppression arguments
    // changed no test while every case that switched Dependabot off also
    // switched code scanning off, so each of these fixes one feature ON.
    //
    // Dependabot off: its alert is neither listed nor counted and cannot give
    // the tier, though it would be `now` on its own. Code scanning is on, so
    // its finding is counted, listed, and takes the tier to `soon`.
    seed("coverage", [
      {
        subject: { type: "repository_coverage", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          state: "alerts_disabled",
          codeScanning: { state: "covered", reason: null },
          secretScanning: { state: "covered", reason: null },
        },
      },
    ] as never[]);
    seed("rest-org-dependabot", [
      normalise(makeAlert({ number: 7, epssPercentage: 0.9 })),
    ] as never[]);
    seed("rest-org-code-scanning", [
      normaliseScan(makeCodeScanningAlert({ number: 21 })),
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.notCovered).toBe(false);
    expect(view.summary.openAlerts).toBe(1);
    expect(view.summary.tier).toBe("soon");
    expect(view.alerts).toEqual([]);
    expect(view.codeScanning.map((c) => c.number)).toEqual([21]);
  });

  it("withdraws the code scanning findings alone when only the scanner is off", () => {
    // The mirror. Code scanning off: its finding is neither listed nor
    // counted. Dependabot is on, and its high-EPSS alert still takes the
    // repository to `now` - which is what proves the two sets are not one.
    seed("coverage", [
      {
        subject: { type: "repository_coverage", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          state: "covered",
          codeScanning: { state: "unreachable", reason: NOT_ACCESSIBLE },
          secretScanning: { state: "covered", reason: null },
        },
      },
    ] as never[]);
    seed("rest-org-dependabot", [
      normalise(makeAlert({ number: 7, epssPercentage: 0.9 })),
    ] as never[]);
    seed("rest-org-code-scanning", [
      normaliseScan(makeCodeScanningAlert({ number: 21 })),
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.notCovered).toBe(false);
    expect(view.summary.openAlerts).toBe(1);
    expect(view.summary.tier).toBe("now");
    expect(view.alerts.map((a) => a.number)).toEqual([7]);
    expect(view.codeScanning).toEqual([]);
  });

  it("falls back to BOTH lanes' confirmations when no item survives", () => {
    // Every finding is off the default branch, so the queue derives none and
    // the header falls back to what the lanes confirmed. Reading the
    // Dependabot confirmation alone reported `0` above a table listing three.
    seed("rest-org-dependabot", [
      {
        subject: { type: "repository", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", openAlerts: 0, worstSeverity: null },
      },
    ] as never[]);
    seed("rest-org-code-scanning", [
      ...[7, 8, 9].map((number) =>
        normaliseScan(
          makeCodeScanningAlert({ number, ref: "refs/pull/1/merge" }),
        ),
      ),
      summariseScanRepo(REPO, [
        makeCodeScanningAlert({ number: 7, ref: "refs/pull/1/merge" }),
        makeCodeScanningAlert({ number: 8, ref: "refs/pull/1/merge" }),
        makeCodeScanningAlert({ number: 9, ref: "refs/pull/1/merge" }),
      ]),
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.codeScanning).toHaveLength(3);
    expect(view.summary.openAlerts).toBe(3);
    expect(view.summary.worstSeverity).toBe("high");
  });

  it("keeps both reasons when two features are off for different ones", () => {
    // Neither may be dropped, and each is named because the two disagree.
    // The section is NOT suppressed here: code scanning is still on, so
    // there is a number to give, and the two reasons ride beside it (#156).
    const body = "Secret scanning is disabled on this repository.";
    seed("coverage", [
      {
        subject: { type: "repository_coverage", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          state: "alerts_disabled",
          codeScanning: { state: "covered", reason: null },
          secretScanning: { state: "feature_off", reason: body },
        },
      },
    ] as never[]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.notCovered).toBe(false);
    expect(view.coverageReasons).toEqual([
      "Dependabot alerts: switched off for this repository",
      `secret scanning: ${body}`,
    ]);
  });

  it("reads a row written before the scanners were probed as covered, never off", () => {
    // The compatibility rule (#152): the two absent fields read `unknown`,
    // and `unknown` is not evidence that anything was switched off.
    seed("coverage", [
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

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.notCovered).toBe(false);
    expect(view.coverageReasons).toEqual([]);
    expect(view.summary.openAlerts).toBe(3);
  });

  it("suppresses the alert count for a repository that is not covered", () => {
    seed("coverage", [
      {
        subject: { type: "repository_coverage", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          state: "alerts_disabled",
          // Every feature confirmed off, in the states a real probe reaches:
          // code scanning has no `feature_off` mapping at all, so GitHub
          // refusing the endpoint is what an off scanner looks like here.
          codeScanning: { state: "unreachable", reason: NOT_ACCESSIBLE },
          secretScanning: { state: "feature_off", reason: SECRETS_OFF },
        },
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
    expect(view.notCovered).toBe(true);
    expect(view.summary.openAlerts).toBeNull();
  });
});

describe("the code scanning rows on the repository page (#156)", () => {
  let dir: string;
  let store: SqliteStore;

  const seedScans = (
    alerts: Parameters<typeof makeCodeScanningAlert>[0][],
    withConfirmation = true,
  ) => {
    const built = alerts.map((a) => makeCodeScanningAlert(a));
    const r = store.beginRun({
      lane: "rest-org-code-scanning",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      ...built.map(normaliseScan),
      ...(withConfirmation ? [summariseScanRepo(REPO, built)] : []),
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "scan-page-"));
    store = SqliteStore.openForWrite(join(dir, "p.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists every stored finding with its ref, including the ones the queue declines", () => {
    // The whole list, not one cell of it. The queue ranks only the
    // default-branch finding; this page lists both, and the ref is what says
    // why one of them is not in the queue.
    seedScans([
      { number: 7, ref: "refs/pull/7/merge", tool: "Trivy" },
      {
        number: 21,
        ref: "refs/heads/main",
        tool: "Trivy",
        securitySeverity: "critical",
        ruleId: "CVE-2026-31789",
      },
    ]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.codeScanning).toEqual([
      {
        number: 7,
        severity: "high",
        tool: "Trivy",
        ruleId: "CVE-2026-0002",
        ref: "refs/pull/7/merge",
        onDefaultBranch: false,
        htmlUrl: "https://github.com/no42-org/twiki/security/code-scanning/7",
        freshness: "fresh",
        age: "5m ago",
      },
      {
        number: 21,
        severity: "critical",
        tool: "Trivy",
        ruleId: "CVE-2026-31789",
        ref: "refs/heads/main",
        onDefaultBranch: true,
        htmlUrl: "https://github.com/no42-org/twiki/security/code-scanning/21",
        freshness: "fresh",
        age: "5m ago",
      },
    ]);
    expect(view.codeScanningAttested).toBe(true);
    // Only the default-branch one reached the queue, so only it counts.
    expect(view.summary.openAlerts).toBe(1);
  });

  it("says a finding is unattested while nothing has confirmed the repository", () => {
    // Rows without a confirmation: a partial sweep stored them and vouched
    // for nothing. The badge must not claim an attestation nobody made.
    seedScans([{ number: 21 }], false);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.codeScanning).toHaveLength(1);
    expect(view.codeScanningAttested).toBe(false);
  });

  it("counts a stored row it cannot read rather than dropping it", () => {
    const r = store.beginRun({
      lane: "rest-org-code-scanning",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "code_scanning_alert", key: "no42-org/twiki#9" },
        payload: { number: 9, repo: "no42-org/twiki", severity: 3 },
      },
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.codeScanning).toEqual([]);
    expect(view.unreadable).toBe(1);
  });

  it("renders the findings table under the Security heading, ref and all", async () => {
    seedScans([
      {
        number: 21,
        ref: "refs/heads/main",
        tool: "Trivy",
        securitySeverity: "critical",
        ruleId: "CVE-2026-31789",
      },
      { number: 7, ref: "refs/pull/7/merge", tool: "zizmor" },
    ]);
    const app = createApp({
      defaultBranchOf: () => "main",
      store,
      watched: [REPO],
      policy: SWEEP,
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });

    const html = await (await app.request("/repo/no42-org/twiki")).text();

    const fresh =
      '<td role="cell"><span class="lbl hid">Last confirmed</span>' +
      '<span class="badge fresh" title="5m ago">fresh \u00B7 5m ago</span></td>';
    // The link carries the row's OWN number: a constant href let a renderer
    // put one row's link on another and pass.
    const link = (n: number) =>
      `<a href="https://github.com/no42-org/twiki/security/code-scanning/${n}"` +
      ' target="_blank" rel="noopener noreferrer">' +
      `#${n}<span class="ext" aria-hidden="true">\u202F\u2197</span>` +
      '<span class="sr-only">, opens GitHub in a new tab</span></a>';
    expect(html).toContain(
      '<table class="cards" role="table"><thead role="rowgroup"><tr role="row">' +
        '<th scope="col" role="columnheader">Code scanning</th>' +
        '<th scope="col" role="columnheader">Severity</th>' +
        '<th scope="col" role="columnheader">Tool</th>' +
        '<th scope="col" role="columnheader">Ref</th>' +
        '<th scope="col" role="columnheader">Last confirmed</th>' +
        '</tr></thead><tbody role="rowgroup">' +
        `<tr role="row"><td role="cell"><span class="lbl hid">Code scanning</span>${link(7)} \u00B7 CVE-2026-0002</td>` +
        '<td role="cell"><span class="lbl">Severity</span>high</td>' +
        '<td role="cell"><span class="lbl">Tool</span>zizmor</td>' +
        '<td role="cell"><span class="lbl">Ref</span>refs/pull/7/merge (not ranked)</td>' +
        `${fresh}</tr>` +
        `<tr role="row"><td role="cell"><span class="lbl hid">Code scanning</span>${link(21)} \u00B7 CVE-2026-31789</td>` +
        '<td class="crit" role="cell"><span class="lbl">Severity</span>critical</td>' +
        '<td role="cell"><span class="lbl">Tool</span>Trivy</td>' +
        '<td role="cell"><span class="lbl">Ref</span>refs/heads/main</td>' +
        `${fresh}</tr>` +
        "</tbody></table>",
    );
    // One section, one count: the heading speaks for the rows beneath it.
    expect(html).toContain('<span class="shown">2 shown</span>');
  });

  it("says code scanning is unconfirmed while nothing has swept it", async () => {
    // The heading attests the Dependabot lane alone, by design. With no
    // findings AND no confirmation, an empty Security section would read as
    // a measured zero for code scanning; this note is what stops it (AD-28).
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
    const app = createApp({
      defaultBranchOf: () => "main",
      store,
      watched: [REPO],
      policy: SWEEP,
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });

    const html = await (await app.request("/repo/no42-org/twiki")).text();

    // The empty sentence names ONLY the kind that was actually measured.
    // Naming a scanner no lane has ever run would be a confident zero, and
    // the note below it retracts nothing: a reader meets the zero first.
    // Both scanner lanes are silent here, and each says so for itself,
    // because the two are separate sweeps with separate freshness.
    expect(html).toContain(
      '<p class="attest">no open alerts in this repository</p>' +
        '<p class="attest">code scanning: not confirmed by any completed sweep</p>' +
        '<p class="attest">secret scanning: not confirmed by any completed sweep</p>',
    );
    expect(html).not.toContain("no open alerts or code scanning findings");
    expect(html).not.toContain("leaked secrets in this repository");
  });

  it("drops the note once a sweep has confirmed the repository", async () => {
    seedScans([]);
    const app = createApp({
      defaultBranchOf: () => "main",
      store,
      watched: [REPO],
      policy: SWEEP,
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });

    const html = await (await app.request("/repo/no42-org/twiki")).text();

    // A confirmation and no findings: `0`, and it means zero.
    expect(html).not.toContain("code scanning: not confirmed");
  });

  it("says nothing is measured when every kind was withheld or never swept", async () => {
    // Dependabot confirmed off, both scanners confirmed ON and neither lane
    // ever swept. The section is not suppressed - `securityStanding` reads a
    // covered scanner as `counted` - so the empty sentence is what a reader
    // meets, and there is nothing measured for it to name: the alerts were
    // withheld and the two scanners were never looked at.
    //
    // This is also the reachability proof for that branch of `securityEmpty`.
    // Its predecessor was justified by "every kind withdrawn", which the
    // whole-section suppression makes impossible, so the branch was dead.
    const r = store.beginRun({
      lane: "coverage",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "repository_coverage", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          state: "alerts_disabled",
          codeScanning: { state: "covered", reason: null },
          secretScanning: { state: "covered", reason: null },
        },
      },
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");
    // The alert lane's own confirmation, so the section is attested and the
    // empty sentence is the one the reader meets.
    const a = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(a, "2026-08-20T11:55:00.000Z", [
      normalise(makeAlert({ number: 7 })),
      {
        subject: { type: "repository", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          openAlerts: 1,
          worstSeverity: "high",
        },
      },
    ] as never[]);
    store.finishRun(a, "ok", "2026-08-20T11:55:00.000Z");
    const app = createApp({
      defaultBranchOf: () => "main",
      store,
      watched: [REPO],
      policy: SWEEP,
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });

    const html = await (await app.request("/repo/no42-org/twiki")).text();

    // Neither scanner lane has swept, so neither is named as a measured
    // zero; the withdrawn Dependabot rows are not named either. That leaves
    // nothing measured at all, which is a sentence of its own rather than a
    // list with no items in it.
    expect(html).toContain(
      '<p class="attest">nothing here is measured: every kind this section' +
        " lists is either not covered or not yet swept</p>",
    );
    expect(html).not.toContain("no open alerts or code scanning findings");
    expect(html).not.toContain("in this repository</p>");
    // And the withheld kind is named, rather than its rows simply vanishing.
    expect(html).toContain(
      '<p class="attest">Dependabot alerts not listed: not collected for this' +
        " repository, for the reason above</p>",
    );
    // The alert really was dropped, so the sentence is about a withheld row
    // and not a repository that happens to have none.
    expect(html).not.toContain("#7");
  });

  it("survives a confirmation whose worst severity is not a string", async () => {
    // The boundary read AGENTS.md's rule is about. Both confirmation
    // payloads are bare `as` casts over whatever JSON the store hands back -
    // no guard, unlike the alert rows beside them - and `worstSeverity`
    // calls `.trim()` on every value it is given. A stored number here threw
    // a TypeError out of `buildRepoView` and answered 500 for the whole
    // repository page, which is the one page an operator reaches for when a
    // repository looks wrong.
    const a = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(a, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "repository", key: "no42-org/twiki" },
        // No alert rows, so the header falls back to this payload - which is
        // the only path that reads `worstSeverity` off it.
        payload: { repo: "no42-org/twiki", openAlerts: 2, worstSeverity: 3 },
      },
    ] as never[]);
    store.finishRun(a, "ok", "2026-08-20T11:55:00.000Z");

    const view = buildRepoView(store, REPO, NOW, DEPS);

    // Dropped, exactly as a non-number is dropped from the count beside it:
    // an absent severity renders as no severity, which is an absence and not
    // a zero.
    expect(view.summary.worstSeverity).toBeNull();
    // The count is still read, so the corrupt field costs only itself.
    expect(view.summary.openAlerts).toBe(2);

    const app = createApp({
      defaultBranchOf: () => "main",
      store,
      watched: [REPO],
      policy: SWEEP,
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });
    const res = await app.request("/repo/no42-org/twiki");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("2 open alerts");
  });

  it("names a swept kind and drops an unswept one from the same sentence", async () => {
    // The discriminating case for the attestation rule: code scanning HAS
    // swept and found nothing, secret scanning never has. One of those is a
    // zero this page measured and the other is a zero nobody looked for, and
    // only the first may be said. A rule that dropped both, or neither,
    // passes the test above and fails this one.
    const a = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(a, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "repository", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", openAlerts: 0, worstSeverity: null },
      },
    ] as never[]);
    store.finishRun(a, "ok", "2026-08-20T11:55:00.000Z");
    seedScans([]);

    const app = createApp({
      defaultBranchOf: () => "main",
      store,
      watched: [REPO],
      policy: SWEEP,
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });
    const html = await (await app.request("/repo/no42-org/twiki")).text();

    expect(html).toContain(
      '<p class="attest">no open alerts or code scanning findings in this' +
        " repository</p>",
    );
    // The kind nobody swept is absent from the zero and present in the note
    // below it, which is the whole distinction.
    expect(html).not.toContain("leaked secrets");
    expect(html).toContain(
      '<p class="attest">secret scanning: not confirmed by any completed' +
        " sweep</p>",
    );
  });

  it("names the code scanning findings it withheld when that feature is off", async () => {
    // The mirror, and the one `codeScanningWithdrawn` exists for: the org
    // sweep still writes a confirmation for this repository, so the
    // `not confirmed by any completed sweep` paragraph does not fire and the
    // rows would otherwise vanish with no sentence at all.
    seedScans([{ number: 21 }]);
    const r = store.beginRun({
      lane: "coverage",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "repository_coverage", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          state: "covered",
          codeScanning: { state: "unreachable", reason: NOT_ACCESSIBLE },
          secretScanning: { state: "covered", reason: null },
        },
      },
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");
    const a = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(a, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "repository", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", openAlerts: 0, worstSeverity: null },
      },
    ] as never[]);
    store.finishRun(a, "ok", "2026-08-20T11:55:00.000Z");
    const app = createApp({
      defaultBranchOf: () => "main",
      store,
      watched: [REPO],
      policy: SWEEP,
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });

    const html = await (await app.request("/repo/no42-org/twiki")).text();

    // "Not collected", never "switched off": this feature's state is
    // `unreachable` - GitHub refusing the endpoint to our App - and the
    // feature may be perfectly on. Saying a switch is off sends the operator
    // to a setting that is fine.
    expect(html).toContain(
      '<p class="attest">code scanning findings not listed: not collected' +
        " for this repository, for the reason above</p>",
    );
    expect(html).not.toContain("the feature is switched off");
    // And the reason GitHub actually gave is on the page, above it.
    expect(html).toContain(`code scanning: ${NOT_ACCESSIBLE}`);
    // Only the alerts are named: they were measured. Code scanning was
    // withdrawn and no secret scanning sweep has ever confirmed this
    // repository, and neither absence may be spelled as a zero.
    expect(html).toContain(
      '<p class="attest">no open alerts in this repository</p>',
    );
    expect(html).not.toContain("leaked secrets in this repository");
    expect(html).not.toContain("Code scanning</th>");
  });

  it("says how many listed findings the queue does not rank, and claims nothing about a count", async () => {
    // The sentence names the queue and nothing else. It used to end "and the
    // count above does not include them", which contradicted the number it
    // pointed at: the count directly above is the heading's `N shown`, which
    // counts every row in the tables and therefore DOES include them.
    const r = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      normalise(makeAlert({ number: 7 })),
      {
        subject: { type: "repository", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          openAlerts: 1,
          worstSeverity: "high",
        },
      },
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");
    seedScans([
      { number: 21, ref: "refs/pull/1/merge" },
      { number: 22, ref: "refs/pull/2/merge" },
      { number: 23, ref: "refs/pull/3/merge" },
    ]);
    const app = createApp({
      defaultBranchOf: () => "main",
      store,
      watched: [REPO],
      policy: SWEEP,
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });

    const html = await (await app.request("/repo/no42-org/twiki")).text();

    expect(html).toContain(
      '<p class="attest">3 of these are not on the default branch,' +
        " so the queue does not rank them</p>",
    );
    // The two numbers this page shows, pinned so the assertion above is read
    // against them: the heading counts all four rows, and the header counts
    // the one item the queue ranked. The old sentence sat under the first and
    // described the second.
    expect(html).toContain('<span class="shown">4 shown</span>');
    expect(html).toContain("1 open alerts");
    // And no claim about a count of any kind rides along with it.
    expect(html).not.toContain("the count above");
  });

  it("badges an unconfirmed finding as unconfirmed, never with a freshness word", async () => {
    seedScans([{ number: 21 }], false);
    const app = createApp({
      defaultBranchOf: () => "main",
      store,
      watched: [REPO],
      policy: SWEEP,
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });

    const html = await (await app.request("/repo/no42-org/twiki")).text();

    expect(html).toContain(
      '<td role="cell"><span class="lbl hid">Last confirmed</span>' +
        '<span class="badge unknown">unconfirmed</span></td>',
    );
  });
});

describe("the per-repository page", () => {
  let dir: string;
  let store: SqliteStore;

  const app = () =>
    createApp({
      defaultBranchOf: () => "main",
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
      '<td role="cell"><span class="lbl hid">Last confirmed</span><span class="badge fresh" title="5m ago">fresh · 5m ago</span></td>';
    // Story 1.9 (#131): roles stated and a header word in every cell, shown
    // on the card for a value that would otherwise be a bare word.
    expect(html).toContain(
      '<h2 id="security">Security <span class="badge fresh" title="5m ago">fresh · 5m ago</span> <span class="shown">2 shown</span></h2>' +
        '<table class="cards" role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Alert</th><th scope="col" role="columnheader">Severity</th><th scope="col" role="columnheader">Package</th><th scope="col" role="columnheader">Last confirmed</th></tr></thead><tbody role="rowgroup">' +
        `<tr role="row"><td role="cell"><span class="lbl hid">Alert</span>${link(7)} · CVE-2026-0001</td><td class="crit" role="cell"><span class="lbl">Severity</span>critical</td><td role="cell"><span class="lbl">Package</span>left-pad</td>${fresh}</tr>` +
        `<tr role="row"><td role="cell"><span class="lbl hid">Alert</span>${link(8)} · CVE-2026-0002</td><td role="cell"><span class="lbl">Severity</span>high</td><td role="cell"><span class="lbl">Package</span>is-odd</td>${fresh}</tr>` +
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
        payload: {
          repo: "no42-org/twiki",
          state: "alerts_disabled",
          // Every feature confirmed off, in the states a real probe reaches:
          // code scanning has no `feature_off` mapping at all, so GitHub
          // refusing the endpoint is what an off scanner looks like here.
          codeScanning: { state: "unreachable", reason: NOT_ACCESSIBLE },
          secretScanning: { state: "feature_off", reason: SECRETS_OFF },
        },
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
        '<p class="attest">Dependabot alerts: switched off for this repository' +
        ` \u00B7 code scanning: ${NOT_ACCESSIBLE}` +
        ` \u00B7 secret scanning: ${SECRETS_OFF}</p>` +
        '<h2 id="ci">',
    );
    // The stale row is not listed beneath the suppression.
    expect(html).not.toContain("#7");
  });

  it("gives both reasons when two features are off for different ones", async () => {
    // Both must reach the page, in the section note AND in the header
    // sub-line: a page that named one and dropped the other would have
    // invented the standing of the feature it kept (#152).
    const body = "Secret scanning is disabled on this repository.";
    const r = store.beginRun({
      lane: "coverage",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "repository_coverage", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          state: "alerts_disabled",
          codeScanning: { state: "unreachable", reason: NOT_ACCESSIBLE },
          secretScanning: { state: "feature_off", reason: body },
        },
      },
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const html = await (await app().request("/repo/no42-org/twiki")).text();

    const all =
      "Dependabot alerts: switched off for this repository" +
      ` \u00B7 code scanning: ${NOT_ACCESSIBLE}` +
      ` \u00B7 secret scanning: ${body}`;
    expect(html).toContain(
      '<h2 id="security">Security <span class="badge unknown" title="never collected">never collected</span></h2>' +
        `<p class="attest">${all}</p>`,
    );
    expect(html).toContain(
      `<span class="uncovered">not covered: ${all}</span>`,
    );
  });

  it("puts what a scanner said in the sentence, not only in a title", async () => {
    // The renderer's own rule: a title is never the sole carrier. The count
    // stands and the caveat rides beside it in the sub-line (#152).
    const body = "Secret scanning is disabled on this repository.";
    const r = store.beginRun({
      lane: "coverage",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "repository_coverage", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          state: "covered",
          codeScanning: { state: "covered", reason: null },
          secretScanning: { state: "feature_off", reason: body },
        },
      },
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const html = await (await app().request("/repo/no42-org/twiki")).text();

    expect(html).toContain(`secret scanning: ${body}`);
    expect(html).not.toContain("not covered");
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
        '<table class="cards" role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Issue</th><th scope="col" role="columnheader">Opened by</th><th scope="col" role="columnheader">Last confirmed</th></tr></thead><tbody role="rowgroup">' +
        '<tr role="row"><td role="cell"><span class="lbl hid">Issue</span>' +
        '<a href="https://github.com/no42-org/twiki/issues/5" target="_blank" rel="noopener noreferrer">#5<span class="ext" aria-hidden="true">\u202F\u2197</span><span class="sr-only">, opens GitHub in a new tab</span></a> Crash on startup' +
        '</td><td role="cell"><span class="lbl">Opened by</span>someone</td>' +
        // The row's own freshness is the clean sweep's, not the partial's.
        '<td role="cell"><span class="lbl hid">Last confirmed</span><span class="badge fresh" title="10m ago">fresh · 10m ago</span></td>' +
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

  it("renders the CI section from this repository's runs, painting every broken verdict", async () => {
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
        // What the lane would have written over exactly these four rows:
        // four distinct workflows, and two default-branch rows whose verdict
        // is broken - Build's `failure` and CI's hang. Release is broken too
        // and is not counted, because it ran on a tag rather than on main.
        payload: { repo: "no42-org/twiki", workflows: 4, failing: 2 },
      },
      run({
        workflowName: "Release",
        runNumber: 3,
        workflowId: 3,
        status: "completed",
        // Broken without saying `failure`. Read as a bare conclusion this
        // rendered in normal weight while the lane counted it as failing.
        conclusion: "timed_out",
        headBranch: "v1.2.0",
        htmlUrl: "https://github.com/no42-org/twiki/actions/runs/3",
      }),
      run({
        workflowName: "CI",
        runNumber: 9,
        workflowId: 2,
        status: "in_progress",
        conclusion: null,
        // Started twelve hours before the render, against a two-hour
        // threshold: hung, and painted as broken though it has no
        // conclusion at all.
        htmlUrl: "https://github.com/no42-org/twiki/actions/runs/9",
      }),
      run({
        workflowName: "Docs",
        runNumber: 4,
        workflowId: 4,
        status: "in_progress",
        conclusion: null,
        // Started ten minutes ago: still going, not hung, not painted.
        createdAt: "2026-08-20T11:50:00.000Z",
        htmlUrl: "https://github.com/no42-org/twiki/actions/runs/4",
      }),
      run({
        workflowName: "Build",
        runNumber: 2,
        workflowId: 1,
        status: "completed",
        // The plain case, here so the assertion below covers all four
        // wordings at once: GitHub's own `failure`, which the cell keeps.
        conclusion: "failure",
        htmlUrl: "https://github.com/no42-org/twiki/actions/runs/2",
      }),
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const html = await (await app().request("/repo/no42-org/twiki")).text();

    const link = (n: number, name: string) =>
      `<a href="https://github.com/no42-org/twiki/actions/runs/${n}" target="_blank" rel="noopener noreferrer">${name}<span class="ext" aria-hidden="true">\u202F\u2197</span><span class="sr-only">, opens GitHub in a new tab</span></a> <span class="why">#${n}</span>`;
    const fresh =
      '<td role="cell"><span class="lbl hid">Last confirmed</span><span class="badge fresh" title="5m ago">fresh · 5m ago</span></td>';
    expect(html).toContain(
      '<h2 id="ci">CI <span class="badge fresh" title="5m ago">fresh · 5m ago</span> <span class="shown">4 shown</span></h2>' +
        '<table class="cards" role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Workflow</th><th scope="col" role="columnheader">Result</th><th scope="col" role="columnheader">Branch</th><th scope="col" role="columnheader">Last confirmed</th></tr></thead><tbody role="rowgroup">' +
        // Workflows in name order. A run still going says so rather than
        // passing, and the painting follows the VERDICT: the hung run and
        // the timed-out one are both critical though neither says
        // `failure`, and the ten-minute-old run is not.
        //
        // Every row here says in words what it says in colour (#144). The
        // hung run reads `hung`, not `in_progress, no result yet`, which is
        // the one place where the two used to contradict each other: red,
        // beside a sentence asserting that nothing was known. The Docs row
        // below is the control - same status, same missing conclusion, not
        // hung, and still worded as unfinished.
        `<tr role="row"><td role="cell"><span class="lbl hid">Workflow</span>${link(2, "Build")}</td><td class="crit" role="cell"><span class="lbl">Result</span>failure</td><td role="cell"><span class="lbl">Branch</span>main</td>${fresh}</tr>` +
        `<tr role="row"><td role="cell"><span class="lbl hid">Workflow</span>${link(9, "CI")}</td><td class="crit" role="cell"><span class="lbl">Result</span>hung</td><td role="cell"><span class="lbl">Branch</span>main</td>${fresh}</tr>` +
        `<tr role="row"><td role="cell"><span class="lbl hid">Workflow</span>${link(4, "Docs")}</td><td role="cell"><span class="lbl">Result</span>in_progress, no result yet</td><td role="cell"><span class="lbl">Branch</span>main</td>${fresh}</tr>` +
        `<tr role="row"><td role="cell"><span class="lbl hid">Workflow</span>${link(3, "Release")}</td><td class="crit" role="cell"><span class="lbl">Result</span>timed_out</td><td role="cell"><span class="lbl">Branch</span>v1.2.0</td>${fresh}</tr>` +
        "</tbody></table>",
    );
  });

  it("orders the rendered run list by the repository's declared branch", async () => {
    // Driven through createApp, not buildRepoView, because the two ordering
    // tests that call the builder directly leave the WIRING untested: with
    // an optional resolver, deleting the binding in `src/tricorder.ts` or
    // the call in `app.ts` left the whole suite green, and every repository
    // on `master` silently ordered its side branches above its main line.
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
        workflowName: "CI",
        status: "completed",
        conclusion: "success",
        event: "push",
        createdAt: "2026-08-20T00:00:00.000Z",
        ...over,
      },
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "repository_actions", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", workflows: 1, failing: 0 },
      },
      run({
        runNumber: 9,
        headBranch: "main",
        htmlUrl: "https://github.com/no42-org/twiki/actions/runs/9",
      }),
      run({
        runNumber: 8,
        headBranch: "master",
        htmlUrl: "https://github.com/no42-org/twiki/actions/runs/8",
      }),
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const html = await (
      await createApp({
        store,
        watched: [REPO],
        policy: SWEEP,
        rankPolicy: DEFAULT_RANK_POLICY,
        // What repos.yaml declares for this repository. On a repository that
        // says master, a run on main is a side branch.
        defaultBranchOf: () => "master",
        now: () => NOW,
      }).request("/repo/no42-org/twiki")
    ).text();

    const link = (n: number) =>
      `<a href="https://github.com/no42-org/twiki/actions/runs/${n}" target="_blank" rel="noopener noreferrer">CI<span class="ext" aria-hidden="true">\u202F\u2197</span><span class="sr-only">, opens GitHub in a new tab</span></a> <span class="why">#${n}</span>`;
    const fresh =
      '<td role="cell"><span class="lbl hid">Last confirmed</span><span class="badge fresh" title="5m ago">fresh · 5m ago</span></td>';
    // The whole tbody, in order: master first though `main` sorts before it
    // alphabetically and carries the higher run number.
    expect(html).toContain(
      '<tbody role="rowgroup">' +
        `<tr role="row"><td role="cell"><span class="lbl hid">Workflow</span>${link(8)}</td><td role="cell"><span class="lbl">Result</span>success</td><td role="cell"><span class="lbl">Branch</span>master</td>${fresh}</tr>` +
        `<tr role="row"><td role="cell"><span class="lbl hid">Workflow</span>${link(9)}</td><td role="cell"><span class="lbl">Result</span>success</td><td role="cell"><span class="lbl">Branch</span>main</td>${fresh}</tr>` +
        "</tbody>",
    );
  });

  it("still renders the page when the branch resolver throws", async () => {
    // The resolver is the caller's. The lane wraps the same call in its
    // per-repository try and degrades one repository; a route that let it
    // escape would answer 500 for the whole page instead. The ordering
    // degrades to the default; no value on the page changes.
    const r = store.beginRun({
      lane: "rest-actions-runs",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "workflow_run", key: "WFR_9" },
        payload: {
          repo: "no42-org/twiki",
          workflowId: 1,
          workflowName: "CI",
          runNumber: 9,
          status: "completed",
          conclusion: "success",
          headBranch: "main",
          event: "push",
          htmlUrl: "https://github.com/no42-org/twiki/actions/runs/9",
          createdAt: "2026-08-20T00:00:00.000Z",
        },
      },
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const res = await createApp({
      store,
      watched: [REPO],
      policy: SWEEP,
      rankPolicy: DEFAULT_RANK_POLICY,
      defaultBranchOf: () => {
        throw new Error("no config loaded");
      },
      now: () => NOW,
    }).request("/repo/no42-org/twiki");

    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<span class="lbl">Branch</span>main');
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
      '<td role="cell"><span class="lbl hid">Last confirmed</span><span class="badge fresh" title="5m ago">fresh · 5m ago</span></td>';
    expect(html).toContain(
      '<h2 id="dependencies">Dependencies <span class="badge fresh" title="5m ago">fresh · 5m ago</span> <span class="shown">2 shown</span></h2>' +
        '<table class="cards" role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">PR</th><th scope="col" role="columnheader">Package</th><th scope="col" role="columnheader">Linked alert</th><th scope="col" role="columnheader">Last confirmed</th></tr></thead><tbody role="rowgroup">' +
        `<tr role="row"><td role="cell"><span class="lbl hid">PR</span>${link(1)} Bump x from 1.0.0 to 1.0.1</td><td role="cell"><span class="lbl">Package</span>x</td><td role="cell"><span class="lbl">Linked alert</span>#7</td>${fresh}</tr>` +
        `<tr role="row"><td role="cell"><span class="lbl hid">PR</span>${link(2)} Bump y from 1.0.0 to 2.0.0</td><td role="cell"><span class="lbl">Package</span>y</td><td role="cell"><span class="lbl">Linked alert</span>none on record</td>${fresh}</tr>` +
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
        '<table class="cards" role="table"><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">PR</th><th scope="col" role="columnheader">Requested from</th><th scope="col" role="columnheader">Waiting</th><th scope="col" role="columnheader">Last confirmed</th></tr></thead><tbody role="rowgroup">' +
        '<tr role="row"><td role="cell"><span class="lbl hid">PR</span>' +
        '<a href="https://github.com/no42-org/twiki/pull/9" target="_blank" rel="noopener noreferrer">#9<span class="ext" aria-hidden="true">\u202F\u2197</span><span class="sr-only">, opens GitHub in a new tab</span></a> Wire the thing' +
        '</td><td role="cell"><span class="lbl">Requested from</span>indigo423, other</td><td role="cell"><span class="lbl">Waiting</span>4d ago</td>' +
        '<td role="cell"><span class="lbl hid">Last confirmed</span><span class="badge fresh" title="5m ago">fresh · 5m ago</span></td>' +
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
      defaultBranchOf: () => "main",
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
        defaultBranchOf: () => "main",
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
        defaultBranchOf: () => "main",
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
        defaultBranchOf: () => "main",
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

describe("the secret scanning rows on the repository page (#158)", () => {
  let dir: string;
  let store: SqliteStore;

  const seedSecrets = (
    alerts: Parameters<typeof makeSecretScanningAlert>[0][],
    withConfirmation = true,
  ) => {
    const built = alerts.map((a) => makeSecretScanningAlert(a));
    const r = store.beginRun({
      lane: "rest-org-secret-scanning",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      ...built.map(normaliseSecret),
      ...(withConfirmation ? [summariseSecretRepo(REPO, built)] : []),
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");
  };

  /** The alert lane's confirmation, so the Security section is attested. */
  const seedAlertConfirmation = () => {
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
  };

  const page = async () => {
    const app = createApp({
      defaultBranchOf: () => "main",
      store,
      watched: [REPO],
      policy: SWEEP,
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });
    return (await app.request("/repo/no42-org/twiki")).text();
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "secret-page-"));
    store = SqliteStore.openForWrite(join(dir, "p.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists every stored secret with its type and validity", () => {
    // The whole list, not one cell of it. There is no ref filter here: a
    // secret is not on a branch, so every row this page lists is a row the
    // queue ranks and the two counts agree by construction.
    seedSecrets([
      { number: 3, secretType: "Amazon AWS Access Key ID" },
      {
        number: 4,
        secretType: "Slack API Token",
        validity: "unknown",
        publiclyLeaked: true,
      },
    ]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.secretScanning).toEqual([
      {
        number: 3,
        secretType: "Amazon AWS Access Key ID",
        validity: "active",
        publiclyLeaked: false,
        htmlUrl: "https://github.com/no42-org/twiki/security/secret-scanning/3",
        freshness: "fresh",
        age: "5m ago",
      },
      {
        number: 4,
        secretType: "Slack API Token",
        validity: "unknown",
        publiclyLeaked: true,
        htmlUrl: "https://github.com/no42-org/twiki/security/secret-scanning/4",
        freshness: "fresh",
        age: "5m ago",
      },
    ]);
    expect(view.secretScanningAttested).toBe(true);
    // Both reached the queue, unlike a code scanning finding off the default
    // branch: there is no condition here for one to fail.
    expect(view.summary.openAlerts).toBe(2);
  });

  it("says a secret is unattested while nothing has confirmed the repository", () => {
    // Rows without a confirmation: a partial sweep stored them and vouched
    // for nothing. The badge must not claim an attestation nobody made.
    seedSecrets([{ number: 3 }], false);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.secretScanning).toHaveLength(1);
    expect(view.secretScanningAttested).toBe(false);
  });

  it("counts a stored row it cannot read rather than dropping it", () => {
    const r = store.beginRun({
      lane: "rest-org-secret-scanning",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "secret_scanning_alert", key: "no42-org/twiki#9" },
        payload: { number: 9, repo: "no42-org/twiki", validity: 3 },
      },
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.secretScanning).toEqual([]);
    expect(view.unreadable).toBe(1);
  });

  it("adds the secret lane's confirmation to the fallback, without a severity", () => {
    // No queue item survives - the rows this confirmation counted have been
    // tombstoned, or belong to a repository this page filtered out - so the
    // header falls back to what the lanes confirmed. All THREE contribute,
    // or a repository whose only findings were secrets would report `0`.
    seedAlertConfirmation();
    const r = store.beginRun({
      lane: "rest-org-secret-scanning",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      summariseSecretRepo(REPO, [
        makeSecretScanningAlert({ number: 3 }),
        makeSecretScanningAlert({ number: 4 }),
      ]),
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.secretScanning).toEqual([]);
    // Zero from the alert lane plus two from this one.
    expect(view.summary.openAlerts).toBe(2);
    // And no severity: GitHub grades no secret, so the confirmation row
    // carries no worst severity and this page must not invent `critical` for
    // a count it read off an old summary.
    expect(view.summary.worstSeverity).toBeNull();
  });

  it("withdraws the secrets alone when only that feature is off", () => {
    // The measured `off`, on the repository that answered it live. The code
    // scanning finding beside it survives, which is what proves the three
    // suppression sets are not one.
    const cov = store.beginRun({
      lane: "coverage",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(cov, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "repository_coverage", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          state: "covered",
          codeScanning: { state: "covered", reason: null },
          secretScanning: { state: "feature_off", reason: SECRETS_OFF },
        },
      },
    ] as never[]);
    store.finishRun(cov, "ok", "2026-08-20T11:55:00.000Z");
    const scan = store.beginRun({
      lane: "rest-org-code-scanning",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(scan, "2026-08-20T11:55:00.000Z", [
      normaliseScan(makeCodeScanningAlert({ number: 21 })),
      summariseScanRepo(REPO, [makeCodeScanningAlert({ number: 21 })]),
    ] as never[]);
    store.finishRun(scan, "ok", "2026-08-20T11:55:00.000Z");
    seedSecrets([{ number: 3 }]);

    const view = buildRepoView(store, REPO, NOW, DEPS);

    expect(view.secretScanningWithdrawn).toBe(true);
    expect(view.secretScanning).toEqual([]);
    // The code scanning finding is untouched, and it is what the count is.
    expect(view.codeScanning.map((c) => c.number)).toEqual([21]);
    expect(view.summary.openAlerts).toBe(1);
    // The secret took its `now` with it.
    expect(view.summary.tier).toBe("soon");
  });

  it("renders the secrets table under the Security heading, type and validity", async () => {
    seedAlertConfirmation();
    seedSecrets([
      { number: 3, secretType: "Amazon AWS Access Key ID" },
      {
        number: 4,
        secretType: "Slack API Token",
        validity: "unknown",
        publiclyLeaked: true,
      },
    ]);

    const html = await page();

    const fresh =
      '<td role="cell"><span class="lbl hid">Last confirmed</span>' +
      '<span class="badge fresh" title="5m ago">fresh \u00B7 5m ago</span></td>';
    // The link carries the row's OWN number: a constant href let a renderer
    // put one row's link on another and pass.
    const link = (n: number) =>
      `<a href="https://github.com/no42-org/twiki/security/secret-scanning/${n}"` +
      ' target="_blank" rel="noopener noreferrer">' +
      `#${n}<span class="ext" aria-hidden="true">\u202F\u2197</span>` +
      '<span class="sr-only">, opens GitHub in a new tab</span></a>';
    expect(html).toContain(
      '<table class="cards" role="table"><thead role="rowgroup"><tr role="row">' +
        '<th scope="col" role="columnheader">Secret scanning</th>' +
        '<th scope="col" role="columnheader">Type</th>' +
        '<th scope="col" role="columnheader">Validity</th>' +
        '<th scope="col" role="columnheader">Last confirmed</th>' +
        '</tr></thead><tbody role="rowgroup">' +
        `<tr role="row"><td role="cell"><span class="lbl hid">Secret scanning</span>${link(3)}</td>` +
        '<td role="cell"><span class="lbl">Type</span>Amazon AWS Access Key ID</td>' +
        '<td role="cell"><span class="lbl">Validity</span>active</td>' +
        `${fresh}</tr>` +
        `<tr role="row"><td role="cell"><span class="lbl hid">Secret scanning</span>${link(4)} \u00B7 publicly leaked</td>` +
        '<td role="cell"><span class="lbl">Type</span>Slack API Token</td>' +
        '<td role="cell"><span class="lbl">Validity</span>unknown</td>' +
        `${fresh}</tr>` +
        "</tbody></table>",
    );
    // One section, one count: the heading speaks for the rows beneath it.
    expect(html).toContain('<span class="shown">2 shown</span>');
    // And no page anywhere claims CISA listed a leaked credential.
    expect(html).not.toContain("CISA");
  });

  it("names the secrets it withheld when that feature is off", async () => {
    const r = store.beginRun({
      lane: "coverage",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "repository_coverage", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          state: "covered",
          codeScanning: { state: "covered", reason: null },
          secretScanning: { state: "feature_off", reason: SECRETS_OFF },
        },
      },
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");
    seedAlertConfirmation();
    seedSecrets([{ number: 3 }]);

    const html = await page();

    expect(html).toContain(
      '<p class="attest">secret scanning alerts not listed: not collected' +
        " for this repository, for the reason above</p>",
    );
    // The rows really were dropped, so the sentence is about a withheld row
    // and not a repository that happens to have none.
    expect(html).not.toContain("Secret scanning</th>");
  });

  it("says one thing, not two, about a feature that is off and unswept", async () => {
    // Both facts are true at once here - coverage says the feature is not
    // collected, and no sweep ever confirmed this repository - and they are
    // genuinely different facts. But the reader does not need both: once the
    // page has said the rows are not collected, a second paragraph saying
    // nothing swept for them is noise, and the overview's chip already
    // withholds its own note under exactly this condition.
    const r = store.beginRun({
      lane: "coverage",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-20T11:55:00.000Z",
    });
    store.recordObservations(r, "2026-08-20T11:55:00.000Z", [
      {
        subject: { type: "repository_coverage", key: "no42-org/twiki" },
        payload: {
          repo: "no42-org/twiki",
          state: "covered",
          codeScanning: { state: "covered", reason: null },
          secretScanning: { state: "feature_off", reason: SECRETS_OFF },
        },
      },
    ] as never[]);
    store.finishRun(r, "ok", "2026-08-20T11:55:00.000Z");
    seedAlertConfirmation();
    // Rows collected before the feature was switched off, and no
    // `repository_secret_scanning` confirmation at all.
    seedSecrets([{ number: 3 }], false);

    const html = await page();

    expect(html).toContain(
      '<p class="attest">secret scanning alerts not listed: not collected' +
        " for this repository, for the reason above</p>",
    );
    // The lane's silence is not repeated underneath it.
    expect(html).not.toContain("secret scanning: not confirmed");
    // The code scanning lane is silent too and IS covered, so its note still
    // fires - which is what proves the suppression is per feature and not a
    // blanket one.
    expect(html).toContain(
      '<p class="attest">code scanning: not confirmed by any completed' +
        " sweep</p>",
    );
  });

  it("says secret scanning is unconfirmed while nothing has swept it", async () => {
    // With no findings AND no confirmation, an empty Security section would
    // read as a measured zero for secrets; this note is what stops it.
    seedAlertConfirmation();

    const html = await page();

    expect(html).toContain(
      '<p class="attest">secret scanning: not confirmed by any completed' +
        " sweep</p>",
    );
  });

  it("drops the note once a sweep has confirmed the repository", async () => {
    seedAlertConfirmation();
    seedSecrets([]);

    const html = await page();

    // A confirmation and no findings: `0`, and it means zero.
    expect(html).not.toContain("secret scanning: not confirmed");
  });

  it("badges an unconfirmed secret as unconfirmed, never with a freshness word", async () => {
    // The mirror of the code scanning sibling above, and it was missing:
    // forcing this table to render `FreshnessBadge` unconditionally left the
    // whole suite green, so a credential row stored by a sweep that vouched
    // for nothing could print `fresh · 5m ago`. The section heading attests
    // the DEPENDABOT lane, so these rows must carry their own standing.
    seedAlertConfirmation();
    seedSecrets([{ number: 3 }], false);

    const html = await page();

    expect(html).toContain(
      '<td role="cell"><span class="lbl hid">Last confirmed</span>' +
        '<span class="badge unknown">unconfirmed</span></td>',
    );
    // The row really is there, so this is not passing on an empty table.
    expect(html).toContain("Secret scanning</th>");
    // And no freshness word rode along with it.
    expect(html).not.toContain('title="5m ago">fresh · 5m ago</span></td>');
  });

  it("says no secret scanning alerts when the lane swept and found none", async () => {
    // The positive half of the measured-zero sentence, which had only ever
    // been asserted ABSENT. A confirmation from both lanes and no rows is the
    // one shape in which this page may name the third feature in a zero, and
    // nothing pinned the clause that does it.
    seedAlertConfirmation();
    seedSecrets([]);

    const html = await page();

    expect(html).toContain(
      '<p class="attest">no open alerts or secret scanning alerts in this' +
        " repository</p>",
    );
    // A sweep vouched for the repository, so no unattested note rides below
    // it: this really is a measured zero rather than an absence.
    expect(html).not.toContain("secret scanning: not confirmed");
  });

  it("never renders a credential the wire payload really carried", async () => {
    // The whole chain, starting at a payload that ACTUALLY has the field.
    //
    // Its predecessor seeded `makeSecretScanningAlert`, whose type has no
    // `secret` at all, and then asserted the page did not contain a
    // credential that was never in the input: a test that asserted what its
    // own setup made impossible. This one begins at the raw JSON GitHub
    // sends, goes through the real mapper, the real lane and the real
    // renderer, and only then looks.
    const raw = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "fixtures/github/secret-scanning-alert-org.schema.json",
        ),
        "utf8",
      ),
    ) as { secret: string; secret_type_display_name: string };
    // An AWS-shaped key deliberately: `redact()` matches GitHub token
    // prefixes and JWTs only, so this string would survive redaction
    // untouched. Dropping it at the boundary is the rule under test, and a
    // GitHub-shaped fixture would let redaction pass the test for the mapper.
    expect(redact(raw.secret)).toBe(raw.secret);

    // The real adapter over a stub that answers with that payload.
    const gh = {
      auth: async () => ({ token: "x", expiresAt: "2026-08-21T12:00:00Z" }),
      request: async () => ({ data: [raw], headers: {} }),
    } as unknown as Octokit;
    const github = new OctokitGitHub(
      async () => gh,
      () => true,
      async () => gh,
      () => "organization",
    );
    const logs: string[] = [];
    await collectOrgSecretScanning(
      {
        github,
        store,
        isWatched: () => true,
        watchedIn: () => [REPO],
        now: () => "2026-08-20T11:55:00.000Z",
        log: (m: string) => logs.push(m),
      },
      "no42-org",
      "full",
    );
    seedAlertConfirmation();

    const html = await page();

    // The finding really reached the page, so the searches below are not
    // passing over an empty section.
    expect(html).toContain("Secret scanning</th>");
    expect(html).toContain(raw.secret_type_display_name);
    // And nothing anywhere in the rendered document is the credential.
    expect(html).not.toContain(raw.secret);
    // Nor did it reach the store or the log on the way here.
    expect(
      JSON.stringify(store.currentByType("secret_scanning_alert")),
    ).not.toContain(raw.secret);
    expect(logs.join("\n")).not.toContain(raw.secret);
  });
});
