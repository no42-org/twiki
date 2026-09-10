/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Bump,
  type CheckStatus,
  type FailingCheck,
  type ProtectionFact,
  type PullRequest,
  type RepoFacts,
  type RepoRef,
  repoSlug,
  type WorkflowRunRef,
} from "../src/core/types.js";
import type {
  CachedValidator,
  EnrichmentPort,
  KevCatalogue,
  KevFetchOutcome,
} from "../src/enrich/port.js";
// The one measured sentence, from the one place that owns it: a copy here
// would be a body string the adapter could stop matching without any test
// noticing.
import { DEPENDABOT_ALERTS_DISABLED_BODY } from "../src/github/octokit-adapter.js";
import type {
  CodeScanningAlertPage,
  DependabotAccess,
  FeatureProbe,
  FileAtRef,
  GitHubPort,
  GitHubReadPort,
  IssuePage,
  OrgAlertPage,
  PullRequestPage,
  RawCodeScanningAlert,
  RawDependabotAlert,
  RawIssue,
  RawOpenPullRequest,
  RawPullRequest,
  RawRepoMeta,
  RawReviewRequest,
  RawSecretScanningAlert,
  RawUpdatePr,
  RawUpdateStatus,
  RawWorkflowRun,
  ReleaseState,
  RequestValidator,
  ReviewRequestPage,
  SecretScanningAlertPage,
  UnlistedRepo,
  UpdatePrPage,
  WorkflowRunPage,
} from "../src/github/port.js";
import type { Advisor, AdvisorRepoInput } from "../src/twiki/advisor.js";
import type { Notifier } from "../src/twiki/notify.js";
import type { Plan } from "../src/twiki/plan.js";

const REPO: RepoRef = { owner: "no42-org", name: "demo" };

export function makeBump(partial: Partial<Bump> = {}): Bump {
  return { level: "patch", indeterminate: false, ...partial };
}

export function makePr(partial: Partial<PullRequest> = {}): PullRequest {
  return {
    repo: REPO,
    number: 1,
    title: "Bump demo from 1.0.0 to 1.0.1",
    branch: "dependabot/demo-1.0.1",
    headSha: "sha-1",
    isSecurity: false,
    isDependabot: true,
    bump: makeBump(),
    checks: "green",
    body: "",
    ...partial,
  };
}

export function makeRun(partial: Partial<WorkflowRunRef> = {}): WorkflowRunRef {
  return {
    runId: 100,
    runAttempt: 1,
    status: "completed",
    conclusion: "failure",
    ...partial,
  };
}

export function makeFacts(partial: Partial<RepoFacts> = {}): RepoFacts {
  return {
    repo: REPO,
    mainChecks: "green",
    latestTag: "v1.2.3",
    hasTagReleaseWorkflow: true,
    unreleasedDependencyCommits: 1,
    protection: {
      state: "protected",
      rulesInForce: ["pull_request", "required_status_checks"],
      inertRulesets: [],
      unreadableSources: [],
    },
    prs: [],
    ...partial,
  };
}

/**
 * A code scanning alert fixture with sensible defaults.
 *
 * `securitySeverity` defaults to a graded value, so a test that means "the
 * tool graded nothing" has to say `NOT_APPLICABLE` out loud rather than get
 * it by omission.
 */
