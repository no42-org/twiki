/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { coverageReason, isCovered } from "../src/core/coverage.js";
import { coverageSubject } from "../src/core/subject.js";
import type { RepoRef } from "../src/core/types.js";
import {
  OctokitGitHub,
  translateDependabotProbe,
} from "../src/github/octokit-adapter.js";
import {
  type CoverageObservation,
  collectCoverage,
  decideCoverage,
} from "../src/tricorder/collect/coverage.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { FakeGitHubReadPort } from "./fakes.js";

const REPO = { owner: "no42-org", name: "twiki" };
const OFF = { owner: "no42-org", name: "legacy" };
const OLD = { owner: "no42-org", name: "ancient" };

const meta = (
  repo: RepoRef,
  over: Partial<{ archived: boolean; disabled: boolean }> = {},
) => ({
  repo,
  archived: false,
  disabled: false,
  ...over,
});

describe("translating the probe on observed behaviour (story 23)", () => {
  // Measured 2026-08-17 against a live installation. Both failures are 403 and
  // differ only in the message, so status alone cannot tell them apart.
  it("reads the disabled message, not just the status", () => {
    expect(
      translateDependabotProbe({
        status: 403,
        message:
          "Dependabot alerts are disabled for this repository. - https://docs.github.com/rest/dependabot",
      }),
    ).toBe("alerts_disabled");
  });

  it("reads the not-accessible message as unreachable", () => {
    expect(
      translateDependabotProbe({
        status: 403,
        message:
          "Resource not accessible by integration - https://docs.github.com/rest/dependabot",
      }),
    ).toBe("unreachable");
  });

  it("treats a 404 as unreachable, which is how GitHub hides a repository", () => {
    expect(
      translateDependabotProbe({ status: 404, message: "Not Found" }),
    ).toBe("unreachable");
  });

  it("does not throw on a rejection that is not an object", () => {
    // Aborted requests can surface null. Throwing inside a catch escapes the
    // probe and fails the whole installation run, turning one repository's odd
    // rejection into zero coverage rows for the organisation.
    expect(translateDependabotProbe(null)).toBe("unknown");
    expect(translateDependabotProbe(undefined)).toBe("unknown");
    expect(translateDependabotProbe("a string")).toBe("unknown");
  });

  it("refuses to guess between the two 403s when the message is new", () => {
    // Guessing produces either a false accusation about the operator's
    // settings or a false claim of inaccessibility, and both read as confident.
    expect(
      translateDependabotProbe({ status: 403, message: "Something else" }),
    ).toBe("unknown");
    expect(translateDependabotProbe({ status: 500, message: "boom" })).toBe(
      "unknown",
    );
    expect(translateDependabotProbe({})).toBe("unknown");
  });
});

describe("the adapter's own probe", () => {
  it("does not call a resolution failure an uninstalled App", async () => {
    // The catch around client() also sees the allowlist guard and any transient
    // token-mint failure. Reporting those as "not installed" would, during a
    // token outage, mark every repository in the organisation as uncovered at
    // once, each naming a cause that is not true. This is precisely the guess
    // translateDependabotProbe refuses to make a few lines below.
    const gh = new OctokitGitHub(
      async () => {
        throw new Error("could not mint an installation token");
      },
      () => true,
    );
    expect(await gh.probeDependabotAccess(REPO)).toBe("unknown");
  });

  it("does not call a non-allowlisted repository uninstalled either", async () => {
    const gh = new OctokitGitHub(
      async () => ({}) as never,
      () => false,
    );
    expect(await gh.probeDependabotAccess(REPO)).toBe("unknown");
  });
});

describe("deciding coverage from cheap facts plus the probe", () => {
  it("lets archived win over a probe that says covered", () => {
    // An archived repository can still answer 200 with old alerts. Reporting it
    // covered would promise something is watching a repository nothing updates.
    expect(decideCoverage({ archived: true, disabled: false }, "covered")).toBe(
      "archived",
    );
  });

  it("does not call a GitHub-disabled repository an uninstalled App", () => {
    // GitHub's `disabled` flag is about the repository, for billing, DMCA or
    // abuse. Reporting it as a missing installation sends the operator to check
    // a setting that is fine.
    expect(decideCoverage({ archived: false, disabled: true }, "covered")).toBe(
      "repo_disabled",
    );
    expect(coverageReason("repo_disabled")).toContain(
      "disabled this repository",
    );
    expect(coverageReason("repo_disabled")).not.toContain("not installed");
  });

  it("takes the probe when the cheap facts say nothing", () => {
    expect(
      decideCoverage({ archived: false, disabled: false }, "alerts_disabled"),
    ).toBe("alerts_disabled");
  });

  it("handles a repository the org listing never mentioned", () => {
    expect(decideCoverage(undefined, "covered")).toBe("covered");
    expect(decideCoverage(undefined, "unreachable")).toBe("unreachable");
  });

  it("only calls one state covered", () => {
    expect(isCovered("covered")).toBe(true);
    for (const s of [
      "alerts_disabled",
      "archived",
      "unreachable",
      "unknown",
    ] as const) {
      expect(isCovered(s), s).toBe(false);
    }
  });

  it("gives a reason for every state except covered, and none for unknown's cause", () => {
    expect(coverageReason("covered")).toBeNull();
    expect(coverageReason("alerts_disabled")).toContain("switched off");
    expect(coverageReason("archived")).toContain("archived");
    expect(coverageReason("unreachable")).toContain("not installed");
    // Deliberately not phrased as an explanation: we do not have one.
    expect(coverageReason("unknown")).toContain("not one we recognise");
  });
});

