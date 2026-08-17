/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import {
  assertRankPolicy,
  compareRankings,
  DEFAULT_RANK_POLICY,
  NOT_APPLICABLE,
  type RankInput,
  rank,
} from "../src/core/rank.js";
import {
  isSeverity,
  normaliseSeverity,
  UNKNOWN_SEVERITY,
  worstSeverity,
} from "../src/core/severity.js";

const P = DEFAULT_RANK_POLICY;

/** A deliberately unremarkable item, so each test varies exactly one signal. */
const BASE: RankInput = {
  kev: false,
  epss: 0.001,
  severity: "low",
  bump: "patch",
  stuck: false,
};

const item = (over: Partial<RankInput> = {}): RankInput => ({
  ...BASE,
  ...over,
});

/** Sort most urgent first, the way a queue page would. */
const order = (inputs: readonly RankInput[]): RankInput[] =>
  [...inputs].sort((a, b) => compareRankings(rank(a, P), rank(b, P)));

const moreUrgent = (a: RankInput, b: RankInput) =>
  compareRankings(rank(a, P), rank(b, P)) < 0;

describe("severity scale", () => {
  it("uses the vocabulary the Dependabot payload actually sends", () => {
    // Measured 2026-08-17 against a live installation: 67 open alerts spelled
    // critical, high, medium and low. Not `moderate`, which is what the GHSA
    // advisory database says and what this scale was once "corrected" to.
    expect(isSeverity("medium")).toBe(true);
    expect(isSeverity("moderate")).toBe(false);
  });

  it("folds GraphQL's MODERATE onto the same value as REST's medium", () => {
    // Two lanes, two spellings, one fact. A scale that knows only one reports
    // a third of the other lane's alerts as unknown.
    expect(normaliseSeverity("MODERATE")).toBe("medium");
    expect(normaliseSeverity("moderate")).toBe("medium");
    expect(normaliseSeverity("Medium")).toBe("medium");
    expect(normaliseSeverity("CRITICAL")).toBe("critical");
  });

  it("still refuses a value that is not a severity at all", () => {
    expect(normaliseSeverity("catastrophic")).toBeNull();
    expect(normaliseSeverity("")).toBeNull();
  });

  it("treats both spellings as equal when picking the worst", () => {
    expect(worstSeverity(["low", "MODERATE"])).toBe("medium");
    expect(worstSeverity(["medium", "moderate"])).toBe("medium");
  });

  it("reports the worst present", () => {
    expect(worstSeverity(["low", "critical", "medium"])).toBe("critical");
    expect(worstSeverity(["low", "medium"])).toBe("medium");
  });

  it("does not depend on the order they arrived in", () => {
    expect(worstSeverity(["medium", "low"])).toBe(
      worstSeverity(["low", "medium"]),
    );
  });

  it("distinguishes nothing-to-report from could-not-read", () => {
    expect(worstSeverity([])).toBeNull();
    expect(worstSeverity(["low", "not-a-severity"])).toBe(UNKNOWN_SEVERITY);
  });

  it("lets critical outrank an unrecognised value", () => {
    expect(worstSeverity(["critical", "not-a-severity"])).toBe("critical");
  });
});

