/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGitHubFromEnv } from "../src/github/octokit-adapter.js";
import { gatherFacts } from "../src/twiki/facts.js";

// The shape of the requests one tick issues.
//
// AD-24's first rule: "Requests are issued serially per installation, as
// GitHub advises, never fanned out concurrently within a bucket." Measured
// 2026-08-22 against the live `no42-org/packyard` shape (15 open pull
// requests, all from Dependabot), twiki's read path did the opposite - 126
// requests at peak concurrency 30 on one installation token, 54 of them the
// adapter re-asking which installation a repository it had just asked about
// belongs to.
//
// Absolute volume was never the problem: 126 requests per repository per hour
// is nothing. The burst shape was, and its width was set by the open-pull-
// request count, which nobody controls.
//
// These pin the shape rather than the timing, so they say something stable on
// a fast machine and a slow one.

const KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const ENV = { TWIKI_GITHUB_APP_ID: "1", TWIKI_GITHUB_APP_PRIVATE_KEY: KEY };

/** The live count on no42-org/packyard, 2026-08-22. */
const OPEN_PRS = 15;

/** A quiet fortnight's worth, to prove the shape does not track the count. */
const MANY_PRS = 40;

const prsOfWidth = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    number: 100 + i,
    title: `bump dep-${i} from 1.0.0 to 1.0.1`,
    head: { ref: `dependabot/npm_and_yarn/dep-${i}`, sha: `sha${i}` },
    user: { login: "dependabot[bot]" },
    body: "",
    labels: [],
    draft: false,
  }));

const PRS = prsOfWidth(OPEN_PRS);

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A transport that records the shape of what was asked: every URL, and the
 * highest number of requests in flight at once. The delay is what makes
 * overlap observable at all - with an instantly-resolving stub, concurrent
 * and serial code produce the same peak of 1.
 */
function shapeRecorder(delayMs = 5, prs: unknown[] = PRS) {
  const urls: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, delayMs));
    inFlight--;
    if (u.includes("/access_tokens")) {
      return json(
        {
          token: "ghs_test",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
          permissions: {},
          repository_selection: "all",
        },
        201,
      );
    }
    if (u.includes("/installation")) return json({ id: 1 });
    if (u.includes("/pulls?") || u.endsWith("/pulls")) return json(prs);
    if (u.includes("/check-runs") || u.includes("/status")) {
      // One body serves both endpoints, so it must be plausible as
      // either. It used to say `state: "failure"` with `total_count: 0`,
      // which GitHub cannot return - a failure state requires at least one
      // failing status - and the old aggregation read `.state`
      // unconditionally, so the red here came from an impossible payload.
      // A failed check run is how an Actions repository is actually red,
      // and the status half is correctly ignored for carrying nothing.
      return json({
        state: "failure",
        total_count: 0,
        statuses: [],
        check_runs: [{ status: "completed", conclusion: "failure" }],
      });
    }
    if (u.includes("/actions/runs")) return json({ workflow_runs: [] });
    if (u.includes("/compare/")) return json({ behind_by: 0 });
    if (u.includes("/releases/latest")) return json({}, 404);
    if (u.includes("/tags") || u.includes("/commits")) return json([]);
    if (u.includes("/contents/")) return json([]);
    if (u.includes("/branches/")) return json({ commit: { sha: "main-sha" } });
    if (/\/repos\/[^/]+\/[^/]+$/.test(u))
      return json({ default_branch: "main" });
    return json({}, 404);
  }) as unknown as typeof fetch;
  return {
    fetchImpl,
    urls,
    peak: () => peak,
    installationLookups: () =>
      urls.filter((u) => /\/repos\/[^/]+\/[^/]+\/installation$/.test(u)).length,
  };
}

const REPO = { owner: "no42-org", name: "packyard" };

describe("one tick's request shape", () => {
  it("issues requests serially, never fanned out within one installation", async () => {
    const rec = shapeRecorder();
    const gh = createGitHubFromEnv(() => true, ENV, rec.fetchImpl);

    await gatherFacts(gh, REPO);

    // AD-24's first clause, as an assertion rather than a convention.
    // Measured before this change: 30.
    expect(rec.peak()).toBe(1);
  });

  it("does not widen as a repository accumulates pull requests", async () => {
    // The property that matters more than any single number: the old fan-out
    // was `Promise.all(rawPrs.map(...))`, so its width was whatever had piled
    // up over a quiet fortnight.
    //
    // An earlier version of this test re-ran the SAME 15-pull-request fixture
    // as the one above and asserted `PRS.length === OPEN_PRS`, a constant
    // against the constant it came from. It could not fail, and it caught
    // nothing the previous test did not already catch. The point is that the
    // width is independent of the count, so the count has to vary.
    const narrow = shapeRecorder(5, prsOfWidth(1));
    await gatherFacts(
      createGitHubFromEnv(() => true, ENV, narrow.fetchImpl),
      REPO,
    );

    const wide = shapeRecorder(5, prsOfWidth(MANY_PRS));
    await gatherFacts(
      createGitHubFromEnv(() => true, ENV, wide.fetchImpl),
      REPO,
    );

    // Forty times the work, the same shape. A fan-out bounded at any width
    // above one fails here even though it would pass a single-fixture check.
    expect(wide.peak()).toBe(narrow.peak());
    expect(wide.peak()).toBe(1);
    // ...and the request count really did scale, so the fixture is doing work.
    expect(wide.urls.length).toBeGreaterThan(narrow.urls.length * 5);
  });

  it("resolves the installation once per repository, not once per call", async () => {
    // 54 of the 126 measured requests were this: the resolver called
    // getRepoInstallation ahead of the client-cache lookup, so the cache could
    // never be consulted first. 43% of the traffic, for an answer that does
    // not change within a tick.
    const rec = shapeRecorder();
    const gh = createGitHubFromEnv(() => true, ENV, rec.fetchImpl);

    await gatherFacts(gh, REPO);

    expect(rec.installationLookups()).toBe(1);
  });

  it("mints one installation token for one installation", async () => {
    const rec = shapeRecorder();
    const gh = createGitHubFromEnv(() => true, ENV, rec.fetchImpl);

    await gatherFacts(gh, REPO);

    expect(rec.urls.filter((u) => u.includes("/access_tokens"))).toHaveLength(
      1,
    );
  });

  it("gathers the same facts it always did", async () => {
    // The whole change is meant to be invisible in what a tick concludes.
    const rec = shapeRecorder();
    const gh = createGitHubFromEnv(() => true, ENV, rec.fetchImpl);

    const facts = await gatherFacts(gh, REPO);

    expect(facts.repo).toEqual(REPO);
    expect(facts.prs.map((p) => p.number)).toEqual(PRS.map((p) => p.number));
    expect(facts.mainChecks).toBe("red");
    expect(facts.latestTag).toBeNull();
    expect(facts.prs.every((p) => p.isDependabot)).toBe(true);
  });
});
