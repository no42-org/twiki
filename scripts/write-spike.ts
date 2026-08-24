/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { readFileSync, writeFileSync } from "node:fs";
import type { Config } from "../src/core/config.js";
import { buildConfig, remediationFromEnv } from "../src/core/config.js";
import { parseRepoSlug } from "../src/core/types.js";
import { createGitHubFromEnv } from "../src/github/octokit-adapter.js";
import type { Advisor, AdvisorRepoInput } from "../src/twiki/advisor.js";
import { NullAudit } from "../src/twiki/audit.js";
import { ConsoleNotifier } from "../src/twiki/notify.js";
import { type Plan, PlanSchema } from "../src/twiki/plan.js";
import { runOnce } from "../src/twiki/run.js";

// Exercise twiki's WRITE paths against real GitHub.
//
// `test/adapter-contract.test.ts` binds the fakes to recorded payloads for the
// READ side, and covers none of the four write methods. Every lane test runs
// against a fake written from the same reading of the API as the adapter, so a
// wrong merge method or a malformed ref would leave the suite green: the fake
// agrees with the bug. That exact gap already shipped a real defect once - 31
// unreadable alert payloads with 613 tests passing - and the write side has
// never been checked at all.
//
// This is NOT a test. It needs a live token and a scratch repository, it
// merges pull requests and pushes tags, and it must never run in CI.
//
// It also does not need Anthropic credits. The advisor and the executor are
// separable by design (the advisor holds no write tools; the executor
// re-validates every gate), so a stub advisor returning a hand-written plan
// exercises the real write calls while leaving the advisor's judgment - the
// half that DOES need credits - honestly untested.

const USAGE = `
usage: npx tsx scripts/write-spike.ts --repo <owner/name> [--plan <file>] [--record <dir>]

  --repo    the SCRATCH repository to act on. Required. There is no default.
  --plan    JSON plan to feed the executor. Defaults to a hold-everything plan,
            which issues no writes - use it to check the wiring first.
  --record  directory to write the observed requests and responses into.
  --direct  PASS A: call the write port directly, bypassing the executor and
            its preconditions. Comma-separated. One of:
            mergePR:<pr>  pushTag:<tag>@<sha>  rerunFailedJobs:<runId>
            requestDependabotRebase:<pr>
            (each needs its argument; "all" alone is not enough)

  Set SPIKE_I_MEAN_IT=yes to actually issue writes. Without it this prints what
  it would do and exits, which is the same shadow/enforce split twiki itself
  uses.
`;

interface Args {
  repo: string;
  plan?: string;
  record?: string;
  /** Pass A: call the write port directly, bypassing the executor (D7). */
  direct?: string;
}

/**
 * One direct write, and what came back.
 *
 * A rejection is a RESULT, not a reason to stop. If GitHub refuses a request
 * the adapter believed correct, that is the finding this whole exercise is
 * hunting - and stopping on the first one would hide the state of the other
 * three. Each write runs independently and records its own outcome.
 */
interface Outcome {
  write: string;
  ok: boolean;
  error?: string;
  requests: unknown[];
}

function parseArgs(argv: string[]): Args | null {
  const out: Partial<Args> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (!value) return null;
    if (flag === "--repo") out.repo = value;
    else if (flag === "--plan") out.plan = value;
    else if (flag === "--record") out.record = value;
    else if (flag === "--direct") out.direct = value;
    else return null;
  }
  return out.repo ? (out as Args) : null;
}

/**
 * The target is named on the command line and nowhere else.
 *
 * Deliberately NOT read from repos.yaml. This script merges pull requests and
 * pushes tags; a version of it that could be pointed at a real repository by a
 * stray environment variable would be a worse risk than the gap it closes. The
 * adapter's own allowlist guard still applies underneath - this refuses to be
 * the place that first weakens it.
 */
function guard(args: Args): void {
  if (process.env.CI) {
    console.error("refusing to run in CI: this issues real writes.");
    process.exit(1);
  }
  // parseRepoSlug THROWS on a bad slug rather than returning null, so an
  // `if (!ref)` check here was dead code and a malformed --repo produced a
  // stack trace instead of the one-line refusal.
  try {
    parseRepoSlug(args.repo);
  } catch {
    console.error(`--repo ${args.repo} is not owner/name.`);
    process.exit(1);
  }
  const configured = process.env.TWIKI_CONFIG ?? "repos.yaml";
  try {
    // Lowercased on both sides. GitHub resolves owner/name case-insensitively
    // and this comparison did not, so `--repo No42-Org/twiki` slipped past a
    // repos.yaml naming `no42-org/twiki` - and the script would then merge and
    // tag in a repository twiki actually manages, which is the exact outcome
    // this guard exists to prevent.
    const text = readFileSync(configured, "utf8").toLowerCase();
    if (text.includes(args.repo.toLowerCase())) {
      console.error(
        `refusing: ${args.repo} appears in ${configured}. Use a scratch ` +
          "repository that twiki does not manage, so a mistake here cannot " +
          "touch anything real.",
      );
      process.exit(1);
    }
  } catch {
    // No config present is fine - it only means there is nothing to collide
    // with. The --repo flag remains the only source of the target.
  }
}

