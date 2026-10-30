/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/core/config.js";
import {
  collectReviewRequests,
  LANE,
  REVIEWS_INSTALLATION,
} from "../src/tricorder/collect/review-requests.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { FakeGitHubReadPort, makeReviewRequest } from "./fakes.js";

describe("the review-request lane (CAP-5)", () => {
  let dir: string;
  let store: SqliteStore;
  let github: FakeGitHubReadPort;
  let logs: string[];
  let clock: number;

  const deps = (reviewers: readonly string[] = ["indigo423"]) => ({
    github,
    store,
    reviewers,
    viaInstallation: "no42-org",
    now: () => new Date(Date.UTC(2026, 7, 21, 12, clock++)).toISOString(),
    log: (m: string) => logs.push(m),
  });

  const current = () =>
    store.currentByType("review_request").filter((c) => c.state === "present");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "reviews-"));
    store = SqliteStore.openForWrite(join(dir, "r.db"));
    github = new FakeGitHubReadPort(new Map());
    logs = [];
    clock = 0;
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores a request keyed by node id, whoever owns the repository", async () => {
    // The point of the lane: 38 of 40 measured requests were in
    // repositories nobody watches, and scoping to the allowlist would have
    // made the capability almost empty.
    github.reviewRequests = [
      makeReviewRequest({ number: 8803 }),
      makeReviewRequest({
        number: 41,
        nodeId: "RR_41",
        repo: { owner: "no42-org", name: "packyard" },
      }),
    ];

    const r = await collectReviewRequests(deps());

    expect(r).toMatchObject({ outcome: "ok", requests: 2 });
    const payloads = current().map((c) => c.payload as { repo: string });
    expect(payloads.map((p) => p.repo).sort()).toEqual([
      "no42-org/packyard",
      "opennms/opennms",
    ]);
  });

  it("passes the configured reviewers to the search verbatim", async () => {
    // AD-19's rule again: an installation token has no user identity, so
    // the logins are configuration and nothing is assumed around them.
    await collectReviewRequests(deps(["indigo423", "someone-else"]));

    expect(github.reviewRequestQueries).toEqual([
      {
        viaInstallation: "no42-org",
        reviewers: ["indigo423", "someone-else"],
      },
    ]);
  });

  it("keeps the other reviewers, so waiting-on-you can be read honestly", async () => {
    github.reviewRequests = [
      makeReviewRequest({ requestedReviewers: ["indigo423", "a", "b"] }),
    ];

    await collectReviewRequests(deps());

    expect(current()[0]?.payload).toMatchObject({
      requestedReviewers: ["indigo423", "a", "b"],
    });
  });

  it("tombstones a request once the review is given or withdrawn", async () => {
    github.reviewRequests = [makeReviewRequest()];
    await collectReviewRequests(deps());
    expect(current()).toHaveLength(1);

    github.reviewRequests = [];
    await collectReviewRequests(deps());

    expect(current()).toHaveLength(0);
  });

  it("does not tombstone when the search hit GitHub's ceiling", async () => {
    github.reviewRequests = [makeReviewRequest()];
    await collectReviewRequests(deps());

    github.reviewRequests = [];
    github.reviewRequestTruncated = true;
    const r = await collectReviewRequests(deps());

    expect(r.outcome).toBe("partial");
    expect(current()).toHaveLength(1);
    expect(store.latestRuns(1)[0]?.detail).toContain("truncated");
  });

  it("does not tombstone when nodes were unreadable", async () => {
    github.reviewRequests = [makeReviewRequest()];
    await collectReviewRequests(deps());

    github.reviewRequests = [];
    github.reviewRequestUnreadable = 2;
    const r = await collectReviewRequests(deps());

    expect(r.outcome).toBe("partial");
    expect(current()).toHaveLength(1);
  });

  it("reports both causes when a sweep is degraded twice over", async () => {
    // Composed, not chosen. A sweep can hit the ceiling AND fail to read
    // nodes, and reporting only the first attributes the whole degradation
    // to one cause in the row an operator actually reads.
    github.reviewRequestTruncated = true;
    github.reviewRequestUnreadable = 3;

    await collectReviewRequests(deps());

    const detail = store.latestRuns(1)[0]?.detail ?? "";
    expect(detail).toContain("truncated");
    expect(detail).toContain("3 review-request nodes could not be read");
  });

  it("leaves the detail empty when nothing was degraded", async () => {
    github.reviewRequests = [makeReviewRequest()];
    await collectReviewRequests(deps());
    expect(store.latestRuns(1)[0]?.detail ?? null).toBeNull();
  });

  it("runs under its own pseudo-installation", async () => {
    // The search is global, so this lane sweeps nothing that is an
    // installation: running it per installation would repeat one call and
    // have the runs reconcile against each other.
    await collectReviewRequests(deps());
    expect(store.latestRuns(1)[0]).toMatchObject({
      lane: LANE,
      installation: REVIEWS_INSTALLATION,
    });
  });

  it("contains a search failure rather than throwing past the lane", async () => {
    github.listReviewRequests = async () => {
      throw new Error("GraphQL upstream 502");
    };
    const r = await collectReviewRequests(deps());
    expect(r.outcome).toBe("failed");
    expect(store.latestRuns(1)[0]?.outcome).toBe("failed");
    // The lane alone, as for KEV: reviews are collected globally and their
    // installation is a placeholder, not an org.
    expect(logs).toEqual([
      "graphql-review-requests: failed, GraphQL upstream 502",
    ]);
  });

  it("a throwing logger cannot fail the lane", async () => {
    github.reviewRequests = [makeReviewRequest()];
    const r = await collectReviewRequests({
      ...deps(),
      log: () => {
        throw new Error("EPIPE");
      },
    });
    expect(r.outcome).toBe("ok");
  });
});

describe("reviewers are configuration (AD-19)", () => {
  it("reads reviewers from repos.yaml and defaults to none", () => {
    const dir = mkdtempSync(join(tmpdir(), "revcfg-"));
    const withReviewers = join(dir, "with.yaml");
    writeFileSync(
      withReviewers,
      "repos:\n  - repo: no42-org/twiki\nreviewers:\n  - indigo423\n",
    );
    expect(loadConfig(withReviewers).reviewers).toEqual(["indigo423"]);

    // A value carrying search syntax would silently rewrite the query.
    const injected = join(dir, "injected.yaml");
    writeFileSync(
      injected,
      "repos:\n  - repo: no42-org/twiki\nreviewers:\n  - indigo423 org:evil\n",
    );
    expect(() => loadConfig(injected)).toThrow(/one login per entry/);

    // No default in source: unset means the lane does not run.
    const without = join(dir, "without.yaml");
    writeFileSync(without, "repos:\n  - repo: no42-org/twiki\n");
    expect(loadConfig(without).reviewers).toEqual([]);

    rmSync(dir, { recursive: true, force: true });
  });
});
