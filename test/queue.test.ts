/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_RANK_POLICY,
  epssRank,
  type Ranking,
} from "../src/core/rank.js";
import { KEV_SUBJECT } from "../src/core/subject.js";
import { DEFAULT_NOW_EPSS, tier } from "../src/core/tier.js";
import {
  buildQueue,
  type DefaultBranchRun,
  newerRun,
} from "../src/tricorder/attention/queue.js";
import { normalise as normaliseScan } from "../src/tricorder/collect/code-scanning.js";
import { normalise } from "../src/tricorder/collect/dependabot-alerts.js";
import type { UpdatePrObservation } from "../src/tricorder/collect/update-prs.js";
import { SqliteStore } from "../src/tricorder/store/sqlite-store.js";
import { createApp } from "../src/tricorder/web/app.js";
import { makeAlert, makeCodeScanningAlert, primaryNav } from "./fakes.js";

const NOW = new Date("2026-08-17T12:00:00.000Z");
const SWEEP = { cadenceMs: 15 * 60_000 };
const DAILY = { cadenceMs: 24 * 60 * 60_000 };
const HOURLY = { cadenceMs: 60 * 60_000 };
const DEPS = {
  policy: SWEEP,
  kevPolicy: DAILY,
  actionsPolicy: HOURLY,
  rankPolicy: DEFAULT_RANK_POLICY,
  hungAfterMs: 2 * 60 * 60_000,
  defaultBranchOf: () => "main",
};
/** The `now` cut as a term rank, so a tier assertion reads ranks, not bands. */
const CUT = epssRank(DEFAULT_NOW_EPSS, DEFAULT_RANK_POLICY.epssBands);

