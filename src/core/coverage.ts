/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// Whether GitHub is watching a repository at all (AD-28).
//
// Distinct from freshness. `fresh`/`stale`/`unknown` says how current a value
// is; coverage says whether we were ever entitled to a value. A repository
// nobody is watching has no alert count to be fresh or stale about, so the two
// render as separate columns rather than as one four-state badge.
//
// Measured 2026-08-17 on one real organisation: 14 of 36 repositories had
// Dependabot alerts disabled. Under an org-endpoint-only design all 14 would
// render as confident green zeros, indistinguishable from the 21 that were
// genuinely clean.

export const COVERAGE_STATES = [
  "covered",
  "alerts_disabled",
  "archived",
  "repo_disabled",
  "unreachable",
  "unknown",
  "feature_off",
] as const;

export type CoverageState = (typeof COVERAGE_STATES)[number];

/**
 * The security features one coverage row speaks for (#152).
 *
 * Three, because a repository with secret scanning switched off was
 * indistinguishable from one with no leaked secrets: nothing asked GitHub, and
 * the Security chip read a confident zero for a feature nobody had a fact
 * about. Ordered as the reader meets them, Dependabot first because it is the
 * one carrying the counts this dashboard ranks.
 */
export const COVERAGE_FEATURES = [
  "dependabot",
  "code_scanning",
  "secret_scanning",
] as const;

export type CoverageFeature = (typeof COVERAGE_FEATURES)[number];

/** What each feature is called in a sentence a reader sees. */
export const FEATURE_LABELS: Record<CoverageFeature, string> = {
  dependabot: "Dependabot alerts",
  code_scanning: "code scanning",
  secret_scanning: "secret scanning",
};

/**
 * One feature's standing, and why.
 *
 * `reason` is what GitHub itself said, verbatim and redacted, rather than a
 * sentence derived from `state`. Two features can be off for different
 * reasons, and a reason read back off the state cannot tell them apart. Null
 * when GitHub gave no message: a 200, or a state the repository listing
 * settled before any probe was spent.
 */
export interface FeatureCoverage {
  state: CoverageState;
  reason: string | null;
}

export type CoverageFeatures = Readonly<
  Record<CoverageFeature, FeatureCoverage>
>;

/** May this repository's alert count be presented as a real number? */
export function isCovered(state: CoverageState): boolean {
  return state === "covered";
}

/**
 * Positive evidence that a feature is NOT covered.
 *
 * `unknown` is not such evidence and must never become one. It is what a
 * failed probe reads as, what a row written before the two scanners were
 * probed at all reads as, and what GitHub's `no analysis found` reads as - a
 * repository with code scanning enabled but nothing analysed yet answers
 * exactly like one that never configured it. Treating any of those as off
 * would put `not covered` on a repository nobody switched anything off in.
 */
export function isOff(state: CoverageState): boolean {
  return state !== "covered" && state !== "unknown";
}

/**
 * What a Security count may say about a repository, from its coverage row.
 *
 * Story 3.2's three-way precedence, generalised from one feature to all of
 * them (#156):
 *
 *   counted        at least one feature is confirmed ON, so its items are a
 *                  real number, and every other feature's reason rides
 *                  beside that number as a note rather than replacing it
 *   unconfirmed    no feature is confirmed on and at least one is unknown,
 *                  so nothing here is a number and nothing here is a finding
 *   not_covered    no feature is confirmed on and none is unknown, which
 *                  leaves every one of them confirmed off
 *
 * Read for `covered` rather than for `off`, because the features do NOT answer
 * symmetrically: code scanning has no mapping to `feature_off` and its absence
 * is deliberate, because `404 no analysis found` is what a repository with code
 * scanning configured and nothing analysed yet answers, identically to one that
 * never configured it. A rule written as "every feature is off" could therefore
 * never fire, which is exactly what the first form of this rule did.
 *
 * Quantified over the features whose findings something actually collects, not
 * over every feature a coverage row describes. A feature confirmed ON that no
 * lane sweeps licenses a count it contributes nothing to, which is the same
 * confident zero one layer over: with secret scanning on, Dependabot off and
 * code scanning never analysed, "counted" would put a number on a repository
 * where nothing had looked at anything.
 */
