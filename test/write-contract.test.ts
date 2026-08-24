/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createGitHubFromEnv } from "../src/github/octokit-adapter.js";

// The contract between the adapter and GitHub, for the WRITE side.
//
// `adapter-contract.test.ts` does this for reads: it maps recorded payloads
// and compares field for field, because a lane test only proves the lane
// agrees with the fake, never that the fake agrees with GitHub. That gap
// shipped a real defect once - 31 unreadable alert payloads with 613 tests
// green.
//
// The write side had the identical gap and no coverage at all. But a write
// contract is a different shape: a read maps a RESPONSE, a write produces a
// REQUEST, so there is nothing to map. These assert on the outbound HTTP call
// instead, through the transport seam the factory already exposes.
//
// EVERY ASSERTION HERE IS AGAINST A REQUEST THAT GITHUB ACTUALLY ACCEPTED.
// The shapes below were recorded by scripts/write-spike.ts running against a
// live scratch repository on 2026-08-24 - all four accepted, verified by
// effect (PR merged, tag created, run re-run, comment posted). Writing these
// from what the adapter *appeared* to do would have been circular: the
// assertion and the adapter would encode the same belief and both could be
// wrong. The recording is what breaks that circle.
//
// Asserting merely that a call happened would be the write-side version of
// checking a field is truthy, which the read contract already learned is
// worthless. So: method, resolved path, and body.

const TEST_KEY = generateKeyPairSync("rsa", {
  modulusLength: 2048,
}).privateKey.export({ type: "pkcs8", format: "pem" }) as string;

interface Seen {
  method: string;
  path: string;
  body: unknown;
}

/**
 * Build the real adapter over a transport that records instead of sending.
 *
 * `createGitHubFromEnv` rather than `new OctokitGitHub(...)`: the factory is
 * what production wires, and its resolver and allowlist guard sit between the
 * caller and the request. Constructing the class directly would skip them.
 */
function recordingGitHub(
  seen: Seen[],
  isAllowed: (r: { owner: string; name: string }) => boolean = () => true,
) {
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";

    // The factory resolves which installation owns the repository before it
    // can mint a token. Answered so the real resolver runs rather than being
    // bypassed - it is one of the things constructing the class directly
    // would have skipped.
    if (url.pathname.endsWith("/installation")) {
      return new Response(JSON.stringify({ id: 7 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    // The installation-token exchange, answered so the real client can carry
    // on. Not a write, and not what is under test.
    if (url.pathname.endsWith("/access_tokens")) {
      return new Response(
        JSON.stringify({
          token: "ghs_test",
          expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    }

    if (method !== "GET") {
      seen.push({
        method,
        path: url.pathname,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
    }
    // Shape taken from the live recording: every write returned an empty-ish
    // 2xx that the adapter ignores. It returns void, so nothing is mapped.
    return new Response("{}", {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  return createGitHubFromEnv(
    isAllowed,
    {
      TWIKI_GITHUB_APP_ID: "1",
      TWIKI_GITHUB_APP_PRIVATE_KEY: TEST_KEY,
    } as NodeJS.ProcessEnv,
    fetchImpl,
  );
}

const REPO = { owner: "no42-org", name: "twiki-write-spike" };

describe("each write issues the request GitHub accepted", () => {
  it("mergePR squash-merges the numbered pull request", async () => {
    const seen: Seen[] = [];
    await recordingGitHub(seen).mergePR(REPO, 42);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("PUT");
    expect(seen[0]?.path).toBe(
      "/repos/no42-org/twiki-write-spike/pulls/42/merge",
    );
    // Recorded live. twiki squash-merges every dependency PR in every managed
    // repository, whatever that repository's own merge settings allow - a repo
    // permitting only merge commits would refuse this.
    expect(seen[0]?.body).toEqual({ merge_method: "squash" });
  });

  it("pushTag fully qualifies the ref", async () => {
    const seen: Seen[] = [];
    await recordingGitHub(seen).pushTag(REPO, "v1.2.3", "deadbeef");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.path).toBe("/repos/no42-org/twiki-write-spike/git/refs");
    // The prefix is the whole point. `v1.2.3` without `refs/tags/` is exactly
    // the error a fake written by the same hand would mirror, and GitHub
    // rejects it - so this assertion is what stands between the adapter and a
    // release that never tags.
    expect(seen[0]?.body).toEqual({
      ref: "refs/tags/v1.2.3",
      sha: "deadbeef",
    });
  });

  it("rerunFailedJobs names the run", async () => {
    const seen: Seen[] = [];
    await recordingGitHub(seen).rerunFailedJobs(REPO, 32774147847);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.path).toBe(
      "/repos/no42-org/twiki-write-spike/actions/runs/32774147847/rerun-failed-jobs",
    );
  });

  it("requestDependabotRebase comments the command Dependabot recognises", async () => {
    const seen: Seen[] = [];
    await recordingGitHub(seen).requestDependabotRebase(REPO, 7);

    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("POST");
    // The pull request is addressed as an ISSUE. Comments on a PR are governed
    // by the pull_requests permission but posted to the issues endpoint, which
    // is why the App needs no separate issues:write.
    expect(seen[0]?.path).toBe(
      "/repos/no42-org/twiki-write-spike/issues/7/comments",
    );
    expect(seen[0]?.body).toEqual({ body: "@dependabot rebase" });
  });

  it("a write outside the allowlist never leaves the process", async () => {
    // The guard the factory adds. If this stops holding, twiki can act on a
    // repository nobody put in repos.yaml.
    //
    // The first version of this test could not fail. It stubbed fetch with a
    // blanket 200, so removing the guard entirely still threw - not from the
    // refusal but because a bare `{}` gave the resolver no installation id -
    // and it asserted on a `seen` array nothing ever wrote to. Deleting the
    // guard left all five tests green.
    //
    // So it uses the SAME recording transport as the others: without the
    // guard the call would resolve, mint a token and issue a real request,
    // which `seen` would capture. The assertion is that nothing was issued.
    const seen: Seen[] = [];
    const github = recordingGitHub(seen, (r) => r.name === "allowed");

    await expect(
      github.mergePR({ owner: "no42-org", name: "forbidden" }, 1),
    ).rejects.toThrow();
    expect(seen).toEqual([]);

    // And the guard is what refused, not the harness: the same call on an
    // allowed repository goes through this transport happily.
    await github.mergePR({ owner: "no42-org", name: "allowed" }, 1);
    expect(seen).toHaveLength(1);
  });
});