describe("the ranked queue (CAP-6)", () => {
  let dir: string;
  let store: SqliteStore;

  const run = () =>
    store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-17T11:55:00.000Z",
    });

  const seedAlerts = (
    alerts: Parameters<typeof makeAlert>[0][],
    at = "2026-08-17T11:55:00.000Z",
  ) => {
    store.recordObservations(
      run(),
      at,
      alerts.map((a) => normalise(makeAlert(a))),
    );
  };

  const seedScans = (
    alerts: Parameters<typeof makeCodeScanningAlert>[0][],
    at = "2026-08-17T11:55:00.000Z",
  ) => {
    store.recordObservations(
      run(),
      at,
      alerts.map((a) => normaliseScan(makeCodeScanningAlert(a))),
    );
  };

  const seedKev = (cveIds: string[], at = "2026-08-17T11:00:00.000Z") => {
    store.recordObservations(run(), at, [
      {
        subject: KEV_SUBJECT,
        payload: { version: "2026.08.17", released: at, cveIds },
      },
    ]);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "queue-"));
    store = SqliteStore.openForWrite(join(dir, "q.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("code scanning findings (#156)", () => {
    it("ranks a critical finding soon, never now, and names the tool", () => {
      // Every term but severity is a fact of absence: no CVE to look up, no
      // EPSS to score, no update to bump, no fix being prepared. `now` needs
      // a broken branch, a KEV listing or an EPSS band, and this kind carries
      // none of the three, so the estate's one critical Trivy finding reaches
      // soon and stops there.
      seedScans([
        {
          number: 21,
          securitySeverity: "critical",
          tool: "Trivy",
          ruleId: "CVE-2026-31789",
        },
      ]);

      const queue = buildQueue(store, NOW, DEPS);

      // The WHOLE item, ranking included: a toMatchObject here left the
      // link, the freshness, the age and every term of the chain unbound.
      expect(queue.items).toEqual([
        {
          kind: "code_scanning",
          // NOT the stored row's key, which is `no42-org/twiki#21` and is
          // shared with a Dependabot alert of the same number: the type that
          // tells the two subjects apart lives outside the key.
          key: "no42-org/twiki#code-scanning:21",
          repo: "no42-org/twiki",
          number: 21,
          packageName: null,
          title: "CVE-2026-31789",
          // A rule id is not an advisory record: Trivy names a CVE, Scorecard
          // and zizmor never do, so the column stays empty rather than
          // meaning two different things per tool.
          advisory: null,
          htmlUrl:
            "https://github.com/no42-org/twiki/security/code-scanning/21",
          explanation: "Trivy, severity critical, on the default branch",
          kevListed: false,
          displaySeverity: "critical",
          ranking: {
            // Every term but severity is a fact of absence, so the key is a
            // run of least-known ranks with one graded severity in it. That
            // is what makes `now` unreachable for this kind: `now` needs the
            // broken, KEV or EPSS term, and all three are least-known here.
            key: [0, 0, 0, 4, 0, 0],
            terms: [
              { name: "broken", rank: 0, reason: "Trivy" },
              { name: "kev", rank: 0, reason: "" },
              { name: "epss", rank: 0, reason: "" },
              { name: "severity", rank: 4, reason: "severity critical" },
              { name: "bump", rank: 0, reason: "on the default branch" },
              { name: "stuck", rank: 0, reason: "" },
            ],
            explanation: "Trivy, severity critical, on the default branch",
          },
          freshness: "fresh",
          age: "5m ago",
        },
      ]);
      expect(tier(queue.items[0]?.ranking as Ranking, CUT)).toBe("soon");
    });

    it("refuses a javascript: href on a finding, as it does on an alert", () => {
      // The first store-derived href of this kind, and hono/jsx renders a
      // `javascript:` scheme verbatim. A row carrying one is a corrupted or
      // foreign row, and the item drops the link rather than the row.
      seedScans([
        { number: 21, htmlUrl: "javascript:alert(1)" as unknown as string },
      ]);

      const queue = buildQueue(store, NOW, DEPS);

      expect(queue.items[0]?.htmlUrl).toBeNull();
      expect(queue.items[0]?.number).toBe(21);
    });

    it("keeps an ungraded finding in the queue, below every graded one", () => {
      // `n/a`, not unknown: the tool grades nothing, which is a fact, and it
      // must not float above findings we did measure.
      seedScans([
        { number: 46, securitySeverity: "n/a", tool: "zizmor" },
        { number: 21, securitySeverity: "high", tool: "Trivy" },
      ]);

      const queue = buildQueue(store, NOW, DEPS);

      expect(queue.items.map((i) => i.number)).toEqual([21, 46]);
      // The signal as it stands, not a null: `n/a` says the tool grades
      // nothing, where null would say we failed to read a grade, and the
      // repository's worst severity reads the difference.
      expect(queue.items[1]?.displaySeverity).toBe("n/a");
      expect(queue.items[1]?.explanation).toBe(
        "zizmor, no severity from the tool, on the default branch",
      );
    });

    it("leaves a finding off the default branch out of the queue entirely", () => {
      // Stored by the lane regardless of ref; the condition is applied here
      // and only here. `refs/pull/7/merge` is not a branch, so the shared
      // predicate answers false rather than parsing a name out of it.
      seedScans([
        { number: 7, ref: "refs/pull/7/merge" },
        { number: 8, ref: "refs/heads/main" },
      ]);

      const queue = buildQueue(store, NOW, DEPS);

      expect(queue.items.map((i) => i.number)).toEqual([8]);
      // Not an unreadable row: we read it perfectly well and it is simply
      // not a claim about the shipped branch.
      expect(queue.unreadable).toBe(0);
    });

    it("honours a repository whose default branch is not main", () => {
      seedScans([{ number: 8, ref: "refs/heads/master" }]);

      expect(buildQueue(store, NOW, DEPS).items).toEqual([]);
      expect(
        buildQueue(store, NOW, {
          ...DEPS,
          defaultBranchOf: () => "master",
        }).items.map((i) => i.number),
      ).toEqual([8]);
    });

    it("derives nothing when the default branch could not be resolved", () => {
      // A guard turning a broken configuration into a measured zero is the
      // failure this whole line of work exists to prevent (AD-33).
      seedScans([{ number: 8 }]);

      const queue = buildQueue(store, NOW, {
        ...DEPS,
        defaultBranchOf: () => null,
      });

      expect(queue.items).toEqual([]);
      expect(queue.unreadable).toBe(0);
    });

    it("counts a row it cannot read and never renders it as an item", () => {
      store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
        {
          subject: { type: "code_scanning_alert", key: "no42-org/twiki#9" },
          payload: { number: 9, repo: "no42-org/twiki", severity: 3 },
        },
      ] as never[]);

      const queue = buildQueue(store, NOW, DEPS);

      expect(queue.items).toEqual([]);
      expect(queue.unreadable).toBe(1);
    });

    it("keeps a code scanning alert and a Dependabot alert of the same number apart", () => {
      // Two subject types over one key space: alert 21 and code scanning
      // alert 21 in one repository are two items, not one contested row.
      seedAlerts([{ number: 21, epssPercentage: 0.02, severity: "high" }]);
      seedScans([{ number: 21, securitySeverity: "high" }]);

      const queue = buildQueue(store, NOW, DEPS);

      // The KEYS, not just the kinds: `alertSubject` puts the type outside
      // the key, so both rows are stored under `no42-org/twiki#21` and the
      // items would collide as render keys, tie the queue's final tiebreak,
      // and in Epic 4 have one finding suppress the other's notification.
      expect(queue.items.map((i) => [i.kind, i.key])).toEqual([
        ["alert", "no42-org/twiki#21"],
        ["code_scanning", "no42-org/twiki#code-scanning:21"],
      ]);
    });
  });

  it("sorts a KEV-listed alert above a higher-EPSS one with no listing", () => {
    // Story 18's acceptance criterion, word for word. This is the ordering the
    // whole chain exists to produce, and until this page nothing asserted it
    // end to end against the store.
    seedKev(["CVE-2021-44228"]);
    seedAlerts([
      {
        number: 1,
        cveId: "CVE-2025-0001",
        epssPercentage: 0.69,
        severity: "high",
      },
      {
        number: 2,
        cveId: "CVE-2021-44228",
        epssPercentage: 0.02,
        severity: "critical",
      },
    ]);

    const queue = buildQueue(store, NOW, DEPS);

    expect(queue.items.map((i) => i.number)).toEqual([2, 1]);
    expect(queue.items[0]?.kevListed).toBe(true);
    expect(queue.items[0]?.explanation).toContain("listed in CISA KEV");
  });

  it("ranks an alert with no EPSS above one measured low, never below", () => {
    // AD-20: absent ranks as unknown, never as zero risk. 9 of the 67 alerts
    // measured on the live estate carried no EPSS, so this is a standing path.
    seedKev(["CVE-0000-0000"]);
    seedAlerts([
      { number: 1, epssPercentage: 0.001, severity: "high" },
      { number: 2, epssPercentage: null, severity: "high" },
    ]);

    const queue = buildQueue(store, NOW, DEPS);

    expect(queue.items.map((i) => i.number)).toEqual([2, 1]);
    expect(queue.items[0]?.explanation).toContain("EPSS unknown");
  });

  it("ranks every KEV verdict unknown when the catalogue was never fetched", () => {
    // The story's other acceptance criterion: a failed KEV fetch renders
    // unknown and ranks as unknown, never as "not listed".
    seedAlerts([{ number: 1, cveId: "CVE-2025-0001", epssPercentage: 0.02 }]);

    const queue = buildQueue(store, NOW, DEPS);

    expect(queue.kev.usable).toBe(false);
    expect(queue.items[0]?.explanation).toContain("KEV status unknown");
  });

  it("stops trusting KEV verdicts once the catalogue goes stale", () => {
    seedKev(["CVE-2025-0001"], "2026-08-10T00:00:00.000Z");
    seedAlerts([{ number: 1, cveId: "CVE-2025-0001" }]);

    const queue = buildQueue(store, NOW, DEPS);

    expect(queue.kev.usable).toBe(false);
    expect(queue.items[0]?.explanation).toContain("KEV status unknown");
  });

  it("says n/a rather than unknown for an advisory with no CVE", () => {
    seedKev(["CVE-0000-0000"]);
    seedAlerts([{ number: 1, cveId: null, ghsaId: "GHSA-xxxx-yyyy-zzzz" }]);

    const queue = buildQueue(store, NOW, DEPS);

    expect(queue.items[0]?.advisory).toBe("GHSA-xxxx-yyyy-zzzz");
    expect(queue.items[0]?.explanation).toContain("no CVE to check");
  });

  it("excludes a resolved alert from the queue", () => {
    seedAlerts([{ number: 1 }, { number: 2 }]);
    store.recordTombstones(run(), "2026-08-17T11:56:00.000Z", [
      { type: "dependabot_alert", key: "no42-org/twiki#1" },
    ]);

    const queue = buildQueue(store, NOW, DEPS);

    expect(queue.items.map((i) => i.number)).toEqual([2]);
  });

  it("counts an unreadable row instead of silently dropping it", () => {
    // A queue quietly missing items looks complete, which is the
    // confident-zero defect wearing a queue costume.
    seedAlerts([{ number: 1 }]);
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      {
        subject: { type: "dependabot_alert", key: "no42-org/broken#9" },
        payload: { nonsense: true },
      },
    ]);

    const queue = buildQueue(store, NOW, DEPS);

    expect(queue.items).toHaveLength(1);
    expect(queue.unreadable).toBe(1);
  });

  it("counts a row with wrong-typed fields instead of throwing downstream", () => {
    // The confirmed 500: `cveId: 42` passed the two-field guard, kevSignal
    // called (42).trim(), and the whole page answered 500. The guard now
    // validates every field the queue consumes, so this is unreadable, and
    // "counted, not guessed at" is true rather than aspirational.
    seedAlerts([{ number: 1 }]);
    for (const [key, bad] of [
      [
        "no42-org/broken#2",
        {
          ...(normalise(makeAlert({ number: 2 })).payload as object),
          cveId: 42,
        },
      ],
      [
        "no42-org/broken#3",
        {
          ...(normalise(makeAlert({ number: 3 })).payload as object),
          severity: 5,
        },
      ],
      [
        "no42-org/broken#4",
        {
          ...(normalise(makeAlert({ number: 4 })).payload as object),
          epssPercentage: "high",
        },
      ],
    ] as const) {
      store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
        { subject: { type: "dependabot_alert", key }, payload: bad },
      ]);
    }

    const queue = buildQueue(store, NOW, DEPS);

    expect(queue.items.map((i) => i.number)).toEqual([1]);
    expect(queue.unreadable).toBe(3);
  });

  it("counts a row whose cveId key is missing entirely", () => {
    // Absent is not null: a missing key would have read as "no CVE to look
    // up", sinking the alert to n/a on the chain's top term when the honest
    // answer is that the row is unreadable.
    const p = normalise(makeAlert({ number: 5 })).payload as Record<
      string,
      unknown
    >;
    delete p.cveId;
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      {
        subject: { type: "dependabot_alert", key: "no42-org/broken#5" },
        payload: p,
      },
    ]);

    const queue = buildQueue(store, NOW, DEPS);
    expect(queue.items).toHaveLength(0);
    expect(queue.unreadable).toBe(1);
  });

  it("refuses to render a link with a non-https scheme", () => {
    // First store-derived href in the codebase, and hono/jsx renders
    // javascript: schemes verbatim. GitHub only hands out https, so anything
    // else is a corrupted or foreign row and loses its link, not its row.
    seedAlerts([
      { number: 1, htmlUrl: "javascript:alert(1)" },
      { number: 2, htmlUrl: "https://github.com/x/y/security/dependabot/2" },
    ]);

    const byNumber = new Map(
      buildQueue(store, NOW, DEPS).items.map((i) => [i.number, i]),
    );
    expect(byNumber.get(1)?.htmlUrl).toBeNull();
    expect(byNumber.get(2)?.htmlUrl).toContain("https://");
  });

  it("reorders when a configured threshold moves, and only then", () => {
    // CAP-6: changing a configured threshold changes the order; no
    // configuration path reorders the chain itself.
    seedKev(["CVE-0000-0000"]);
    seedAlerts([
      { number: 1, epssPercentage: 0.2, severity: "low" },
      { number: 2, epssPercentage: 0.05, severity: "critical" },
    ]);

    const coarse = buildQueue(store, NOW, {
      ...DEPS,
      rankPolicy: { epssBands: [0.5, 0.1, 0.01] },
    });
    const fine = buildQueue(store, NOW, {
      ...DEPS,
      rankPolicy: { epssBands: [0.5, 0.3, 0.01] },
    });

    expect(coarse.items.map((i) => i.number)).toEqual([1, 2]);
    expect(fine.items.map((i) => i.number)).toEqual([2, 1]);
  });

  it("gives every row its own freshness, judged on the sweep cadence", () => {
    seedKev(["CVE-0000-0000"]);
    seedAlerts([{ number: 1 }], "2026-08-17T09:00:00.000Z");
    seedAlerts([{ number: 2 }], "2026-08-17T11:55:00.000Z");

    const byNumber = new Map(
      buildQueue(store, NOW, DEPS).items.map((i) => [i.number, i]),
    );

    expect(byNumber.get(1)?.freshness).toBe("stale");
    expect(byNumber.get(2)?.freshness).toBe("fresh");
  });

  it("breaks rank ties deterministically so the page does not reshuffle", () => {
    seedKev(["CVE-0000-0000"]);
    seedAlerts([
      { number: 3, repo: { owner: "no42-org", name: "zzz" } },
      { number: 1, repo: { owner: "no42-org", name: "aaa" } },
    ]);

    const first = buildQueue(store, NOW, DEPS).items.map((i) => i.key);
    const second = buildQueue(store, NOW, DEPS).items.map((i) => i.key);

    expect(first).toEqual(["no42-org/aaa#1", "no42-org/zzz#3"]);
    expect(second).toEqual(first);
  });
});

