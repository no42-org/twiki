/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { workflowRunsUrl } from "../src/github/port.js";
import {
  collectWorkflowRuns,
  LANE,
  latestPerBucket,
  normaliseRun,
} from "../src/tricorder/collect/workflow-runs.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { FakeGitHubReadPort, makeWorkflowRun } from "./fakes.js";

const REPO = { owner: "no42-org", name: "packyard" };

const VALIDATOR = {
  etag: 'W/"runs-1"',
  lastModified: null,
  tokenGen: "2026-08-18T20:00:00Z",
};

describe("latest run per workflow and bucket", () => {
  it("keeps the first (newest) run of each workflow, in page order", () => {
    // GitHub answers newest first; the selection leans on that rather than
    // re-sorting, so the fixture is deliberately newest-first.
    const latest = latestPerBucket(
      [
        makeWorkflowRun({ runNumber: 9, workflowId: 100 }),
        makeWorkflowRun({
          runNumber: 8,
          workflowId: 200,
          workflowName: "Release",
        }),
        makeWorkflowRun({ runNumber: 7, workflowId: 100 }),
        makeWorkflowRun({ runNumber: 6, workflowId: 200 }),
      ],
      "main",
    );
    expect(latest.map((l) => l.run.runNumber)).toEqual([9, 8]);
  });

  it("keeps one run per workflow PER SIDE of the default-branch line", () => {
    // The whole point of the split. One workflow, four runs: the newest on
    // main and the newest anywhere else both survive, and the older run in
    // each bucket does not.
    const latest = latestPerBucket(
      [
        makeWorkflowRun({ runNumber: 9, headBranch: "feature/x" }),
        makeWorkflowRun({ runNumber: 8, headBranch: "feature/y" }),
        makeWorkflowRun({ runNumber: 7, headBranch: "main" }),
        makeWorkflowRun({ runNumber: 6, headBranch: "main" }),
      ],
      "main",
    );
    expect(latest).toEqual([
      {
        run: expect.objectContaining({ runNumber: 9 }),
        onDefaultBranch: false,
      },
      { run: expect.objectContaining({ runNumber: 7 }), onDefaultBranch: true },
    ]);
  });

  it("files the buckets by the repository's OWN default branch", () => {
    // A repository on `master` must not have its main-line run filed as a
    // side branch. Asserted through the whole returned structure, because a
    // check on one flag would pass while the other row was wrong.
    const latest = latestPerBucket(
      [
        makeWorkflowRun({ runNumber: 9, headBranch: "main" }),
        makeWorkflowRun({ runNumber: 8, headBranch: "master" }),
      ],
      "master",
    );
    expect(latest).toEqual([
      {
        run: expect.objectContaining({ runNumber: 9 }),
        onDefaultBranch: false,
      },
      { run: expect.objectContaining({ runNumber: 8 }), onDefaultBranch: true },
    ]);
  });

  it("treats a run with no head branch as not on the default branch", () => {
    // `head_branch` is nullable, and "GitHub named no branch" is not "GitHub
    // named this one" - a null filed as main would invent a red main.
    const latest = latestPerBucket(
      [makeWorkflowRun({ runNumber: 9, headBranch: null })],
      "main",
    );
    expect(latest).toEqual([
      {
        run: expect.objectContaining({ runNumber: 9 }),
        onDefaultBranch: false,
      },
    ]);
  });
});

