/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProtectionFact, RepoPolicy } from "../src/core/types.js";
import { createGitHubFromEnv } from "../src/github/octokit-adapter.js";
import { canRebase, isSettled, mergeBlock } from "../src/twiki/gates.js";
import { buildDigest, hasActionableActivity } from "../src/twiki/report.js";
import type { RepoResult, RunResult } from "../src/twiki/result.js";

// Whether the branch twiki merges into and releases from is defended.
//
// THREE SOURCES DISAGREE, and twiki can only read two of them. Legacy branch
// protection returns 403 for every allowlisted repository, because it needs
// `administration: read` and the App holds no `administration` permission at
// all. Both `blitsbom` and `CoolModFiles` keep their required status checks
// there, invisible.
//
// So an empty set of effective rules is NOT evidence of absence, and the
// adapter must not conclude one from the other. That is the whole test file:
// the interesting assertions are the ones about what is NOT concluded.
//
// Every payload here was recorded from the live API with the App's own
// installation token, except the two marked derived.

const FIXTURES = join(import.meta.dirname, "fixtures/github");
const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const TEST_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const REPO = { owner: "no42-org", name: "blitsbom" };

function githubServing(opts: {
  rules: string;
  rulesets?: string;
  legacyStatus?: number;
  legacy?: string | Record<string, unknown>;
}) {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const p = url.pathname;
    if (p.includes("/rules/branches/")) return ok(load(opts.rules));
    if (p.endsWith("/rulesets"))
      return ok(load(opts.rulesets ?? "rulesets-active.json"));
    if (p.endsWith("/protection")) {
      if (opts.legacy !== undefined) {
        return ok(
          typeof opts.legacy === "string" ? load(opts.legacy) : opts.legacy,
        );
      }
      const status = opts.legacyStatus ?? 403;
      return new Response(
        JSON.stringify(
          status === 403
            ? (load("branch-protection-forbidden.json") as { body: unknown })
                .body
            : { message: "Branch not protected" },
        ),
        { status, headers: { "content-type": "application/json" } },
      );
    }
    if (p.endsWith("/installation")) return ok({ id: 7 });
    if (p.endsWith("/access_tokens"))
      return ok({
        token: "ghs_test",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      });
    return ok({});
  }) as typeof fetch;

  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  return createGitHubFromEnv(
    () => true,
    {
      TWIKI_GITHUB_APP_ID: "1",
      TWIKI_GITHUB_APP_PRIVATE_KEY: TEST_KEY,
    } as NodeJS.ProcessEnv,
    fetchImpl,
  );
}