describe("update PRs in the queue (CAP-3)", () => {
  let dir: string;
  let store: SqliteStore;

  const run = () =>
    store.beginRun({
      lane: "graphql-update-prs",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-17T11:55:00.000Z",
    });

  const seedPr = (nodeId: string, over: Partial<UpdatePrObservation> = {}) => {
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      {
        subject: { type: "dependency_update_pr", key: nodeId },
        payload: {
          repo: "no42-org/twiki",
          number: 1,
          title: "Bump x from 1.0.0 to 1.0.1",
          author: "dependabot",
          htmlUrl: "https://github.com/no42-org/twiki/pull/1",
          createdAt: "2026-08-17T00:00:00.000Z",
          packageName: "x",
          bump: "patch",
          ...over,
        } satisfies UpdatePrObservation,
      },
    ]);
  };

  const seedAlert = (
    number: number,
    over: Partial<Parameters<typeof makeAlert>[0]> = {},
  ) => {
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number, ...over })),
    ]);
  };

  const seedKev = (cveIds: string[]) => {
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      {
        subject: KEV_SUBJECT,
        payload: { version: "v", released: "r", cveIds },
      },
    ]);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "queuepr-"));
    store = SqliteStore.openForWrite(join(dir, "qp.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("sorts a PR fixing a KEV-listed CVE above one with a higher-EPSS advisory", () => {
    // CAP-3's acceptance criterion, word for word, through the local join: the
    // stored alerts carry package, CVE, EPSS and severity, so the PR inherits
    // the risk of what it fixes without any extra API call.
    seedKev(["CVE-2021-44228"]);
    seedAlert(1, {
      packageName: "log4j",
      cveId: "CVE-2021-44228",
      epssPercentage: 0.02,
    });
    seedAlert(2, {
      packageName: "lodash",
      cveId: "CVE-2025-0001",
      epssPercentage: 0.69,
    });
    seedPr("PR_kev", { number: 10, packageName: "log4j" });
    seedPr("PR_epss", { number: 11, packageName: "lodash" });

    const prs = buildQueue(store, NOW, DEPS).items.filter(
      (i) => i.kind === "update_pr",
    );

    expect(prs.map((i) => i.number)).toEqual([10, 11]);
    expect(prs[0]?.kevListed).toBe(true);
    expect(prs[0]?.advisory).toBe("CVE-2021-44228");
  });

  it("says nothing about the build on a PR that inherited an advisory", () => {
    // The candidate-bearing branch builds its own RankInput, and nothing
    // else pinned what it passes for `broken`. A `null` there ranks UNKNOWN,
    // above the LEAST_KNOWN every alert carries, so every advisory-linked PR
    // in the estate would outrank every alert including the KEV-listed ones
    // - the inversion the chain exists to prevent, and the exact claim this
    // story rests on. The whole sentence, so the leading term is pinned by
    // its absence from it.
    seedKev(["CVE-2021-44228"]);
    seedAlert(1, {
      packageName: "log4j",
      cveId: "CVE-2021-44228",
      epssPercentage: 0.42,
      severity: "critical",
    });
    seedPr("PR_a", { number: 10, packageName: "log4j" });

    const items = buildQueue(store, NOW, DEPS).items;

    expect(items.find((i) => i.kind === "update_pr")?.explanation).toBe(
      "listed in CISA KEV, EPSS 42.0%, severity critical, patch bump, no Dependabot fix attempt on record",
    );
    // And the alert it copied from still comes first: `PR_a` sorts before
    // `no42-org/twiki#1` on the key, so only the chain can put them this way
    // round, and only if the two agree that neither says anything about a
    // build.
    expect(items.map((i) => i.kind)).toEqual(["alert", "update_pr"]);
  });

  it("treats a PR with no matching open alert as a plain update", () => {
    // Facts of absence, not gaps: no open alert affects this package, so its
    // security terms are n/a. Calling them unknown would float every routine
    // bump above every alert we checked and found absent.
    seedKev(["CVE-0000-0000"]);
    seedAlert(1, { packageName: "unrelated", epssPercentage: 0.001 });
    seedPr("PR_plain", { number: 12, packageName: "left-pad" });

    const items = buildQueue(store, NOW, DEPS).items;
    const pr = items.find((i) => i.kind === "update_pr");
    const alert = items.find((i) => i.kind === "alert");

    expect(pr?.explanation).toContain("no CVE to check");
    // The measured alert, however dull, outranks the plain update on nothing:
    // they differ only where the chain says they differ.
    expect(alert).toBeDefined();
  });

  it("orders plain updates by bump size, with unknown between patch and minor", () => {
    seedKev(["CVE-0000-0000"]);
    seedPr("PR_major", { number: 1, bump: "major", packageName: "a" });
    seedPr("PR_unknown", { number: 2, bump: null, packageName: "b" });
    seedPr("PR_patch", { number: 3, bump: "patch", packageName: "c" });

    const prs = buildQueue(store, NOW, DEPS).items.filter(
      (i) => i.kind === "update_pr",
    );

    expect(prs.map((i) => i.number)).toEqual([1, 2, 3]);
    expect(prs[1]?.explanation).toContain("bump unknown");
  });

  it("joins across the casing gap between advisory data and PR titles", () => {
    // The alert name comes from ecosystem-normalised advisory data (pip says
    // django); the PR title carries manifest casing. A case miss silently
    // loses the risk inheritance and the PR ranks as a plain update.
    seedKev(["CVE-2026-1234"]);
    seedAlert(1, {
      packageName: "django",
      cveId: "CVE-2026-1234",
      severity: "critical",
    });
    seedPr("PR_case", {
      number: 30,
      packageName: "Django",
      title: "Bump Django from 3.2 to 4.2",
    });

    const pr = buildQueue(store, NOW, DEPS).items.find(
      (i) => i.kind === "update_pr",
    );
    expect(pr?.kevListed).toBe(true);
    expect(pr?.advisory).toBe("CVE-2026-1234");

    // And the other direction, so folding only the side this fixture happens
    // to exercise cannot regress: mixed-case advisory data, lowercase title.
    seedAlert(2, {
      packageName: "Sequelize",
      cveId: "CVE-2026-9876",
      severity: "critical",
    });
    seedPr("PR_case2", {
      number: 32,
      packageName: "sequelize",
      title: "Bump sequelize from 5.0.0 to 6.0.0",
    });
    const pr2 = buildQueue(store, NOW, DEPS).items.find(
      (i) => i.kind === "update_pr" && i.number === 32,
    );
    expect(pr2?.advisory).toBe("CVE-2026-9876");
  });

  it("keeps the advisory when the only candidate ties the plain baseline", () => {
    // kev=false and below-band EPSS both rank LEAST_KNOWN, exactly like n/a,
    // so a strict comparison seeded from the baseline skipped the candidate
    // and the row said "no advisory" about a PR fixing a real one.
    seedKev(["CVE-0000-0000"]);
    seedAlert(1, {
      packageName: "left-pad",
      cveId: "CVE-2026-5555",
      epssPercentage: 0.005,
      severity: "low",
    });
    seedPr("PR_tie", { number: 31, packageName: "left-pad", bump: "patch" });

    const pr = buildQueue(store, NOW, DEPS).items.find(
      (i) => i.kind === "update_pr",
    );
    expect(pr?.advisory).toBe("CVE-2026-5555");
    expect(pr?.explanation).toContain("not in CISA KEV");
  });

  it("judges a PR fixing two advisories by the more urgent one", () => {
    seedKev(["CVE-2021-44228"]);
    seedAlert(1, {
      packageName: "log4j",
      cveId: "CVE-2025-1111",
      epssPercentage: 0.001,
      severity: "low",
    });
    seedAlert(2, {
      packageName: "log4j",
      cveId: "CVE-2021-44228",
      epssPercentage: 0.02,
      severity: "critical",
    });
    seedPr("PR_two", { number: 20, packageName: "log4j" });

    const pr = buildQueue(store, NOW, DEPS).items.find(
      (i) => i.kind === "update_pr",
    );

    expect(pr?.advisory).toBe("CVE-2021-44228");
    expect(pr?.kevListed).toBe(true);
  });

  it("counts a malformed PR row instead of dropping or throwing", () => {
    seedPr("PR_ok", { number: 1 });
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      {
        subject: { type: "dependency_update_pr", key: "PR_bad" },
        payload: { repo: "no42-org/twiki", number: "seven" },
      },
    ]);

    const queue = buildQueue(store, NOW, DEPS);
    expect(queue.items.filter((i) => i.kind === "update_pr")).toHaveLength(1);
    expect(queue.unreadable).toBe(1);
  });

  it("drops a non-https PR link but keeps the row", () => {
    seedPr("PR_evil", { number: 1, htmlUrl: "javascript:alert(1)" });
    const pr = buildQueue(store, NOW, DEPS).items.find(
      (i) => i.kind === "update_pr",
    );
    expect(pr).toBeDefined();
    expect(pr?.htmlUrl).toBeNull();
  });
});