export type SecurityStanding = "counted" | "unconfirmed" | "not_covered";

/**
 * The features a lane sweeps for findings today.
 *
 * All three, since Story 3.4 gave secret scanning its lane (#158). A feature
 * belongs here when its findings can reach the queue, never merely because
 * coverage describes it - which is why this list was two entries long while
 * `COVERAGE_FEATURES` was three, and why the two must stay separate.
 */
const COUNTED_FEATURES: readonly CoverageFeature[] = [
  "dependabot",
  "code_scanning",
  "secret_scanning",
];

export function securityStanding(features: CoverageFeatures): SecurityStanding {
  if (COUNTED_FEATURES.some((feature) => isCovered(features[feature].state))) {
    return "counted";
  }
  if (
    COUNTED_FEATURES.some((feature) => features[feature].state === "unknown")
  ) {
    return "unconfirmed";
  }
  // Nothing on and nothing unknown leaves every counted feature off, because
  // the states partition: isOff is exactly "not covered and not unknown".
  return "not_covered";
}

/**
 * The reason to show for one feature: GitHub's words where it gave any, ours
 * where it did not.
 *
 * An `unknown` with nothing stored yields NO reason at all. `coverageReason`
 * phrases `unknown` as an answer we could not read, and a row written before
 * this feature was probed carries no answer of any kind; printing that
 * sentence over it would claim a call we never made.
 */
export function featureReason(feature: FeatureCoverage): string | null {
  if (feature.reason !== null) return feature.reason;
  if (feature.state === "unknown") return null;
  return coverageReason(feature.state);
}

/**
 * Two reasons in one sentence, for the chip title and the page's sub-line.
 *
 * One place, so the overview and the repository page cannot punctuate the
 * same pair of reasons two ways (AD-32).
 */
export function joinNotes(notes: readonly string[]): string {
  return notes.join(" · ");
}

/** The features a predicate selects, each paired with the reason it gives. */
function reasonsOf(
  features: CoverageFeatures,
  wanted: (state: CoverageState) => boolean,
): [CoverageFeature, string][] {
  const hit: [CoverageFeature, string][] = [];
  for (const feature of COVERAGE_FEATURES) {
    if (!wanted(features[feature].state)) continue;
    const reason = featureReason(features[feature]);
    if (reason !== null) hit.push([feature, reason]);
  }
  return hit;
}

/**
 * Everything a coverage row says about this repository's security features:
 * why each one that is off is off, then what GitHub answered for each it did
 * not settle.
 *
 * One list for every surface, so the overview chip and the repository page
 * cannot say different things about the same stored row (AD-32). Empty when
 * all three answered `covered`, which is the only state that needs no note.
 */
export function coverageNotes(features: CoverageFeatures): string[] {
  return [...offNotes(features), ...unansweredNotes(features)];
}

/**
 * States that describe the REPOSITORY rather than one of its features.
 *
 * The coverage lane writes them to all three features at once, and their
 * sentences name the repository themselves.
 */
const WHOLE_REPO: readonly CoverageState[] = ["archived", "repo_disabled"];

/**
 * Why each feature that is off is off, each naming its feature.
 *
 * Always named. Two features off for the same reason are two findings, and
 * collapsing them into one unlabelled note leaves the reader unable to say
 * which feature it is about - the same silence this story exists to remove.
 * When two are off for different reasons both survive; dropping either is how
 * a page ends up inventing the standing of the feature it kept (#152).
 *
 * The one exception is a repository-wide state, which is not about a feature
 * at all. `archived` and `repo_disabled` are written to all three at once and
 * their sentences name the repository, so the note is said once and unlabelled:
 * labelling it would attribute a fact about the repository to a feature.
 */
