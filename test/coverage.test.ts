/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COVERAGE_STATES,
  type CoverageFeatures,
  coverageReason,
  featureReason,
  isCovered,
  isOff,
  offNotes,
  securityStanding,
  unansweredNotes,
} from "../src/core/coverage.js";
import { coverageSubject } from "../src/core/subject.js";
import type { RepoRef } from "../src/core/types.js";
import {
  MAX_REASON_CHARS,
  OctokitGitHub,
  translateCodeScanningProbe,
  translateDependabotProbe,
  translateSecretScanningProbe,
} from "../src/github/octokit-adapter.js";
import {
  type CoverageObservation,
  collectCoverage,
  coverageFeatures,
  wholeRepoCoverage,
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

describe("translating the two scanner probes on measured bodies (story 3.2)", () => {
  // The bodies come from the recordings, not from a second copy typed here.
  // test/adapter-contract.test.ts drives the same fixtures through the real
  // adapter; this file exercises the translators directly.
  const FIXTURES = join(import.meta.dirname, "fixtures/github");
  const recorded404 = (name: string) => {
    const raw = JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as {
      message: string;
      documentation_url: string;
      status: string;
    };
    return {
      // The shape @octokit/request throws: a numeric status, and the message
      // with the documentation URL appended. The recording stores the status
      // as a string, so it is converted here.
      err: {
        status: Number(raw.status),
        message: `${raw.message} - ${raw.documentation_url}`,
      },
      // What GitHub actually wrote, which is what reaches the page.
      body: raw.message,
    };
  };
  const secretOff = recorded404("secret-scanning-404.json");
  const noAnalysis = recorded404("code-scanning-404.json");

  it("reads the secret scanning message as the feature being off", () => {
    expect(translateSecretScanningProbe(secretOff.err)).toEqual({
      state: "feature_off",
      // GitHub's own words, not a sentence derived from the state, and
      // without the documentation link the client appends: that link is the
      // same for every repository and would fill the sentence a reader sees.
      reason: secretOff.body,
      answered: true,
    });
    expect(secretOff.body).not.toContain("https://");
  });

  it("does not read `no analysis found` as code scanning being off", () => {
    // A repository with code scanning enabled and nothing analysed yet
    // answers exactly like one that never configured it. Four of the seven
    // public repositories probed answered this way, and reading it as off
    // would put `not covered` on a repository that is scanned.
    expect(translateCodeScanningProbe(noAnalysis.err)).toEqual({
      state: "unknown",
      reason: noAnalysis.body,
      // Answered, so it does NOT degrade the daily run to partial. A measured
      // answer that means unknown is not a failure to answer.
      answered: true,
    });
  });

  it("names an endpoint the App may not read, rather than guessing", () => {
    // Measured on the sibling Dependabot probe. Without it a permissions
    // problem and a switched-off feature read the same on the page.
    for (const translate of [
      translateCodeScanningProbe,
      translateSecretScanningProbe,
    ]) {
      expect(
        translate({
          status: 403,
          message:
            "Resource not accessible by integration - https://docs.github.com/rest",
        }),
      ).toEqual({
        state: "unreachable",
        reason: "Resource not accessible by integration",
        answered: true,
      });
    }
  });

  it("treats an unmeasured body as an ANSWER, not as a failure", () => {
    // A private repository without Advanced Security answers a 403 body
    // nothing here has measured. Counting that as a failure would hold the
    // daily lane permanently partial and, with the lane's write rule, freeze
    // that repository's row for ever.
    for (const translate of [
      translateCodeScanningProbe,
      translateSecretScanningProbe,
    ]) {
      const probe = translate({
        status: 403,
        message: "Advanced Security must be enabled for this repository.",
      });
      expect(probe.state).toBe("unknown");
      expect(probe.reason).toBe(
        "Advanced Security must be enabled for this repository.",
      );
      expect(probe.answered, "a stable body is an answer").toBe(true);
    }
  });

  it("treats a request that reached no answer as no answer", () => {
    // A 5xx, an empty body and a non-object rejection are all transient, and
    // only these degrade the run, because only these can change on a retry.
    for (const translate of [
      translateCodeScanningProbe,
      translateSecretScanningProbe,
    ]) {
      for (const err of [
        { status: 500, message: "boom" },
        { status: 404, message: "" },
        {},
        null,
        "a string",
      ]) {
        const probe = translate(err);
        expect(probe.state, JSON.stringify(err)).toBe("unknown");
        expect(probe.answered, JSON.stringify(err)).toBe(false);
      }
    }
  });

  it("distinguishes an empty body from a feature nobody probed", () => {
    // Both read `unknown`, and both must: neither is evidence. But a page
    // that quotes an empty string says GitHub answered nothing readable,
    // which is a different claim from never having asked.
    expect(
      translateCodeScanningProbe({ status: 404, message: "" }).reason,
    ).toBeNull();
    expect(translateCodeScanningProbe(null).reason).toBeNull();
  });

  it("refuses to guess from a 404 body it has not measured", () => {
    for (const translate of [
      translateCodeScanningProbe,
      translateSecretScanningProbe,
    ]) {
      expect(translate({ status: 404, message: "Not Found" })).toEqual({
        state: "unknown",
        reason: "Not Found",
        answered: true,
      });
    }
  });

  it("will not read the disabled body under a status it never measured", () => {
    // A false `off` is the direction this dashboard exists to refuse, so the
    // status is part of the match rather than the message alone.
    expect(
      translateSecretScanningProbe({ status: 403, message: secretOff.body })
        .state,
    ).toBe("unknown");
  });

  it("classifies on the raw body and redacts only what it stores", () => {
    // Matching the redacted message would let a future redaction rule rewrite
    // a measured body and silently reclassify it as one we have never seen.
    const leaked = translateSecretScanningProbe({
      status: 401,
      message: "Bad credentials: ghs_AAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(leaked.reason).not.toMatch(/ghs_[A-Za-z0-9]{8,}/);
    expect(leaked.reason).toContain("Bad credentials");
    // A credential embedded in the MEASURED body still classifies as
    // measured, because the match ran before the redaction.
    expect(
      translateSecretScanningProbe({
        status: 404,
        message: `${secretOff.body} ghp_AAAAAAAAAAAAAAAAAAAA`,
      }).state,
    ).toBe("feature_off");
  });

  it("bounds the reason it stores", () => {
    const probe = translateCodeScanningProbe({
      status: 403,
      message: "x".repeat(MAX_REASON_CHARS * 3),
    });
    expect(probe.reason).toHaveLength(MAX_REASON_CHARS);
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

  it("does not call a resolution failure a switched-off scanner either", async () => {
    // The same rule, for the two new probes: a token-mint outage is not
    // GitHub saying a feature is off, and no answer, so the run degrades.
    const gh = new OctokitGitHub(
      async () => {
        throw new Error("could not mint an installation token");
      },
      () => true,
    );
    for (const probe of [
      await gh.probeCodeScanning(REPO),
      await gh.probeSecretScanning(REPO),
    ]) {
      expect(probe).toEqual({
        state: "unknown",
        reason: null,
        answered: false,
      });
    }
  });
});

describe("the cheap facts that settle every feature", () => {
  it("lets archived win over anything a probe could say", () => {
    // An archived repository can still answer 200 with old alerts. Reporting it
    // covered would promise something is watching a repository nothing updates.
    expect(wholeRepoCoverage({ archived: true, disabled: false })).toBe(
      "archived",
    );
  });

  it("does not call a GitHub-disabled repository an uninstalled App", () => {
    // GitHub's `disabled` flag is about the repository, for billing, DMCA or
    // abuse. Reporting it as a missing installation sends the operator to check
    // a setting that is fine.
    expect(wholeRepoCoverage({ archived: false, disabled: true })).toBe(
      "repo_disabled",
    );
    expect(coverageReason("repo_disabled")).toContain(
      "disabled this repository",
    );
    expect(coverageReason("repo_disabled")).not.toContain("not installed");
  });

  it("leaves the probes to decide when the cheap facts say nothing", () => {
    expect(wholeRepoCoverage({ archived: false, disabled: false })).toBeNull();
    // A repository the org listing never mentioned.
    expect(wholeRepoCoverage(undefined)).toBeNull();
  });

  it("only calls one state covered", () => {
    expect(isCovered("covered")).toBe(true);
    for (const s of COVERAGE_STATES.filter((s) => s !== "covered")) {
      expect(isCovered(s), s).toBe(false);
    }
  });

  it("reads every state but covered and unknown as positive evidence of off", () => {
    // `unknown` is not evidence: it is what a failed probe, an unprobed
    // feature and GitHub's own `no analysis found` all read as.
    expect(isOff("unknown")).toBe(false);
    expect(isOff("covered")).toBe(false);
    for (const s of COVERAGE_STATES.filter(
      (s) => s !== "covered" && s !== "unknown",
    )) {
      expect(isOff(s), s).toBe(true);
    }
  });

  it("gives a reason for every state except covered, and none for unknown's cause", () => {
    expect(coverageReason("covered")).toBeNull();
    expect(coverageReason("alerts_disabled")).toContain("switched off");
    expect(coverageReason("archived")).toContain("archived");
    expect(coverageReason("unreachable")).toContain("not installed");
    expect(coverageReason("feature_off")).toContain("switched off");
    // Deliberately not phrased as an explanation: we do not have one.
    expect(coverageReason("unknown")).toContain("not one we recognise");
  });
});

describe("the reasons a feature carries", () => {
  const feature = (state: string, reason: string | null = null) =>
    ({ state, reason }) as never;
  const features = (
    dependabot: unknown,
    code_scanning: unknown,
    secret_scanning: unknown,
  ) => ({ dependabot, code_scanning, secret_scanning }) as CoverageFeatures;

  it("prefers what GitHub said to anything derived from the state", () => {
    expect(
      featureReason(feature("feature_off", "Secret scanning is disabled.")),
    ).toBe("Secret scanning is disabled.");
  });

  it("gives no reason at all for an unknown nobody has an answer for", () => {
    // `coverageReason("unknown")` says GitHub answered something we could not
    // read. A row written before this feature was probed carries no answer of
    // any kind, and printing that sentence would claim a call never made.
    expect(featureReason(feature("unknown"))).toBeNull();
    expect(featureReason(feature("unknown", "no analysis found"))).toBe(
      "no analysis found",
    );
  });

  it("says a whole-repository fact once, unprefixed", () => {
    // Archived is true of all three features. Three copies under three
    // feature names would read as three findings where there is one.
    const archived = feature("archived");
    expect(offNotes(features(archived, archived, archived))).toEqual([
      "the repository is archived, so nothing is updating it",
    ]);
  });

  it("keeps both reasons, each named, when two features are off differently", () => {
    expect(
      offNotes(
        features(
          feature("alerts_disabled"),
          feature("covered"),
          feature("feature_off", "Secret scanning is disabled."),
        ),
      ),
    ).toEqual([
      "Dependabot alerts: switched off for this repository",
      "secret scanning: Secret scanning is disabled.",
    ]);
  });

  it("names the feature on every unanswered reason, since GitHub's do not", () => {
    // `no analysis found` on its own tells a reader nothing about WHICH
    // feature has none.
    expect(
      unansweredNotes(
        features(
          feature("covered"),
          feature("unknown", "no analysis found"),
          feature("covered"),
        ),
      ),
    ).toEqual(["code scanning: no analysis found"]);
  });

  it("drops an unanswered feature that has no message to quote", () => {
    // A row written before this feature was probed. Nobody asked GitHub, so
    // there is no answer, and none is invented.
    expect(
      unansweredNotes(
        features(feature("covered"), feature("unknown"), feature("unknown")),
      ),
    ).toEqual([]);
  });
});

describe("what standing the Security number has (#156)", () => {
  const f = (
    dependabot: string,
    code_scanning: string,
    secret_scanning: string,
  ): CoverageFeatures =>
    ({
      dependabot: { state: dependabot, reason: null },
      code_scanning: { state: code_scanning, reason: null },
      secret_scanning: { state: secret_scanning, reason: null },
    }) as CoverageFeatures;

  it("counts as soon as one collected feature is confirmed on", () => {
    // Story 3.2's rule generalised: one feature being off no longer withdraws
    // the whole number, or a repository that scans itself would show nothing.
    expect(
      securityStanding(f("alerts_disabled", "covered", "feature_off")),
    ).toBe("counted");
    expect(securityStanding(f("covered", "unknown", "feature_off"))).toBe(
      "counted",
    );
  });

  it("reads unconfirmed while a collected feature is unknown and none is on", () => {
    // The live shape of this estate: `404 no analysis found` is `unknown`, and
    // calling it `not covered` would claim GitHub said a feature is off when
    // GitHub said nothing of the kind.
    expect(
      securityStanding(f("alerts_disabled", "unknown", "feature_off")),
    ).toBe("unconfirmed");
  });

  it("reads not covered only when every collected feature is confirmed off", () => {
    // All three now, since secret scanning joined the counted set (#158).
    expect(
      securityStanding(f("alerts_disabled", "feature_off", "feature_off")),
    ).toBe("not_covered");
  });

  it("lets secret scanning license a count now that a lane sweeps it", () => {
    // The inverse of what this case asserted through Story 3.3, and the
    // inversion is the point (#158). Secret scanning confirmed ON used to
    // license nothing, because no lane collected its findings and a number
    // resting on it would have been a confident zero. Story 3.4 added the
    // lane, `COUNTED_FEATURES` gained the third entry, and the same two
    // inputs now answer `counted`: there IS something looking, so the number
    // speaks for it and the other two features ride beside it as notes.
    expect(securityStanding(f("alerts_disabled", "unknown", "covered"))).toBe(
      "counted",
    );
    expect(
      securityStanding(f("alerts_disabled", "feature_off", "covered")),
    ).toBe("counted");
  });

  it("still reads unconfirmed while secret scanning alone is unknown", () => {
    // The other half of the change: a feature joining COUNTED_FEATURES makes
    // its `unknown` withhold a number as well as making its `covered` grant
    // one. Before Story 3.4 this pair answered `not_covered`, because the
    // third feature was quantified over by nothing.
    expect(
      securityStanding(f("alerts_disabled", "feature_off", "unknown")),
    ).toBe("unconfirmed");
  });
});

describe("reading a coverage row written before the scanners were probed", () => {
  it("reads both new features as unknown, never as off", () => {
    // The whole compatibility rule (#152): the row carries `state` and
    // nothing else, and an absent field must not become a finding.
    const features = coverageFeatures({
      repo: "no42-org/twiki",
      state: "covered",
    });
    expect(features).toEqual({
      dependabot: { state: "covered", reason: null },
      code_scanning: { state: "unknown", reason: null },
      secret_scanning: { state: "unknown", reason: null },
    });
    expect(isOff(features.code_scanning.state)).toBe(false);
    expect(isOff(features.secret_scanning.state)).toBe(false);
  });

  it("reads a malformed or unrecognised stored feature as unknown", () => {
    // The store hands back JSON. A shape this lane never wrote must not
    // become a state, least of all an off one.
    expect(
      coverageFeatures({
        repo: "no42-org/twiki",
        state: "not-a-state" as never,
        codeScanning: "off" as never,
        secretScanning: { state: "switched_off", reason: 7 } as never,
      }),
    ).toEqual({
      dependabot: { state: "unknown", reason: null },
      code_scanning: { state: "unknown", reason: null },
      secret_scanning: { state: "unknown", reason: null },
    });
  });

  it("reads a row this lane wrote back exactly", () => {
    expect(
      coverageFeatures({
        repo: "no42-org/twiki",
        state: "alerts_disabled",
        codeScanning: { state: "unknown", reason: "no analysis found" },
        secretScanning: {
          state: "feature_off",
          reason: "Secret scanning is disabled on this repository.",
        },
      }),
    ).toEqual({
      dependabot: { state: "alerts_disabled", reason: null },
      code_scanning: { state: "unknown", reason: "no analysis found" },
      secret_scanning: {
        state: "feature_off",
        reason: "Secret scanning is disabled on this repository.",
      },
    });
  });
});

describe("credentials never reach a log line or the store", () => {
  it("redacts the detail a failing lane records", async () => {
    // AD-16. The realistic carrier is a GitHub auth failure quoting the
    // credential it rejected, and that detail goes to BOTH the log and
    // collection_run.detail, so redacting at the formatter alone missed it.
    const dir = mkdtempSync(join(tmpdir(), "redact-"));
    const store = SqliteStore.openForWrite(join(dir, "r.db"));
    const github = new FakeGitHubReadPort(new Map());
    const logs: string[] = [];
    github.listOrgRepos = async () => {
      throw new Error("Bad credentials: ghs_AAAAAAAAAAAAAAAAAAAAAAAA");
    };

    await collectCoverage(
      {
        github,
        store,
        watchedIn: () => [REPO],
        now: () => new Date().toISOString(),
        log: (m: string) => logs.push(m),
      },
      "no42-org",
    );

    expect(logs.join("\n")).not.toMatch(/ghs_[A-Za-z0-9]{8,}/);
    expect(store.latestRuns(1)[0]?.detail ?? "").not.toMatch(
      /ghs_[A-Za-z0-9]{8,}/,
    );
    // Still says what went wrong.
    expect(store.latestRuns(1)[0]?.detail).toContain("Bad credentials");

    store.close();
    rmSync(dir, { recursive: true, force: true });
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

  const payloadOf = (repo: RepoRef) =>
    store.current(coverageSubject(repo))?.payload as
      | CoverageObservation
      | undefined;
  const stateOf = (repo: RepoRef) => payloadOf(repo)?.state;
  const featuresOf = (repo: RepoRef) => {
    const payload = payloadOf(repo);
    return payload === undefined ? undefined : coverageFeatures(payload);
  };

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
    // The whole row, not the one field: the two scanners are written beside
    // `state`, and a test looking only at `state` would let either go
    // unwritten for months (#66).
    expect(payloadOf(REPO)).toEqual({
      repo: "no42-org/twiki",
      state: "covered",
      codeScanning: { state: "covered", reason: null },
      secretScanning: { state: "covered", reason: null },
    });
  });

  it("records the feature GitHub says is off, with GitHub's own words", async () => {
    // The story's motivating case: secret scanning switched off was
    // indistinguishable from a repository with no leaked secrets.
    const body = "Secret scanning is disabled on this repository.";
    github.secretScanning.set("no42-org/twiki", {
      state: "feature_off",
      reason: body,
      answered: true,
    });

    const result = await collectCoverage(deps(), "no42-org");

    expect(result).toMatchObject({
      outcome: "ok",
      covered: 0,
      notCovered: 1,
      unknown: 0,
    });
    expect(featuresOf(REPO)).toEqual({
      dependabot: { state: "covered", reason: null },
      code_scanning: { state: "covered", reason: null },
      secret_scanning: { state: "feature_off", reason: body },
    });
  });

  it("does not report a run partial for a measured answer that means unknown", async () => {
    // `no analysis found` is an ANSWER. Counting it as a failure to answer
    // would leave this daily lane reporting partial for ever: four of seven
    // repositories on the real estate answer exactly this.
    github.codeScanning.set("no42-org/twiki", {
      state: "unknown",
      reason: "no analysis found",
      answered: true,
    });

    const result = await collectCoverage(deps(), "no42-org");

    expect(result).toMatchObject({ outcome: "ok", unknown: 0, notCovered: 1 });
    expect(featuresOf(REPO)?.code_scanning).toEqual({
      state: "unknown",
      reason: "no analysis found",
    });
  });

  it("degrades to partial when a scanner probe reaches no answer", async () => {
    // BOTH scanners, not just the one somebody thought of. The sibling
    // asymmetry AGENTS.md records from #66: dropping the secret-scanning half
    // of this flag left the whole suite green, and a secret-scanning outage
    // would then report the daily run `ok`.
    for (const which of ["codeScanning", "secretScanning"] as const) {
      const fresh = new FakeGitHubReadPort(new Map());
      fresh.orgRepos = github.orgRepos;
      fresh[which].set("no42-org/twiki", {
        state: "unknown",
        reason: "Bad gateway",
        answered: false,
      });
      github = fresh;

      const result = await collectCoverage(deps(), "no42-org");

      expect(result, which).toMatchObject({ outcome: "partial", unknown: 1 });
      expect(store.latestRuns(1)[0]?.outcome, which).toBe("partial");
    }
  });

  it("keeps the answers beside a probe that failed, and does not freeze the row", async () => {
    // One unanswered probe used to hold back the whole row, so the two
    // answers beside it were discarded AND the attestation froze: a feature
    // switched off today went unrecorded for as long as a sibling kept
    // failing, while the row aged out of freshness.
    const body = "Secret scanning is disabled on this repository.";
    github.codeScanning.set("no42-org/twiki", {
      state: "unknown",
      reason: "Bad gateway",
      answered: false,
    });
    github.secretScanning.set("no42-org/twiki", {
      state: "feature_off",
      reason: body,
      answered: true,
    });

    const first = await collectCoverage(deps(), "no42-org");

    expect(first.outcome).toBe("partial");
    expect(featuresOf(REPO)).toEqual({
      dependabot: { state: "covered", reason: null },
      code_scanning: { state: "unknown", reason: "Bad gateway" },
      secret_scanning: { state: "feature_off", reason: body },
    });
    expect(store.current(coverageSubject(REPO))?.verifiedAt).toBeDefined();
  });

  it("does not overwrite a stored scanner state with a probe that failed", async () => {
    // Second run. A secret-scanning outage must not flip a chip back from
    // `not covered` to a plain unconfirmed by writing `unknown` over the off
    // it already knew.
    const body = "Secret scanning is disabled on this repository.";
    github.secretScanning.set("no42-org/twiki", {
      state: "feature_off",
      reason: body,
      answered: true,
    });
    await collectCoverage(deps(), "no42-org");
    const stored = store.current(coverageSubject(REPO))?.verifiedAt;

    github.secretScanning.set("no42-org/twiki", {
      state: "unknown",
      reason: null,
      answered: false,
    });
    const second = await collectCoverage(deps(), "no42-org");

    expect(second.outcome).toBe("partial");
    expect(
      featuresOf(REPO)?.secret_scanning,
      "prior knowledge survives",
    ).toEqual({ state: "feature_off", reason: body });
    // And the attestation still advanced, so a repository whose probe keeps
    // failing does not age out of freshness on a lane that is running.
    expect(store.current(coverageSubject(REPO))?.verifiedAt).not.toBe(stored);
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
    const feature = async () => {
      probes++;
      return { state: "covered", reason: null, answered: true } as const;
    };
    counting.probeCodeScanning = feature;
    counting.probeSecretScanning = feature;
    github = counting;

    await collectCoverage(deps(), "no42-org");

    // Archived is a fact about the repository, so it wins for EVERY feature
    // at write time rather than for the one that happened to be checked.
    expect(featuresOf(OLD)).toEqual({
      dependabot: { state: "archived", reason: null },
      code_scanning: { state: "archived", reason: null },
      secret_scanning: { state: "archived", reason: null },
    });
    expect(probes, "archived is free from the org listing").toBe(0);
  });

  it("records a GitHub-disabled repository the same way, and just as cheaply", async () => {
    watched = [OLD];
    github.orgRepos.set("no42-org", [meta(OLD, { disabled: true })]);
    let probes = 0;
    const counting = new FakeGitHubReadPort(new Map());
    counting.orgRepos = github.orgRepos;
    counting.probeSecretScanning = async () => {
      probes++;
      return { state: "covered", reason: null, answered: true } as const;
    };
    github = counting;

    await collectCoverage(deps(), "no42-org");

    expect(featuresOf(OLD)).toEqual({
      dependabot: { state: "repo_disabled", reason: null },
      code_scanning: { state: "repo_disabled", reason: null },
      secret_scanning: { state: "repo_disabled", reason: null },
    });
    expect(probes).toBe(0);
  });

  it("reports a probe that reached no answer as partial, not as ok", async () => {
    github.access.set("no42-org/twiki", "unknown");
    const result = await collectCoverage(deps(), "no42-org");
    // A lane reporting ok while holding unknowns lets the page treat them as
    // settled, which is the confident zero one level up.
    expect(result.outcome).toBe("partial");
    expect(result.unknown).toBe(1);
    expect(store.latestRuns(1)[0]?.detail).toContain("no answer");
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
    // A rate-limited probe reaches no answer. Persisting that over a
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

  it("a throwing logger cannot fail the lane", async () => {
    const result = await collectCoverage(
      {
        ...deps(),
        log: () => {
          throw new Error("EPIPE");
        },
      },
      "no42-org",
    );
    expect(result.outcome).toBe("ok");
    expect(store.latestRuns(1)[0]?.outcome).toBe("ok");
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
