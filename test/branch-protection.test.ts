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
}) {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const p = url.pathname;
    if (p.includes("/rules/branches/")) return ok(load(opts.rules));
    if (p.endsWith("/rulesets"))
      return ok(load(opts.rulesets ?? "rulesets-active.json"));
    if (p.endsWith("/protection")) {
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
