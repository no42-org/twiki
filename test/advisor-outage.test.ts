/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildConfig } from "../src/core/config.js";
import { JsonlAudit, NullAudit } from "../src/twiki/audit.js";
import { type Notifier, WebhookNotifier } from "../src/twiki/notify.js";
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

describe("the outage report says only what it can support", () => {
  const outage = (reason: string) => ({
    mode: "shadow" as const,
    repos: [],
    advisorFailed: reason,
  });

  it("does not claim the advisor was unreachable", () => {
    // safePlan catches EVERY throw from the advisor, and two of the causes are
    // the opposite of unreachable: a missing plan tool call, and a schema
    // validation failure. Both mean it answered and the answer was unusable -
    // and a validation failure is also a plausible prompt-injection symptom.
    // Telling an operator it was unreachable sends them to check credit and
    // network, which are fine, and away from the model output.
    const digest = buildDigest(
      outage("Advisor did not return a plan tool call"),
    );

    expect(digest).not.toMatch(/could not be reached|unreachable/i);
    expect(digest).toMatch(/did not produce a plan/i);
  });

  it("does not discount the decisions the advisor never made", () => {
    // NOT everything below the banner is advisor-derived. evaluateRelease
    // gates on isSettled and never reads the plan; a major bump is flagged
    // before the plan is consulted. An earlier banner told the reader to
    // discount everything, which would have discounted a real tag push and an
    // URGENT security flag.
    const digest = buildDigest({
      mode: "enforce",
      advisorFailed: "credit balance is too low",
      repos: [
        {
          repo: "no42-org/demo",
          mainRed: false,
          prs: [
            {
              number: 7,
              title: "bump left-pad from 1 to 2",
              security: true,
              status: "flagged-major",
              detail: "URGENT security major",
            },
          ],
          release: { status: "released", version: "v1.2.4", detail: "cut" },
        },
      ],
    });

    expect(digest).toMatch(/releases and flagged majors.*still stand/i);
    expect(digest).not.toMatch(/nothing below is a merge decision/i);
    // Both are still rendered, not swallowed by the banner.
    expect(digest).toContain("released v1.2.4");
    expect(digest).toContain("URGENT security major");
  });

  it("bounds the reason so one failure cannot cost the whole digest", () => {
    // safePlan's try covers PlanSchema.parse, and a ZodError message is a
    // multi-kilobyte dump. Raw, that pushes the digest past Discord's 2000
    // character limit, the webhook answers 400, deliver throws, and runOnce
    // catches it into "notify failed" - losing every merge and release that
    // DID happen this tick.
    const digest = buildDigest(outage("z".repeat(5000)));

    expect(digest.length).toBeLessThan(2000);
    expect(digest).toMatch(/truncated/i);
  });

  it("keeps a short reason intact", () => {
    const digest = buildDigest(outage("credit balance is too low"));
    expect(digest).toContain("credit balance is too low");
    expect(digest).not.toMatch(/truncated/i);
  });
});

describe("the outage reaches the audit, not just the digest", () => {
  it("records the reason on the audit line", async () => {
    // The commit claimed "the digest and the audit both see it" while
    // JsonlAudit serialised only { at, mode, repos }. Six hours of outage
    // ticks were byte-identical to ticks where a healthy advisor held
    // everything on purpose - the exact confusion the banner exists to
    // prevent, reproduced in the file an operator reads afterwards.
    const dir = mkdtempSync(join(tmpdir(), "advisor-audit-"));
    const path = join(dir, "audit.jsonl");

    new JsonlAudit(path).record(
      { mode: "shadow", repos: [], advisorFailed: "credit balance is too low" },
      "2026-08-22T22:38:31.000Z",
    );

    const line = JSON.parse(readFileSync(path, "utf8").trim());
    expect(line.advisorFailed).toBe("credit balance is too low");
    rmSync(dir, { recursive: true, force: true });
  });

  it("says nothing about the advisor on a healthy run", () => {
    const dir = mkdtempSync(join(tmpdir(), "advisor-audit-"));
    const path = join(dir, "audit.jsonl");

    new JsonlAudit(path).record(
      { mode: "shadow", repos: [] },
      "2026-08-22T22:38:31.000Z",
    );

    const line = JSON.parse(readFileSync(path, "utf8").trim());
    expect("advisorFailed" in line).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("a persistent outage is announced once, and its recovery once", () => {
  it("does not re-post an identical digest every tick", async () => {
    // Deliberate, and worth pinning so it is understood rather than
    // rediscovered. DedupingNotifier hashes the digest and skips an unchanged
    // one, which is how a persistently red main behaves too. The harm is
    // small: an advisor outage only matters when there are pull requests to
    // decide on, and then the digest carries them and varies as they change.
    // An estate quiet enough for the digest to be byte-identical is one where
    // the advisor had nothing to decide anyway.
    const dir = mkdtempSync(join(tmpdir(), "advisor-dedupe-"));
    const dedupe = join(dir, ".twiki-last-digest.slack");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("ok", { status: 200 })),
    );

    const digest = buildDigest({
      mode: "shadow",
      repos: [],
      advisorFailed: "credit balance is too low",
    });
    await new WebhookNotifier(
      "https://example.invalid/h",
      "slack",
      dedupe,
    ).send(digest);
    await new WebhookNotifier(
      "https://example.invalid/h",
      "slack",
      dedupe,
    ).send(digest);
    expect(fetch).toHaveBeenCalledTimes(1);

    // ...and recovery IS announced, because the digest changes.
    const recovered = buildDigest({ mode: "shadow", repos: [] });
    await new WebhookNotifier(
      "https://example.invalid/h",
      "slack",
      dedupe,
    ).send(recovered);
    expect(fetch).toHaveBeenCalledTimes(2);

    vi.unstubAllGlobals();
    rmSync(dir, { recursive: true, force: true });
  });
});