describe("the coverage lane", () => {
  let dir: string;
  let store: SqliteStore;
  let github: FakeGitHubReadPort;
  let logs: string[];
  let watched: RepoRef[];
  let clock: number;

  const deps = () => ({
    github,
    store,
    watchedIn: () => watched,
    now: () => new Date(Date.UTC(2026, 7, 17, 10, clock++)).toISOString(),
    log: (m: string) => logs.push(m),
  });

  const stateOf = (repo: RepoRef) =>
    (store.current(coverageSubject(repo))?.payload as CoverageObservation)
      ?.state;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "coverage-"));
    store = SqliteStore.openForWrite(join(dir, "c.db"));
    github = new FakeGitHubReadPort(new Map());
    logs = [];
    clock = 0;
    watched = [REPO];
    github.orgRepos.set("no42-org", [meta(REPO)]);
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("records a watched repository GitHub is actually watching", async () => {
    const result = await collectCoverage(deps(), "no42-org");
    expect(result).toMatchObject({ outcome: "ok", covered: 1, notCovered: 0 });
    expect(stateOf(REPO)).toBe("covered");
  });

  it("does not call a resolution failure an uninstalled App", async () => {
    // The adapter's catch around client() also sees the allowlist guard and any
    // transient token-mint failure. Reporting those as "not installed" would,
    // during a token outage, mark every repository in the organisation as
    // uncovered at once, and each one would name a cause that is not true.
    github.probeDependabotAccess = async () => "unknown";
    const result = await collectCoverage(deps(), "no42-org");
    expect(stateOf(REPO)).toBe("unknown");
    expect(result.outcome).toBe("partial");
  });

  it("records a repository whose alerts are switched off", async () => {
    // The case that motivates the whole lane: 14 of 36 real repositories.
    watched = [REPO, OFF];
    github.orgRepos.set("no42-org", [meta(REPO), meta(OFF)]);
    github.access.set("no42-org/legacy", "alerts_disabled");

    const result = await collectCoverage(deps(), "no42-org");

    expect(result).toMatchObject({ covered: 1, notCovered: 1 });
    expect(stateOf(OFF)).toBe("alerts_disabled");
  });

  it("records an archived repository without spending a probe on it", async () => {
    watched = [OLD];
    github.orgRepos.set("no42-org", [meta(OLD, { archived: true })]);
    let probes = 0;
    const counting = new FakeGitHubReadPort(new Map());
    counting.orgRepos = github.orgRepos;
    counting.probeDependabotAccess = async () => {
      probes++;
      return "covered";
    };
    github = counting;

    await collectCoverage(deps(), "no42-org");

    expect(stateOf(OLD)).toBe("archived");
    expect(probes, "archived is free from the org listing").toBe(0);
  });

  it("reports an unrecognised answer as partial, not as ok", async () => {
    github.access.set("no42-org/twiki", "unknown");
    const result = await collectCoverage(deps(), "no42-org");
    // A lane reporting ok while holding unknowns lets the page treat them as
    // settled, which is the confident zero one level up.
    expect(result.outcome).toBe("partial");
    expect(result.unknown).toBe(1);
    expect(store.latestRuns(1)[0]?.detail).toContain("unrecognised");
  });

  it("matches a mixed-case repos.yaml entry to the org listing", async () => {
    watched = [{ owner: "No42-Org", name: "TWiki" }];
    github.orgRepos.set("no42-org", [
      meta({ owner: "no42-org", name: "twiki" }),
    ]);
    await collectCoverage(deps(), "no42-org");
    expect(stateOf(REPO)).toBe("covered");
  });

  it("does not overwrite known coverage with a probe that failed", async () => {
    // A rate-limited probe returns an unrecognised 403. Persisting that over a
    // good `covered` would blank a correct alert count until the next
    // successful run, up to a day later.
    await collectCoverage(deps(), "no42-org");
    expect(stateOf(REPO)).toBe("covered");

    github.access.set("no42-org/twiki", "unknown");
    const result = await collectCoverage(deps(), "no42-org");

    expect(result.unknown).toBe(1);
    expect(result.outcome).toBe("partial");
    expect(stateOf(REPO), "prior knowledge survives the failure").toBe(
      "covered",
    );
  });

  it("does record an unknown when nothing was known before", async () => {
    github.access.set("no42-org/twiki", "unknown");
    await collectCoverage(deps(), "no42-org");
    expect(stateOf(REPO)).toBe("unknown");
  });

  it("contains a failure rather than aborting the cycle", async () => {
    github.listOrgRepos = async () => {
      throw new Error("org is unreachable");
    };
    const result = await collectCoverage(deps(), "no42-org");
    expect(result.outcome).toBe("failed");
    expect(store.latestRuns(1)[0]?.outcome).toBe("failed");
  });

  it("keeps confirming coverage so it does not go stale on its own", async () => {
    await collectCoverage(deps(), "no42-org");
    const first = store.current(coverageSubject(REPO))?.verifiedAt;
    await collectCoverage(deps(), "no42-org");
    const second = store.current(coverageSubject(REPO));

    // Unchanged, so no new observation row, but verified_at must still advance
    // or a working coverage lane would render as a dying one.
    expect(second?.verifiedAt).not.toBe(first);
    expect(second?.observedAt).toBe(first);
  });
});
