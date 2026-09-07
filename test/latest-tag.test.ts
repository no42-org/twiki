/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createGitHubFromEnv,
  MAX_ALERT_PAGES,
} from "../src/github/octokit-adapter.js";

// What "the latest tag" means to twiki (#110).
//
// `latestTag` used to call `repos.getLatestRelease`, which answers the newest
// PUBLISHED release. Two live repositories carried a newer tag than that: one
// whose own workflow had drafted the release, one with no release object at
// all. Every tick twiki derived that same tag again, pushed it, got 422, and
// reported the repository errored. The refs are the primary object; the
// release is derived from a ref. So the read lists tag refs and takes the
// newest stable version itself, and never consults the releases list.

const FIXTURES = join(import.meta.dirname, "fixtures/github");
const load = (name: string): unknown =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8"));

const TEST_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

const REPO = { owner: "no42-org", name: "blittermib-chart" };

/** Serve one refs payload; optionally keep paging forever to exercise the cap. */
function githubServing(
  opts: { refs?: string; endless?: boolean },
  seen: URL[] = [],
) {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = new URL(String(input));
    seen.push(url);
    if (url.pathname.includes("/git/matching-refs/tags")) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      if (opts.endless) {
        headers.link = `<https://api.github.com${url.pathname}?page=2>; rel="next"`;
      }
      return new Response(
        JSON.stringify(load(opts.refs ?? "tag-refs-draft-newest.json")),
        { status: 200, headers },
      );
    }
    if (url.pathname.includes("/releases")) {
      // The releases list is the wrong object. Reaching it is the bug.
      throw new Error(`latestTag consulted the releases API: ${url.pathname}`);
    }
    const body = url.pathname.endsWith("/installation")
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

describe("latestTag reads the newest tag ref, not the latest release", () => {
  it("returns the newest tag even when its release is a draft or missing", async () => {
    // blittermib-chart: v0.5.11 published, v0.5.12 drafted by its own workflow.
    // nl6: v0.28.0 published, v0.28.1 with no release at all. From the ref
    // store both look the same: the tag exists, so it is the latest.
    const github = githubServing({ refs: "tag-refs-draft-newest.json" });
    await expect(github.latestTag(REPO)).resolves.toBe("v0.5.12");
  });

  it("never consults the releases API", async () => {
    const seen: URL[] = [];
    const github = githubServing({}, seen);
    await github.latestTag(REPO);
    expect(seen.some((u) => u.pathname.includes("/releases"))).toBe(false);
    expect(
      seen.some((u) => u.pathname.includes("/git/matching-refs/tags")),
    ).toBe(true);
  });

  it("takes the maximum by version, skipping prereleases and non-versions", async () => {
    const github = githubServing({ refs: "tag-refs-unordered.json" });
    await expect(github.latestTag(REPO)).resolves.toBe("v0.10.0");
  });

  it("keeps an unprefixed scheme", async () => {
    const github = githubServing({ refs: "tag-refs-unprefixed.json" });
    await expect(github.latestTag(REPO)).resolves.toBe("1.2.1");
  });

  it("refuses to answer from a truncated listing", async () => {
    const github = githubServing({ endless: true });
    await expect(github.latestTag(REPO)).rejects.toThrow(
      new RegExp(`exceeded ${MAX_ALERT_PAGES} pages`),
    );
  });
});
