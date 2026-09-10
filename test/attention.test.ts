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
import { DEFAULT_NOW_EPSS } from "../src/core/tier.js";
import {
  attentionByRepo,
  repoAttention,
} from "../src/tricorder/attention/tiers.js";
import { normalise } from "../src/tricorder/collect/dependabot-alerts.js";
import { normaliseReviewRequest } from "../src/tricorder/collect/review-requests.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { makeAlert, makeReviewRequest } from "./fakes.js";

// AD-29 and AD-34: one tier per repository, the maximum over its open items,
// raised by an overdue review, computed once for every reader.

const NOW = new Date("2026-08-20T12:00:00.000Z");
const REPO = { owner: "no42-org", name: "twiki" };
const DEPS = {
  policy: { cadenceMs: 15 * 60_000 },
  kevPolicy: { cadenceMs: 24 * 60 * 60_000 },
  actionsPolicy: { cadenceMs: 60 * 60_000 },
  rankPolicy: DEFAULT_RANK_POLICY,
  cutRank: epssRank(DEFAULT_NOW_EPSS, DEFAULT_RANK_POLICY.epssBands),
  reviewBudgetDays: 3,
  hungAfterMs: 2 * 60 * 60_000,
  defaultBranchOf: () => "main",
};

const daysAgo = (days: number): string =>
  new Date(NOW.getTime() - days * 24 * 60 * 60_000).toISOString();