describe("the ranking chain (AD-20)", () => {
  describe("order is code", () => {
    it("puts KEV above everything below it", () => {
      // The KEV item is worse on nothing else at all.
      const kev = item({
        kev: true,
        epss: 0.0,
        severity: "low",
        bump: "patch",
      });
      const rest = item({
        kev: false,
        epss: 0.99,
        severity: "critical",
        bump: "major",
      });
      expect(moreUrgent(kev, rest)).toBe(true);
    });

    it("puts EPSS above severity", () => {
      const highEpss = item({ epss: 0.9, severity: "low" });
      const highSeverity = item({ epss: 0.001, severity: "critical" });
      expect(moreUrgent(highEpss, highSeverity)).toBe(true);
    });

    it("puts severity above bump type", () => {
      const severe = item({ severity: "critical", bump: "patch" });
      const major = item({ severity: "low", bump: "major" });
      expect(moreUrgent(severe, major)).toBe(true);
    });

    it("breaks ties down the chain, not across it", () => {
      const a = item({ severity: "high", bump: "patch" });
      const b = item({ severity: "high", bump: "major" });
      expect(moreUrgent(b, a)).toBe(true);
    });

    it("orders a realistic queue by the chain", () => {
      const kevListed = item({ kev: true, epss: 0.0, severity: "low" });
      const exploitable = item({ epss: 0.8, severity: "low" });
      const severe = item({ epss: 0.001, severity: "critical" });
      const dull = item();
      expect(order([dull, severe, exploitable, kevListed])).toEqual([
        kevListed,
        exploitable,
        severe,
        dull,
      ]);
    });
  });

  describe("absent ranks as unknown, never as zero risk", () => {
    it("ranks unknown KEV above a confirmed absence", () => {
      expect(moreUrgent(item({ kev: null }), item({ kev: false }))).toBe(true);
    });

    it("ranks unknown KEV below a confirmed listing", () => {
      expect(moreUrgent(item({ kev: true }), item({ kev: null }))).toBe(true);
    });

    it("ranks unknown EPSS above a measured low one", () => {
      // The whole point: a lookup we failed to do must not sink below an item
      // we actually measured and found harmless.
      expect(moreUrgent(item({ epss: null }), item({ epss: 0.0 }))).toBe(true);
    });

    it("ranks unknown EPSS below every measured band", () => {
      expect(moreUrgent(item({ epss: 0.02 }), item({ epss: null }))).toBe(true);
    });

    it("ranks unknown severity above low", () => {
      expect(
        moreUrgent(item({ severity: null }), item({ severity: "low" })),
      ).toBe(true);
    });

    it("ranks unknown severity below moderate", () => {
      expect(
        moreUrgent(item({ severity: "medium" }), item({ severity: null })),
      ).toBe(true);
    });

    it("ranks unknown bump above patch", () => {
      expect(moreUrgent(item({ bump: null }), item({ bump: "patch" }))).toBe(
        true,
      );
    });

    it("ranks a value it does not recognise as unknown, not as safest", () => {
      // The types stop this at compile time, but they stop it only in code we
      // control. GitHub can add a severity or a bump kind at any time, and a
      // lane would hand the new string straight through. Ranking it as the
      // safe end would hide the one item nobody has a rule for yet.
      const alien = item({ severity: "catastrophic" as never });
      expect(moreUrgent(alien, item({ severity: "low" }))).toBe(true);
      expect(moreUrgent(item({ severity: "medium" }), alien)).toBe(true);

      const alienBump = item({ bump: "epoch" as never });
      expect(moreUrgent(alienBump, item({ bump: "patch" }))).toBe(true);
    });

    it("never lets an all-unknown item rank last", () => {
      const nothingKnown = item({
        kev: null,
        epss: null,
        severity: null,
        bump: null,
        stuck: null,
      });
      const measuredHarmless = item({
        kev: false,
        epss: 0,
        severity: "low",
        bump: "patch",
        stuck: false,
      });
      expect(order([measuredHarmless, nothingKnown])[0]).toBe(nothingKnown);
    });
  });

  describe("nothing to know is not the same as not knowing", () => {
    it("does not float a CVE-less bump above a checked security alert", () => {
      // KEV is the top term, so this one conflation decides the whole queue.
      // Most update pull requests have no CVE at all; if "nothing to look up"
      // read as "unknown", every one of them would outrank every advisory we
      // successfully checked and found absent from the catalogue.
      const noCve = item({
        kev: NOT_APPLICABLE,
        epss: NOT_APPLICABLE,
        severity: NOT_APPLICABLE,
        bump: "patch",
      });
      const checkedAdvisory = item({
        kev: false,
        epss: 0.02,
        severity: "critical",
      });
      expect(moreUrgent(checkedAdvisory, noCve)).toBe(true);
    });

    it("still ranks a genuinely unchecked catalogue above a checked one", () => {
      expect(moreUrgent(item({ kev: null }), item({ kev: false }))).toBe(true);
      expect(
        moreUrgent(item({ kev: null }), item({ kev: NOT_APPLICABLE })),
      ).toBe(true);
    });

    it("ranks an unscoreable item below a measured one, not above it", () => {
      // Isolated to EPSS: with no CVE there is no score to be had, and that is
      // a fact, not a gap. Treating it as unknown would lift every CVE-less
      // update above everything we measured and found low.
      const noCve = item({ epss: NOT_APPLICABLE });
      const measuredLow = item({ epss: 0.02 });
      const unchecked = item({ epss: null });
      expect(moreUrgent(measuredLow, noCve)).toBe(true);
      expect(moreUrgent(unchecked, noCve)).toBe(true);
    });

    it("ties n/a with a confirmed absence, because both are facts", () => {
      expect(
        compareRankings(
          rank(item({ kev: NOT_APPLICABLE }), P),
          rank(item({ kev: false }), P),
        ),
      ).toBe(0);
    });

    it("does not let a non-update tie-break above a real one", () => {
      const alert = item({ bump: NOT_APPLICABLE, stuck: NOT_APPLICABLE });
      const update = item({ bump: "patch", stuck: false });
      expect(compareRankings(rank(alert, P), rank(update, P))).toBe(0);
    });

    it("says which kind of absence it means", () => {
      const r = rank(
        item({
          kev: NOT_APPLICABLE,
          epss: NOT_APPLICABLE,
          severity: NOT_APPLICABLE,
          bump: NOT_APPLICABLE,
          stuck: NOT_APPLICABLE,
        }),
        P,
      );
      expect(r.explanation).toContain("no CVE to check against KEV");
      expect(r.explanation).toContain("not an update");
      expect(r.explanation).not.toContain("unknown");
    });
  });

  describe("a stuck update needs the maintainer more, not less", () => {
    it("outranks an otherwise identical prepared update", () => {
      expect(moreUrgent(item({ stuck: true }), item({ stuck: false }))).toBe(
        true,
      );
    });

    it("never outranks a term above it in the chain", () => {
      // Stuck breaks ties. It must not promote an item past the chain, or it
      // would be a reordering by another name.
      const stuckButDull = item({ stuck: true, severity: "low" });
      const severe = item({ stuck: false, severity: "critical" });
      expect(moreUrgent(severe, stuckButDull)).toBe(true);
    });

    it("is visible in the explanation rather than only in the order", () => {
      expect(rank(item({ stuck: true }), P).explanation).toContain(
        "could not prepare",
      );
    });
  });

  describe("thresholds are configuration, order is not", () => {
    it("changes the order when a threshold moves", () => {
      const a = item({ epss: 0.2, severity: "low" });
      const b = item({ epss: 0.05, severity: "critical" });
      const coarse = { epssBands: [0.5, 0.1, 0.01] };
      const fine = { epssBands: [0.5, 0.3, 0.01] };

      // Under `coarse` they sit in different EPSS bands and EPSS decides.
      expect(compareRankings(rank(a, coarse), rank(b, coarse))).toBeLessThan(0);
      // Under `fine` both fall in the same band, so severity breaks the tie.
      expect(compareRankings(rank(a, fine), rank(b, fine))).toBeGreaterThan(0);
    });

    it("exposes no way to reorder the chain itself", () => {
      // The policy surface is thresholds only. If this ever grows a field that
      // names or sorts the terms, AD-20 has been broken.
      expect(Object.keys(DEFAULT_RANK_POLICY)).toEqual(["epssBands"]);
    });

    it("refuses a bad policy at the point of use, not only on request", () => {
      // Testing assertRankPolicy on its own leaves rank() free to stop calling
      // it, and a mis-banded queue looks exactly like a working one.
      expect(() => rank(item(), { epssBands: [0.1, 0.5] })).toThrow(
        /descending/,
      );
      expect(() => rank(item(), { epssBands: [] })).toThrow(/empty/);
    });

    it("refuses a policy that would silently mis-band", () => {
      expect(() => assertRankPolicy({ epssBands: [0.1, 0.5] })).toThrow(
        /descending/,
      );
      expect(() => assertRankPolicy({ epssBands: [] })).toThrow(/empty/);
      expect(() => assertRankPolicy({ epssBands: [1.5] })).toThrow(
        /probability/,
      );
      expect(() => assertRankPolicy({ epssBands: [0.5, 0.5] })).toThrow(
        /descending/,
      );
      // A band of zero is satisfied by every probability, so the term stops
      // discriminating entirely and severity quietly becomes the second term.
      expect(() => assertRankPolicy({ epssBands: [0.5, 0] })).toThrow(
        /above zero/,
      );
    });
  });

  describe("it is a chain, not a score", () => {
    it("produces no total anywhere in its output", () => {
      const r = rank(item({ kev: true, epss: 0.9, severity: "critical" }), P);
      // A single number invites multiplying EPSS by CVSS, which FIRST
      // prohibits as Score Laundering. There is deliberately nothing to
      // multiply: the output is a positional key and its reasons.
      expect(Object.keys(r).sort()).toEqual(["explanation", "key", "terms"]);
      expect(Array.isArray(r.key)).toBe(true);
    });

    it("keeps the terms in chain order so the key is positional", () => {
      expect(rank(item(), P).terms.map((t) => t.name)).toEqual([
        "kev",
        "epss",
        "severity",
        "bump",
        "stuck",
      ]);
    });

    it("cannot be compensated: a top KEV beats any sum of the rest", () => {
      // If the chain were ever additive, enough lesser signals would overtake
      // a KEV listing. Lexicographically they cannot.
      const kevOnly = item({
        kev: true,
        epss: null,
        severity: null,
        bump: null,
        stuck: null,
      });
      const everythingElse = item({
        kev: false,
        epss: 0.99,
        severity: "critical",
        bump: "major",
        stuck: true,
      });
      expect(moreUrgent(kevOnly, everythingElse)).toBe(true);
    });
  });

  describe("it explains itself (CAP-6)", () => {
    it("gives a reason per term, most significant first", () => {
      const r = rank(
        item({ kev: true, epss: 0.42, severity: "high", bump: "minor" }),
        P,
      );
      expect(r.explanation).toBe(
        "listed in CISA KEV, EPSS 42.0%, severity high, minor bump, update prepared normally",
      );
    });

    it("says which signals were unknown rather than staying silent", () => {
      const r = rank(item({ kev: null, epss: null, severity: null }), P);
      expect(r.explanation).toContain("KEV status unknown");
      expect(r.explanation).toContain("EPSS unknown");
      expect(r.explanation).toContain("severity unknown");
    });

    it("says a low EPSS is below the band rather than just printing it", () => {
      expect(rank(item({ epss: 0.001 }), P).explanation).toContain(
        "below 1.0%",
      );
    });
  });

  describe("comparison", () => {
    it("treats a missing term as unknown, not as measured-harmless", () => {
      // Unreachable while every key is the same shape. It becomes reachable the
      // day a term joins the chain, and a key built by the older shape must not
      // sort as though the new signal had been measured and found safe.
      const short = { key: [2, 2], terms: [], explanation: "older shape" };
      const longSafe = { key: [2, 2, 0], terms: [], explanation: "measured" };
      const longUnknown = { key: [2, 2, 1], terms: [], explanation: "unknown" };

      expect(compareRankings(short, longSafe)).toBeLessThan(0);
      expect(compareRankings(short, longUnknown)).toBe(0);
    });
  });

  describe("purity", () => {
    it("returns the same result for the same input", () => {
      const i = item({ kev: true, epss: 0.3 });
      expect(rank(i, P)).toEqual(rank(i, P));
    });

    it("does not mutate its input", () => {
      const i = item({ kev: true });
      const before = structuredClone(i);
      rank(i, P);
      expect(i).toEqual(before);
    });

    it("treats a non-finite EPSS as unknown rather than as a number", () => {
      expect(rank(item({ epss: Number.NaN }), P).explanation).toContain(
        "EPSS unknown",
      );
    });

    it("treats an impossible EPSS as unknown, not as measured-harmless", () => {
      // The adapter passes security_advisory.epss.percentage through from an
      // untyped payload. A negative sentinel falling through every band would
      // sink the item with the reason "EPSS -100.0%, below 1.0%".
      for (const epss of [-1, -0.5, 1.5, 42]) {
        expect(rank(item({ epss }), P).explanation, `${epss}`).toContain(
          "EPSS unknown",
        );
        expect(moreUrgent(item({ epss }), item({ epss: 0 })), `${epss}`).toBe(
          true,
        );
      }
    });
  });
});
