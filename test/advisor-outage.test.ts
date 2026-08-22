/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it, vi } from "vitest";
import { buildConfig } from "../src/core/config.js";
import { NullAudit } from "../src/twiki/audit.js";
import type { Notifier } from "../src/twiki/notify.js";
import { buildDigest, hasActionableActivity } from "../src/twiki/report.js";
import { runOnce } from "../src/twiki/run.js";
import { FakeGitHub, type FakeRepoData } from "./fakes.js";

// What the digest says when the advisor is down.
//
// Found on the first real deployment, 2026-08-22. The Anthropic key had no
// credits, so every plan call failed and `safePlan` degraded exactly as
// designed: hold everything, log it. But the only thing that reached the
// digest was the per-pull-request wording:
//
//   held #156 - chore(deps): Bump eslint-config-next... (no advisor decision - held)
//
// That reads as twiki being cautious. The explanation lived in stderr, and
// the digest is what goes to chat, so an operator watching the channel sees a
// healthy-looking run that merges nothing - indefinitely, because a missing
// key does not fix itself.
//
// Same shape as the partial-write dishonesty fixed in #60: the report not
// saying WHY. Sharper here, because a total outage renders as routine.

const SLUG = "no42-org/demo";

function deps(notifier: Notifier, advisorErr?: Error) {
  const data: FakeRepoData = {
    rawPrs: [
      {
        number: 156,
        title: "chore(deps): Bump eslint-config-next from 16.3.0 to 16.3.1",
        branch: "dependabot/npm_and_yarn/eslint-config-next-16.3.1",
        headSha: "sha-1",
        body: "",
        isSecurity: false,
        dependency: {
          name: "eslint-config-next",
          from: "16.3.0",
          to: "16.3.1",
        },
      },
    ],
    prChecks: { "sha-1": "green" },
    mainChecks: "green",
    latestTag: "v1.2.3",
    unreleased: 1,
    hasWorkflow: true,
    defaultSha: "main-sha",
  };
  return {
    github: new FakeGitHub(new Map([[SLUG, data]])),
    advisor: {
      plan: advisorErr
        ? vi.fn(async () => {
            throw advisorErr;
          })
        : vi.fn(async () => ({ repos: [] })),
    },
    notifier,
    audit: new NullAudit(),
    now: () => "2026-08-22T22:38:31.000Z",
    log: () => {},
  };
}

const config = () => buildConfig({ mode: "shadow", repos: [{ repo: SLUG }] });

function capturing() {
  const sent: string[] = [];
  return {
    sent,
    notifier: { send: async (t: string) => void sent.push(t) } as Notifier,
  };
}

describe("a failed advisor is reported, not just logged", () => {
  it("says so in the digest", async () => {
    const cap = capturing();
    const err = new Error(
      '400 {"type":"error","error":{"message":"Your credit balance is too low"}}',
    );

    const result = await runOnce(config(), deps(cap.notifier, err));

    expect(result.advisorFailed).toBeDefined();
    const digest = cap.sent[0] ?? "";
    expect(digest).toMatch(/advisor/i);
    // The reason, not merely the fact: "the advisor is down" and "the advisor
    // is down because the account has no credit" call for different actions.
    expect(digest).toMatch(/credit balance/i);
  });

  it("does not let the outage read as routine caution", async () => {
    const cap = capturing();

    await runOnce(config(), deps(cap.notifier, new Error("upstream 503")));

    const digest = cap.sent[0] ?? "";
    // Everything held, and the digest must not present that as a decision.
    expect(digest).toContain("held");
    expect(digest).toMatch(/held .*because|advisor/i);
  });

  it("says nothing about the advisor when it worked", async () => {
    const cap = capturing();

    const result = await runOnce(config(), deps(cap.notifier));

    expect(result.advisorFailed).toBeUndefined();
    // Asserted on the banner, not the word: "no advisor decision - held" is
    // the legitimate per-pull-request wording when a WORKING advisor simply
    // decided nothing, and distinguishing those two is the whole point.
    expect(cap.sent[0] ?? "").not.toMatch(/could not be reached/i);
  });

  it("makes a run actionable even when there is nothing else to say", () => {
    // A quiet estate plus a broken advisor is still news: every decision it
    // would have made is silently not being made.
    expect(
      hasActionableActivity({
        mode: "shadow",
        repos: [],
        advisorFailed: "credit balance is too low",
      }),
    ).toBe(true);
    expect(hasActionableActivity({ mode: "shadow", repos: [] })).toBe(false);
  });

  it("renders the outage even for a repository with nothing else to report", () => {
    const digest = buildDigest({
      mode: "shadow",
      repos: [],
      advisorFailed: "credit balance is too low",
    });

    expect(digest).toMatch(/advisor/i);
    expect(digest).not.toMatch(/all repos quiet/i);
  });
});
