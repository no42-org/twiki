/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type RawWorkflowRun, workflowRunsUrl } from "../src/github/port.js";
import {
  collectWorkflowRuns,
  LANE,
  latestPerWorkflow,
} from "../src/tricorder/collect/workflow-runs.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { FakeGitHubReadPort } from "./fakes.js";

const REPO = { owner: "no42-org", name: "packyard" };

const makeRun = (over: Partial<RawWorkflowRun> = {}): RawWorkflowRun => ({
  nodeId: `WFR_${over.runNumber ?? 1}`,
  repo: REPO,
  workflowId: 100,
  workflowName: "CI",
  runNumber: 1,
  status: "completed",
  conclusion: "success",
  headBranch: "main",
  event: "push",
  htmlUrl: "https://github.com/no42-org/packyard/actions/runs/1",
  createdAt: "2026-08-18T00:00:00.000Z",
  ...over,
});

const VALIDATOR = {
  etag: 'W/"runs-1"',
  lastModified: null,
  tokenGen: "2026-08-18T20:00:00Z",
};

describe("latest run per workflow", () => {
  it("keeps the first (newest) run of each workflow, in page order", () => {
    // GitHub answers newest first; the selection leans on that rather than
    // re-sorting, so the fixture is deliberately newest-first.
    const latest = latestPerWorkflow([
      makeRun({ runNumber: 9, workflowId: 100 }),
      makeRun({ runNumber: 8, workflowId: 200, workflowName: "Release" }),
      makeRun({ runNumber: 7, workflowId: 100 }),
      makeRun({ runNumber: 6, workflowId: 200 }),
    ]);
    expect(latest.map((r) => r.runNumber)).toEqual([9, 8]);
  });
});

describe("the Actions lane (story 15)", () => {
  let dir: string;
  let store: SqliteStore;
  let github: FakeGitHubReadPort;
  let logs: string[];
  let clock: number;
  let watched: { owner: string; name: string }[];

  const deps = () => ({
    github,
    store,
    watchedIn: (installation: string) =>
      watched.filter((r) => r.owner.toLowerCase() === installation),
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
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores the latest run per workflow, keyed by node id", async () => {
    github.workflowRuns.set("no42-org/packyard", [
      makeRun({ runNumber: 9, nodeId: "WFR_9", conclusion: "failure" }),
      makeRun({ runNumber: 8, nodeId: "WFR_8" }),
      makeRun({
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
      makeRun({ runNumber: 1, nodeId: "WFR_1" }),
      makeRun({ runNumber: 2, nodeId: "WFR_2", workflowId: 200 }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    // Sweep 2: CI has a NEWER run; Release fell out of the 100-run window
    // entirely (dormant workflow). CI's old run is superseded; Release's
    // last known run must stay, because window absence is a fact about the
    // window, not the workflow.
    github.workflowRuns.set("no42-org/packyard", [
      makeRun({ runNumber: 3, nodeId: "WFR_3" }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    const keys = current()
      .map((c) => c.subject.key)
      .sort();
    expect(keys).toEqual(["WFR_2", "WFR_3"]);
  });

  it("updates the same run in place as its status changes", async () => {
    github.workflowRuns.set("no42-org/packyard", [
      makeRun({ nodeId: "WFR_1", status: "in_progress", conclusion: null }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    const before = current()[0];

    github.workflowRuns.set("no42-org/packyard", [
      makeRun({ nodeId: "WFR_1", status: "completed", conclusion: "failure" }),
    ]);
    await collectWorkflowRuns(deps(), "no42-org", "full");
    const after = current()[0];

    expect(current()).toHaveLength(1);
    expect(after?.payload).toMatchObject({ conclusion: "failure" });
    expect(after?.observedAt).not.toBe(before?.observedAt);
  });

  it("a 304 confirms the repository's stored runs without rewriting them", async () => {
    github.workflowRuns.set("no42-org/packyard", [
      makeRun({ nodeId: "WFR_1" }),
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
      makeRun({ nodeId: "WFR_1" }),
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
      makeRun({ runNumber: 1, nodeId: "WFR_1" }),
    ]);
    github.workflowRunValidators.set("no42-org/packyard", VALIDATOR);
    await collectWorkflowRuns(deps(), "no42-org", "full");

    // A newer run arrives but the page also carried unreadable payloads:
    // the supersession must not run (the unreadable one might have been the
    // even-newer run of the same workflow), and no validator may vouch for
    // an incompletely-read page.
    github.workflowRuns.set("no42-org/packyard", [
      makeRun({ runNumber: 2, nodeId: "WFR_2" }),
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
      makeRun({ nodeId: "WFR_1" }),
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
      makeRun({ nodeId: "WFR_1" }),
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
      makeRun({ nodeId: "WFR_1" }),
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
      makeRun({ nodeId: "WFR_1" }),
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
      makeRun({ nodeId: "WFR_1" }),
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
      makeRun({ nodeId: "WFR_1" }),
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
      makeRun({ nodeId: "WFR_p" }),
    ]);
    github.workflowRuns.set("no42-org/twiki", [
      makeRun({ nodeId: "WFR_t", repo: { owner: "no42-org", name: "twiki" } }),
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
      makeRun({ nodeId: "WFR_1" }),
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

  it("counts failing workflows in the confirmation", async () => {
    github.workflowRuns.set("no42-org/packyard", [
      makeRun({ nodeId: "WFR_1", conclusion: "failure" }),
      makeRun({ nodeId: "WFR_2", workflowId: 200, conclusion: "success" }),
    ]);

    await collectWorkflowRuns(deps(), "no42-org", "full");

    expect(store.currentByType("repository_actions")[0]?.payload).toMatchObject(
      { workflows: 2, failing: 1 },
    );
  });

  it("yields before starting when the budget is below the floor", async () => {
    // The security lanes have no cheaper route; this one can wait an hour.
    github.workflowRuns.set("no42-org/packyard", [
      makeRun({ nodeId: "WFR_1" }),
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
      makeRun({ nodeId: "WFR_1" }),
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
      makeRun({ nodeId: "WFR_1" }),
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

  it("writes run rows under its own lane name", async () => {
    await collectWorkflowRuns(deps(), "no42-org", "full");
    expect(store.latestRuns(1)[0]?.lane).toBe(LANE);
  });
});