export function makeCodeScanningAlert(
  partial: Partial<RawCodeScanningAlert> = {},
): RawCodeScanningAlert {
  // Derived from the repository and the number, as the real payload's own
  // html_url is. A constant here made every row's link identical, so a
  // rendered-HTML assertion over two rows could not tell them apart and a
  // renderer putting one row's link on another passed.
  const number = partial.number ?? 1;
  const repo = partial.repo ?? { owner: "no42-org", name: "twiki" };
  return {
    number,
    repo,
    state: "open",
    securitySeverity: "high",
    ruleId: "CVE-2026-0002",
    tool: "Trivy",
    ref: "refs/heads/main",
    htmlUrl: `https://github.com/${repo.owner}/${repo.name}/security/code-scanning/${number}`,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

/**
 * A secret scanning alert fixture with sensible defaults.
 *
 * `validity` defaults to `active`, so a test that means "GitHub said nothing
 * about this token" has to say `unknown` out loud rather than get it by
 * omission. There is no `secret` field to default, here or anywhere: the
 * credential is not part of the type.
 */
export function makeSecretScanningAlert(
  partial: Partial<RawSecretScanningAlert> = {},
): RawSecretScanningAlert {
  // Derived from the repository and the number, as the real payload's own
  // html_url is: a constant made every row's link identical, so a
  // rendered-HTML assertion over two rows could not tell them apart.
  const number = partial.number ?? 1;
  const repo = partial.repo ?? { owner: "no42-org", name: "twiki" };
  return {
    number,
    repo,
    state: "open",
    secretType: "GitHub Personal Access Token",
    validity: "active",
    publiclyLeaked: false,
    htmlUrl: `https://github.com/${repo.owner}/${repo.name}/security/secret-scanning/${number}`,
    createdAt: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

/** A Dependabot alert fixture with sensible defaults. */
export function makeAlert(
  partial: Partial<RawDependabotAlert> = {},
): RawDependabotAlert {
  return {
    number: 1,
    repo: { owner: "no42-org", name: "twiki" },
    state: "open",
    severity: "high",
    ghsaId: "GHSA-xxxx-yyyy-zzzz",
    cveId: "CVE-2026-0001",
    packageName: "left-pad",
    ecosystem: "npm",
    epssPercentage: 0.42,
    epssPercentile: 0.9,
    relationship: "direct",
    scope: "runtime",
    htmlUrl: "https://github.com/no42-org/twiki/security/dependabot/1",
    createdAt: "2026-08-01T00:00:00.000Z",
    ...partial,
  };
}

// Domain fixtures, in ONE place.
//
// Centralised because a hand-written fixture is a claim about what the API
// produces, and a claim nobody checks is how a lane collected nothing while
// 613 tests passed.
//
// What checks them is test/adapter-contract.test.ts, which drives recorded
// payloads through the real adapter and compares every mapped field. It
// covers the shapes these builders stand in for: Dependabot alerts (both
// listings), workflow runs, pull-request and issue search nodes, update
// statuses and repository metadata. It does NOT verify these literals
// directly - a builder may still say whatever it likes about a package
// name - so treat a value here as a convenience, and the contract as the
// statement about what the API actually returns.

export const makeReviewRequest = (
  over: Partial<RawReviewRequest> = {},
): RawReviewRequest => ({
  nodeId: `RR_${over.number ?? 1}`,
  repo: { owner: "OpenNMS", name: "opennms" },
  number: 8803,
  title: "NMS-19878: Topology Preview UI",
  author: "someone-else",
  htmlUrl: "https://github.com/OpenNMS/opennms/pull/8803",
  createdAt: "2026-08-19T17:48:49Z",
  requestedReviewers: ["indigo423", "christianpape"],
  ...over,
});

export const makeRawIssue = (over: Partial<RawIssue> = {}): RawIssue => ({
  nodeId: `I_${over.number ?? 1}`,
  repo: { owner: "no42-org", name: "twiki" },
  number: 1,
  title: "Crash on startup",
  author: "some-user",
  htmlUrl: "https://github.com/no42-org/twiki/issues/1",
  createdAt: "2026-08-17T00:00:00.000Z",
  ...over,
});

export const makeUpdateStatus = (
  over: Partial<RawUpdateStatus> = {},
): RawUpdateStatus => ({
  repo: { owner: "no42-org", name: "twiki" },
  alertNumber: 1,
  update: { pullRequestNumber: 10, error: null },
  ...over,
});

export const makeUpdatePr = (over: Partial<RawUpdatePr> = {}): RawUpdatePr => ({
  nodeId: `PR_${over.number ?? 1}`,
  repo: { owner: "no42-org", name: "twiki" },
  number: 1,
  title: "Bump left-pad from 1.0.0 to 1.0.1",
  // The payload spelling of the arbitrary actor the lane's suite configures
  // as `app/custom-bot`, not a third unrelated login: the lane classifies its
  // own results now (#167), so a fixture whose author no configured actor
  // matches is a fixture the lane correctly discards. Spelled with the
  // `[bot]` suffix on purpose - config says `app/x` and payloads say
  // `x[bot]`, and this is the fold in production's own shape.
  author: "custom-bot[bot]",
  htmlUrl: "https://github.com/no42-org/twiki/pull/1",
  createdAt: "2026-08-17T00:00:00.000Z",
  ...over,
});

/**
 * One open, human pull request as the plain lane's search returns it (#167).
 *
 * Its own builder rather than a variant of `makeUpdatePr`: the two carry
 * different fields (`headRef`) and, more importantly, different authors, and
 * a shared builder would make "which lane collects this" a default nobody
 * reads.
 */
export const makeOpenPr = (
  over: Partial<RawOpenPullRequest> = {},
): RawOpenPullRequest => ({
  nodeId: `PR_${over.number ?? 1}`,
  repo: { owner: "no42-org", name: "twiki" },
  number: 1,
  title: "Fix the thing",
  author: "a-contributor",
  // Derived from the number, as `nodeId` is. Hardcoded to `/pull/1`, a
  // whole-payload assertion would pin `number: 7` beside pull request 1's
  // URL, and a mapper that dropped or swapped the field would pass it.
  htmlUrl: `https://github.com/no42-org/twiki/pull/${over.number ?? 1}`,
  createdAt: "2026-09-10T00:00:00.000Z",
  headRef: "fix-the-thing",
  ...over,
});

export const makeWorkflowRun = (
  over: Partial<RawWorkflowRun> = {},
): RawWorkflowRun => ({
  nodeId: `WFR_${over.runNumber ?? 1}`,
  // Spelled out rather than reusing REPO: this builder moved here from the
  // Actions lane's own test file, where REPO meant a different repository,
  // and inheriting the wrong one silently repointed every fixture.
  repo: { owner: "no42-org", name: "packyard" },
  workflowId: 100,
  workflowName: "CI",
  runNumber: 1,
  status: "completed",
  conclusion: "success",
  headBranch: "main",
  event: "push",
  htmlUrl: "https://github.com/no42-org/packyard/actions/runs/1",
  createdAt: "2026-08-18T00:00:00.000Z",
  ...over,
});

/** Advisor stub: returns a fixed plan, or one derived from the input. */
export class StubAdvisor implements Advisor {
  constructor(
    private readonly impl: Plan | ((i: AdvisorRepoInput[]) => Plan),
  ) {}
  async plan(input: AdvisorRepoInput[]): Promise<Plan> {
    return typeof this.impl === "function" ? this.impl(input) : this.impl;
  }
}

/** Advisor that recommends merging every PR the executor is shown. */
export const mergeEverythingAdvisor = new StubAdvisor((input) => ({
  repos: input.map(({ facts }) => ({
    repo: repoSlug(facts.repo),
    prDecisions: facts.prs.map((pr) => ({
      number: pr.number,
      action: "merge" as const,
      reason: "stub: merge",
      risk: "low" as const,
    })),
    release: { action: "release" as const, reason: "stub: release" },
  })),
}));

export class CapturingNotifier implements Notifier {
  messages: string[] = [];
  async send(text: string): Promise<void> {
    this.messages.push(text);
  }
}

export interface FakeRepoData {
  rawPrs: RawPullRequest[];
  prChecks: Record<string, CheckStatus>;
  mainChecks: CheckStatus;
  latestTag: string | null;
  unreleased: number;
  hasWorkflow: boolean;
  defaultSha: string;
  /** Defaults to protected; set it to exercise the reporting paths. */
  protection?: ProtectionFact;
  /** Failing checks keyed by ref (PR head SHA, or the main SHA = defaultSha). */
  failing?: Record<string, FailingCheck[]>;
  /** Workflow runs keyed by SHA (PR head SHA, or the main SHA = defaultSha). */
  workflowRuns?: Record<string, WorkflowRunRef[]>;
  /** behind_by keyed by PR head SHA. */
  behindByMap?: Record<string, number | null>;
  /**
   * File text keyed by `<ref>:<path>`. Anything unlisted is absent AT THAT
   * REF, which is what makes "the tree is read at the sha being tagged"
   * expressible here: the same path can exist at one sha and not another.
   */
  contents?: Record<string, string>;
}

/**
 * Enrichment stub. Named and placed per the conventions, so tests stop casting
 * an object literal to the port and can no longer build states the real parser
 * refuses to produce.
 */
export class FakeEnrichmentPort implements EnrichmentPort {
  /** Ids the next fetch reports as listed. */
  cveIds: string[] = [];
  /** Entries the next fetch could not read. */
  unreadable = 0;
  version = "2026.08.17";
  released = "2026-08-17T17:00:24.7655Z";
  /** When set, the next fetch throws this instead of answering. */
  failWith: Error | null = null;
  /** When true, a conditional fetch answers 304. Unconditional still 200s. */
  notModified = false;
  /** Validators the next fresh fetch hands back. */
  validator: CachedValidator = { etag: 'W/"kev-1"', lastModified: null };
  /** What each call carried, so a test can assert conditionality. */
  cachedSeen: (CachedValidator | null)[] = [];
  calls = 0;

  endpoint(): string {
    return "https://fake.test/kev.json";
  }

  async fetchKev(cached: CachedValidator | null): Promise<KevFetchOutcome> {
    this.calls++;
    if (this.failWith) throw this.failWith;
    this.cachedSeen.push(cached);
    if (this.notModified && cached) {
      return { kind: "not_modified", validator: cached };
    }
    const catalogue: KevCatalogue = {
      version: this.version,
      released: this.released,
      claimedCount: this.cveIds.length + this.unreadable,
      cveIds: [...this.cveIds].sort(),
      unreadable: this.unreadable,
    };
    return { kind: "fresh", catalogue, validator: this.validator };
  }
}

/** GitHub's measured body when a repository has nothing analysed (#152). */
const CODE_SCANNING_NO_ANALYSIS = "no analysis found";

/**
 * What a 502 leaves behind: an answer never reached, and words that came from
 * the transport rather than from GitHub reporting on the repository.
 *
 * A real sentence rather than null, because null exercises only `named()`'s
 * "no reason recorded" fallback and nothing would then render an unreachable
 * entry carrying the words that actually come back (#169).
 */
const UNREACHABLE_BODY = "Bad gateway";

/**
 * GitHub's measured body when secret scanning is off (#152, #158).
 *
 * Measured live on `CoolModFiles` on 2026-09-09 and recorded verbatim in
 * `test/fixtures/github/secret-scanning-404.json`. Read from the fixture
 * rather than typed here, so the fake and the adapter contract test are
 * quoting the same recording and cannot drift into two different sentences.
 */
const SECRET_SCANNING_OFF: string = (
  JSON.parse(
    readFileSync(
      join(import.meta.dirname, "fixtures/github/secret-scanning-404.json"),
      "utf8",
    ),
  ) as { message: string }
).message;

/** What a 200 from either security-feature probe looks like. */
const COVERED_FEATURE: FeatureProbe = {
  state: "covered",
  reason: null,
  answered: true,
};

/** Read half, usable on its own by a consumer that holds only GitHubReadPort. */
export class FakeGitHubReadPort implements GitHubReadPort {
  /** Org-level alerts, keyed by org login. */
  orgAlerts = new Map<string, RawDependabotAlert[]>();
  /** Orgs whose next read should fail, for exercising failure isolation. */
  failingOrgs = new Set<string>();

  constructor(protected readonly data: Map<string, FakeRepoData>) {}

  /** Payloads the mapper would have dropped, per org. */
  unreadableByOrg = new Map<string, number>();

  /** Update PRs per org, and the author lists each call asked for. */
  updatePrs = new Map<string, RawUpdatePr[]>();
  updatePrUnreadable = new Map<string, number>();
  updatePrTruncated = new Set<string>();
  /**
   * Repositories the search could not cover, per org. Named, not counted:
   * the port hands the lane a list, and a fake that reduced it to a number
   * would let the lane's detail go back to counting with its tests green.
   */
  updatePrUnsearchable = new Map<string, UnlistedRepo[]>();
  updatePrQueries: {
    repos: readonly RepoRef[];
    authors: readonly string[];
  }[] = [];

  async listOpenUpdatePRs(
    repos: readonly RepoRef[],
    authors: readonly string[],
  ): Promise<UpdatePrPage> {
    this.updatePrQueries.push({ repos, authors });
    const org = repos[0]?.owner.toLowerCase() ?? "";
    return {
      prs: this.updatePrs.get(org) ?? [],
      unreadable: this.updatePrUnreadable.get(org) ?? 0,
      truncated: this.updatePrTruncated.has(org),
      unsearchable: this.updatePrUnsearchable.get(org) ?? [],
    };
  }

  /** Review requests the global search answers with (CAP-5). */
  reviewRequests: RawReviewRequest[] = [];
  reviewRequestUnreadable = 0;
  reviewRequestTruncated = false;
  /** Whose token each call authenticated with, and for whom it searched. */
  reviewRequestQueries: {
    viaInstallation: string;
    reviewers: readonly string[];
  }[] = [];

  async listReviewRequests(
    viaInstallation: string,
    reviewers: readonly string[],
  ): Promise<ReviewRequestPage> {
    this.reviewRequestQueries.push({ viaInstallation, reviewers });
    return {
      requests: this.reviewRequests,
      unreadable: this.reviewRequestUnreadable,
      truncated: this.reviewRequestTruncated,
    };
  }

  /**
   * Plain pull requests per org, and the exclusions each call asked for
   * (#167).
   *
   * Its own set of fields rather than a share of the update-PR ones: the two
   * lanes run in one sweep against one fake, and a shared map would let a
   * test that seeded one lane silently answer for the other.
   */
  pullRequests = new Map<string, RawOpenPullRequest[]>();
  pullRequestUnreadable = new Map<string, number>();
  pullRequestTruncated = new Set<string>();
  /** Repositories the pull-request search could not cover, per org. */
  pullRequestUnsearchable = new Map<string, UnlistedRepo[]>();
  pullRequestQueries: {
    repos: readonly RepoRef[];
    excludeAuthors: readonly string[];
  }[] = [];

  async listOpenPullRequests(
    repos: readonly RepoRef[],
    excludeAuthors: readonly string[],
  ): Promise<PullRequestPage> {
    this.pullRequestQueries.push({ repos, excludeAuthors });
    const org = repos[0]?.owner.toLowerCase() ?? "";
    return {
      prs: this.pullRequests.get(org) ?? [],
      unreadable: this.pullRequestUnreadable.get(org) ?? 0,
      truncated: this.pullRequestTruncated.has(org),
      unsearchable: this.pullRequestUnsearchable.get(org) ?? [],
    };
  }

  /** Untriaged issues per org, and the repo lists each call asked for. */
  issues = new Map<string, RawIssue[]>();
  issueUnreadable = new Map<string, number>();
  issueTruncated = new Set<string>();
  /** Repositories the issue search could not cover, per org. */
  issueUnsearchable = new Map<string, UnlistedRepo[]>();
  issueQueries: { repos: readonly RepoRef[] }[] = [];

  async listUntriagedIssues(repos: readonly RepoRef[]): Promise<IssuePage> {
    this.issueQueries.push({ repos });
    const org = repos[0]?.owner.toLowerCase() ?? "";
    return {
      issues: this.issues.get(org) ?? [],
      unreadable: this.issueUnreadable.get(org) ?? 0,
      truncated: this.issueTruncated.has(org),
      unsearchable: this.issueUnsearchable.get(org) ?? [],
    };
  }

  /** dependabotUpdate statuses per `owner/name`. */
  updateStatuses = new Map<string, RawUpdateStatus[]>();
  /** Repos (lowercase `owner/name`) whose status read should fail. */
  updateStatusFailing = new Set<string>();

  async listDependabotUpdateStatuses(
    repo: RepoRef,
  ): Promise<RawUpdateStatus[]> {
    const slug = repoSlug(repo).toLowerCase();
    if (this.updateStatusFailing.has(slug)) {
      throw new Error(`fake: ${slug} status read failed`);
    }
    return this.updateStatuses.get(slug) ?? [];
  }

  /** Workflow runs per lowercase `owner/name`, newest first like GitHub. */
  workflowRuns = new Map<string, RawWorkflowRun[]>();
  workflowRunUnreadable = new Map<string, number>();
  /** Repos whose next conditional read answers 304. Unconditional still 200s. */
  workflowRunNotModified = new Set<string>();
  /** Validator a 200 hands back, per repo slug. */
  workflowRunValidators = new Map<string, RequestValidator>();
  /** Repos whose read should fail. */
  workflowRunFailing = new Set<string>();
  /** What each call carried, keyed in call order. */
  workflowRunCachedSeen: { repo: string; cached: RequestValidator | null }[] =
    [];

  async listRepoWorkflowRuns(
    repo: RepoRef,
    cached: RequestValidator | null = null,
  ): Promise<WorkflowRunPage> {
    const slug = repoSlug(repo).toLowerCase();
    this.workflowRunCachedSeen.push({ repo: slug, cached });
    if (this.workflowRunFailing.has(slug)) {
      throw new Error(`fake: ${slug} runs unreachable`);
    }
    if (cached && this.workflowRunNotModified.has(slug)) {
      return { runs: [], unreadable: 0, notModified: true, validator: cached };
    }
    return {
      runs: this.workflowRuns.get(slug) ?? [],
      unreadable: this.workflowRunUnreadable.get(slug) ?? 0,
      notModified: false,
      validator: this.workflowRunValidators.get(slug) ?? null,
    };
  }

  async rateLimit(): Promise<{ limit: number; remaining: number }> {
    return { limit: 5800, remaining: 5000 };
  }

  /** Repository metadata per org, for the coverage lane. */
  orgRepos = new Map<string, RawRepoMeta[]>();
  /** Probe answers per `owner/name`; anything unset reads as covered. */
  access = new Map<string, DependabotAccess>();
  /** Code scanning probe answers per `owner/name`; unset reads as covered. */
  codeScanning = new Map<string, FeatureProbe>();
  /** Secret scanning probe answers per `owner/name`; unset reads as covered. */
  secretScanning = new Map<string, FeatureProbe>();

  async listOrgRepos(org: string): Promise<RawRepoMeta[]> {
    return this.orgRepos.get(org) ?? [];
  }

  async probeDependabotAccess(repo: RepoRef): Promise<DependabotAccess> {
    return this.access.get(repoSlug(repo).toLowerCase()) ?? "covered";
  }

  async probeCodeScanning(repo: RepoRef): Promise<FeatureProbe> {
    return (
      this.codeScanning.get(repoSlug(repo).toLowerCase()) ?? COVERED_FEATURE
    );
  }

  async probeSecretScanning(repo: RepoRef): Promise<FeatureProbe> {
    return (
      this.secretScanning.get(repoSlug(repo).toLowerCase()) ?? COVERED_FEATURE
    );
  }

  /** Orgs whose next conditional read answers 304. Unconditional still 200s. */
  orgAlertNotModified = new Set<string>();
  /** Orgs whose listing stops at the pagination cap. */
  orgAlertTruncated = new Set<string>();
  /** Validator a 200 hands back, per org; null mimics a multi-page listing. */
  orgAlertValidators = new Map<string, RequestValidator>();
  /** What each call carried, so a test can assert conditionality. */
  orgAlertCachedSeen: (RequestValidator | null)[] = [];

  /** Alerts per lowercase `owner/name`, for the personal-account fan-out. */
  repoAlerts = new Map<string, RawDependabotAlert[]>();
  /** Accounts the fake treats as user accounts. */
  userAccounts = new Set<string>();
  /** Repos the fan-out should report as having alerts switched off. */
  alertsDisabled = new Set<string>();
  /** Repos the fan-out could not read at all. */
  unreachableRepos = new Set<string>();

  async listDependabotAlerts(
    org: string,
    repos: readonly RepoRef[] = [],
    cached: RequestValidator | null = null,
  ): Promise<OrgAlertPage> {
    if (this.userAccounts.has(org)) {
      // Recorded before anything else: a test asserting the lane sends no
      // validator on this path has nothing to assert against otherwise, and
      // the first version of that test was vacuous for exactly that reason.
      this.orgAlertCachedSeen.push(cached);
      if (this.failingOrgs.has(org)) {
        throw new Error(`fake: ${org} is unreachable`);
      }
      const alerts: RawDependabotAlert[] = [];
      let unreadable = 0;
      const unreachable: UnlistedRepo[] = [];
      const skipped: UnlistedRepo[] = [];
      for (const repo of repos) {
        const slug = repoSlug(repo).toLowerCase();
        if (this.alertsDisabled.has(slug)) {
          skipped.push({ repo, reason: DEPENDABOT_ALERTS_DISABLED_BODY });
          continue;
        }
        if (this.unreachableRepos.has(slug)) {
          unreachable.push({ repo, reason: UNREACHABLE_BODY });
          continue;
        }
        alerts.push(...(this.repoAlerts.get(slug) ?? []));
        unreadable += this.unreadableByOrg.get(slug) ?? 0;
      }
      return {
        alerts,
        unreadable,
        unreachable,
        skipped,
        notModified: false,
        truncated: false,
        validator: null,
      };
    }
    if (this.failingOrgs.has(org)) {
      throw new Error(`fake: ${org} is unreachable`);
    }
    this.orgAlertCachedSeen.push(cached);
    if (cached && this.orgAlertNotModified.has(org)) {
      return {
        alerts: [],
        unreadable: 0,
        unreachable: [],
        skipped: [],
        notModified: true,
        truncated: false,
        validator: cached,
      };
    }
    return {
      alerts: this.orgAlerts.get(org) ?? [],
      unreadable: this.unreadableByOrg.get(org) ?? 0,
      unreachable: [],
      skipped: [],
      notModified: false,
      truncated: this.orgAlertTruncated.has(org),
      validator: this.orgAlertValidators.get(org) ?? null,
    };
  }

  /** Code scanning alerts per lowercase org login, for the org-level path. */
  orgCodeScanningAlerts = new Map<string, RawCodeScanningAlert[]>();
  /** Code scanning alerts per lowercase `owner/name`, for the fan-out. */
  repoCodeScanningAlerts = new Map<string, RawCodeScanningAlert[]>();
  /** Payloads the mapper would have dropped, per org or per repo slug. */
  codeScanningUnreadable = new Map<string, number>();
  /** Orgs whose next conditional read answers 304. Unconditional still 200s. */
  codeScanningNotModified = new Set<string>();
  /** Orgs whose listing stops at the pagination cap. */
  codeScanningTruncated = new Set<string>();
  /** Validator a 200 hands back, per org; null mimics a multi-page listing. */
  codeScanningValidators = new Map<string, RequestValidator>();
  /** What each call carried, so a test can assert conditionality. */
  codeScanningCachedSeen: (RequestValidator | null)[] = [];
  /** The account and the repository list each call was given. */
  codeScanningQueries: { org: string; repos: readonly RepoRef[] }[] = [];
  /** Orgs whose code scanning read should fail outright. */
  codeScanningFailingOrgs = new Set<string>();
  /** Repos GitHub answered with no analysis to list, on the fan-out. */
  codeScanningSkipped = new Set<string>();
  /** Repos the fan-out could not read at all. */
  codeScanningUnreachable = new Set<string>();

  async listCodeScanningAlerts(
    org: string,
    repos: readonly RepoRef[] = [],
    cached: RequestValidator | null = null,
  ): Promise<CodeScanningAlertPage> {
    // Recorded before any early return, for the reason the alert fake states:
    // a test asserting the lane sends no validator on the fan-out has nothing
    // to assert against otherwise.
    this.codeScanningCachedSeen.push(cached);
    this.codeScanningQueries.push({ org, repos });
    if (this.codeScanningFailingOrgs.has(org)) {
      throw new Error(`fake: ${org} code scanning is unreachable`);
    }
    if (this.userAccounts.has(org)) {
      const alerts: RawCodeScanningAlert[] = [];
      let unreadable = 0;
      const unreachable: UnlistedRepo[] = [];
      const skipped: UnlistedRepo[] = [];
      for (const repo of repos) {
        const slug = repoSlug(repo).toLowerCase();
        if (this.codeScanningSkipped.has(slug)) {
          skipped.push({ repo, reason: CODE_SCANNING_NO_ANALYSIS });
          continue;
        }
        if (this.codeScanningUnreachable.has(slug)) {
          unreachable.push({ repo, reason: null });
          continue;
        }
        alerts.push(...(this.repoCodeScanningAlerts.get(slug) ?? []));
        unreadable += this.codeScanningUnreadable.get(slug) ?? 0;
      }
      return {
        alerts,
        unreadable,
        unreachable,
        skipped,
        notModified: false,
        truncated: false,
        validator: null,
      };
    }
    if (cached && this.codeScanningNotModified.has(org)) {
      return {
        alerts: [],
        unreadable: 0,
        unreachable: [],
        skipped: [],
        notModified: true,
        truncated: false,
        validator: cached,
      };
    }
    return {
      alerts: this.orgCodeScanningAlerts.get(org) ?? [],
      unreadable: this.codeScanningUnreadable.get(org) ?? 0,
      unreachable: [],
      skipped: [],
      notModified: false,
      truncated: this.codeScanningTruncated.has(org),
      validator: this.codeScanningValidators.get(org) ?? null,
    };
  }

  /** Secret scanning alerts per lowercase org login, for the org-level path. */
  orgSecretScanningAlerts = new Map<string, RawSecretScanningAlert[]>();
  /** Secret scanning alerts per lowercase `owner/name`, for the fan-out. */
  repoSecretScanningAlerts = new Map<string, RawSecretScanningAlert[]>();
  /** Payloads the mapper would have dropped, per org or per repo slug. */
  secretScanningUnreadable = new Map<string, number>();
  /** Orgs whose next conditional read answers 304. Unconditional still 200s. */
  secretScanningNotModified = new Set<string>();
  /** Orgs whose listing stops at the pagination cap. */
  secretScanningTruncated = new Set<string>();
  /** Validator a 200 hands back, per org; null mimics a multi-page listing. */
  secretScanningValidators = new Map<string, RequestValidator>();
  /** What each call carried, so a test can assert conditionality. */
  secretScanningCachedSeen: (RequestValidator | null)[] = [];
  /** The account and the repository list each call was given. */
  secretScanningQueries: { org: string; repos: readonly RepoRef[] }[] = [];
  /** Orgs whose secret scanning read should fail outright. */
  secretScanningFailingOrgs = new Set<string>();
  /** Repos GitHub answered with the feature switched off, on the fan-out. */
  secretScanningSkipped = new Set<string>();
  /** Repos the fan-out could not read at all. */
  secretScanningUnreachable = new Set<string>();

  async listSecretScanningAlerts(
    org: string,
    repos: readonly RepoRef[] = [],
    cached: RequestValidator | null = null,
  ): Promise<SecretScanningAlertPage> {
    // Recorded before any early return, for the reason the two fakes above
    // state: a test asserting the lane sends no validator on the fan-out has
    // nothing to assert against otherwise.
    this.secretScanningCachedSeen.push(cached);
    this.secretScanningQueries.push({ org, repos });
    if (this.secretScanningFailingOrgs.has(org)) {
      throw new Error(`fake: ${org} secret scanning is unreachable`);
    }
    if (this.userAccounts.has(org)) {
      const alerts: RawSecretScanningAlert[] = [];
      let unreadable = 0;
      const unreachable: UnlistedRepo[] = [];
      const skipped: UnlistedRepo[] = [];
      for (const repo of repos) {
        const slug = repoSlug(repo).toLowerCase();
        if (this.secretScanningSkipped.has(slug)) {
          skipped.push({ repo, reason: SECRET_SCANNING_OFF });
          continue;
        }
        if (this.secretScanningUnreachable.has(slug)) {
          unreachable.push({ repo, reason: null });
          continue;
        }
        alerts.push(...(this.repoSecretScanningAlerts.get(slug) ?? []));
        unreadable += this.secretScanningUnreadable.get(slug) ?? 0;
      }
      return {
        alerts,
        unreadable,
        unreachable,
        skipped,
        notModified: false,
        truncated: false,
        validator: null,
      };
    }
    if (cached && this.secretScanningNotModified.has(org)) {
      return {
        alerts: [],
        unreadable: 0,
        unreachable: [],
        skipped: [],
        notModified: true,
        truncated: false,
        validator: cached,
      };
    }
    return {
      alerts: this.orgSecretScanningAlerts.get(org) ?? [],
      unreadable: this.secretScanningUnreadable.get(org) ?? 0,
      unreachable: [],
      skipped: [],
      notModified: false,
      truncated: this.secretScanningTruncated.has(org),
      validator: this.secretScanningValidators.get(org) ?? null,
    };
  }

  protected get(repo: RepoRef): FakeRepoData {
    const d = this.data.get(repoSlug(repo));
    if (!d) throw new Error(`no fake data for ${repoSlug(repo)}`);
    return d;
  }

  async listOpenDependabotPRs(repo: RepoRef): Promise<RawPullRequest[]> {
    return this.get(repo).rawPrs;
  }
  async prChecks(repo: RepoRef, headSha: string): Promise<CheckStatus> {
    return this.get(repo).prChecks[headSha] ?? "pending";
  }
  async branchChecks(repo: RepoRef): Promise<CheckStatus> {
    return this.get(repo).mainChecks;
  }
  /** When set, latestTag throws: a READ failure inside the release step. */
  failLatestTagWith: Error | null = null;

  async latestTag(repo: RepoRef): Promise<string | null> {
    if (this.failLatestTagWith) throw this.failLatestTagWith;
    return this.get(repo).latestTag;
  }
  async dependabotCommitsSince(repo: RepoRef): Promise<number> {
    return this.get(repo).unreleased;
  }
  async hasTagReleaseWorkflow(repo: RepoRef): Promise<boolean> {
    return this.get(repo).hasWorkflow;
  }
  // Returns whatever a human chose, exactly like every other method here -
  // which is why the adapter carries its own recorded-payload test (D5).
  async branchProtection(repo: RepoRef): Promise<ProtectionFact> {
    return (
      this.get(repo).protection ?? {
        state: "protected",
        rulesInForce: ["pull_request"],
        inertRulesets: [],
        unreadableSources: [],
      }
    );
  }
  async defaultBranchSha(repo: RepoRef): Promise<string> {
    return this.get(repo).defaultSha;
  }
  async failingChecks(repo: RepoRef, ref: string): Promise<FailingCheck[]> {
    return this.get(repo).failing?.[ref] ?? [];
  }
  async workflowRunsForSha(
    repo: RepoRef,
    sha: string,
  ): Promise<WorkflowRunRef[]> {
    return this.get(repo).workflowRuns?.[sha] ?? [];
  }
  async behindBy(repo: RepoRef, headSha: string): Promise<number | null> {
    // Default null (unknown/fail-closed), matching the real adapter on error.
    return this.get(repo).behindByMap?.[headSha] ?? null;
  }
  /** Every content read, so a test can assert that NONE happened. */
  contentReads: { repo: string; path: string; ref: string }[] = [];

  async readFileAtRef(
    repo: RepoRef,
    path: string,
    ref: string,
  ): Promise<FileAtRef> {
    this.contentReads.push({ repo: repoSlug(repo), path, ref });
    const text = this.get(repo).contents?.[`${ref}:${path}`];
    return text === undefined ? { kind: "absent" } : { kind: "text", text };
  }
}

/** Read half plus the write half, recording every mutation for assertions. */
export class FakeGitHub extends FakeGitHubReadPort implements GitHubPort {
  merged: { repo: string; number: number }[] = [];
  tagged: { repo: string; tag: string; sha: string }[] = [];
  reran: { repo: string; runId: number }[] = [];
  rebased: { repo: string; number: number }[] = [];

  /** PR numbers whose merge throws, for exercising partial completion. */
  failMergeOn = new Map<number, Error>();
  /** Run ids whose re-run throws, and PR numbers whose rebase throws. */
  failRerunOn = new Map<number, Error>();
  failRebaseOn = new Map<number, Error>();

  async mergePR(repo: RepoRef, prNumber: number): Promise<void> {
    const fail = this.failMergeOn.get(prNumber);
    if (fail) throw fail;
    this.merged.push({ repo: repoSlug(repo), number: prNumber });
  }
  /** When set, pushTag throws this, for exercising the release-write path. */
  failTagWith: Error | null = null;

  async pushTag(repo: RepoRef, tag: string, sha: string): Promise<void> {
    if (this.failTagWith) throw this.failTagWith;
    this.tagged.push({ repo: repoSlug(repo), tag, sha });
  }
  /** Release state per "<slug>@<tag>"; anything unlisted is "none". */
  releaseStates = new Map<string, ReleaseState>();

  async releaseStateForTag(repo: RepoRef, tag: string): Promise<ReleaseState> {
    return this.releaseStates.get(`${repoSlug(repo)}@${tag}`) ?? "none";
  }
  async rerunFailedJobs(repo: RepoRef, runId: number): Promise<void> {
    const fail = this.failRerunOn.get(runId);
    if (fail) throw fail;
    this.reran.push({ repo: repoSlug(repo), runId });
  }
  async requestDependabotRebase(
    repo: RepoRef,
    prNumber: number,
  ): Promise<void> {
    const fail = this.failRebaseOn.get(prNumber);
    if (fail) throw fail;
    this.rebased.push({ repo: repoSlug(repo), number: prNumber });
  }
}

export { REPO };

/**
 * The whole primary nav as every page renders it (Story 1.8), so a page
 * test pins it entire rather than one link of it. `current` is the link
 * carrying `aria-current="page"`; a repo page has none.
 */
export const primaryNav = (
  current: "overview" | "queue" | "reviews" | null,
  at: string,
): string => {
  const link = (href: string, text: string) =>
    `<a href="${href}"${current === text ? ' aria-current="page"' : ""}>${text}</a>`;
  return (
    '<nav class="primary" aria-label="primary">' +
    link("/", "overview") +
    link("/queue", "queue") +
    link("/reviews", "reviews") +
    `<span class="rendered">rendered <time datetime="${at}">${at}</time></span>` +
    "</nav>"
  );
};