export function offNotes(features: CoverageFeatures): string[] {
  const hit = reasonsOf(features, isOff);
  const first = hit[0];
  if (first === undefined) return [];
  if (hit.every(([feature]) => WHOLE_REPO.includes(features[feature].state))) {
    return [first[1]];
  }
  return hit.map(
    ([feature, reason]) => `${FEATURE_LABELS[feature]}: ${reason}`,
  );
}

/**
 * What GitHub said about each feature it gave no usable answer for.
 *
 * Always named, unlike `offNotes`, because every reason here is GitHub's
 * verbatim body and those do not name their subject: `no analysis found` on
 * its own tells a reader nothing about which feature has none. A feature with
 * no stored message contributes nothing - nobody asked GitHub, so there is no
 * answer to quote.
 */
export function unansweredNotes(features: CoverageFeatures): string[] {
  return reasonsOf(features, (state) => state === "unknown").map(
    ([feature, reason]) => `${FEATURE_LABELS[feature]}: ${reason}`,
  );
}

/**
 * The neutral phrase for a feature nothing has confirmed either way.
 *
 * It must be true of BOTH `unknown` states, which is why it describes our
 * knowledge rather than GitHub's answer: a probe that came back with words we
 * do not recognise, and a row written before the feature was probed at all,
 * are the same fact from a reader's side and only one of them involved a call.
 * `coverageReason`'s "GitHub's answer was not one we recognise" would claim a
 * call we never made over the second.
 */
export const NOT_CONFIRMED = "not confirmed on or off";

/**
 * Every feature that is neither covered nor off, each named, with GitHub's
 * own words where the probe stored any.
 *
 * Wider than `unansweredNotes`, which names only the ones that DID come back
 * with a body. A count stands beside a feature nobody confirmed just as much
 * as beside one that answered something odd, and a chip that said nothing
 * about it would present a number for a topic one of its features has no
 * standing in (AD-28).
 */
export function unconfirmedNotes(features: CoverageFeatures): string[] {
  return COVERAGE_FEATURES.filter(
    (feature) =>
      !isCovered(features[feature].state) && !isOff(features[feature].state),
  ).map(
    (feature) =>
      `${FEATURE_LABELS[feature]}: ${features[feature].reason ?? NOT_CONFIRMED}`,
  );
}

/**
 * Why a feature is not covered, for the reader, where GitHub gave no words of
 * its own.
 *
 * Phrased to sit BEHIND the feature label `offNotes` puts in front of it, so
 * the sentence does not name a feature and read `Dependabot alerts: Dependabot
 * alerts are switched off`. The two repository-wide states are the exception:
 * they name the repository, which is their subject, and are rendered alone.
 *
 * `unknown` is deliberately not phrased as a reason. It means the probe
 * returned something we have not seen before, and inventing an explanation for
 * it would be the same confident guess this module exists to prevent.
 */
export function coverageReason(state: CoverageState): string | null {
  switch (state) {
    case "covered":
      return null;
    case "alerts_disabled":
      return "switched off for this repository";
    case "archived":
      return "the repository is archived, so nothing is updating it";
    case "repo_disabled":
      // GitHub's `disabled` flag is about the repository itself, for billing,
      // DMCA or abuse. Reporting it as a missing installation would send the
      // operator to check a setting that is fine.
      return "GitHub has disabled this repository";
    case "unreachable":
      return "the App is not installed on this repository";
    case "unknown":
      return "GitHub's answer was not one we recognise";
    case "feature_off":
      // The fallback only: GitHub names the feature in its own message, which
      // is what a row written by the probe carries and what `featureReason`
      // prefers. WHICH feature is off comes from the label `offNotes` puts in
      // front of this, so the sentence itself must not guess at one.
      return "switched off for this repository";
  }
}
