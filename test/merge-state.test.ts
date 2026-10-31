/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { OctokitGitHub } from "../src/github/octokit-adapter.js";
import {
  readPr,
  readPullRequest,
} from "../src/tricorder/attention/payloads.js";
import { normalisePullRequest } from "../src/tricorder/collect/pull-requests.js";
import { normalisePr } from "../src/tricorder/collect/update-prs.js";
import { makeOpenPr, makeUpdatePr } from "./fakes.js";

const REPOS = [{ owner: "no42-org", name: "twiki" }];

/** An Octokit GraphQL stub that captures the document and answers with `nodes`. */
function stubGh(nodes: unknown[]) {
  const documents: string[] = [];
  const gh = {
    graphql: async (document: string) => {
      documents.push(document);
      return {
        search: {
          issueCount: nodes.length,
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes,
        },
      };
    },
  } as unknown as import("@octokit/rest").Octokit;
  return {
    documents,
    adapter: new OctokitGitHub(
      async () => gh,
      () => true,
      async () => gh,
    ),
  };
}

const node = (over: Record<string, unknown> = {}) => ({
  id: "PR_1",
  number: 1,
  title: "Fix the thing",
  url: "https://github.com/no42-org/twiki/pull/1",
  createdAt: "2026-09-10T00:00:00.000Z",
  author: { login: "a-contributor" },
  repository: { name: "twiki", owner: { login: "no42-org" } },
  headRefName: "feat/x",
  isDraft: true,
  reviewDecision: "CHANGES_REQUESTED",
  ...over,
});

const EXPECTED = {
  nodeId: "PR_1",
  repo: { owner: "no42-org", name: "twiki" },
  number: 1,
  title: "Fix the thing",
  author: "a-contributor",
  htmlUrl: "https://github.com/no42-org/twiki/pull/1",
  createdAt: "2026-09-10T00:00:00.000Z",
  headRef: "feat/x",
  isDraft: true,
  reviewDecision: "CHANGES_REQUESTED",
};

describe("reviewDecision, isDraft and headRefName: the GraphQL mapper", () => {
  it("reads all three on the update pull request lane, and asks for them", async () => {
    const { adapter, documents } = stubGh([node()]);
    const page = await adapter.listOpenUpdatePRs(REPOS, ["app/dependabot"]);
    for (const field of ["reviewDecision", "isDraft", "headRefName"]) {
      expect(documents[0]).toContain(field);
    }
    expect(page.prs).toEqual([EXPECTED]);
  });

  it("reads all three on the plain pull request lane, and asks for them", async () => {
    const { adapter, documents } = stubGh([node()]);
    const page = await adapter.listOpenPullRequests(REPOS, ["app/dependabot"]);
    for (const field of ["reviewDecision", "isDraft", "headRefName"]) {
      expect(documents[0]).toContain(field);
    }
    expect(page.prs).toEqual([EXPECTED]);
  });

  it.each([
    ["an unrecognised string", { reviewDecision: "SHRUG" }],
    ["a missing field", { reviewDecision: undefined }],
  ])("reads %s as unknown on both lanes, never null", async (_name, over) => {
    const update = stubGh([node(over)]);
    const plain = stubGh([node(over)]);
    expect(
      (await update.adapter.listOpenUpdatePRs(REPOS, ["app/dependabot"])).prs,
    ).toEqual([{ ...EXPECTED, reviewDecision: "unknown" }]);
    expect(
      (await plain.adapter.listOpenPullRequests(REPOS, ["app/dependabot"])).prs,
    ).toEqual([{ ...EXPECTED, reviewDecision: "unknown" }]);
  });

  it("reads a null reviewDecision as null and a missing draft flag as null", async () => {
    const { adapter } = stubGh([
      node({
        reviewDecision: null,
        isDraft: undefined,
        headRefName: undefined,
      }),
    ]);
    const page = await adapter.listOpenUpdatePRs(REPOS, ["app/dependabot"]);
    expect(page.prs).toEqual([
      { ...EXPECTED, reviewDecision: null, isDraft: null, headRef: null },
    ]);
  });
});

describe("reviewDecision, isDraft and head ref: the observations", () => {
  it("normalisePr carries all three through", () => {
    const { payload } = normalisePr(
      makeUpdatePr({
        headRef: "dependabot/x",
        isDraft: true,
        reviewDecision: "APPROVED",
      }),
    );
    expect(payload).toEqual({
      repo: "no42-org/twiki",
      number: 1,
      title: "Bump left-pad from 1.0.0 to 1.0.1",
      author: "custom-bot[bot]",
      htmlUrl: "https://github.com/no42-org/twiki/pull/1",
      createdAt: "2026-08-17T00:00:00.000Z",
      packageName: "left-pad",
      bump: "patch",
      headRef: "dependabot/x",
      isDraft: true,
      reviewDecision: "APPROVED",
    });
  });

  it("normalisePullRequest carries draft state and review decision through", () => {
    const { payload } = normalisePullRequest(
      makeOpenPr({ isDraft: true, reviewDecision: "REVIEW_REQUIRED" }),
    );
    expect(payload).toEqual({
      repo: "no42-org/twiki",
      number: 1,
      title: "Fix the thing",
      author: "a-contributor",
      htmlUrl: "https://github.com/no42-org/twiki/pull/1",
      createdAt: "2026-09-10T00:00:00.000Z",
      headRef: "fix-the-thing",
      isDraft: true,
      reviewDecision: "REVIEW_REQUIRED",
    });
  });
});

describe("reviewDecision, isDraft and head ref: the payload readers", () => {
  const oldPr = {
    repo: "no42-org/twiki",
    number: 1,
    title: "Bump x from 1.0.0 to 1.0.1",
    author: "dependabot",
    htmlUrl: "https://github.com/no42-org/twiki/pull/1",
    createdAt: "2026-08-17T00:00:00.000Z",
    packageName: "x",
    bump: "patch",
  };
  const oldPlain = {
    repo: "no42-org/twiki",
    number: 7,
    title: "Fix the thing",
    author: "a-contributor",
    htmlUrl: "https://github.com/no42-org/twiki/pull/7",
    createdAt: "2026-08-17T00:00:00.000Z",
    headRef: "feature",
  };

  it("reads an update PR row that predates the fields as unknown", () => {
    expect(readPr(oldPr)).toEqual({
      ...oldPr,
      headRef: null,
      isDraft: null,
      reviewDecision: "unknown",
    });
  });

  it("reads a plain PR row that predates the fields as unknown", () => {
    expect(readPullRequest(oldPlain)).toEqual({
      ...oldPlain,
      isDraft: null,
      reviewDecision: "unknown",
    });
  });

  it("reads an unrecognised reviewDecision as unknown on both", () => {
    const bad = { isDraft: false, reviewDecision: "SHRUG" };
    expect(readPr({ ...oldPr, headRef: "a", ...bad })).toEqual({
      ...oldPr,
      headRef: "a",
      isDraft: false,
      reviewDecision: "unknown",
    });
    expect(readPullRequest({ ...oldPlain, ...bad })).toEqual({
      ...oldPlain,
      isDraft: false,
      reviewDecision: "unknown",
    });
  });

  it("keeps the values a current row carries, including a null decision", () => {
    const row = {
      ...oldPr,
      headRef: "dependabot/x",
      isDraft: false,
      reviewDecision: null,
    };
    expect(readPr(row)).toEqual(row);
    const plain = { ...oldPlain, isDraft: true, reviewDecision: "APPROVED" };
    expect(readPullRequest(plain)).toEqual(plain);
  });
});