describe("what defends the branch twiki merges into", () => {
  it("rules in force mean protected, whole fact and all", async () => {
    // Asserting the WHOLE returned object, not one field of it. The `:latest`
    // guard was tested and correct while the two tags written beside it were
    // wrong for three months, because the test only ever looked at `:latest`
    // (#66).
    const github = githubServing({
      rules: "branch-rules-required-checks.json",
    });
    const fact: ProtectionFact = await github.branchProtection(REPO, "main");
    expect(fact).toStrictEqual({
      state: "protected",
      rulesInForce: [
        "deletion",
        "non_fast_forward",
        "required_signatures",
        "required_status_checks",
        "pull_request",
      ],
      inertRulesets: [],
      unreadableSources: [
        "legacy branch protection (needs the App permission `administration: read`)",
      ],
    });
  });

  it("rules without required checks are still rules", async () => {
    // `blitsbom`, exactly as recorded. Its rules carry no
    // `required_status_checks` - those live in legacy protection, which is
    // the 403 below. A version of this that reasoned "no required checks, so
    // nothing is verified" would report a defended repository as undefended,
    // which is the inference this whole fact exists to prevent.
    const github = githubServing({
      rules: "branch-rules-no-required-checks.json",
    });
    const fact = await github.branchProtection(REPO, "main");
    expect(fact.state).toBe("protected");
    expect(fact.rulesInForce).not.toContain("required_status_checks");
  });

  it("nothing visible is not the same as nothing there", async () => {
    // `CoolModFiles` as it was before its configuration was corrected: no
    // effective rules, and legacy protection unreadable. It was in fact
    // defended by legacy protection the whole time - required checks `verify`
    // and `playwright` - so "undefended" would have been false.
    const github = githubServing({
      rules: "branch-rules-none.derived.json",
      rulesets: "rulesets-disabled.json",
    });
    const fact = await github.branchProtection(REPO, "main");
    expect(fact.state).toBe("unknown");
    expect(fact.state).not.toBe("undefended");
    expect(fact.unreadableSources.join(" ")).toContain("administration: read");
  });

  it("undefended requires that nothing was hidden", async () => {
    // A 404 means the endpoint ANSWERED: there is no legacy protection. That
    // is the only way to reach `undefended`, and it is unreachable on this
    // estate today because the App cannot get past the 403 to be told 404.
    const github = githubServing({
      rules: "branch-rules-none.derived.json",
      rulesets: "rulesets-disabled.json",
      legacyStatus: 404,
    });
    const fact = await github.branchProtection(REPO, "main");
    expect(fact.state).toBe("undefended");
    expect(fact.unreadableSources).toStrictEqual([]);
  });

  it("names a ruleset that exists and does not enforce", async () => {
    // The trap that motivated the change. `CoolModFiles` carried a ruleset
    // named "main protection", targeting the default branch, declaring
    // required checks and pull requests - with enforcement disabled. The name
    // is what a listing shows; the inertness is only in the object.
    const github = githubServing({
      rules: "branch-rules-none.derived.json",
      rulesets: "rulesets-disabled.json",
    });
    const fact = await github.branchProtection(REPO, "main");
    expect(fact.inertRulesets).toStrictEqual([
      { name: "main protection", enforcement: "disabled" },
    ]);
  });

  it("an inert ruleset does not undo the rules actually in force", async () => {
    // THE CASE THAT PINS D2. Everywhere else the two sources happen to agree,
    // so a version judging from the ruleset listing instead of the rules in
    // force passed all eleven other tests - the central decision of this
    // change, unprotected. Found by mutation, not by review.
    //
    // A repository with an active ruleset AND a leftover disabled one is
    // ordinary. The rules in force say protected; the listing carries an
    // inert entry. Only the first is evidence.
    const github = githubServing({
      rules: "branch-rules-required-checks.json",
      rulesets: "rulesets-disabled.json",
    });
    const fact = await github.branchProtection(REPO, "main");
    expect(fact.state).toBe("protected");
    expect(fact.inertRulesets).toHaveLength(1);
  });

  it("a dry-run ruleset does not enforce either", async () => {
    // DERIVED: no ruleset on this estate uses `evaluate`. Left to fall
    // through, an unrecognised enforcement value would be treated as active
    // and a dry run would read as protection.
    const github = githubServing({
      rules: "branch-rules-none.derived.json",
      rulesets: "rulesets-evaluate.derived.json",
    });
    const fact = await github.branchProtection(REPO, "main");
    expect(fact.inertRulesets.map((r) => r.enforcement)).toStrictEqual([
      "evaluate",
    ]);
  });

  it("an active ruleset is not reported as inert", async () => {
    const github = githubServing({
      rules: "branch-rules-required-checks.json",
      rulesets: "rulesets-active.json",
    });
    await expect(
      github.branchProtection(REPO, "main").then((f) => f.inertRulesets),
    ).resolves.toStrictEqual([]);
  });
});