describe("repoAttention (AD-29, AD-34)", () => {
  let dir: string;
  let store: SqliteStore;

  const seed = (
    lane: string,
    observations: { subject: unknown; payload: unknown }[],
    at = "2026-08-20T11:55:00.000Z",
  ) => {
    const r = store.beginRun({
      lane,
      installation: "no42-org",
      scope: "full",
      startedAt: at,
    });
    store.recordObservations(r, at, observations as never[]);
    store.finishRun(r, "ok", at);
  };

  const seedKev = (cveIds: string[]) =>
    seed("kev", [
      {
        subject: KEV_SUBJECT,
        payload: { version: "2026.08.20", released: daysAgo(0), cveIds },
      },
    ]);

  const issue = (key: string, repo = "no42-org/twiki") => ({
    subject: { type: "issue", key },
    payload: {
      repo,
      number: 5,
      title: "Crash on startup",
      author: "someone",
      htmlUrl: `https://github.com/${repo}/issues/5`,
      createdAt: daysAgo(1),
    },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "attention-"));
    store = SqliteStore.openForWrite(join(dir, "a.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("is quiet with no open items and says so", () => {
    expect(repoAttention(store, REPO, NOW, DEPS)).toEqual({
      tier: "quiet",
      reason: "no open items",
      first: null,
      overdueReview: null,
      openReviews: 0,
      openAlerts: 0,
      worstSeverity: null,
      items: [],
    });
  });

  it("takes the maximum over the repository's items", () => {
    seedKev(["CVE-2021-44228"]);
    seed("graphql-issues", [issue("I_1")]);
    seed("rest-org-dependabot", [
      normalise(
        makeAlert({ number: 7, cveId: "CVE-2021-44228", severity: "high" }),
      ),
    ]);

    const attention = repoAttention(store, REPO, NOW, DEPS);

    expect(attention.tier).toBe("now");
    expect(attention.reason).toBe(
      "alert #7 left-pad: listed in CISA KEV, EPSS 42.0%, severity high, not an update, stuck state unknown",
    );
    expect(attention.items.map((i) => i.kind)).toEqual(["alert", "issue"]);
  });

  it("makes a red default branch now, and names the workflow in one sentence", () => {
    // The tier is the easy thing to miss: leading the chain decides ORDER,
    // and without its own rule in tier() a broken main would satisfy nothing
    // but `anyAboveLeast` and land in `soon`.
    seedKev(["CVE-2021-44228"]);
    seed("rest-org-dependabot", [
      normalise(
        makeAlert({ number: 7, cveId: "CVE-2021-44228", severity: "high" }),
      ),
    ]);
    seed(
      "rest-actions-runs",
      [
        {
          subject: { type: "repository_actions", key: "no42-org/twiki" },
          payload: { repo: "no42-org/twiki", workflows: 1, failing: 1 },
        },
        {
          subject: { type: "workflow_run", key: "WFR_9" },
          payload: {
            repo: "no42-org/twiki",
            workflowId: 1,
            workflowName: "CI",
            runNumber: 9,
            status: "completed",
            conclusion: "failure",
            headBranch: "main",
            event: "push",
            htmlUrl: "https://github.com/no42-org/twiki/actions/runs/9",
            createdAt: "2026-08-20T10:00:00.000Z",
          },
        },
      ],
      "2026-08-20T11:30:00.000Z",
    );

    const attention = repoAttention(store, REPO, NOW, DEPS);

    expect(attention.tier).toBe("now");
    // One plain sentence: the run it points at, and what happened to which
    // workflow. The KEV-listed alert is `now` too and ranks below it.
    expect(attention.reason).toBe(
      "workflow run #9: default branch workflow CI failed 2h ago",
    );
    expect(attention.items.map((i) => i.kind)).toEqual(["ci_failure", "alert"]);
  });

  it("names the first item in chain order AT the tier, not the first item", () => {
    // An update PR linked to an alert we cannot read has an unknown KEV
    // term, which sorts above an alert checked and found absent; only the
    // alert reaches now. The rationale must name the item that put the
    // repository there, not the item at the top of the list.
    seedKev(["CVE-0000-0000"]);
    seed("rest-org-dependabot", [
      normalise(
        makeAlert({
          number: 2,
          cveId: "CVE-2026-0002",
          epssPercentage: 0.5,
          severity: "low",
        }),
      ),
      {
        subject: { type: "dependabot_alert", key: "no42-org/twiki#9" },
        payload: { number: 9, repo: "no42-org/twiki", cveId: 42 },
      },
    ]);
    seed("graphql-update-status", [
      {
        subject: { type: "dependabot_update_status", key: "no42-org/twiki#9" },
        payload: {
          repo: "no42-org/twiki",
          alertNumber: 9,
          update: { pullRequestNumber: 70, error: null },
        },
      },
    ]);
    seed("graphql-update-prs", [
      {
        subject: { type: "dependency_update_pr", key: "PR_70" },
        payload: {
          repo: "no42-org/twiki",
          number: 70,
          title: "Bump x from 1.0.0 to 1.0.1",
          author: "dependabot",
          htmlUrl: "https://github.com/no42-org/twiki/pull/70",
          createdAt: daysAgo(1),
          packageName: "x",
          bump: "patch",
        },
      },
    ]);

    const attention = repoAttention(store, REPO, NOW, DEPS);

    expect(attention.items.map((i) => i.kind)).toEqual(["update_pr", "alert"]);
    expect(attention.tier).toBe("now");
    expect(attention.reason).toMatch(/^alert #2 left-pad: /);
  });

  it("raises a quiet repository to soon on a review older than the budget", () => {
    seed("graphql-issues", [issue("I_1")]);
    seed("graphql-review-requests", [
      normaliseReviewRequest(
        makeReviewRequest({
          repo: { owner: "no42-org", name: "twiki" },
          number: 12,
          createdAt: daysAgo(4),
        }),
      ),
    ]);

    const attention = repoAttention(store, REPO, NOW, DEPS);

    expect(attention.tier).toBe("soon");
    expect(attention.reason).toBe(
      "pull request #12 open 4d, past the 3d review budget",
    );
    // The review gave the tier, so no item is the naming item.
    expect(attention.first).toBeNull();
    expect(attention.overdueReview).toEqual({ number: 12, days: 4 });
    expect(attention.openReviews).toBe(1);
  });

  it("names the older of two overdue reviews", () => {
    seed("graphql-review-requests", [
      normaliseReviewRequest(
        makeReviewRequest({
          repo: { owner: "no42-org", name: "twiki" },
          number: 5,
          createdAt: daysAgo(5),
        }),
      ),
      normaliseReviewRequest(
        makeReviewRequest({
          repo: { owner: "no42-org", name: "twiki" },
          number: 8,
          createdAt: daysAgo(8),
        }),
      ),
    ]);

    expect(repoAttention(store, REPO, NOW, DEPS).reason).toBe(
      "pull request #8 open 8d, past the 3d review budget",
    );
  });

  it("does not count a review at exactly the budget as overdue", () => {
    seed("graphql-review-requests", [
      normaliseReviewRequest(
        makeReviewRequest({
          repo: { owner: "no42-org", name: "twiki" },
          number: 12,
          createdAt: daysAgo(3),
        }),
      ),
    ]);

    expect(repoAttention(store, REPO, NOW, DEPS).tier).toBe("quiet");
  });

  it("raises nothing on a review whose date it cannot read", () => {
    // A date that does not parse supports no claim about waiting time; and
    // a row with no date at all is unreadable, so it is not a review here.
    seed("graphql-review-requests", [
      normaliseReviewRequest(
        makeReviewRequest({
          repo: { owner: "no42-org", name: "twiki" },
          number: 12,
          createdAt: "yesterday",
        }),
      ),
      {
        subject: { type: "review_request", key: "RR_null" },
        payload: {
          repo: "no42-org/twiki",
          number: 13,
          title: "No date",
          author: "someone",
          htmlUrl: "https://github.com/no42-org/twiki/pull/13",
          createdAt: null,
          requestedReviewers: ["indigo423"],
        },
      },
    ]);

    expect(repoAttention(store, REPO, NOW, DEPS)).toMatchObject({
      tier: "quiet",
      reason: "no open items",
    });
  });

  it("matches the repository whatever casing the rows carry", () => {
    // Subject keys are folded (AD-22); payload casing comes from GitHub.
    seedKev(["CVE-2021-44228"]);
    seed("rest-org-dependabot", [
      normalise(
        makeAlert({
          number: 4,
          cveId: "CVE-2021-44228",
          repo: { owner: "No42-Org", name: "TWiki" },
        }),
      ),
    ]);
    seed("graphql-review-requests", [
      {
        subject: { type: "review_request", key: "RR_case" },
        payload: {
          repo: "No42-Org/TWiki",
          number: 12,
          title: "Mixed case",
          author: "someone",
          htmlUrl: "https://github.com/no42-org/twiki/pull/12",
          createdAt: daysAgo(9),
          requestedReviewers: ["indigo423"],
        },
      },
    ]);

    const attention = repoAttention(store, REPO, NOW, DEPS);

    expect(attention).toMatchObject({ tier: "now", openAlerts: 1 });
    expect(attention.reason).toMatch(/^alert #4 left-pad: listed in CISA KEV/);
    // The review is matched too: with the alert gone it would be what lifts
    // the repository, so budget it against the same folded slug.
    expect(
      repoAttention(store, REPO, NOW, { ...DEPS, reviewBudgetDays: 1 }).tier,
    ).toBe("now");
  });

  it("leaves a review inside the budget alone", () => {
    seed("graphql-review-requests", [
      normaliseReviewRequest(
        makeReviewRequest({
          repo: { owner: "no42-org", name: "twiki" },
          number: 12,
          createdAt: daysAgo(2),
        }),
      ),
    ]);

    expect(repoAttention(store, REPO, NOW, DEPS).tier).toBe("quiet");
  });

  it("lets an item that already reaches the tier give the reason", () => {
    // An overdue review raises to soon; an alert already at soon is the
    // first thing in chain order that attains it, so it is named.
    seedKev(["CVE-0000-0000"]);
    seed("rest-org-dependabot", [
      normalise(
        makeAlert({
          number: 3,
          cveId: "CVE-2026-0003",
          epssPercentage: 0.02,
          severity: "high",
        }),
      ),
    ]);
    seed("graphql-review-requests", [
      normaliseReviewRequest(
        makeReviewRequest({
          repo: { owner: "no42-org", name: "twiki" },
          number: 12,
          createdAt: daysAgo(9),
        }),
      ),
    ]);

    const attention = repoAttention(store, REPO, NOW, DEPS);

    expect(attention.tier).toBe("soon");
    expect(attention.reason).toMatch(/^alert #3 left-pad: /);
    expect(attention.first?.number).toBe(3);
    // The review is still reported, even though it did not give the tier.
    expect(attention.overdueReview).toEqual({ number: 12, days: 9 });
  });

  it("ignores another repository's items and reviews", () => {
    seedKev(["CVE-2021-44228"]);
    seed("rest-org-dependabot", [
      normalise(
        makeAlert({
          number: 9,
          cveId: "CVE-2021-44228",
          repo: { owner: "no42-org", name: "other" },
        }),
      ),
    ]);
    seed("graphql-issues", [issue("I_other", "no42-org/other")]);
    seed("graphql-review-requests", [
      normaliseReviewRequest(
        makeReviewRequest({
          repo: { owner: "no42-org", name: "other" },
          createdAt: daysAgo(9),
        }),
      ),
    ]);

    expect(repoAttention(store, REPO, NOW, DEPS)).toEqual({
      tier: "quiet",
      reason: "no open items",
      first: null,
      overdueReview: null,
      openReviews: 0,
      openAlerts: 0,
      worstSeverity: null,
      items: [],
    });
  });

  it("counts open alerts and their worst severity from the same items", () => {
    seedKev(["CVE-0000-0000"]);
    seed("rest-org-dependabot", [
      normalise(makeAlert({ number: 1, severity: "high" })),
      normalise(makeAlert({ number: 2, severity: "critical" })),
    ]);
    seed("graphql-issues", [issue("I_1")]);

    const attention = repoAttention(store, REPO, NOW, DEPS);

    expect(attention.openAlerts).toBe(2);
    expect(attention.worstSeverity).toBe("critical");
    expect(attention.items).toHaveLength(3);
  });
});

describe("attentionByRepo (AD-32)", () => {
  let dir: string;
  let store: SqliteStore;

  const OTHER = { owner: "no42-org", name: "other" };
  const UNWATCHED = { owner: "no42-org", name: "delisted" };

  const seed = (
    lane: string,
    observations: { subject: unknown; payload: unknown }[],
  ) => {
    const at = "2026-08-20T11:55:00.000Z";
    const r = store.beginRun({
      lane,
      installation: "no42-org",
      scope: "full",
      startedAt: at,
    });
    store.recordObservations(r, at, observations as never[]);
    store.finishRun(r, "ok", at);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "attention-batch-"));
    store = SqliteStore.openForWrite(join(dir, "b.db"));
    seed("rest-org-dependabot", [
      normalise(makeAlert({ number: 1, repo: REPO, epssPercentage: 0.5 })),
      normalise(makeAlert({ number: 2, repo: OTHER, epssPercentage: 0.02 })),
      normalise(makeAlert({ number: 3, repo: UNWATCHED, epssPercentage: 0.5 })),
    ]);
    seed("graphql-review-requests", [
      normaliseReviewRequest(
        makeReviewRequest({ repo: OTHER, number: 8, createdAt: daysAgo(1) }),
      ),
      normaliseReviewRequest(
        makeReviewRequest({
          repo: UNWATCHED,
          number: 9,
          createdAt: daysAgo(9),
        }),
      ),
    ]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("builds the queue once and reads the review rows once for every repository", () => {
    // The whole reason the batch form exists: the overview and the notifier
    // iterate every repository, and a queue build per repository was the
    // deferred item from Story 1.3.
    const reads = new Map<string, number>();
    const counted = new Proxy(store, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== "currentByType") return value;
        return (type: string) => {
          reads.set(type, (reads.get(type) ?? 0) + 1);
          return target.currentByType(type as never);
        };
      },
    });

    attentionByRepo(counted, [REPO, OTHER, UNWATCHED, REPO], NOW, DEPS);

    expect(reads.get("dependabot_alert")).toBe(1);
    expect(reads.get("review_request")).toBe(1);
  });

  it("groups the one queue by folded slug and reports the same verdict as repoAttention", () => {
    const { byRepo, queue } = attentionByRepo(
      store,
      [REPO, { owner: "No42-Org", name: "Other" }],
      NOW,
      DEPS,
    );

    expect([...byRepo.keys()]).toEqual(["no42-org/twiki", "no42-org/other"]);
    expect(byRepo.get("no42-org/twiki")).toEqual(
      repoAttention(store, REPO, NOW, DEPS),
    );
    expect(byRepo.get("no42-org/other")).toEqual(
      repoAttention(store, OTHER, NOW, DEPS),
    );
    expect(byRepo.get("no42-org/twiki")).toMatchObject({
      tier: "now",
      first: { number: 1 },
      openReviews: 0,
    });
    expect(byRepo.get("no42-org/other")).toMatchObject({
      tier: "soon",
      first: { number: 2 },
      overdueReview: null,
      openReviews: 1,
    });
    // The queue itself is the whole estate; grouping is what scopes it.
    // Alerts 1 and 3 tie on every term, so the key breaks the tie.
    expect(queue.items.map((i) => i.number)).toEqual([3, 1, 2]);
  });

  it("gives an unwatched repository no group, so its items and reviews count nowhere", () => {
    const { byRepo } = attentionByRepo(store, [REPO], NOW, DEPS);

    expect([...byRepo.keys()]).toEqual(["no42-org/twiki"]);
    expect(
      [...byRepo.values()].flatMap((a) => a.items.map((i) => i.repo)),
    ).toEqual(["no42-org/twiki"]);
  });

  it("drops the alert items of a repository the caller may not count", () => {
    // Coverage says nobody may count REPO's alerts (AD-28): they give no
    // tier, no reason and no count. OTHER is untouched.
    const { byRepo } = attentionByRepo(
      store,
      [REPO, OTHER],
      NOW,
      DEPS,
      // Named by feature, so this reads as evidence about Dependabot rather
      // than as the first of three sets nobody can tell apart.
      { dependabot: new Set(["no42-org/twiki"]) },
    );

    expect(byRepo.get("no42-org/twiki")).toMatchObject({
      tier: "quiet",
      reason: "no open items",
      first: null,
      openAlerts: 0,
      items: [],
    });
    expect(byRepo.get("no42-org/other")).toMatchObject({
      tier: "soon",
      openAlerts: 1,
    });
    expect(
      repoAttention(store, REPO, NOW, DEPS, {
        dependabot: new Set(["no42-org/twiki"]),
      }).tier,
    ).toBe("quiet");
  });

  it("withdraws only the feature it was given evidence about", () => {
    // The suppression is keyed BY FEATURE, and this is what that buys. It
    // used to be three trailing `ReadonlySet<string>` parameters, which the
    // compiler cannot tell apart: transposing two of them at either
    // production call site compiled clean and withdrew the wrong feature's
    // rows, on a page whose whole job is to say what it is not counting.
    //
    // Naming one feature and finding the other's item untouched is the
    // assertion; that this call does not even typecheck against the old
    // signature is the guarantee.
    const { byRepo } = attentionByRepo(store, [REPO], NOW, DEPS, {
      secret_scanning: new Set(["no42-org/twiki"]),
    });

    // The Dependabot alert is still counted: evidence about secret scanning
    // says nothing about it.
    expect(byRepo.get("no42-org/twiki")).toMatchObject({
      tier: "now",
      openAlerts: 1,
    });
  });

  it("seeds a quiet verdict for a watched repository with no rows at all", () => {
    const { byRepo } = attentionByRepo(
      store,
      [{ owner: "no42-org", name: "empty" }],
      NOW,
      DEPS,
    );

    expect(byRepo.get("no42-org/empty")).toEqual({
      tier: "quiet",
      reason: "no open items",
      first: null,
      overdueReview: null,
      openReviews: 0,
      openAlerts: 0,
      worstSeverity: null,
      items: [],
    });
  });
});
