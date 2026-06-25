/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { expect, it } from "vitest";
import { NullAudit } from "../src/audit.js";
import { buildConfig } from "../src/config.js";
import type { RawPullRequest } from "../src/github/port.js";
import { runOnce } from "../src/run.js";
import {
  CapturingNotifier,
  FakeGitHub,
  type FakeRepoData,
  mergeEverythingAdvisor,
} from "./fakes.js";

// End-to-end through runOnce in shadow mode against fixture GitHub state.
// Shadow must perform NO writes while still producing a faithful would-do digest.

const A = "no42-org/alpha";
const B = "no42-org/beta";

function pr(number: number, headSha: string, to = "1.0.1"): RawPullRequest {
  return {
    number,
    headSha,
    title: `Bump pkg from 1.0.0 to ${to}`,
    branch: `dependabot/pkg-${number}`,
    body: "Routine dependency update.",
    isSecurity: false,
    dependency: { name: "pkg", from: "1.0.0", to },
  };
}

it("shadow run reports would-do actions and writes nothing", async () => {
  const alpha: FakeRepoData = {
    rawPrs: [pr(1, "a1")],
    prChecks: { a1: "green" },
    mainChecks: "green",
    latestTag: "v2.0.0",
    unreleased: 0,
    hasWorkflow: true,
    defaultSha: "alpha-sha",
  };
  // beta is settled (no open mergeable PRs, green main, unreleased changes).
  const beta: FakeRepoData = {
    rawPrs: [],
    prChecks: {},
    mainChecks: "green",
    latestTag: "v0.4.7",
    unreleased: 2,
    hasWorkflow: true,
    defaultSha: "beta-sha",
  };
  const github = new FakeGitHub(
    new Map([
      [A, alpha],
      [B, beta],
    ]),
  );
  const notifier = new CapturingNotifier();

  const res = await runOnce(
    buildConfig({ mode: "shadow", repos: [{ repo: A }, { repo: B }] }),
    {
      github,
      advisor: mergeEverythingAdvisor,
      notifier,
      audit: new NullAudit(),
      now: () => "2026-05-31T00:00:00Z",
    },
  );

  // No writes in shadow mode.
  expect(github.merged).toEqual([]);
  expect(github.tagged).toEqual([]);

  // alpha would merge #1; beta would release the next patch.
  expect(res.repos.find((r) => r.repo === A)?.prs[0]?.status).toBe(
    "would-merge",
  );
  expect(res.repos.find((r) => r.repo === B)?.release).toMatchObject({
    status: "would-release",
    version: "v0.4.8",
  });

  const digest = notifier.messages[0] ?? "";
  expect(digest).toContain("SHADOW");
  expect(digest).toContain("would merge #1");
  expect(digest).toContain("would release v0.4.8");
});

it("suppresses the digest on a purely routine tick", async () => {
  // No PRs, green main, nothing unreleased → every repo is in the routine
  // `waiting` state with no actionable news, so no message should be sent.
  const quiet: FakeRepoData = {
    rawPrs: [],
    prChecks: {},
    mainChecks: "green",
    latestTag: "v1.0.0",
    unreleased: 0,
    hasWorkflow: true,
    defaultSha: "quiet-sha",
  };
  const github = new FakeGitHub(new Map([[A, quiet]]));
  const notifier = new CapturingNotifier();

  const res = await runOnce(
    buildConfig({ mode: "shadow", repos: [{ repo: A }] }),
    {
      github,
      advisor: mergeEverythingAdvisor,
      notifier,
      audit: new NullAudit(),
      now: () => "2026-05-31T00:00:00Z",
    },
  );

  expect(res.repos[0]?.release.status).toBe("waiting");
  expect(notifier.messages).toEqual([]);
});