/**
 * A transport that records what it sends, shared by both passes.
 *
 * ONE implementation on purpose. There were two, and when the credential leak
 * was found and fixed in pass A's copy, pass B's kept recording live
 * installation tokens - a review caught it, not the fix. Two recorders means
 * two chances to get the redaction wrong.
 *
 * The token exchange is never recorded: its response body IS a credential.
 * The redaction below is belt-and-braces for anything else token-shaped.
 */
function makeRecorder(sink: () => unknown[]): typeof fetch {
  const redact = (text: string | undefined): string | undefined =>
    text
      ?.replace(/ghs_[A-Za-z0-9]+/g, "ghs_REDACTED")
      .replace(/eyJ[A-Za-z0-9_-]{10,}/g, "JWT_REDACTED");

  return (async (input: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    const res = await fetch(input, init);
    if (method !== "GET" && !url.includes("/access_tokens")) {
      const body = await res
        .clone()
        .text()
        .catch(() => undefined);
      let requestBody: unknown;
      try {
        // Guarded: a non-JSON body must not turn an ACCEPTED write into a
        // reported REJECTION, which is the one signal this spike produces.
        requestBody = init?.body ? JSON.parse(String(init.body)) : undefined;
      } catch {
        requestBody = String(init?.body);
      }
      sink().push({
        method,
        url,
        requestBody,
        status: res.status,
        responseBody: redact(body)?.slice(0, 4000),
      });
      console.error(`[spike]   ${method} ${url} → ${res.status}`);
    }
    return res;
  }) as typeof fetch;
}

/** A plan the executor will act on, with no LLM involved. */
function stubAdvisor(plan: Plan): Advisor {
  return {
    async plan(input: AdvisorRepoInput[]): Promise<Plan> {
      console.error(
        `[spike] stub advisor: ${input.length} repo(s) in, ` +
          `${plan.repos.length} decision set(s) out (no API call)`,
      );
      // Validated by the same schema the real advisor's output is, so a schema
      // change breaks the stub rather than letting it drift.
      return PlanSchema.parse(plan);
    },
  };
}

function holdEverything(repo: string): Plan {
  return {
    repos: [
      {
        repo,
        prDecisions: [],
        release: { action: "wait", reason: "spike default: no writes" },
      },
    ],
  };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    console.error(USAGE);
    process.exit(1);
  }
  guard(args);

  const plan: Plan = args.plan
    ? PlanSchema.parse(JSON.parse(readFileSync(args.plan, "utf8")))
    : holdEverything(args.repo);

  const armed = process.env.SPIKE_I_MEAN_IT === "yes";

  // Say what is about to happen, before it happens. The plan is the whole
  // input, so printing it is a complete description of the intended writes.
  console.error(`\n[spike] target      ${args.repo}`);
  console.error(
    `[spike] mode        ${armed ? "ENFORCE (will write)" : "dry run"}`,
  );
  console.error(
    `[spike] plan        ${args.plan ?? "(default: hold everything)"}`,
  );
  if (args.direct) {
    console.error(`[spike] direct      ${args.direct}`);
    for (const step of args.direct.split(",")) {
      console.error(`[spike]   will call ${step.trim()}`);
    }
  }
  for (const r of plan.repos) {
    for (const d of r.prDecisions) {
      console.error(`[spike]   PR #${d.number}: ${d.action} — ${d.reason}`);
    }
    console.error(
      `[spike]   release: ${r.release.action} — ${r.release.reason}`,
    );
  }

  if (!armed) {
    console.error(
      "\n[spike] dry run. Set SPIKE_I_MEAN_IT=yes to issue these writes.\n",
    );
    return;
  }

  if (args.direct) {
    return runDirect(args);
  }
  return run(args, plan);
}

async function run(args: Args, plan: Plan): Promise<void> {
  const observed: unknown[] = [];
  const recordingFetch = makeRecorder(() => observed);

  const config: Config = buildConfig(
    { mode: "enforce", repos: [{ repo: args.repo }] },
    "enforce",
    remediationFromEnv(),
  );

  await runOnce(config, {
    github: createGitHubFromEnv(
      (repo) => `${repo.owner}/${repo.name}` === args.repo,
      process.env,
      recordingFetch,
    ),
    advisor: stubAdvisor(plan),
    notifier: new ConsoleNotifier(),
    audit: new NullAudit(),
    now: () => new Date().toISOString(),
    log: (msg) => console.error(`[twiki] ${msg}`),
  });

  if (args.record) {
    const path = `${args.record.replace(/\/$/, "")}/write-spike.json`;
    writeFileSync(path, `${JSON.stringify(observed, null, 2)}\n`);
    console.error(
      `\n[spike] recorded ${observed.length} non-GET request(s) to ${path}.` +
        "\n[spike] SCRUB BEFORE COMMITTING: read the diff, do not trust this.\n",
    );
  }
}

