/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createGitHubFromEnv } from "../src/github/octokit-adapter.js";

// How many merged-but-unreleased dependency commits a repository has, which
// is one of the three conditions `isSettled` requires before twiki will cut a
// release.
//
// This function had NO test at all. `test/fakes.ts` implements
// `dependabotCommitsSince` by returning a number a human chose, so every
// settled/release test in the suite agreed with the fake and said nothing
// about whether the fake agreed with GitHub. It did not: the no-tag branch
// asked GitHub to filter commits by `author=dependabot[bot]`, and that filter
// matches no bot login, so the count came back 0 for every repository that
// had never published a release. twiki could not cut any repository's FIRST
// release, and reported "🎉 Dependencies up to date." while refusing (#90).
//
// The two branches had drifted apart: the compare branch filtered in our own
// code and was correct, the listing branch delegated to GitHub and was not.
// They now share one predicate, so they cannot disagree again.

const FIXTURES = join(import.meta.dirname, "fixtures/github");
const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const TEST_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const REPO = { owner: "no42-org", name: "blitsbom" };

/** Serve one payload for the commit listing and one for the compare. */
function githubServing(
  fixtures: { commits?: string; compare?: string },
  seen?: URL[],
) {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    seen?.push(url);
    const body = url.pathname.endsWith("/commits")
      ? load(fixtures.commits ?? "commits-mixed.json")
      : url.pathname.includes("/compare/")
        ? load(fixtures.compare ?? "compare-mixed.json")
        : url.pathname.endsWith("/installation")
          ? { id: 7 }
          : url.pathname.endsWith("/access_tokens")
            ? {
                token: "ghs_test",
                expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              }
            : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return createGitHubFromEnv(
    () => true,
    {
      TWIKI_GITHUB_APP_ID: "1",
      TWIKI_GITHUB_APP_PRIVATE_KEY: TEST_KEY,
    } as NodeJS.ProcessEnv,
    fetchImpl,
  );
}

describe("counting unreleased dependency commits", () => {
  // The fixture counts are DELIBERATELY ASYMMETRIC. With an equal number of
  // Dependabot and human commits, a filter inverted to count humans would
  // return the same number and the assertion would hold either way - the
  // "test that cannot fail" this repository keeps finding in its own suite.
  //   commits-mixed.json:  2 Dependabot, 4 human  -> inverted gives 4
  //   compare-mixed.json:  3 Dependabot, 1 human  -> inverted gives 1

  it("a repository with no release counts across the whole listing", async () => {
    const github = githubServing({});
    await expect(github.dependabotCommitsSince(REPO, null)).resolves.toBe(2);
  });

  it("a repository with a release counts only what came after it", async () => {
    const github = githubServing({});
    await expect(github.dependabotCommitsSince(REPO, "v0.8.0")).resolves.toBe(
      3,
    );
  });

  it("does not ask GitHub to filter by author", async () => {
    // The defect itself. GitHub's `author` parameter does not match bot
    // logins: `?author=dependabot%5Bbot%5D` returned 0 against a listing
    // containing 42 such commits. Delegating the filter returned nothing and
    // that read as "nothing to release".
    const seen: URL[] = [];
    const github = githubServing({}, seen);
    await github.dependabotCommitsSince(REPO, null);

    const listing = seen.find((u) => u.pathname.endsWith("/commits"));
    expect(listing).toBeDefined();
    expect(listing?.searchParams.get("author")).toBeNull();
  });

  it("counts a commit GitHub could not map to an account", async () => {
    // DERIVED, not recorded: every Dependabot commit in this estate resolves
    // to the `dependabot[bot]` account, so `author: null` cannot be recorded
    // from it. The fallback on the git author name exists for that case and
    // was previously unreachable on the listing branch, which never filtered
    // in our code at all.
    const github = githubServing({
      commits: "commits-unmapped-author.derived.json",
    });
    await expect(github.dependabotCommitsSince(REPO, null)).resolves.toBe(1);
  });

  it("walks past a page that contains no Dependabot commits", async () => {
    // Filtering locally moved the bound from "the first 100 matches" to "the
    // first 100 commits scanned". A repository whose Dependabot merges sit
    // behind newer human commits would count 0 and be told there was nothing
    // to release - #90 again, through a narrower window. Review caught it.
    //
    // Page one here is recorded and contains only human commits; page two
    // carries the Dependabot ones. Reading one page returns 0.
    const pages = ["commits-humans-only.json", "commits-mixed.json"];
    let served = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/commits")) {
        return new Response(
          JSON.stringify(
            url.pathname.endsWith("/installation")
              ? { id: 7 }
              : url.pathname.endsWith("/access_tokens")
                ? {
                    token: "ghs_test",
                    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
                  }
                : {},
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const body = load(pages[served] ?? "commits-humans-only.json");
      served++;
      const more = served < pages.length;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "content-type": "application/json",
          ...(more
            ? {
                link: `<https://api.github.com/repos/no42-org/blitsbom/commits?page=${served + 1}>; rel="next"`,
              }
            : {}),
        },
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

    await expect(github.dependabotCommitsSince(REPO, null)).resolves.toBe(2);
    expect(served).toBe(2);
  });

  it("refuses to report zero from a comparison it could not see all of", async () => {
    // GitHub caps the commits on a comparison and reports the true size
    // separately. Zero matches out of a truncated view is not evidence that
    // there is nothing to release, and the return type cannot say "unknown" -
    // so it fails loudly instead. run.ts catches this per repository and the
    // message reaches the digest.
    const truncated = {
      total_commits: 400,
      commits: load("commits-humans-only.json"),
    };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const body = url.pathname.includes("/compare/")
        ? truncated
        : url.pathname.endsWith("/installation")
          ? { id: 7 }
          : url.pathname.endsWith("/access_tokens")
            ? {
                token: "ghs_test",
                expires_at: new Date(Date.now() + 3_600_000).toISOString(),
              }
            : {};
      return new Response(JSON.stringify(body), {
        status: 200,
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

    await expect(github.dependabotCommitsSince(REPO, "v0.8.0")).rejects.toThrow(
      /4 of 400 commits/,
    );
  });

  it("both branches apply the same predicate", async () => {
    // NOT a guard against #90 returning: the mock ignores query parameters, so
    // re-adding `author: DEPENDABOT_LOGIN` would serve the same payload and
    // this would stay green. `does not ask GitHub to filter by author` is the
    // test that covers that. What this binds is narrower and still worth
    // having - the two branches drifted apart once because nothing compared
    // them, and this fails if they are given different predicates again.
    const single = "commits-unmapped-author.derived.json";
    const commits = load(single) as unknown[];
    const asCompare = { commits, total_commits: commits.length };
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      const body = url.pathname.includes("/compare/")
        ? asCompare
        : url.pathname.endsWith("/commits")
          ? commits
          : url.pathname.endsWith("/installation")
            ? { id: 7 }
            : url.pathname.endsWith("/access_tokens")
              ? {
                  token: "ghs_test",
                  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
                }
              : {};
      return new Response(JSON.stringify(body), {
        status: 200,
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

    const untagged = await github.dependabotCommitsSince(REPO, null);
    const tagged = await github.dependabotCommitsSince(REPO, "v0.8.0");
    expect(untagged).toBe(tagged);
  });
});