describe("the Actions lane (story 15)", () => {
  let dir: string;
  let store: SqliteStore;
  let github: FakeGitHubReadPort;
  let logs: string[];
  let clock: number;
  let watched: { owner: string; name: string }[];

  /** What each repository declares, as `resolveDefaultBranch` would answer. */
  let defaultBranches: Map<string, string>;
  /**
   * A threshold in the order of magnitude the wiring uses. Nothing here pins
   * it to the lane's cadence, and this comment does not claim it does: the
   * binding lives in `main()`, which is not exported, so the story that first
   * reads the count is where it gets pinned.
   */
  const HUNG_AFTER_MS = 2 * 60 * 60_000;

  const deps = () => ({
    github,
    store,
    watchedIn: (installation: string) =>
      watched.filter((r) => r.owner.toLowerCase() === installation),
    defaultBranchOf: (repo: { owner: string; name: string }) =>
      defaultBranches.get(`${repo.owner}/${repo.name}`.toLowerCase()) ?? "main",
    hungAfterMs: HUNG_AFTER_MS,
    now: () => new Date(Date.UTC(2026, 7, 18, 20, clock++)).toISOString(),
    log: (m: string) => logs.push(m),
  });

  const current = () =>
    store.currentByType("workflow_run").filter((c) => c.state === "present");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "actions-"));
    store = SqliteStore.openForWrite(join(dir, "a.db"));
    github = new FakeGitHubReadPort(new Map());
    logs = [];
    clock = 0;
    watched = [REPO];
    defaultBranches = new Map();
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores the latest run per workflow, keyed by node id", async () => {
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 9, nodeId: "WFR_9", conclusion: "failure" }),
      makeWorkflowRun({ runNumber: 8, nodeId: "WFR_8" }),
      makeWorkflowRun({
        runNumber: 7,
        nodeId: "WFR_7",
        workflowId: 200,
        workflowName: "Release",
      }),
    ]);

    const r = await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(r).toMatchObject({
      outcome: "ok",
      runs: 2,
      fetched: 1,
      notModified: 0,
    });
    const keys = current()
      .map((c) => c.subject.key)
      .sort();
    expect(keys).toEqual(["WFR_7", "WFR_9"]);
    const ci = current().find((c) => c.subject.key === "WFR_9");
    expect(ci?.payload).toMatchObject({
      repo: "no42-org/packyard",
      workflowName: "CI",
      conclusion: "failure",
    });
  });

  it("tombstones by supersession, never by window absence", async () => {
    // Sweep 1: workflows CI and Release each have a latest run.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 1, nodeId: "WFR_1" }),
      makeWorkflowRun({ runNumber: 2, nodeId: "WFR_2", workflowId: 200 }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    // Sweep 2: CI has a NEWER run; Release fell out of the 100-run window
    // entirely (dormant workflow). CI's old run is superseded; Release's
    // last known run must stay, because window absence is a fact about the
    // window, not the workflow.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 3, nodeId: "WFR_3" }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    const keys = current()
      .map((c) => c.subject.key)
      .sort();
    expect(keys).toEqual(["WFR_2", "WFR_3"]);
  });

  it("updates the same run in place as its status changes", async () => {
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({
        nodeId: "WFR_1",
        status: "in_progress",
        conclusion: null,
      }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    const before = current()[0];

    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({
        nodeId: "WFR_1",
        status: "completed",
        conclusion: "failure",
      }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    const after = current()[0];

    expect(current()).toHaveLength(1);
    expect(after?.payload).toMatchObject({ conclusion: "failure" });
    expect(after?.observedAt).not.toBe(before?.observedAt);
  });

  it("a 304 confirms the repository's stored runs without rewriting them", async () => {
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ nodeId: "WFR_1" }),
    ]);
    github.workflowRunValidators.set("no42-org/packyard", VALIDATOR);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    const before = current()[0];

    github.workflowRunNotModified.add("no42-org/packyard");
    const r = await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(r).toMatchObject({
      outcome: "ok",
      runs: 1,
      fetched: 0,
      notModified: 1,
    });
    const after = current()[0];
    expect(after?.observedAt).toBe(before?.observedAt);
    expect(after?.verifiedAt).not.toBe(before?.verifiedAt);
    // The second call was conditional.
    expect(github.workflowRunCachedSeen[1]?.cached).toEqual(VALIDATOR);
  });

  it("purges the validator when a 200 rewrote rows without one", async () => {
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ nodeId: "WFR_1" }),
    ]);
    github.workflowRunValidators.set("no42-org/packyard", VALIDATOR);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    const url = workflowRunsUrl(REPO);
    expect(store.loadValidator("no42-org", url)).not.toBeNull();

    github.workflowRunValidators.delete("no42-org/packyard");
    await collectWorkflowRuns(deps(), "no42-org", "full");
    expect(store.loadValidator("no42-org", url)).toBeNull();
  });

  it("unreadable payloads degrade the run and freeze that repo's cache and tombstones", async () => {
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 1, nodeId: "WFR_1" }),
    ]);
    github.workflowRunValidators.set("no42-org/packyard", VALIDATOR);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    // A newer run arrives but the page also carried unreadable payloads:
    // the supersession must not run (the unreadable one might have been the
    // even-newer run of the same workflow), and no validator may vouch for
    // an incompletely-read page.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 2, nodeId: "WFR_2" }),
    ]);
    github.workflowRunUnreadable.set("no42-org/packyard", 1);
    const r = await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(r.outcome).toBe("partial");
    const keys = current()
      .map((c) => c.subject.key)
      .sort();
    expect(keys).toEqual(["WFR_1", "WFR_2"]);
    expect(store.loadValidator("no42-org", workflowRunsUrl(REPO))).toBeNull();
  });

  it("one repository's failure degrades the run, keeping the rest", async () => {
    watched.push({ owner: "no42-org", name: "twiki" });
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ nodeId: "WFR_1" }),
    ]);
    github.workflowRunFailing.add("no42-org/twiki");

    const r = await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(r.outcome).toBe("partial");
    expect(r.runs).toBe(1);
    expect(current()).toHaveLength(1);
    expect(store.latestRuns(1)[0]?.detail).toContain("1 repositories failed");
  });

  it("a failed repository's stored rows and validator are left alone", async () => {
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ nodeId: "WFR_1" }),
    ]);
    github.workflowRunValidators.set("no42-org/packyard", VALIDATOR);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    github.workflowRunFailing.add("no42-org/packyard");
    await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(current()).toHaveLength(1);
    // The rows were not rewritten, so the validator still describes them.
    expect(
      store.loadValidator("no42-org", workflowRunsUrl(REPO)),
    ).not.toBeNull();
  });

  it("splits the cost into fetched, not-modified and failed", async () => {
    // The measurement story 15 exists for. A bare request count is
    // tautological (always one per watched repository) and misleading: a 304
    // costs no budget, so only `fetched` is spend and `notModified` is what
    // the cache saved.
    watched.push({ owner: "no42-org", name: "twiki" });
    watched.push({ owner: "no42-org", name: "broken" });
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ nodeId: "WFR_1" }),
    ]);
    github.workflowRunValidators.set("no42-org/packyard", VALIDATOR);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    github.workflowRunNotModified.add("no42-org/packyard");
    github.workflowRunFailing.add("no42-org/broken");
    const r = await collectWorkflowRuns(deps(), "no42-org", "full");

    // packyard 304s, twiki is fetched, broken fails: three watched repos,
    // three distinct outcomes, and only one of them cost budget.
    expect(r).toMatchObject({
      fetched: 1,
      notModified: 1,
      failedRepos: 1,
      outcome: "partial",
    });
  });

  it("writes no validator when the observation commit fails", async () => {
    // A validator written inside the fetch loop would survive a failed
    // recordObservations and then 304-confirm rows that were never stored:
    // a red build rendering green and fresh for as long as the repo is
    // quiet. Validators land only after the rows they vouch for.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ nodeId: "WFR_1" }),
    ]);
    github.workflowRunValidators.set("no42-org/packyard", VALIDATOR);
    const exploding = {
      ...deps(),
      store: Object.assign(Object.create(Object.getPrototypeOf(store)), store, {
        recordObservations: () => {
          throw new Error("SQLITE_BUSY");
        },
      }) as typeof store,
    };

    const r = await collectWorkflowRuns(exploding, "no42-org", "full");

    expect(r.outcome).toBe("failed");
    expect(store.loadValidator("no42-org", workflowRunsUrl(REPO))).toBeNull();
    expect(current()).toHaveLength(0);
  });

  it("reports the remaining budget, and survives not getting it", async () => {
    // Story 15 asks for the remaining budget in as many words, and
    // /rate_limit is the only honest source (AD-24). A diagnostic that took
    // the lane down would be worse than the number is useful.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ nodeId: "WFR_1" }),
    ]);
    const ok = await collectWorkflowRuns(deps(), "no42-org", "full");
    expect(ok.budgetRemaining).toBe(5000);

    github.rateLimit = async () => {
      throw new Error("rate_limit unreachable");
    };
    const degraded = await collectWorkflowRuns(deps(), "no42-org", "full");
    expect(degraded.outcome).toBe("ok");
    expect(degraded.budgetRemaining).toBeNull();
  });

  it("yields at its deadline and records what it did not reach", async () => {
    // AD-24: a lane that would exceed its budget yields and records a
    // partial run rather than pushing through. The repositories it never
    // reached keep their own attestations and go on ageing, which is what
    // makes them render stale instead of zero.
    watched.push({ owner: "no42-org", name: "twiki" });
    watched.push({ owner: "no42-org", name: "third" });
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ nodeId: "WFR_1" }),
    ]);

    // A deadline already in the past: nothing is reached at all.
    const r = await collectWorkflowRuns(deps(), "no42-org", "full", {
      deadlineAt: "2026-08-18T00:00:00.000Z",
    });

    expect(r.yielded).toBe(true);
    expect(r.outcome).toBe("partial");
    expect(r.reached).toBe(0);
    expect(r.watched).toBe(3);
    expect(current()).toHaveLength(0);
    expect(store.latestRuns(1)[0]?.detail).toContain("0 of 3");
  });

  it("resumes at the repositories the last sweep did not reach", async () => {
    // Without ordering by attestation the same prefix is swept every time
    // and the tail is never collected at all, while each sweep reports
    // success for what it did look at.
    watched.push({ owner: "no42-org", name: "twiki" });
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ nodeId: "WFR_p" }),
    ]);
    github.workflowRuns.set("no42-org/twiki", [
      makeWorkflowRun({
        nodeId: "WFR_t",
        repo: { owner: "no42-org", name: "twiki" },
      }),
    ]);

    // Sweep 1 reaches exactly one repository before its deadline. The fake
    // clock advances a minute per read, and the deadline is checked once
    // per repository, so 20:02 admits the first and stops the second.
    const first = await collectWorkflowRuns(deps(), "no42-org", "full", {
      deadlineAt: new Date(Date.UTC(2026, 7, 18, 20, 2)).toISOString(),
    });
    expect(first.reached).toBe(1);
    const firstSeen = github.workflowRunCachedSeen.map((c) => c.repo);

    // Sweep 2 must start with the one sweep 1 missed.
    github.workflowRunCachedSeen = [];
    const second = await collectWorkflowRuns(deps(), "no42-org", "full", {
      deadlineAt: new Date(Date.UTC(2026, 7, 18, 20, 30)).toISOString(),
    });
    const secondSeen = github.workflowRunCachedSeen.map((c) => c.repo);

    expect(second.reached).toBe(2);
    expect(secondSeen[0]).not.toBe(firstSeen[0]);
  });

  it("writes a per-repository confirmation, so no workflows is not no sweep", () => {
    // A repository with no workflows has no run rows, which without a
    // confirmation is indistinguishable from one the sweep never reached
    // (AD-28).
    return (async () => {
      github.workflowRuns.set("no42-org/packyard", []);
      await collectWorkflowRuns(deps(), "no42-org", "full");

      const confirmations = store
        .currentByType("repository_actions")
        .filter((c) => c.state === "present");
      expect(confirmations.map((c) => c.subject.key)).toEqual([
        "no42-org/packyard",
      ]);
      expect(confirmations[0]?.payload).toMatchObject({
        repo: "no42-org/packyard",
        workflows: 0,
        failing: 0,
      });
    })();
  });

  it("advances the confirmation on a 304, not only on a fetch", async () => {
    // A repository that always answers 304 is confirmed every sweep. If
    // only the 200 path wrote its attestation it would look
    // least-recently-confirmed forever, so the sweep order would keep
    // returning to it while its page section aged into stale.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ nodeId: "WFR_1" }),
    ]);
    github.workflowRunValidators.set("no42-org/packyard", VALIDATOR);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    const before = store.currentByType("repository_actions")[0];

    github.workflowRunNotModified.add("no42-org/packyard");
    const r = await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(r.notModified).toBe(1);
    const after = store.currentByType("repository_actions")[0];
    expect(after?.verifiedAt).not.toBe(before?.verifiedAt);
    // Confirmed, not rewritten: the counts did not change, so neither did
    // the observation behind them.
    expect(after?.observedAt).toBe(before?.observedAt);
    expect(after?.payload).toMatchObject({ workflows: 1 });
  });

  it("refuses to vouch for a repository whose payloads it could not read", async () => {
    // page.runs excludes what did not map, so counting it would publish
    // "no runs recorded" with a fresh badge for a repository whose runs we
    // merely failed to parse - a confident zero stated more confidently
    // than the ambiguity it replaced (AD-28).
    github.workflowRuns.set("no42-org/packyard", []);
    github.workflowRunUnreadable.set("no42-org/packyard", 3);

    const r = await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(r.outcome).toBe("partial");
    expect(store.currentByType("repository_actions")[0]?.payload).toMatchObject(
      { workflows: null, failing: null },
    );
  });

  it("records a failed repository so it cannot camp at the head of the sweep", async () => {
    // A repository that fails deterministically (Actions off, a 403) would
    // otherwise stay least-recently-confirmed forever and head every
    // bounded sweep, starving the ones behind it - the failure the ordering
    // exists to prevent, moved to a failing prefix.
    // Sweep 1: only twiki is watched, and it is confirmed.
    watched = [{ owner: "no42-org", name: "twiki" }];
    github.workflowRuns.set("no42-org/twiki", [
      makeWorkflowRun({
        nodeId: "WFR_t",
        repo: { owner: "no42-org", name: "twiki" },
      }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    // Sweep 2: a permanently failing repository joins. Never confirmed, so
    // it goes first, which is right - nothing has tried it yet.
    watched.push({ owner: "no42-org", name: "packyard" });
    github.workflowRunFailing.add("no42-org/packyard");
    github.workflowRunCachedSeen = [];
    await collectWorkflowRuns(deps(), "no42-org", "full");
    expect(github.workflowRunCachedSeen[0]?.repo).toBe("no42-org/packyard");

    const failed = store
      .currentByType("repository_actions")
      .find((c) => c.subject.key === "no42-org/packyard");
    // Reached, ordering advanced, nothing vouched for.
    expect(failed?.payload).toMatchObject({ workflows: null });

    // Sweep 3: it no longer outranks a repository confirmed longer ago.
    // Without the row it would head every sweep from here to forever.
    github.workflowRunCachedSeen = [];
    await collectWorkflowRuns(deps(), "no42-org", "full");
    expect(github.workflowRunCachedSeen[0]?.repo).toBe("no42-org/twiki");
  });

  it("reports a yield and the failures alongside it, not one or the other", async () => {
    // A degraded sweep is exactly the one likely to do both, and reporting
    // only the yield leaves the failures nowhere but a transient log line.
    watched.push({ owner: "no42-org", name: "twiki" });
    watched.push({ owner: "no42-org", name: "third" });
    github.workflowRunFailing.add("no42-org/packyard");

    const r = await collectWorkflowRuns(deps(), "no42-org", "full", {
      deadlineAt: new Date(Date.UTC(2026, 7, 18, 20, 3)).toISOString(),
    });

    expect(r.yielded).toBe(true);
    const detail = store.latestRuns(1)[0]?.detail ?? "";
    expect(detail).toContain("yielded after");
    expect(detail).toContain("1 repositories failed");
  });

  it("counts failing workflows in the confirmation", async () => {
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ nodeId: "WFR_1", conclusion: "failure" }),
      makeWorkflowRun({
        nodeId: "WFR_2",
        workflowId: 200,
        conclusion: "success",
      }),
    ]);

    await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(store.currentByType("repository_actions")[0]?.payload).toMatchObject(
      { workflows: 2, failing: 1 },
    );
  });

  it("yields before starting when the budget is below the floor", async () => {
    // The security lanes have no cheaper route; this one can wait an hour.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ nodeId: "WFR_1" }),
    ]);
    github.rateLimit = async () => ({ limit: 5800, remaining: 10 });

    const r = await collectWorkflowRuns(deps(), "no42-org", "full", {
      budgetFloor: 500,
    });

    expect(r.yielded).toBe(true);
    expect(r.outcome).toBe("partial");
    expect(r.reached).toBe(0);
    expect(current()).toHaveLength(0);
  });

  it("runs when the budget reading fails, rather than stopping collection", async () => {
    // An unreadable diagnostic is not evidence of a low budget, and the
    // deadline still bounds the sweep.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ nodeId: "WFR_1" }),
    ]);
    github.rateLimit = async () => {
      throw new Error("rate_limit unreachable");
    };

    const r = await collectWorkflowRuns(deps(), "no42-org", "full", {
      budgetFloor: 500,
    });

    expect(r.yielded).toBe(false);
    expect(r.reached).toBe(1);
  });

  it("contains a store failure rather than throwing past the lane", async () => {
    store.close();
    const r = await collectWorkflowRuns(deps(), "no42-org", "full");
    expect(r.outcome).toBe("failed");
    store = SqliteStore.openForWrite(join(dir, "a.db"));
  });

  it("a throwing logger cannot fail the lane", async () => {
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ nodeId: "WFR_1" }),
    ]);
    const r = await collectWorkflowRuns(
      {
        ...deps(),
        log: () => {
          throw new Error("EPIPE");
        },
      },
      "no42-org",
      "full",
    );
    expect(r.outcome).toBe("ok");
    expect(store.latestRuns(1)[0]?.outcome).toBe("ok");
  });

  it("keeps the failed default-branch run while pull requests churn", async () => {
    // The failure this story exists for. Keyed by workflow alone, the first
    // pull-request run superseded the red main within minutes and the store
    // forgot main was broken - for as long as anyone kept pushing.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 1, conclusion: "failure" }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    const firstSeen = current().find((c) => c.subject.key === "WFR_1");

    for (const runNumber of [2, 3, 4]) {
      github.workflowRuns.set("no42-org/packyard", [
        makeWorkflowRun({ runNumber, headBranch: "feature/x" }),
      ]);
      await collectWorkflowRuns(deps(), "no42-org", "full");
    }

    // The red main is still present, still says failure, and is still
    // current: the sweeps that did not supersede it confirmed it.
    const main = current().find((c) => c.subject.key === "WFR_1");
    expect(main?.payload).toMatchObject({
      conclusion: "failure",
      headBranch: "main",
    });
    // Current, not merely present: every sweep that did not supersede it
    // confirmed it, so it never ages into stale behind the branch runs.
    expect(main?.verifiedAt.localeCompare(firstSeen?.verifiedAt ?? "")).toBe(1);
    expect(main?.observedAt).toBe(firstSeen?.observedAt);
    // Two rows, one per bucket: the red main and the newest branch run.
    expect(
      current()
        .map((c) => c.subject.key)
        .sort(),
    ).toEqual(["WFR_1", "WFR_4"]);
  });

  it("leaves a fork's pull request out of the default bucket (#141)", async () => {
    // The reported failure. A contributor works on their fork's own `main`
    // and opens a pull request; GitHub runs it HERE and reports
    // head_branch: "main", because that is the branch name in the head
    // repository. Bucketing it by the name alone put a stranger's failed run
    // in the default bucket, where it superseded the genuine push row and
    // counted as "main is broken".
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({
        runNumber: 9,
        headBranch: "main",
        event: "pull_request",
        conclusion: "failure",
      }),
      makeWorkflowRun({ runNumber: 2, headBranch: "main", event: "push" }),
    ]);

    const r = await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(r.outcome).toBe("ok");
    // Both rows survive: the push in the default bucket, the pull request in
    // the other one. Neither tombstones the other, because they are no
    // longer in the same bucket.
    expect(
      current()
        .map((c) => c.subject.key)
        .sort(),
    ).toEqual(["WFR_2", "WFR_9"]);
    const push = current().find((c) => c.subject.key === "WFR_2");
    expect(push?.payload).toMatchObject({ event: "push", headBranch: "main" });
    // And the repository is not reported broken on a stranger's evidence.
    expect(store.currentByType("repository_actions")[0]?.payload).toMatchObject(
      { workflows: 1, failing: 0 },
    );
  });

  it("reclassifies a stored fork run out of the default bucket on one sweep", async () => {
    // A store written under the branch-only rule holds the fork run in the
    // default bucket. The event is already in every stored payload, so the
    // first sweep that reads it moves the row without a migration, and the
    // genuine push row is not tombstoned for having been in the wrong one.
    const first = store.beginRun({
      lane: LANE,
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-18T19:00:00.000Z",
    });
    store.recordObservations(first, "2026-08-18T19:00:00.000Z", [
      normaliseRun(
        makeWorkflowRun({
          runNumber: 9,
          headBranch: "main",
          event: "pull_request",
          conclusion: "failure",
        }),
      ),
      normaliseRun(
        makeWorkflowRun({ runNumber: 2, headBranch: "main", event: "push" }),
      ),
    ]);
    store.finishRun(first, "ok", "2026-08-18T19:00:00.000Z");

    // The page carries a NEWER push on main. That makes the default bucket
    // observed, so a stored row wrongly filed there is tombstoned: this is
    // what tells a branch-only reclassification apart from the right one.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 12, headBranch: "main", event: "push" }),
    ]);

    await collectWorkflowRuns(deps(), "no42-org", "full");

    // The newer push supersedes the older push. The fork's run belongs to
    // the other bucket, which the page never observed, so it survives -
    // whereas filing it by branch alone would have tombstoned it here.
    expect(
      current()
        .map((c) => c.subject.key)
        .sort(),
    ).toEqual(["WFR_12", "WFR_9"]);
    expect(store.currentByType("repository_actions")[0]?.payload).toMatchObject(
      { failing: 0 },
    );
  });

  it("leaves a stored row with no event out of every decision", async () => {
    // The bucket reads the event, so the guard checks it. A payload without
    // one cannot be filed, and an unreadable row is left alone rather than
    // guessed at.
    const first = store.beginRun({
      lane: LANE,
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-18T19:00:00.000Z",
    });
    const complete = normaliseRun(
      makeWorkflowRun({ runNumber: 2, headBranch: "main" }),
    );
    store.recordObservations(first, "2026-08-18T19:00:00.000Z", [
      complete,
      {
        subject: { type: "workflow_run", key: "WFR_noevent" },
        payload: { ...(complete.payload as object), event: undefined },
      } as never,
    ]);
    store.finishRun(first, "ok", "2026-08-18T19:00:00.000Z");

    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 12, headBranch: "main" }),
    ]);

    await collectWorkflowRuns(deps(), "no42-org", "full");

    // The readable row was superseded; the unreadable one was neither
    // superseded nor counted, and it is still present.
    expect(
      current()
        .map((c) => c.subject.key)
        .sort(),
    ).toEqual(["WFR_12", "WFR_noevent"]);
    expect(store.currentByType("repository_actions")[0]?.payload).toMatchObject(
      { workflows: 1 },
    );
  });

  it("supersedes only within a bucket, in both directions", async () => {
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 1, headBranch: "main" }),
      makeWorkflowRun({ runNumber: 2, headBranch: "feature/x" }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    expect(
      current()
        .map((c) => c.subject.key)
        .sort(),
    ).toEqual(["WFR_1", "WFR_2"]);

    // A newer run in each bucket, arriving one bucket at a time. Each
    // replaces its own row and leaves the other alone.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 3, headBranch: "feature/y" }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    expect(
      current()
        .map((c) => c.subject.key)
        .sort(),
    ).toEqual(["WFR_1", "WFR_3"]);

    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 4, headBranch: "main" }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    expect(
      current()
        .map((c) => c.subject.key)
        .sort(),
    ).toEqual(["WFR_3", "WFR_4"]);
  });

  it("files a master repository's main-line run as the default-branch row", async () => {
    // Read through the declared branch, not a `main` literal. A repository on
    // master would otherwise have every run of its real main line filed as a
    // side branch, and a stray `main` branch would become its default row.
    defaultBranches.set("no42-org/packyard", "master");
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 1, headBranch: "main" }),
      makeWorkflowRun({
        runNumber: 2,
        headBranch: "master",
        conclusion: "failure",
      }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    // A newer run on `main` supersedes the OTHER-branch row, because on this
    // repository main is just another branch.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 3, headBranch: "main" }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(
      current()
        .map((c) => c.subject.key)
        .sort(),
    ).toEqual(["WFR_2", "WFR_3"]);
    // And the master row is what the failing counter counted.
    expect(store.currentByType("repository_actions")[0]?.payload).toMatchObject(
      { repo: "no42-org/packyard", workflows: 1, failing: 1 },
    );
  });

  it("confirms a retained row the page did not supersede", async () => {
    // A default-branch run whose bucket has no run on this page is still the
    // latest that bucket has, and the page can see that: both runs here were
    // created at the same instant, so the carried row sits inside the window
    // the page is evidence about. Without the touch it would age into stale
    // while every sweep could see it was still the last word on that branch.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 1, conclusion: "failure" }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    const before = current().find((c) => c.subject.key === "WFR_1");

    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 2, headBranch: "feature/x" }),
    ]);
    const r = await collectWorkflowRuns(deps(), "no42-org", "full");
    const after = current().find((c) => c.subject.key === "WFR_1");

    // Confirmed, not rewritten: freshness moved, the value did not.
    expect(after?.verifiedAt).not.toBe(before?.verifiedAt);
    expect(after?.observedAt).toBe(before?.observedAt);
    // Counted as seen, exactly as a 304-confirmed row is.
    expect(r.runs).toBe(2);
  });

  it("confirms a carried row the page's window reaches back to", async () => {
    // The window a page is evidence about runs from its oldest run forward.
    // Release last ran on the 16th and this page reaches back to midday on
    // the 15th, so "no Release run here" really is proof that nothing newer
    // exists - and the row may be badged current.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({
        runNumber: 1,
        workflowId: 100,
        createdAt: "2026-08-15T00:00:00.000Z",
      }),
      makeWorkflowRun({
        runNumber: 2,
        workflowId: 200,
        workflowName: "Release",
        conclusion: "failure",
        createdAt: "2026-08-16T00:00:00.000Z",
      }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    const before = current().find((c) => c.subject.key === "WFR_2");

    // Two runs, so the window is a range rather than a point: the carried
    // Release row sits between them. Read from the NEWEST run the page would
    // not cover it, and this is the assertion that says which end the window
    // is anchored to.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({
        runNumber: 4,
        workflowId: 300,
        workflowName: "Docs",
        createdAt: "2026-08-17T00:00:00.000Z",
      }),
      makeWorkflowRun({
        runNumber: 3,
        workflowId: 100,
        createdAt: "2026-08-15T12:00:00.000Z",
      }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    const after = current().find((c) => c.subject.key === "WFR_2");
    expect(after?.verifiedAt).not.toBe(before?.verifiedAt);
    expect(after?.observedAt).toBe(before?.observedAt);
    // Vouched for, so it counts towards what the sweep attested.
    expect(store.currentByType("repository_actions")[0]?.payload).toEqual({
      repo: "no42-org/packyard",
      workflows: 3,
      failing: 1,
    });
  });

  it("still has a window when one run on the page has a bad timestamp", async () => {
    // One unreadable time is not a reason to stop believing the rest of the
    // page. The window is the oldest time the page DOES state, so a carried
    // row inside it is still confirmed.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({
        runNumber: 1,
        workflowId: 100,
        createdAt: "2026-08-15T00:00:00.000Z",
      }),
      makeWorkflowRun({
        runNumber: 2,
        workflowId: 200,
        workflowName: "Release",
        createdAt: "2026-08-16T00:00:00.000Z",
      }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    const before = current().find((c) => c.subject.key === "WFR_2");

    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 3, workflowId: 100, createdAt: "nonsense" }),
      makeWorkflowRun({
        runNumber: 4,
        workflowId: 300,
        workflowName: "Docs",
        createdAt: "2026-08-15T12:00:00.000Z",
      }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    const after = current().find((c) => c.subject.key === "WFR_2");
    expect(after?.verifiedAt).not.toBe(before?.verifiedAt);
  });

  it("leaves a carried row the page's window cannot reach to age", async () => {
    // The same shape with the window one day short. Release last ran on the
    // 16th and this page only reaches back to the 17th, so its absence
    // proves nothing: with more than a hundred newer runs a newer Release
    // run can sit outside the page entirely, and badging the stored failure
    // fresh would keep showing a red main somebody had already fixed.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({
        runNumber: 1,
        workflowId: 100,
        createdAt: "2026-08-15T00:00:00.000Z",
      }),
      makeWorkflowRun({
        runNumber: 2,
        workflowId: 200,
        workflowName: "Release",
        conclusion: "failure",
        createdAt: "2026-08-16T00:00:00.000Z",
      }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    const before = current().find((c) => c.subject.key === "WFR_2");

    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({
        runNumber: 3,
        workflowId: 100,
        createdAt: "2026-08-17T00:00:00.000Z",
      }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    const after = current().find((c) => c.subject.key === "WFR_2");
    // Still present - nothing superseded it - but not confirmed, so it ages
    // into stale and the page says the sweep did not look far enough back.
    expect(after).toBeDefined();
    expect(after?.verifiedAt).toBe(before?.verifiedAt);
    // Still counted, though: the window decides whose freshness this sweep
    // may touch, not what the store holds. The page renders this row, so the
    // count includes it, and the two cannot disagree about the repository.
    expect(store.currentByType("repository_actions")[0]?.payload).toEqual({
      repo: "no42-org/packyard",
      workflows: 2,
      failing: 1,
    });
  });

  it("confirms no carried row from a page with no runs at all", async () => {
    // An empty page is evidence about nothing: it has no window, so it
    // cannot prove the absence of anything.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 1, conclusion: "failure" }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    const before = current().find((c) => c.subject.key === "WFR_1");

    github.workflowRuns.set("no42-org/packyard", []);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    const after = current().find((c) => c.subject.key === "WFR_1");
    expect(after).toBeDefined();
    expect(after?.verifiedAt).toBe(before?.verifiedAt);
    // Unconfirmed and still held, so still counted: an empty page proves no
    // absence, and reporting zero here would be a confident zero about rows
    // the store plainly has (AD-28).
    expect(store.currentByType("repository_actions")[0]?.payload).toEqual({
      repo: "no42-org/packyard",
      workflows: 1,
      failing: 1,
    });
  });

  it("confirms nothing on a page it could not read completely", async () => {
    // An unreadable payload might have been the newer run of either bucket,
    // so neither superseding nor vouching for what is left is honest. The
    // whole repository freezes rather than half of it moving.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 1, conclusion: "failure" }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    const before = current().find((c) => c.subject.key === "WFR_1");

    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 2, headBranch: "feature/x" }),
    ]);
    github.workflowRunUnreadable.set("no42-org/packyard", 1);
    const r = await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(r.outcome).toBe("partial");
    const after = current().find((c) => c.subject.key === "WFR_1");
    expect(after?.verifiedAt).toBe(before?.verifiedAt);
    expect(store.currentByType("repository_actions")[0]?.payload).toMatchObject(
      { workflows: null, failing: null },
    );
  });

  it("counts failing from the verdict, on the default branch only", async () => {
    // Three retained default-branch rows - failed, hung, passed - and one
    // failing branch run that must not be counted. The hung one is an
    // unfinished run created twenty hours before this sweep, well past the
    // two-hour threshold the wiring passes.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 1, workflowId: 100, conclusion: "failure" }),
      makeWorkflowRun({
        runNumber: 2,
        workflowId: 200,
        status: "in_progress",
        conclusion: null,
      }),
      makeWorkflowRun({ runNumber: 3, workflowId: 300, conclusion: "success" }),
      makeWorkflowRun({
        runNumber: 4,
        workflowId: 400,
        headBranch: "feature/x",
        conclusion: "failure",
      }),
    ]);

    await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(store.currentByType("repository_actions")[0]?.payload).toEqual({
      repo: "no42-org/packyard",
      // Four distinct workflows retained, four rows; the failing count is
      // the two broken default-branch ones.
      workflows: 4,
      failing: 2,
    });
  });

  it("counts one workflow once, however many buckets it fills", async () => {
    // A workflow with a run on main and one on a branch is still ONE
    // workflow; reporting two would put a count on the page that nothing on
    // it explains.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 1, headBranch: "main" }),
      makeWorkflowRun({ runNumber: 2, headBranch: "feature/x" }),
    ]);

    await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(store.currentByType("repository_actions")[0]?.payload).toEqual({
      repo: "no42-org/packyard",
      workflows: 1,
      failing: 0,
    });
  });

  it("counts a retained row the page never showed, on a 200 and a 304", async () => {
    // The red main that fell out of the window is still what the counter is
    // about, whichever way the next sweep answered.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 1, conclusion: "failure" }),
    ]);
    github.workflowRunValidators.set("no42-org/packyard", VALIDATOR);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 2, headBranch: "feature/x" }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    expect(store.currentByType("repository_actions")[0]?.payload).toMatchObject(
      { workflows: 1, failing: 1 },
    );

    github.workflowRunNotModified.add("no42-org/packyard");
    await collectWorkflowRuns(deps(), "no42-org", "full");
    expect(store.currentByType("repository_actions")[0]?.payload).toMatchObject(
      { workflows: 1, failing: 1 },
    );
  });

  it("does not count a failing branch run when a 304 confirms it", async () => {
    // The free path judges the same way the fetched one does. Counting every
    // stored failure here would make a repository whose only red run is on a
    // feature branch read broken for as long as it stayed quiet.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({
        runNumber: 1,
        headBranch: "feature/x",
        conclusion: "failure",
      }),
      makeWorkflowRun({ runNumber: 2, headBranch: "main" }),
    ]);
    github.workflowRunValidators.set("no42-org/packyard", VALIDATOR);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    expect(store.currentByType("repository_actions")[0]?.payload).toEqual({
      repo: "no42-org/packyard",
      workflows: 1,
      failing: 0,
    });

    github.workflowRunNotModified.add("no42-org/packyard");
    const r = await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(r.notModified).toBe(1);
    expect(store.currentByType("repository_actions")[0]?.payload).toEqual({
      repo: "no42-org/packyard",
      workflows: 1,
      failing: 0,
    });
  });

  it("writes the same counters on a 200 and the 304 after it", async () => {
    // #142. The counters used to run over `retained` on the 200 path and
    // over everything stored on the 304 path, so a repository whose red main
    // had aged out of the page window wrote `failing: 0` on the sweep that
    // read a page and `failing: 1` on the next one that was told nothing had
    // changed - two numbers about a repository nothing had touched. Both
    // paths now count the rows the store HOLDS, so they agree because they
    // are the same computation over the same set.
    github.workflowRunValidators.set("no42-org/packyard", VALIDATOR);
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({
        runNumber: 1,
        nodeId: "WFR_1",
        conclusion: "failure",
        createdAt: "2026-08-15T00:00:00.000Z",
      }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    // A second page, every run on it newer than the red row: the window
    // starts after that row, so this sweep cannot vouch for its freshness.
    // It is still held, and still counted.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({
        runNumber: 3,
        nodeId: "WFR_3",
        workflowId: 200,
        workflowName: "Release",
        createdAt: "2026-08-18T00:00:00.000Z",
      }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    const afterFetch = store.currentByType("repository_actions")[0]?.payload;
    expect(afterFetch).toEqual({
      repo: "no42-org/packyard",
      workflows: 2,
      failing: 1,
    });
    // Both rows held, which is what the two paths now have in common.
    expect(current()).toHaveLength(2);

    github.workflowRunNotModified.add("no42-org/packyard");
    const r = await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(r.notModified).toBe(1);
    expect(store.currentByType("repository_actions")[0]?.payload).toEqual(
      afterFetch,
    );
  });

  it("counts a run that turns hung under repeated 304s", async () => {
    // Why the counters are not carried forward from the last confirmation,
    // which is what a 304 seems to invite. `failing` counts hung runs, and a
    // run becomes hung by the CLOCK rather than by the listing: carried
    // forward, this run would be painted red by the page and counted by
    // nothing, for as long as the repository stayed quiet.
    github.workflowRunValidators.set("no42-org/packyard", VALIDATOR);
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({
        runNumber: 1,
        nodeId: "WFR_1",
        status: "in_progress",
        conclusion: null,
        // Half an hour before the first sweep, against a two-hour threshold.
        createdAt: "2026-08-18T19:30:00.000Z",
      }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    expect(store.currentByType("repository_actions")[0]?.payload).toEqual({
      repo: "no42-org/packyard",
      workflows: 1,
      failing: 0,
    });

    // Three hours and twenty minutes later, with GitHub still saying the
    // listing has not changed. The run has not moved; the clock has.
    clock = 200;
    github.workflowRunNotModified.add("no42-org/packyard");
    const r = await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(r.notModified).toBe(1);
    expect(store.currentByType("repository_actions")[0]?.payload).toEqual({
      repo: "no42-org/packyard",
      workflows: 1,
      failing: 1,
    });
  });

  it("leaves a stored row it cannot read out of every decision", async () => {
    // A row with no workflow id is one the buckets cannot judge. It is
    // skipped rather than guessed at: read through a hole it would land in a
    // bucket of its own, never be superseded, and be counted and confirmed
    // forever.
    //
    // Its created time is deliberately VALID and inside the page's window,
    // so the window check below cannot stand in for the missing guard - it
    // did, and the first version of this test passed with the guard removed.
    const at = "2026-08-18T19:00:00.000Z";
    const seeded = store.beginRun({
      lane: LANE,
      installation: "no42-org",
      scope: "full",
      startedAt: at,
    });
    store.recordObservations(seeded, at, [
      {
        subject: { type: "workflow_run", key: "WFR_bad" },
        payload: {
          repo: "no42-org/packyard",
          workflowName: "CI",
          runNumber: 1,
          status: "completed",
          conclusion: "failure",
          headBranch: "main",
          event: "push",
          htmlUrl: "https://github.com/no42-org/packyard/actions/runs/1",
          createdAt: "2026-08-18T06:00:00.000Z",
        },
      },
    ]);
    store.finishRun(seeded, "ok", at);

    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 9 }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    const bad = current().find((c) => c.subject.key === "WFR_bad");
    // Present, because nothing observed supersedes what nothing could read.
    expect(bad).toBeDefined();
    // Not confirmed: the sweep has no idea what this row says.
    expect(bad?.verifiedAt).toBe(at);
    // And not counted, so the attestation cannot vouch for it either.
    expect(store.currentByType("repository_actions")[0]?.payload).toEqual({
      repo: "no42-org/packyard",
      workflows: 1,
      failing: 0,
    });
  });

  it("sorts an old store's rows into buckets without losing one", async () => {
    // A store written before this change holds one row per workflow, on
    // whatever branch happened to run last. One sweep reclassifies them from
    // the head branch each row already carries: nothing is tombstoned for
    // having been written on the wrong side of a line that did not exist.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({ runNumber: 1, workflowId: 100, headBranch: "main" }),
      makeWorkflowRun({
        runNumber: 2,
        workflowId: 200,
        headBranch: "feature/x",
      }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    const schemaBefore = store.schemaVersion();

    // Sweep 2: one run in a bucket neither stored row occupies.
    github.workflowRuns.set("no42-org/packyard", [
      makeWorkflowRun({
        runNumber: 3,
        workflowId: 100,
        headBranch: "feature/y",
      }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(
      current()
        .map((c) => c.subject.key)
        .sort(),
    ).toEqual(["WFR_1", "WFR_2", "WFR_3"]);
    expect(
      store.currentByType("workflow_run").filter((c) => c.state === "resolved"),
    ).toEqual([]);
    expect(store.schemaVersion()).toBe(schemaBefore);
  });

  it("degrades one repository when the branch resolver throws", async () => {
    // The resolver is the caller's, and it is consulted before the read. A
    // throw there must look like any other per-repository failure - partial,
    // the rest of the sweep intact - rather than ending the sweep for the
    // repositories behind it.
    watched.push({ owner: "no42-org", name: "twiki" });
    github.workflowRuns.set("no42-org/twiki", [
      makeWorkflowRun({
        nodeId: "WFR_t",
        repo: { owner: "no42-org", name: "twiki" },
      }),
    ]);
    const exploding = {
      ...deps(),
      defaultBranchOf: (repo: { owner: string; name: string }) => {
        if (repo.name === "packyard") throw new Error("no config loaded");
        return "main";
      },
    };

    const r = await collectWorkflowRuns(exploding, "no42-org", "full");

    expect(r.outcome).toBe("partial");
    expect(r.failedRepos).toBe(1);
    expect(current().map((c) => c.subject.key)).toEqual(["WFR_t"]);
  });

  it("writes run rows under its own lane name", async () => {
    await collectWorkflowRuns(deps(), "no42-org", "full");
    expect(store.latestRuns(1)[0]?.lane).toBe(LANE);
  });
});