describe("the stuck flag and untriaged issues (CAP-2, CAP-3)", () => {
  let dir: string;
  let store: SqliteStore;

  const run = () =>
    store.beginRun({
      lane: "graphql-update-status",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-17T11:55:00.000Z",
    });

  const seedAlert = (
    number: number,
    over: Partial<Parameters<typeof makeAlert>[0]> = {},
  ) => {
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number, ...over })),
    ]);
  };

  const seedStatus = (
    alertNumber: number,
    update: { pullRequestNumber: number | null; error: string | null } | null,
    repo = "no42-org/twiki",
  ) => {
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      {
        subject: {
          type: "dependabot_update_status",
          key: `${repo}#${alertNumber}`,
        },
        payload: { repo, alertNumber, update },
      },
    ]);
  };

  const seedPr = (nodeId: string, over: Partial<UpdatePrObservation> = {}) => {
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      {
        subject: { type: "dependency_update_pr", key: nodeId },
        payload: {
          repo: "no42-org/twiki",
          number: 1,
          title: "Bump x from 1.0.0 to 1.0.1",
          author: "dependabot",
          htmlUrl: "https://github.com/no42-org/twiki/pull/1",
          createdAt: "2026-08-17T00:00:00.000Z",
          packageName: "x",
          bump: "patch",
          ...over,
        } satisfies UpdatePrObservation,
      },
    ]);
  };

  const seedIssue = (nodeId: string, over: Record<string, unknown> = {}) => {
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      {
        subject: { type: "issue", key: nodeId },
        payload: {
          repo: "no42-org/twiki",
          number: 5,
          title: "Crash on startup",
          author: "some-user",
          htmlUrl: "https://github.com/no42-org/twiki/issues/5",
          createdAt: "2026-08-17T00:00:00.000Z",
          ...over,
        },
      },
    ]);
  };

  const seedKev = (cveIds: string[]) => {
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      {
        subject: KEV_SUBJECT,
        payload: { version: "v", released: "r", cveIds },
      },
    ]);
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "queues-"));
    store = SqliteStore.openForWrite(join(dir, "qs.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("distinguishes stuck, unknown, and prepared on otherwise-equal alerts", () => {
    // CAP-3's remaining criterion: an update GitHub could not prepare is
    // visible as stuck rather than silently absent. Four alerts identical on
    // every other term, so the stuck flag alone decides the order: a named
    // error first, then never-looked (unknown, AD-20), then the two facts
    // (prepared, and not-attempted) tied at the bottom.
    seedKev(["CVE-0000-0000"]);
    for (const n of [1, 2, 3, 4]) seedAlert(n);
    seedStatus(1, { pullRequestNumber: null, error: "pull_request_limit" });
    seedStatus(3, { pullRequestNumber: 10, error: null });
    seedStatus(4, null);
    // Alert 2 has no status row at all: we have not looked.

    const items = buildQueue(store, NOW, DEPS).items;

    expect(items.map((i) => i.number)).toEqual([1, 2, 3, 4]);
    expect(items[0]?.explanation).toContain(
      "GitHub could not prepare this update",
    );
    expect(items[1]?.explanation).toContain("stuck state unknown");
    expect(items[2]?.explanation).toContain("update prepared normally");
    expect(items[3]?.explanation).toContain(
      "no Dependabot fix attempt on record",
    );
  });

  it("lets stuck break ties only, never overturn a higher term", () => {
    // AD-20: the chain order is code. A stuck medium alert must not outrank a
    // critical one whose update is fine.
    seedKev(["CVE-0000-0000"]);
    seedAlert(1, { severity: "medium" });
    seedAlert(2, { severity: "critical" });
    seedStatus(1, { pullRequestNumber: null, error: "some_error" });
    seedStatus(2, { pullRequestNumber: 10, error: null });

    const items = buildQueue(store, NOW, DEPS).items;
    expect(items.map((i) => i.number)).toEqual([2, 1]);
  });

  it("joins a PR to its alert by the status's PR number, not the title", () => {
    // GitHub's own statement of which alert a PR fixes beats the parsed
    // package heuristic: here the title's name matches nothing, so only the
    // precise join can carry the advisory across.
    seedKev(["CVE-2021-44228"]);
    seedAlert(1, {
      packageName: "org.apache.logging.log4j:log4j-core",
      cveId: "CVE-2021-44228",
    });
    seedStatus(1, { pullRequestNumber: 40, error: null });
    seedPr("PR_precise", {
      number: 40,
      packageName: "log4j-core",
      title: "Bump log4j-core from 2.14.0 to 2.17.1",
    });

    const pr = buildQueue(store, NOW, DEPS).items.find(
      (i) => i.kind === "update_pr",
    );

    expect(pr?.advisory).toBe("CVE-2021-44228");
    expect(pr?.kevListed).toBe(true);
    // A PR we are looking at was prepared: the linked status settles stuck.
    expect(pr?.explanation).toContain("update prepared normally");
  });

  it("prefers the precise join over a package-name candidate", () => {
    // Two alerts share the package name; the status says this PR fixes the
    // harmless one. The heuristic alone would inherit the worst of both.
    seedKev(["CVE-2021-44228"]);
    seedAlert(1, {
      packageName: "log4j",
      cveId: "CVE-2021-44228",
      severity: "critical",
    });
    seedAlert(2, {
      packageName: "log4j",
      cveId: "CVE-2026-0002",
      epssPercentage: 0.001,
      severity: "low",
    });
    seedStatus(2, { pullRequestNumber: 50, error: null });
    seedPr("PR_linked", { number: 50, packageName: "log4j" });

    const pr = buildQueue(store, NOW, DEPS).items.find(
      (i) => i.kind === "update_pr",
    );
    expect(pr?.advisory).toBe("CVE-2026-0002");
    expect(pr?.kevListed).toBe(false);
  });

  it("marks a PR stuck when its status carries both a PR number and an error", () => {
    // A status can name a PR AND an error: the PR opened, a later update
    // attempt failed. The alert row says "could not prepare", and the PR row
    // one line away must not say "prepared normally" about the same update.
    seedKev(["CVE-0000-0000"]);
    seedAlert(1, { packageName: "left-pad" });
    seedStatus(1, { pullRequestNumber: 60, error: "update_not_possible" });
    seedPr("PR_both", { number: 60, packageName: "left-pad" });

    const items = buildQueue(store, NOW, DEPS).items;
    const pr = items.find((i) => i.kind === "update_pr");
    const alert = items.find((i) => i.kind === "alert");

    expect(pr?.explanation).toContain("GitHub could not prepare this update");
    expect(alert?.explanation).toContain(
      "GitHub could not prepare this update",
    );
  });

  it("does not fall back to the package heuristic when the linked alert is unreadable", () => {
    // The status names WHICH alert the PR fixes. If that row cannot be read,
    // the honest answer is unknown, not the terms of a different alert that
    // happens to share the package name: that is the wrong-alert inheritance
    // the precise join exists to prevent.
    seedKev(["CVE-2021-44228"]);
    seedAlert(1, {
      packageName: "log4j",
      cveId: "CVE-2021-44228",
      severity: "critical",
    });
    // Alert 2 is what the status names, and it is malformed.
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      {
        subject: { type: "dependabot_alert", key: "no42-org/twiki#2" },
        payload: { number: 2, repo: "no42-org/twiki", cveId: 42 },
      },
    ]);
    seedStatus(2, { pullRequestNumber: 70, error: null });
    seedPr("PR_ghost", { number: 70, packageName: "log4j" });

    const pr = buildQueue(store, NOW, DEPS).items.find(
      (i) => i.kind === "update_pr",
    );

    // Not the KEV-listed critical from alert 1, and not a plain update either:
    // there IS an advisory, we failed to read it, so the terms are unknown.
    expect(pr?.kevListed).toBe(false);
    expect(pr?.advisory).toBeNull();
    expect(pr?.explanation).toContain("KEV status unknown");
    expect(pr?.explanation).toContain("update prepared normally");
  });

  it("degrades a malformed status row to unknown, not to a crash or a zero", () => {
    seedKev(["CVE-0000-0000"]);
    seedAlert(1);
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      {
        subject: { type: "dependabot_update_status", key: "no42-org/twiki#1" },
        payload: { repo: "no42-org/twiki", alertNumber: 1, update: "yes" },
      },
    ]);

    const queue = buildQueue(store, NOW, DEPS);

    // Not counted as an unshown item: the degradation is visible on the alert
    // row itself, which honestly says we do not know.
    expect(queue.unreadable).toBe(0);
    expect(queue.items[0]?.explanation).toContain("stuck state unknown");
  });

  it("ranks an untriaged issue below every measured alert", () => {
    // CAP-2: the issue is on the list, but all its security terms are facts
    // of absence, so anything we actually measured outranks it.
    seedKev(["CVE-0000-0000"]);
    seedAlert(1, { epssPercentage: 0.001, severity: "low" });
    seedIssue("I_5");

    const items = buildQueue(store, NOW, DEPS).items;

    expect(items.map((i) => i.kind)).toEqual(["alert", "issue"]);
    const issue = items[1];
    expect(issue?.explanation).toBe("untriaged issue, nobody assigned");
    // Its KEV term is n/a by construction; the page must never shout it.
    expect(issue?.kevListed).toBe(false);
    expect(issue?.title).toBe("Crash on startup");
    expect(issue?.number).toBe(5);
  });

  it("counts a malformed issue row instead of dropping or throwing", () => {
    // Each bad row is wrong in exactly ONE field, so each check in the guard
    // is the only thing standing between that row and the page: a fixture
    // malformed in several fields dies on whichever check happens to run
    // first and pins none of the others.
    seedIssue("I_ok");
    seedIssue("I_bad_number", { number: "five" });
    seedIssue("I_bad_title", { title: 42 });
    // The one that detonates: htmlUrl gets .startsWith() called on it.
    seedIssue("I_bad_url", { htmlUrl: 42 });
    // A field NOTHING renders must not hide the row: only the fields the
    // page consumes are validated.
    seedIssue("I_odd_author", { author: 42, number: 6 });

    const queue = buildQueue(store, NOW, DEPS);
    expect(queue.items.filter((i) => i.kind === "issue")).toHaveLength(2);
    expect(queue.unreadable).toBe(3);
  });

  it("drops a non-https issue link but keeps the row", () => {
    seedIssue("I_evil", { htmlUrl: "javascript:alert(1)" });
    const issue = buildQueue(store, NOW, DEPS).items.find(
      (i) => i.kind === "issue",
    );
    expect(issue).toBeDefined();
    expect(issue?.htmlUrl).toBeNull();
  });
});