describe("protection is reported, never gated on", () => {
  // The requirement most likely to be broken later by someone who thinks
  // blocking on an undefended branch is obviously right. It may well be - but
  // it is a policy decision with a deadlock attached, and this change
  // deliberately does not take it (D4).
  const policy: RepoPolicy = { autoMergeMinor: true, mergeOnly: false };
  const facts = (state: ProtectionFact["state"]) => ({
    repo: REPO,
    mainChecks: "green" as const,
    latestTag: "v1.0.0",
    hasTagReleaseWorkflow: true,
    unreleasedDependencyCommits: 3,
    protection: {
      state,
      rulesInForce: state === "protected" ? ["pull_request"] : [],
      inertRulesets: [],
      unreadableSources: [],
    },
    prs: [],
  });
  const pr = (repoFacts: ReturnType<typeof facts>) => ({
    repo: REPO,
    number: 1,
    title: "chore(deps): bump x from 1.0.0 to 1.0.1",
    branch: "dependabot/npm_and_yarn/x-1.0.1",
    headSha: "deadbeef",
    isSecurity: false,
    isDependabot: true,
    bump: { level: "patch" as const, indeterminate: false },
    checks: "green" as const,
    body: "",
    behindBy: 3,
    _facts: repoFacts,
  });

  for (const state of ["protected", "undefended", "unknown"] as const) {
    it(`${state}: decides exactly as every other state does`, () => {
      const f = facts(state);
      expect(isSettled(f, policy)).toBe(true);
      expect(mergeBlock(pr(f), policy)).toBeNull();
      expect(canRebase(pr(f), policy)).toBe(true);
    });
  }

  it("no gate function reads the protection fact at all", () => {
    // Stronger than the table above, which would still pass if a gate read
    // the fact and happened to agree. Source-level: the three pure gate
    // functions must not mention it.
    const src = readFileSync(
      join(import.meta.dirname, "../src/twiki/gates.ts"),
      "utf8",
    );
    expect(src).not.toContain("protection");
  });
});