main().catch((err) => {
  console.error(`[spike] failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});

/**
 * Pass A: call each write method on the port, bypassing the executor (D7).
 *
 * The executor cannot reach all four in one repository state - `mergePR` needs
 * an open Dependabot pull request while `pushTag` needs `isSettled()` with
 * none, and `rerunFailedJobs` needs main red while `pushTag` needs it green.
 * This answers the narrower question the contract test cannot: does GitHub
 * accept the request the adapter builds.
 *
 * It proves NOTHING about the gates. Pass B does that.
 */
async function runDirect(args: Args): Promise<void> {
  const outcomes: Outcome[] = [];
  let current: unknown[] = [];

  const recordingFetch = makeRecorder(() => current);

  const github = createGitHubFromEnv(
    (r) => `${r.owner}/${r.name}` === args.repo,
    process.env,
    recordingFetch,
  );
  const ref = parseRepoSlug(args.repo);

  const flush = () => {
    if (!args.record) return;
    try {
      const path = `${args.record.replace(/\/$/, "")}/write-spike-direct.json`;
      writeFileSync(path, `${JSON.stringify(outcomes, null, 2)}\n`);
    } catch (err) {
      // Never abort the remaining writes because the recording failed. The
      // flush sat outside the try/catch, so a bad --record directory killed
      // the loop after the first write had ALREADY been issued.
      console.error(
        `[spike] could not write the recording: ${err instanceof Error ? err.message : err}`,
      );
    }
  };

  // Each write is isolated: a rejection is recorded and the next one still
  // runs. Stopping on the first failure would hide the state of the rest,
  // and "GitHub refused this" is the finding, not an error to bail on.
  const attempt = async (name: string, fn: () => Promise<unknown>) => {
    current = [];
    console.error(`\n[spike] ${name}`);
    try {
      await fn();
      outcomes.push({ write: name, ok: true, requests: current });
      console.error(`[spike] ${name}: ACCEPTED`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      outcomes.push({ write: name, ok: false, error: msg, requests: current });
      console.error(`[spike] ${name}: REJECTED — ${msg.slice(0, 200)}`);
    }
    flush(); // incremental: a crash mid-run must not lose what was learned
  };

  const ALL = "mergePR,pushTag,rerunFailedJobs,requestDependabotRebase";
  const spec = args.direct === "all" ? ALL : (args.direct ?? "");
  if (args.direct === "all") {
    console.error(
      "[spike] --direct all needs arguments per write; " +
        `expand it yourself, e.g. ${ALL.split(",").join(":<arg>,")}:<arg>`,
    );
    return;
  }

  for (const raw of spec.split(",")) {
    const step = raw.trim();
    if (!step) continue;
    const [name, arg] = step.split(":");
    // Validate before issuing. Without this, `mergePR` with no colon requested
    // /pulls/NaN/merge and `pushTag:v1` sent an undefined sha - both surfacing
    // as REJECTED, which is the one signal this spike exists to produce. A bad
    // argument must not be mistakable for a genuine adapter defect.
    const num = (v: string | undefined): number | null => {
      const n = Number(v);
      return v && Number.isInteger(n) && n > 0 ? n : null;
    };
    if (name === "mergePR" || name === "requestDependabotRebase") {
      const n = num(arg);
      if (n === null) {
        console.error(`[spike] ${step}: needs ${name}:<pr number>; skipped`);
        continue;
      }
      await attempt(step, () =>
        name === "mergePR"
          ? github.mergePR(ref, n)
          : github.requestDependabotRebase(ref, n),
      );
    } else if (name === "pushTag") {
      const [tag, sha] = (arg ?? "").split("@");
      if (!tag || !sha) {
        console.error(`[spike] ${step}: needs pushTag:<tag>@<sha>; skipped`);
        continue;
      }
      await attempt(step, () => github.pushTag(ref, tag, sha));
    } else if (name === "rerunFailedJobs") {
      const n = num(arg);
      if (n === null) {
        console.error(
          `[spike] ${step}: needs rerunFailedJobs:<run id>; skipped`,
        );
        continue;
      }
      await attempt(step, () => github.rerunFailedJobs(ref, n));
    } else {
      console.error(`[spike] unknown write "${step}"`);
    }
  }

  console.error("\n[spike] ── summary ──");
  for (const o of outcomes) {
    console.error(`[spike]   ${o.ok ? "ACCEPTED" : "REJECTED"}  ${o.write}`);
  }
  if (args.record) {
    console.error(
      `[spike] recorded to ${args.record}/write-spike-direct.json` +
        "\n[spike] SCRUB BEFORE COMMITTING: read the diff, do not trust this.\n",
    );
  }
}