describe("CI failures in the queue (Story 2.3)", () => {
  let dir: string;
  let store: SqliteStore;

  const ACTIONS_LANE = "rest-actions-runs";
  const CONFIRMED_AT = "2026-08-17T11:15:00.000Z";

  /**
   * One Actions sweep: the repository's own confirmation plus its rows.
   *
   * Confirmed forty-five minutes before the render, which is STALE on the
   * fifteen-minute alert cadence - it tolerates two of them - and FRESH on
   * the lane's own hourly one. The whole feature therefore derives nothing
   * at all if the Actions policy is ever taken from the sweep budget, which
   * is what makes this the fixture rather than a five-minute-old one.
   */
  const sweep = (
    payloads: { subject: unknown; payload: unknown }[],
    at = CONFIRMED_AT,
  ) => {
    const r = store.beginRun({
      lane: ACTIONS_LANE,
      installation: "no42-org",
      scope: "full",
      startedAt: at,
    });
    store.recordObservations(r, at, payloads as never[]);
    store.finishRun(r, "ok", at);
  };

  const confirmation = (
    repo = "no42-org/twiki",
    workflows: number | null = 1,
  ) => ({
    subject: { type: "repository_actions", key: repo },
    payload: { repo, workflows, failing: 0 },
  });

  /** A stored run row. Defaults to a failed push on main two hours ago. */
  const runRow = (over: Record<string, unknown> = {}) => ({
    subject: { type: "workflow_run", key: `WFR_${over.runNumber ?? 9}` },
    payload: {
      repo: "no42-org/twiki",
      workflowId: 1,
      workflowName: "CI",
      runNumber: 9,
      status: "completed",
      conclusion: "failure",
      headBranch: "main",
      event: "push",
      htmlUrl: "https://github.com/no42-org/twiki/actions/runs/9",
      createdAt: "2026-08-17T10:00:00.000Z",
      ...over,
    },
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "queue-ci-"));
    store = SqliteStore.openForWrite(join(dir, "ci.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("derives one item per broken default-branch workflow, keyed by the workflow", () => {
    sweep([confirmation(), runRow()]);

    const { items } = buildQueue(store, NOW, DEPS);

    // The whole item, not the field somebody worried about: the key, the
    // deciding run's number and URL, the chain terms and the freshness are
    // one derivation and a test of one of them lets the rest drift.
    expect(items).toEqual([
      {
        kind: "ci_failure",
        // The workflow, not the run: a rerun that breaks the same workflow
        // again is the same thing needing the same attention.
        key: "no42-org/twiki#workflow:1",
        repo: "no42-org/twiki",
        number: 9,
        packageName: null,
        title: "CI",
        advisory: null,
        htmlUrl: "https://github.com/no42-org/twiki/actions/runs/9",
        explanation: "default branch workflow CI failed 2h ago",
        kevListed: false,
        displaySeverity: null,
        ranking: items[0]?.ranking,
        // The lane's hourly cadence: on the fifteen-minute sweep budget this
        // half-hour-old confirmation would read stale and the item would not
        // exist at all.
        freshness: "fresh",
        age: "45m ago",
      },
    ]);
    expect(items[0]?.ranking.terms).toEqual([
      {
        name: "broken",
        rank: 2,
        reason: "default branch workflow CI failed 2h ago",
      },
      { name: "kev", rank: 0, reason: "" },
      { name: "epss", rank: 0, reason: "" },
      { name: "severity", rank: 0, reason: "" },
      { name: "bump", rank: 0, reason: "" },
      { name: "stuck", rank: 0, reason: "" },
    ]);
  });

  it("reads the verdict's own word, so a hung run says hung and not failed", () => {
    sweep([
      confirmation(),
      // Started three hours before the render against a two-hour threshold:
      // hung, and it never said `failure` at all. At exactly two hours it
      // has used its whole allowance and not yet exceeded it, which is why
      // the fixture's own two-hour default is not enough here.
      runRow({
        status: "in_progress",
        conclusion: null,
        createdAt: "2026-08-17T09:00:00.000Z",
      }),
    ]);

    const { items } = buildQueue(store, NOW, DEPS);

    // What a maintainer does about a workflow that never finished is not
    // what they do about one that failed.
    expect(items.map((i) => i.explanation)).toEqual([
      "default branch workflow CI hung 3h ago",
    ]);
  });

  it("lets a green rerun clear a red main", () => {
    // The newest run of a workflow is the one that says what main is doing.
    // Selecting among the BROKEN rows first skipped the green rerun
    // entirely, so the failure it replaced kept the key and a fixed main
    // went on reading red until the store superseded the row.
    // Keys chosen so the FAILING row is the one the store returns first:
    // `currentByType` orders by subject key, so `WFR_a` before `WFR_b`. Held
    // first-wins, the failure would keep the workflow and this test would
    // pass on the wrong reason.
    sweep([
      {
        ...runRow({ runNumber: 9, conclusion: "failure" }),
        subject: { type: "workflow_run", key: "WFR_a" },
      },
      {
        ...runRow({ runNumber: 10, conclusion: "success" }),
        subject: { type: "workflow_run", key: "WFR_b" },
      },
      confirmation(),
    ]);

    expect(buildQueue(store, NOW, DEPS).items).toEqual([]);
  });

  it("resolves two rows sharing a run number by their key, not by store order", () => {
    // Asserted on the comparator directly, because the tie is invisible
    // through buildQueue: `currentByType` already returns rows in
    // subject-key order and the first row of a tie is the one held, so the
    // item comes out right whether or not the term is there - until the
    // store's ORDER BY changes. GitHub counts run numbers per workflow and a
    // re-run shares its number, so the tie itself is real, and left to the
    // store the item would name one run's link and the other's verdict.
    const at = (key: string, runNumber: number): DefaultBranchRun =>
      ({
        row: { subject: { type: "workflow_run", key } },
        run: { runNumber },
      }) as never;

    expect(newerRun(at("WFR_b", 10), at("WFR_a", 9))).toBe(true);
    expect(newerRun(at("WFR_a", 9), at("WFR_b", 10))).toBe(false);
    // The tie, both ways round, and a row against itself.
    expect(newerRun(at("WFR_a", 9), at("WFR_b", 9))).toBe(true);
    expect(newerRun(at("WFR_b", 9), at("WFR_a", 9))).toBe(false);
    expect(newerRun(at("WFR_a", 9), at("WFR_a", 9))).toBe(false);
  });

  it("derives nothing from a run row that has itself gone stale", () => {
    // The confirmation says the sweep reached this repository this hour. It
    // says nothing about THIS row, which the sweep only touches while the
    // run is inside the page it reads: a main fixed outside that window, or
    // a workflow deleted or gone quiet, keeps its last failing row for
    // ever, and without this gate it would rank `now` for ever with a stale
    // badge beside it.
    const at = "2026-08-17T11:15:00.000Z";
    const r = store.beginRun({
      lane: ACTIONS_LANE,
      installation: "no42-org",
      scope: "full",
      startedAt: at,
    });
    store.recordObservations(r, at, [confirmation()] as never[]);
    store.finishRun(r, "ok", at);
    // The row is three hours old and nothing has touched it since.
    const old = store.beginRun({
      lane: ACTIONS_LANE,
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-17T09:00:00.000Z",
    });
    store.recordObservations(old, "2026-08-17T09:00:00.000Z", [
      runRow(),
    ] as never[]);
    store.finishRun(old, "ok", "2026-08-17T09:00:00.000Z");

    expect(buildQueue(store, NOW, DEPS).items).toEqual([]);
  });

  it("derives nothing once the confirmation is tombstoned", () => {
    sweep([confirmation(), runRow()]);
    expect(buildQueue(store, NOW, DEPS).items).toHaveLength(1);

    // A tombstone is a retracted assertion, and it carries the payload
    // forward: read without the state guard it still says `workflows: 1`
    // and still vouches.
    const r = store.beginRun({
      lane: ACTIONS_LANE,
      installation: "no42-org",
      scope: "full",
      startedAt: CONFIRMED_AT,
    });
    store.recordTombstones(r, CONFIRMED_AT, [
      { type: "repository_actions" as const, key: "no42-org/twiki" },
    ]);
    store.finishRun(r, "ok", CONFIRMED_AT);

    expect(buildQueue(store, NOW, DEPS).items).toEqual([]);
  });

  it("says the time is unknown rather than never collected on a junk timestamp", () => {
    // `ageLabel` answers "never collected" for a stamp it cannot parse,
    // which would be false of a run the sweep plainly collected and would
    // read `failed never collected` in the rationale.
    sweep([confirmation(), runRow({ createdAt: "last tuesday" })]);

    expect(
      buildQueue(store, NOW, DEPS).items.map((i) => i.explanation),
    ).toEqual(["default branch workflow CI failed at an unknown time"]);
  });

  it("gives a rerun the same key, so the item does not duplicate", () => {
    sweep([
      {
        ...runRow({ runNumber: 9 }),
        subject: { type: "workflow_run", key: "WFR_a" },
      },
      // The rerun, mid-supersession: a second present row for the same
      // workflow on the same side of the default-branch line. Keyed so the
      // store returns the OLDER run first, or holding first-wins would name
      // the newer one by luck.
      {
        ...runRow({ runNumber: 10 }),
        subject: { type: "workflow_run", key: "WFR_b" },
      },
      confirmation(),
    ]);

    const { items } = buildQueue(store, NOW, DEPS);

    expect(items.map((i) => [i.key, i.number])).toEqual([
      ["no42-org/twiki#workflow:1", 10],
    ]);
  });

  it("derives nothing from a run that is not broken, and nothing off the default branch", () => {
    sweep([
      confirmation("no42-org/twiki", 4),
      runRow({ runNumber: 1, workflowId: 1, conclusion: "success" }),
      // Cancelled is `other`: not a failure of main, and guessing that it is
      // would invent red builds.
      runRow({ runNumber: 2, workflowId: 2, conclusion: "cancelled" }),
      // Failed, on a feature branch: the repository page lists it and the
      // queue does not.
      runRow({ runNumber: 3, workflowId: 3, headBranch: "feature/x" }),
      // Failed, saying `main`, from a fork's pull request (#141).
      runRow({ runNumber: 4, workflowId: 4, event: "pull_request" }),
    ]);

    expect(buildQueue(store, NOW, DEPS).items).toEqual([]);
  });

  it("derives nothing without a fresh confirmation for that repository", () => {
    // The rows are there and one of them is a red main. What is missing is
    // the sweep's word that it reached this repository, and absence of an
    // item must not be read as a green build (AD-28): the CI chip says
    // `unconfirmed` instead.
    sweep([runRow()]);
    expect(buildQueue(store, NOW, DEPS).items).toEqual([]);

    // Reached, and could not read what it found.
    sweep([confirmation("no42-org/twiki", null), runRow()]);
    expect(buildQueue(store, NOW, DEPS).items).toEqual([]);
  });

  it("derives nothing from a confirmation that has gone stale on the hourly cadence", () => {
    // Three hours old: past the hourly lane's budget, so the last word is a
    // claim nobody has renewed.
    sweep([confirmation(), runRow()], "2026-08-17T09:00:00.000Z");

    expect(buildQueue(store, NOW, DEPS).items).toEqual([]);
  });

  it("judges the branch by the repository's own declared default", () => {
    sweep([
      confirmation(),
      runRow({ runNumber: 9, headBranch: "master" }),
      runRow({ runNumber: 8, workflowId: 2, headBranch: "main" }),
    ]);

    // Declared `master`: the master run is the red main and the main one is
    // a side branch. A resolver stuck on `main` reverses both.
    expect(
      buildQueue(store, NOW, {
        ...DEPS,
        defaultBranchOf: () => "master",
      }).items.map((i) => i.number),
    ).toEqual([9]);
    expect(buildQueue(store, NOW, DEPS).items.map((i) => i.number)).toEqual([
      8,
    ]);
  });

  it("counts a run row it cannot read as unreadable, and derives no item from it", () => {
    sweep([
      confirmation(),
      {
        subject: { type: "workflow_run", key: "WFR_bad" },
        payload: { repo: "no42-org/twiki", workflowId: "one" },
      },
    ]);

    const queue = buildQueue(store, NOW, DEPS);

    expect(queue.items).toEqual([]);
    expect(queue.unreadable).toBe(1);
  });

  it("outranks a KEV-listed alert in another repository, and every item beside it", () => {
    sweep([confirmation(), runRow()]);
    const alerts = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-17T11:55:00.000Z",
    });
    store.recordObservations(alerts, "2026-08-17T11:55:00.000Z", [
      {
        subject: KEV_SUBJECT,
        payload: {
          version: "v",
          released: "r",
          cveIds: ["CVE-2021-44228"],
        },
      },
      normalise(
        makeAlert({
          number: 1,
          repo: { owner: "no42-org", name: "other" },
          cveId: "CVE-2021-44228",
          severity: "critical",
          epssPercentage: 0.9,
        }),
      ),
    ]);
    store.finishRun(alerts, "ok", "2026-08-17T11:55:00.000Z");

    // The chain is lexicographic and `broken` leads it, so no sum of the
    // terms below can overturn a red main.
    expect(buildQueue(store, NOW, DEPS).items.map((i) => i.kind)).toEqual([
      "ci_failure",
      "alert",
    ]);
  });
});

