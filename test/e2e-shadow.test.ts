/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { expect, it } from "vitest";
import { buildConfig } from "../src/core/config.js";
import type { RawPullRequest } from "../src/github/port.js";
import { NullAudit } from "../src/twiki/audit.js";
import { runOnce } from "../src/twiki/run.js";
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
    defaultSha: "alpha-sha",
  };
  // beta has no open PRs and a green main, so there is nothing to merge and
  // nothing to report.
  const beta: FakeRepoData = {
    rawPrs: [],
    prChecks: {},
    mainChecks: "green",
    latestTag: "v0.4.7",
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

  // alpha would merge #1; beta has nothing to do.
  expect(res.repos.find((r) => r.repo === A)?.prs[0]?.status).toBe(
    "would-merge",
  );
  expect(res.repos.find((r) => r.repo === B)?.prs).toEqual([]);

  const digest = notifier.messages[0] ?? "";
  expect(digest).toContain("SHADOW");
  expect(digest).toContain("would merge #1");
  expect(digest).not.toMatch(/releas/i);
});

it("suppresses the digest on a purely routine tick", async () => {
  // No PRs and green main: nothing merged, held or remediated, so no message
  // should be sent.
  const quiet: FakeRepoData = {
    rawPrs: [],
    prChecks: {},
    mainChecks: "green",
    latestTag: "v1.0.0",
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

  expect(res.repos[0]?.prs).toEqual([]);
  expect(notifier.messages).toEqual([]);
});
