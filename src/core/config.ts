/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { watchKey } from "./slug.js";
import {
  DEFAULT_POLICY,
  type Mode,
  parseRepoSlug,
  type RepoPolicy,
  type RepoRef,
  repoSlug,
} from "./types.js";

// Strict schemas: unknown keys are rejected so a typo in repos.yaml fails loudly
// rather than silently disabling a policy override.

const RepoEntrySchema = z.strictObject({
  repo: z.string().regex(/^[^/]+\/[^/]+$/, "must be owner/name"),
  autoMergeMinor: z.boolean().optional(),
  mergeOnly: z.boolean().optional(),
  /**
   * What this repository calls its default branch; absent means `main`.
   *
   * A branch NAME, not a ref. Two shapes an operator plausibly writes could
   * never equal a stripped ref, so each is dealt with here rather than
   * accepted and silently never matched: surrounding whitespace is trimmed,
   * and a `refs/` prefix is an error naming the field. Empty is an error for
   * the same reason. Somebody who wrote `defaultBranch: ""` meant something,
   * and answering `main` would hide the one declaration that is definitely
   * wrong.
   */
  defaultBranch: z
    .string()
    .transform((v) => v.trim())
    .refine((v) => v.length > 0, "must name a branch")
    .refine(
      (v) => !v.startsWith("refs/"),
      "must name the branch, not the ref: write `main`, not `refs/heads/main`",
    )
    .optional(),
});