describe("the queue page", () => {
  let dir: string;
  let store: SqliteStore;

  const run = () =>
    store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-17T11:55:00.000Z",
    });

  const app = () =>
    createApp({
      defaultBranchOf: () => "main",
      store,
      watched: [{ owner: "no42-org", name: "twiki" }],
      policy: SWEEP,
      lanePolicies: { kev: DAILY },
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "queuep-"));
    store = SqliteStore.openForWrite(join(dir, "p.db"));
  });

  afterEach(() => {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the queue with reasons and per-row freshness", async () => {
    const r = run();
    store.recordObservations(r, "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number: 7, severity: "critical" })),
      {
        subject: KEV_SUBJECT,
        payload: {
          version: "2026.08.17",
          released: "x",
          cveIds: ["CVE-2026-0001"],
        },
      },
    ]);

    const res = await app().request("/queue");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(html).toContain("no42-org/twiki#7");
    expect(html).toContain("severity critical");
    expect(html).toContain("fresh");
  });

  it("answers 200 with the readable rows when a stored row is malformed", async () => {
    const r = run();
    store.recordObservations(r, "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number: 1 })),
      {
        subject: { type: "dependabot_alert", key: "no42-org/broken#2" },
        payload: { number: 2, repo: "no42-org/broken", cveId: 42 },
      },
    ]);

    const res = await app().request("/queue");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("no42-org/twiki#1");
    expect(html).toContain(
      '<p class="failed">1 stored item could not be read and is not shown. This list is incomplete.</p>',
    );
  });

  it("counts alerts, PRs and issues separately in the header", async () => {
    const r = run();
    store.recordObservations(r, "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number: 1 })),
      {
        subject: { type: "dependency_update_pr", key: "PR_h" },
        payload: {
          repo: "no42-org/twiki",
          number: 2,
          title: "Bump x from 1.0.0 to 1.0.1",
          author: "dependabot",
          htmlUrl: "https://github.com/no42-org/twiki/pull/2",
          createdAt: "2026-08-17T00:00:00.000Z",
          packageName: "x",
          bump: "patch",
        },
      },
      {
        subject: { type: "issue", key: "I_h" },
        payload: {
          repo: "no42-org/twiki",
          number: 3,
          title: "Crash on startup",
          author: "some-user",
          htmlUrl: "https://github.com/no42-org/twiki/issues/3",
          createdAt: "2026-08-17T00:00:00.000Z",
        },
      },
    ]);

    const html = await (await app().request("/queue")).text();
    // "3 open alerts" over rows that are one of each read as a collector bug
    // to anyone reconciling against GitHub's security tab.
    expect(html).toContain("1 open alerts");
    expect(html).toContain("1 update PRs");
    expect(html).toContain("1 untriaged issues");
    // The issue's title is on the row: repo#number alone forces a click.
    expect(html).toContain("Crash on startup");
    // And its rationale is the muted kind, never the KEV shout.
    expect(html).toContain(
      '<div class="why-rank">untriaged issue, nobody assigned</div>',
    );
  });

  it("renders a CI failure under its own topic, filtered by it", async () => {
    // The CI tile links here, so this is the page a reader lands on from a
    // red main. The row must carry the topic word, the workflow's name and
    // the same sentence the overview's rationale reads.
    const actions = store.beginRun({
      lane: "rest-actions-runs",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-17T11:55:00.000Z",
    });
    store.recordObservations(actions, "2026-08-17T11:55:00.000Z", [
      {
        subject: { type: "repository_actions", key: "no42-org/twiki" },
        payload: { repo: "no42-org/twiki", workflows: 1, failing: 1 },
      },
      {
        subject: { type: "workflow_run", key: "WFR_9" },
        payload: {
          repo: "no42-org/twiki",
          workflowId: 1,
          workflowName: "CI",
          runNumber: 9,
          status: "completed",
          conclusion: "failure",
          headBranch: "main",
          event: "push",
          htmlUrl: "https://github.com/no42-org/twiki/actions/runs/9",
          createdAt: "2026-08-17T10:00:00.000Z",
        },
      },
    ] as never[]);
    store.finishRun(actions, "ok", "2026-08-17T11:55:00.000Z");

    const html = await (await app().request("/queue?topic=ci")).text();

    expect(html).toContain(
      '<td class="topic" role="cell"><span class="lbl hid">Topic</span>ci</td>',
    );
    // The badge, because a run number renders exactly like an issue or a
    // pull request number and the rationale beside it calls it a workflow
    // run.
    expect(html).toContain(
      '<span class="badge">run</span> <a href="https://github.com/no42-org/twiki/actions/runs/9" target="_blank" rel="noopener noreferrer">no42-org/twiki#9<span class="ext" aria-hidden="true">\u202F\u2197</span><span class="sr-only">, opens GitHub in a new tab</span></a> · CI',
    );
    expect(html).toContain("0 open alerts · 1 broken builds · 0 update PRs");
    expect(html).toContain(
      '<div class="why-rank">default branch workflow CI failed 2h ago</div>',
    );
    expect(html).toContain("CI items · 1 shown");
  });

  it("counts a code scanning finding in the summary line, not only in the table", async () => {
    // The summary counts the TOPIC, not one kind of it. With the Dependabot
    // alerts all closed, a per-kind line read `0 open alerts` directly above
    // a table of scanner findings - the same failure it once had over the
    // first red main it ever showed.
    store.recordObservations(run(), "2026-08-17T11:55:00.000Z", [
      normaliseScan(makeCodeScanningAlert({ number: 21 })),
    ]);

    const html = await (await app().request("/queue")).text();

    expect(html).toContain(
      "1 open alerts · 0 broken builds · 0 update PRs · 0 untriaged issues",
    );
    // And it really is in the table below, so the count is not a zero of a
    // different kind that happens to read 1.
    expect(html).toContain('<span class="badge">scan</span>');
  });

  it("labels the ordering a local policy, never SSVC (AD-20)", async () => {
    const html = await (await app().request("/queue")).text();
    expect(html).toContain("local policy");
    // The whole note, as the page's footer outside main.
    expect(html).toContain(
      '</main><footer class="policy-note">Ordering is a local policy: a broken default branch, then CISA KEV listing, then EPSS, then severity, then update size, then whether GitHub could prepare the update. It is not SSVC and not any published standard.</footer>',
    );
    expect(html).toContain("not SSVC");
  });

  it("says plainly when the KEV catalogue is unavailable", async () => {
    const html = await (await app().request("/queue")).text();
    expect(html).toContain("KEV status ranks as unknown");
  });

  it("judges the KEV index on its own daily cadence, not the sweep's", async () => {
    // The view-model tests pass kevPolicy directly, so unwiring the fallback
    // in createApp was invisible: a one-hour-old catalogue is stale on the
    // sweep budget and fresh on the daily one, and only the page exercises the
    // wiring.
    const r = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-17T11:00:00.000Z",
    });
    store.recordObservations(r, "2026-08-17T11:00:00.000Z", [
      {
        subject: KEV_SUBJECT,
        payload: { version: "v", released: "x", cveIds: ["CVE-2026-0001"] },
      },
    ]);
    const r2 = store.beginRun({
      lane: "rest-org-dependabot",
      installation: "no42-org",
      scope: "full",
      startedAt: "2026-08-17T11:55:00.000Z",
    });
    store.recordObservations(r2, "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number: 1, cveId: "CVE-2026-0001" })),
    ]);

    const html = await (await app().request("/queue")).text();

    expect(html).toContain("listed in CISA KEV");
    expect(html).not.toContain("KEV status ranks as unknown");
  });

  it("applies the configured thresholds, not the defaults", async () => {
    // Under the custom bands both items share an EPSS band and severity
    // decides; under the defaults EPSS decides the other way. Unwiring
    // rankPolicy in createApp silently reverts to the defaults.
    const r = run();
    store.recordObservations(r, "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number: 1, epssPercentage: 0.2, severity: "low" })),
      normalise(
        makeAlert({ number: 2, epssPercentage: 0.05, severity: "critical" }),
      ),
    ]);

    const custom = createApp({
      defaultBranchOf: () => "main",
      store,
      watched: [{ owner: "no42-org", name: "twiki" }],
      policy: SWEEP,
      lanePolicies: { kev: DAILY },
      rankPolicy: { epssBands: [0.5, 0.3, 0.01] },
      // Bands without 0.1 need a cut of their own, exactly as at startup.
      cutRank: epssRank(0.3, [0.5, 0.3, 0.01]),
      now: () => NOW,
    });
    const html = await (await custom.request("/queue")).text();

    const first = html.indexOf("no42-org/twiki#2");
    const second = html.indexOf("no42-org/twiki#1");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(-1);
    expect(first, "critical leads under the custom bands").toBeLessThan(second);
  });

  // Story 1.8 (#129): one primary nav on every page, marking the page the
  // reader is on, with the rendered-at time as text. Asserted whole.
  const primary = (current: "overview" | "queue") =>
    primaryNav(current, "2026-08-17T12:00:00.000Z");

  it("links the pages to each other and marks the current one", async () => {
    const queue = await (await app().request("/queue")).text();
    const home = await (await app().request("/")).text();
    expect(queue).toContain(primary("queue"));
    expect(home).toContain(primary("overview"));
  });

  it("leads with one skip link to the list, then the nav, then the landmarks", async () => {
    const html = await (await app().request("/queue")).text();
    expect(html).toContain(
      '<body><a class="skip" href="#list">skip to list</a>' +
        primary("queue") +
        '<main id="main">',
    );
    // A named region, so the skip link lands on something announced.
    expect(html).toContain('<section id="list" aria-label="queue">');
    expect(html).toContain('</main><footer class="policy-note">');
    // The rendered-at time is in the nav only.
    expect(html.match(/<time /g)).toHaveLength(1);
    expect(html).not.toContain("· rendered");
  });

  it.each([
    ["/queue", "queue · gitricorder"],
    ["/queue?topic=dependencies", "queue · dependencies · gitricorder"],
    ["/queue?repo=no42-org%2Ftwiki", "queue · no42-org/twiki · gitricorder"],
    [
      "/queue?topic=dependencies&repo=no42-org%2Ftwiki",
      "queue · dependencies · no42-org/twiki · gitricorder",
    ],
    // An unknown value renders the no-matches state, so the title names no
    // filter, not even the half it understood.
    ["/queue?topic=foo", "queue · gitricorder"],
    ["/queue?topic=foo&repo=no42-org%2Ftwiki", "queue · gitricorder"],
  ])("%s carries the title %s", async (path, title) => {
    const html = await (await app().request(path)).text();
    expect(html).toContain(`<title>${title}</title>`);
  });

  // Story 1.5 (AD-39): the filter lives in the URL. The bar, the sentence
  // and the no-matches state are asserted whole, never one attribute of
  // them, so a dropped entry or a swapped aria-current cannot pass.

  const bar = (current: string | null, repo?: string) => {
    const entry = (href: string, text: string) =>
      current === text
        ? `<a href="${href}" aria-current="true">${text}</a>`
        : `<a href="${href}">${text}</a>`;
    // Under a repository filter every entry keeps it, `all` included.
    const r = repo === undefined ? "" : `repo=${encodeURIComponent(repo)}`;
    const topic = (t: string) =>
      `/queue?${r === "" ? "" : `${r}&amp;`}topic=${t}`;
    return (
      '<nav class="filters" aria-label="topic filter">' +
      entry(r === "" ? "/queue" : `/queue?${r}`, "all") +
      entry(topic("security"), "security") +
      entry(topic("ci"), "ci") +
      entry(topic("dependencies"), "dependencies") +
      entry(topic("pulls"), "pulls") +
      entry(topic("issues"), "issues") +
      '<a href="/reviews">reviews</a>' +
      "</nav>"
    );
  };

  const updatePr = (repo: string, number: number) => ({
    subject: {
      type: "dependency_update_pr" as const,
      key: `PR_${repo}_${number}`,
    },
    payload: {
      repo,
      number,
      title: `Bump x from 1.0.${number} to 1.1.0`,
      author: "dependabot",
      htmlUrl: `https://github.com/${repo}/pull/${number}`,
      createdAt: "2026-08-17T00:00:00.000Z",
      packageName: "x",
      bump: "minor",
    },
  });

  it("filters by topic, marks the bar and says what is shown", async () => {
    const r = run();
    store.recordObservations(r, "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number: 1 })),
      ...Array.from({ length: 7 }, (_, i) => updatePr("no42-org/twiki", i + 1)),
    ]);

    const res = await app().request("/queue?topic=dependencies");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(bar("dependencies"));
    expect(html).toContain(
      '<p class="filter-state">Dependency items · 7 shown · <a href="/queue">clear</a></p>',
    );
    // Only update PRs are rows; the alert is in the summary, not the list.
    expect(html).not.toContain("CVE-2026-0001");
    expect(
      html.match(
        /<td class="topic" role="cell"><span class="lbl hid">Topic<\/span>dependencies<\/td>/g,
      ),
    ).toHaveLength(7);
    expect(html).not.toContain("Topic</span>security</td>");
    expect(html).toContain("1 open alerts · 0 broken builds · 7 update PRs");
  });

  it("matches the repository by folded slug, with the topic", async () => {
    const r = run();
    store.recordObservations(r, "2026-08-17T11:55:00.000Z", [
      normalise(
        makeAlert({
          number: 1,
          repo: { owner: "Riptide-Labs", name: "riptide" },
        }),
      ),
      normalise(
        makeAlert({
          number: 2,
          repo: { owner: "riptide-labs", name: "Riptide" },
        }),
      ),
      normalise(makeAlert({ number: 3 })),
      updatePr("Riptide-Labs/riptide", 4),
    ]);
    const mixed = createApp({
      defaultBranchOf: () => "main",
      store,
      watched: [
        { owner: "no42-org", name: "twiki" },
        { owner: "Riptide-Labs", name: "riptide" },
      ],
      policy: SWEEP,
      lanePolicies: { kev: DAILY },
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });

    const res = await mixed.request(
      "/queue?repo=RIPTIDE-labs%2Friptide&topic=security",
    );
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(bar("security", "riptide-labs/riptide"));
    expect(html).toContain(
      '<p class="filter-state">Security items in riptide-labs/riptide · 2 shown · <a href="/queue">clear</a></p>',
    );
    expect(
      html.match(
        /<td class="topic" role="cell"><span class="lbl hid">Topic<\/span>security<\/td><td role="cell"><span class="lbl hid">Repository<\/span><a class="slug" href="\/repo\/riptide-labs\/riptide">riptide-labs\/riptide<\/a><\/td>/g,
      ),
    ).toHaveLength(2);
    expect(html).not.toContain("no42-org/twiki#3");
    expect(html).not.toContain("riptide#4");
  });

  it("answers an unknown topic with 200 and the no-matches sentence", async () => {
    const r = run();
    store.recordObservations(r, "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number: 1 })),
    ]);

    const res = await app().request("/queue?topic=foo");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(bar(null));
    // The list landmark is there with nothing in it but the sentence, so a
    // skip link still has somewhere to go.
    expect(html).toContain(
      '<section id="list" aria-label="queue"><p class="filter-state">No foo items open. <a href="/queue">Clear filter.</a></p></section>',
    );
    expect(html).not.toContain("<table");
    expect(html).not.toContain("Nothing needs attention");
  });

  it("treats reviews as an unknown topic: they are not queue items", async () => {
    const res = await app().request("/queue?topic=reviews");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(bar(null));
    expect(html).toContain(
      '<p class="filter-state">No reviews items open. <a href="/queue">Clear filter.</a></p>',
    );
  });

  it("answers an unwatched repository with 200 and the no-matches sentence", async () => {
    const res = await app().request("/queue?repo=not%2Fwatched");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(bar("all"));
    expect(html).toContain(
      '<p class="filter-state">No items open in not/watched. <a href="/queue">Clear filter.</a></p>',
    );
  });

  it("says a topic with no collector is not collected, never that it is empty", async () => {
    const html = await (await app().request("/queue?topic=pulls")).text();
    expect(html).toContain(bar("pulls"));
    expect(html).toContain(
      '<p class="filter-state">Pull request items are not collected yet. <a href="/queue">Clear filter.</a></p>',
    );
  });

  it("filters by repository alone, keeping the repo in the bar and the estate in the summary", async () => {
    const r = run();
    store.recordObservations(r, "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number: 1 })),
      normalise(
        makeAlert({ number: 2, repo: { owner: "no42-org", name: "other" } }),
      ),
      updatePr("no42-org/twiki", 3),
      updatePr("no42-org/gone", 4),
    ]);
    const two = createApp({
      defaultBranchOf: () => "main",
      store,
      watched: [
        { owner: "no42-org", name: "twiki" },
        { owner: "no42-org", name: "other" },
      ],
      policy: SWEEP,
      lanePolicies: { kev: DAILY },
      rankPolicy: DEFAULT_RANK_POLICY,
      now: () => NOW,
    });

    const html = await (await two.request("/queue?repo=No42-Org/twiki")).text();

    expect(html).toContain(bar("all", "no42-org/twiki"));
    expect(html).toContain(
      '<p class="filter-state">Items in no42-org/twiki · 2 shown · <a href="/queue">clear</a></p>',
    );
    // Two watched repositories, one de-listed: the summary counts the
    // watched estate, not the filter and not the de-listed PR.
    expect(html).toContain(
      "2 open alerts · 0 broken builds · 1 update PRs · 0 untriaged issues",
    );
    expect(html).not.toContain("no42-org/other#2");
    // The de-listed item is omitted under a filter, heading and all.
    expect(html).not.toContain("no42-org/gone");
    expect(html).not.toContain("no longer watched");
  });

  it("says a de-listed repository is no longer watched when asked for by name", async () => {
    const r = run();
    store.recordObservations(r, "2026-08-17T11:55:00.000Z", [
      normalise(
        makeAlert({ number: 2, repo: { owner: "no42-org", name: "gone" } }),
      ),
    ]);

    const res = await app().request("/queue?repo=no42-org%2Fgone");
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain(
      '<p class="filter-state">no42-org/gone is no longer watched. <a href="/queue">Clear filter.</a></p>',
    );
  });

  it("does not say nothing needs attention over a table of de-listed items", async () => {
    const r = run();
    store.recordObservations(r, "2026-08-17T11:55:00.000Z", [
      normalise(
        makeAlert({ number: 2, repo: { owner: "no42-org", name: "gone" } }),
      ),
    ]);

    const html = await (await app().request("/queue")).text();

    expect(html).toContain(
      "0 open alerts · 0 broken builds · 0 update PRs · 0 untriaged issues",
    );
    expect(html).toContain(
      '<section id="list" aria-label="queue"><p class="none">Nothing needs attention in watched repositories.</p></section><h2>no longer watched</h2>',
    );
    expect(html).not.toContain("Nothing needs attention.</p>");
  });

  it("says a topic with nothing open has nothing open, not zero rows", async () => {
    const r = run();
    store.recordObservations(r, "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number: 1 })),
    ]);

    const html = await (await app().request("/queue?topic=issues")).text();

    expect(html).toContain(bar("issues"));
    expect(html).toContain(
      '<p class="filter-state">No issue items open. <a href="/queue">Clear filter.</a></p>',
    );
  });

  it("lists a de-listed repository apart, counted nowhere, with no repo link", async () => {
    const r = run();
    store.recordObservations(r, "2026-08-17T11:55:00.000Z", [
      normalise(makeAlert({ number: 1, severity: "high" })),
      normalise(
        makeAlert({
          number: 2,
          severity: "critical",
          repo: { owner: "no42-org", name: "gone" },
        }),
      ),
      updatePr("no42-org/gone", 3),
    ]);

    const html = await (await app().request("/queue")).text();

    expect(html).toContain(
      "1 open alerts · 0 broken builds · 0 update PRs · 0 untriaged issues",
    );
    expect(html).toContain(bar("all"));
    expect(html).not.toContain('class="filter-state"');
    // The watched row ranks 1 in its list; the de-listed rows rank 1 and 2
    // in theirs, after the heading, with the slug as plain text.
    const heading = html.indexOf("<h2>no longer watched</h2>");
    expect(heading).toBeGreaterThan(html.indexOf("no42-org/twiki#1"));
    const after = html.slice(heading);
    // The whole row (Story 1.9, #131): six cells, each with its role and
    // its header word, the rank painted and the rest for a screen reader.
    expect(after).toContain(
      '<tr role="row">' +
        '<td class="num" role="cell"><span class="lbl">#</span>1</td>' +
        '<td class="topic" role="cell"><span class="lbl hid">Topic</span>security</td>' +
        '<td role="cell"><span class="lbl hid">Repository</span><span class="slug">no42-org/gone</span></td>' +
        '<td role="cell"><span class="lbl hid">Item</span> <a href="https://github.com/no42-org/twiki/security/dependabot/1" target="_blank" rel="noopener noreferrer">no42-org/gone#2<span class="ext" aria-hidden="true">\u202F\u2197</span><span class="sr-only">, opens GitHub in a new tab</span></a> · left-pad · CVE-2026-0001</td>' +
        '<td role="cell"><span class="lbl hid">Why it ranks here</span><div class="why-rank">KEV status unknown, EPSS 42.0%, severity critical, not an update, stuck state unknown</div></td>' +
        '<td role="cell"><span class="lbl hid">Last confirmed</span><span class="badge fresh" title="5m ago">fresh · 5m ago</span></td>' +
        "</tr>",
    );
    expect(after).toContain(
      '<td class="num" role="cell"><span class="lbl">#</span>2</td><td class="topic" role="cell"><span class="lbl hid">Topic</span>dependencies</td><td role="cell"><span class="lbl hid">Repository</span><span class="slug">no42-org/gone</span></td>',
    );
    expect(after).not.toContain('href="/repo/no42-org/gone"');
    // Under a topic filter the de-listed item is omitted, heading and all.
    const filtered = await (
      await app().request("/queue?topic=security")
    ).text();
    expect(filtered).not.toContain("no longer watched");
    expect(filtered).not.toContain("no42-org/gone");
    expect(filtered).toContain(
      '<p class="filter-state">Security items · 1 shown · <a href="/queue">clear</a></p>',
    );
  });

  it("keeps the honesty strings on the unfiltered queue", async () => {
    const html = await (await app().request("/queue")).text();
    expect(html).toContain(bar("all"));
    expect(html).toContain(
      '<section id="list" aria-label="queue"><p class="none">Nothing needs attention.</p></section>',
    );
    expect(html).not.toContain('class="filter-state"');
  });
});