describe("a fact nothing gates on must not be able to stop a tick", () => {
  it("an unreadable rules endpoint yields unknown, not a throw", async () => {
    // `gatherFacts` is NOT wrapped: a throw here reaches run.ts, which drops
    // the whole repository out of the tick - no merges, no release, digest
    // reads "fact-gathering failed". A transient 5xx on a read that nothing
    // gates on would have blocked all of twiki's real work for that
    // repository. Review caught it; the first version threw.
    const fetchImpl = (async (input: string | URL | Request) => {
      const p = new URL(String(input)).pathname;
      const body = p.endsWith("/installation")
        ? { id: 7 }
        : p.endsWith("/access_tokens")
          ? {
              token: "ghs_test",
              expires_at: new Date(Date.now() + 3_600_000).toISOString(),
            }
          : {};
      const status = p.includes("/rules/branches/") ? 500 : 200;
      return new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const github = createGitHubFromEnv(
      () => true,
      {
        TWIKI_GITHUB_APP_ID: "1",
        TWIKI_GITHUB_APP_PRIVATE_KEY: TEST_KEY,
      } as NodeJS.ProcessEnv,
      fetchImpl,
    );

    const fact = await github.branchProtection(REPO, "main");
    expect(fact.state).toBe("unknown");
    expect(fact.unreadableSources.join(" ")).toContain("rules in force");
  });

  it("rules that only stop destruction are not a defence", async () => {
    // DERIVED: no branch here has only non-gating rules. `deletion` and
    // `non_fast_forward` stop the branch being destroyed or rewritten, which
    // says nothing about whether what lands on it was verified. Counting them
    // made such a branch read `protected` - and since the digest is SILENT
    // for `protected`, that silence is what an operator reads as "defended".
    const github = githubServing({
      rules: "branch-rules-non-gating.derived.json",
      legacyStatus: 404,
    });
    const fact = await github.branchProtection(REPO, "main");
    expect(fact.state).toBe("undefended");
    expect(fact.rulesInForce).toStrictEqual(["deletion", "non_fast_forward"]);
  });

  it("a pull-request rule alone is a defence", async () => {
    const github = githubServing({
      rules: "branch-rules-no-required-checks.json",
      legacyStatus: 404,
    });
    await expect(
      github.branchProtection(REPO, "main").then((f) => f.state),
    ).resolves.toBe("protected");
  });
});

describe("the operator actually gets told", () => {
  const repoResult = (protection?: RepoResult["protection"]): RepoResult => ({
    repo: "no42-org/blitsbom",
    mainRed: false,
    prs: [],
    release: { status: "waiting", detail: "nothing to release" },
    ...(protection ? { protection } : {}),
  });
  const run = (repo: RepoResult): RunResult => ({
    mode: "enforce",
    repos: [repo],
  });

  it("a quiet repository still reports an unconfirmed branch", () => {
    // The repository most likely to be undefended is the quiet one: nothing
    // merging, nothing releasing. Without this the digest is suppressed
    // entirely and the fact is gathered every tick and shown on none of them.
    expect(hasActionableActivity(run(repoResult()))).toBe(false);
    expect(
      hasActionableActivity(
        run(
          repoResult({
            state: "undefended",
            rulesInForce: [],
            inertRulesets: [],
            unreadableSources: [],
          }),
        ),
      ),
    ).toBe(true);
  });

  it("says undefended, names the inert ruleset and what it could not read", () => {
    // 28 lines of rendering had no test at all, and the fakes default every
    // repository to `protected` - the one value that makes this block emit
    // nothing.
    const digest = buildDigest(
      run(
        repoResult({
          state: "unknown",
          rulesInForce: [],
          inertRulesets: [{ name: "main protection", enforcement: "disabled" }],
          unreadableSources: [
            "legacy branch protection (needs the App permission `administration: read`)",
          ],
        }),
      ),
    );
    expect(digest).toContain("could not be confirmed");
    expect(digest).toContain('ruleset "main protection"');
    expect(digest).toContain("does not enforce (disabled)");
    expect(digest).toContain("administration: read");
    // Not the other wording - "undefended" would be a claim, not a report.
    expect(digest).not.toContain("main is undefended");
  });

  it("says undefended when that is what it means", () => {
    const digest = buildDigest(
      run(
        repoResult({
          state: "undefended",
          rulesInForce: ["deletion"],
          inertRulesets: [],
          unreadableSources: [],
        }),
      ),
    );
    expect(digest).toContain("main is undefended");
    expect(digest).not.toContain("could not be confirmed");
  });

  it("a confirmed branch adds no line", () => {
    // A report that speaks every tick stops being read.
    const digest = buildDigest(run(repoResult()));
    expect(digest).not.toContain("undefended");
    expect(digest).not.toContain("could not be confirmed");
  });
});

describe("legacy branch protection, now that twiki may read it", () => {
  // Granting `administration: read` did not only widen the view. It made the
  // previous verdict WRONG: the rules endpoint reports rulesets only, so a
  // branch defended solely by legacy protection went from `unknown` - an
  // honest admission - to a confident `undefended`.

  it("a branch defended only by legacy protection is not undefended", async () => {
    // The regression the permission grant created. No rulesets rules at all,
    // and legacy protection requiring status checks.
    const github = githubServing({
      rules: "branch-rules-none.derived.json",
      legacy: "branch-protection-legacy-checks.json",
    });
    const fact = await github.branchProtection(REPO, "main");
    expect(fact.state).toBe("protected");
    expect(fact.rulesInForce).toContain("required_status_checks");
    expect(fact.unreadableSources).toStrictEqual([]);
  });

  it("legacy contributes what the rules endpoint omits", async () => {
    // `blitsbom` exactly as recorded: its rules carry `pull_request` and NO
    // `required_status_checks`, while its legacy protection requires
    // `gates / verify` and `gates / lint-workflows`. Before this, the fact
    // reported a defence the branch has as absent.
    const github = githubServing({
      rules: "branch-rules-no-required-checks.json",
      legacy: "branch-protection-legacy.json",
    });
    const fact = await github.branchProtection(REPO, "main");
    expect(fact.rulesInForce).toContain("pull_request");
    expect(fact.rulesInForce).toContain("required_status_checks");
    // Merged, not duplicated: `required_signatures` is declared by BOTH.
    expect(
      fact.rulesInForce.filter((r) => r === "required_signatures"),
    ).toHaveLength(1);
  });

  it("legacy protection that configures no defence is not a defence", async () => {
    const github = githubServing({
      rules: "branch-rules-none.derived.json",
      legacy: {
        url: "https://api.github.com/x",
        allow_force_pushes: { enabled: false },
        allow_deletions: { enabled: false },
      },
    });
    await expect(
      github.branchProtection(REPO, "main").then((f) => f.state),
    ).resolves.toBe("undefended");
  });

  it("enforce_admins alone does not defend anything", async () => {
    // It decides who may BYPASS the other rules. With no other rule
    // configured there is nothing to bypass, and counting it would report a
    // branch as defended on the strength of a setting that gates nothing.
    const github = githubServing({
      rules: "branch-rules-none.derived.json",
      legacy: {
        url: "https://api.github.com/x",
        enforce_admins: { enabled: true },
      },
    });
    await expect(
      github.branchProtection(REPO, "main").then((f) => f.state),
    ).resolves.toBe("undefended");
  });
});