const ConfigSchema = z.strictObject({
  mode: z.enum(["shadow", "enforce"]).default("shadow"),
  repos: z.array(RepoEntrySchema).min(1, "at least one repo required"),
  /**
   * Dependency-update bot actors, as search-qualifier logins such as
   * `app/dependabot`. Configuration and only configuration: AD-19 forbids a
   * bot login literal in source, so there is no default. An absent list means
   * the update-PR lane collects nothing, loudly.
   */
  bots: z
    .array(
      z
        .string()
        .min(1)
        .regex(/^[^\s:"]+$/, "one login per entry, no spaces or search syntax"),
    )
    .optional(),
  /**
   * Logins whose review requests to collect (CAP-5).
   *
   * Configuration for the same reason the bot actors are (AD-19): an
   * installation token has no user identity, so `review-requested:@me` is
   * not available and there is nobody for this dashboard to assume it
   * belongs to. No default exists in source; unset means the lane does not
   * run, and the entrypoint says so.
   */
  reviewers: z
    .array(
      z
        .string()
        .min(1)
        .regex(/^[^\s:"]+$/, "one login per entry, no spaces or search syntax"),
    )
    .optional(),
});

export type RawConfig = z.infer<typeof ConfigSchema>;

/** CI-remediation settings (sourced from env, not the repos.yaml file). */
export interface RemediationConfig {
  /** Whether re-run / rebase writes are performed (diagnostics run regardless). */
  enabled: boolean;
  /** Attempt ceiling for re-runs; compared against GitHub's 1-based run_attempt. */
  maxAttempts: number;
}

export const DEFAULT_REMEDIATION: RemediationConfig = {
  enabled: true,
  maxAttempts: 2,
};

export interface Config {
  mode: Mode;
  /** Allowlist of repos, in declaration order. */
  repos: RepoRef[];
  /** Resolved per-repo policy, keyed by "owner/name" as declared. */
  policies: Map<string, RepoPolicy>;
  /**
   * The declared slug for a case-folded one: `watchKey` to the `policies` key.
   *
   * An index, not a second copy. This file now holds two keying rules,
   * deliberately: `policies` is keyed by the raw declared slug and twiki's
   * allowlist matching has always gone through it, so re-keying it would
   * change which repositories twiki acts on. The read side compares against
   * slugs GitHub supplies with its own casing (AD-22), so it needs a folded
   * way in, and this is it. Read both through the accessors below.
   */
  declaredSlugs: Map<string, string>;
  /** CI-remediation settings. */
  remediation: RemediationConfig;
  /** Dependency-update bot actors (AD-19). Empty when none are configured. */
  bots: readonly string[];
  reviewers: readonly string[];
}

/**
 * Where a problem sits in the document, as a reader would write it:
 * `repos[0].mergeOnyl`, not a JSON array. Empty path means the top level.
 */
function locate(segments: readonly PropertyKey[]): string {
  return segments.reduce<string>((acc, seg) => {
    if (typeof seg === "number") return `${acc}[${seg}]`;
    return acc === "" ? String(seg) : `${acc}.${String(seg)}`;
  }, "");
}

/**
 * One sentence per problem, built from the issue's structured fields rather
 * than by matching text zod owns - a zod upgrade that changes the wording
 * must not silently change ours.
 *
 * An unrecognized key names BOTH causes. This parser cannot detect a key from
 * the future and does not need to; it only has to stop asserting the one
 * explanation. Version skew produces exactly this error whenever a config is
 * written against a newer build than the image running it, and saying only
 * "typo" sends the reader hunting for a mistake they did not make.
 */
function renderIssue(issue: z.core.$ZodIssue): string[] {
  const at = locate(issue.path);
  if (issue.code === "unrecognized_keys") {
    return issue.keys.map((key) => {
      const where = at === "" ? key : `${at}.${key}`;
      return (
        `${where}: unrecognized key. Either a typo, or this config was ` +
        "written for a newer twiki than the one reading it."
      );
    });
  }
  return [at === "" ? issue.message : `${at}: ${issue.message}`];
}

/**
 * Read and validate the repo allowlist.
 *
 * Every failure here is something the operator supplied - a path, a file, a
 * document - so each one names what was being read and what is wrong with it.
 * Unwrapped, a schema failure surfaced as zod's serialised issue array plus a
 * stack trace into this file, naming the parser and never the config.
 */
export function loadConfig(
  path: string,
  modeOverride?: Mode,
  remediation?: RemediationConfig,
): Config {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `cannot read the config at ${path}: ${err instanceof Error ? err.message : err}`,
    );
  }

  let doc: unknown;
  try {
    doc = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `${path} is not valid YAML: ${err instanceof Error ? err.message : err}`,
    );
  }

  const parsed = ConfigSchema.safeParse(doc);
  if (!parsed.success) {
    const problems = parsed.error.issues.flatMap(renderIssue);
    throw new Error(
      `${path} is not a valid twiki config:\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
  return buildConfig(parsed.data, modeOverride, remediation);
}

export function buildConfig(
  raw: RawConfig,
  modeOverride?: Mode,
  remediation: RemediationConfig = DEFAULT_REMEDIATION,
): Config {
  const repos: RepoRef[] = [];
  const policies = new Map<string, RepoPolicy>();
  const declaredSlugs = new Map<string, string>();
  for (const entry of raw.repos) {
    const ref = parseRepoSlug(entry.repo);
    const slug = repoSlug(ref);
    // Folded, because GitHub slugs are case-insensitive: `Org/A` and `org/a`
    // are one repository. A raw-slug check lets both through, and then the
    // folded index keeps only the last one - so the second declaration would
    // silently govern both.
    const key = watchKey(ref);
    const already = declaredSlugs.get(key);
    if (already !== undefined) {
      throw new Error(
        already === slug
          ? `Duplicate repo in config: ${slug}`
          : `Duplicate repo in config: ${slug} and ${already} are the same repository`,
      );
    }
    repos.push(ref);
    policies.set(slug, {
      autoMergeMinor: entry.autoMergeMinor ?? DEFAULT_POLICY.autoMergeMinor,
      mergeOnly: entry.mergeOnly ?? DEFAULT_POLICY.mergeOnly,
      defaultBranch: entry.defaultBranch ?? DEFAULT_POLICY.defaultBranch,
    });
    declaredSlugs.set(key, slug);
  }
  return {
    mode: modeOverride ?? raw.mode,
    repos,
    policies,
    declaredSlugs,
    remediation,
    bots: raw.bots ?? [],
    reviewers: raw.reviewers ?? [],
  };
}

/** Parse the remediation settings from environment variables. */
export function remediationFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RemediationConfig {
  const parsed = Number(env.TWIKI_MAX_CI_ATTEMPTS ?? "");
  const maxAttempts =
    Number.isInteger(parsed) && parsed > 0
      ? parsed
      : DEFAULT_REMEDIATION.maxAttempts;
  const enabled = (env.TWIKI_CI_REMEDIATION ?? "on").toLowerCase() !== "off";
  return { enabled, maxAttempts };
}

export function resolvePolicy(config: Config, repo: RepoRef): RepoPolicy {
  return config.policies.get(repoSlug(repo)) ?? DEFAULT_POLICY;
}

export function isAllowlisted(config: Config, repo: RepoRef): boolean {
  return config.policies.has(repoSlug(repo));
}

/**
 * What a repository calls its default branch, as declared.
 *
 * The one way to ask. Keyed by `watchKey`, so a repository declared
 * `Owner/Name` answers the same as one asked for as `owner/name` (AD-22) -
 * the read side never sees the casing repos.yaml was written in.
 *
 * A repository nobody declared answers `main`, exactly as an allowlisted one
 * that declared nothing does. Absence of a declaration is not knowledge that
 * the branch is called something else, and this accessor is not the place to
 * discover that a repository is unwatched; `isAllowlisted` is.
 */
export function resolveDefaultBranch(config: Config, repo: RepoRef): string {
  const slug = config.declaredSlugs.get(watchKey(repo));
  // Through the policy, so the declared branch has one home. A second map
  // holding the value would be two copies kept in step by hand.
  const policy = slug === undefined ? undefined : config.policies.get(slug);
  return policy?.defaultBranch ?? DEFAULT_POLICY.defaultBranch;
}

/**
 * How much collected history gitricorder keeps.
 *
 * Both windows are OFF by default, meaning nothing is ever deleted. The
 * observation log grows only when a value actually changes, so keeping it is
 * cheap, and it is the only record of how long a condition has persisted.
 *
 * Run history is the asymmetric case: `collection_run` gains a row per lane
 * per installation per cycle whether or not anything happened, roughly 1.9M a
 * year at the planned cadences, and nothing reads it beyond the latest run per
 * key. It is off by default too, so that turning retention on is always a
 * deliberate act, but it is the one likely to want a value.
 */
export interface RetentionConfig {
  /** Days of observation history to keep, or null to keep everything. */
  observationDays: number | null;
  /** Days of collection-run history to keep, or null to keep everything. */
  runDays: number | null;
}

export const DEFAULT_RETENTION: RetentionConfig = {
  observationDays: null,
  runDays: null,
};

/**
 * Parse retention settings from the environment.
 *
 * Unset means keep everything. A malformed value throws rather than falling
 * back to a default: retention deletes data irreversibly, and silently
 * ignoring a typo in the one setting that destroys history is not a
 * recoverable mistake.
 */
export function retentionFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): RetentionConfig {
  return {
    observationDays: retentionDays(
      env.TRICORDER_RETENTION_DAYS,
      "TRICORDER_RETENTION_DAYS",
    ),
    runDays: retentionDays(
      env.TRICORDER_RUN_RETENTION_DAYS,
      "TRICORDER_RUN_RETENTION_DAYS",
    ),
  };
}

function retentionDays(raw: string | undefined, name: string): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const trimmed = raw.trim();
  // Decimal digits only. Number() also accepts "1e3" and "0x1f", and a
  // retention window is not a place to be surprised by coercion.
  if (!/^\d+$/.test(trimmed) || Number(trimmed) < 1) {
    throw new Error(
      `${name} must be a whole number of days above zero, or unset to keep everything. Got: ${raw}`,
    );
  }
  return Number(trimmed);
}

/**
 * The cutoff timestamp for a retention window: anything strictly older goes.
 *
 * Pure, so the boundary is testable without waiting a fortnight.
 */
export function retentionCutoff(now: Date, days: number): string {
  return new Date(now.getTime() - days * 24 * 60 * 60_000).toISOString();
}
