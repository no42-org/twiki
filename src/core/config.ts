/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
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
  /** Resolved per-repo policy, keyed by "owner/name". */
  policies: Map<string, RepoPolicy>;
  /** CI-remediation settings. */
  remediation: RemediationConfig;
  /** Dependency-update bot actors (AD-19). Empty when none are configured. */
  bots: readonly string[];
}

export function loadConfig(
  path: string,
  modeOverride?: Mode,
  remediation?: RemediationConfig,
): Config {
  const raw = readFileSync(path, "utf8");
  const parsed = ConfigSchema.parse(parseYaml(raw));
  return buildConfig(parsed, modeOverride, remediation);
}

export function buildConfig(
  raw: RawConfig,
  modeOverride?: Mode,
  remediation: RemediationConfig = DEFAULT_REMEDIATION,
): Config {
  const repos: RepoRef[] = [];
  const policies = new Map<string, RepoPolicy>();
  for (const entry of raw.repos) {
    const ref = parseRepoSlug(entry.repo);
    const slug = repoSlug(ref);
    if (policies.has(slug)) {
      throw new Error(`Duplicate repo in config: ${slug}`);
    }
    repos.push(ref);
    policies.set(slug, {
      autoMergeMinor: entry.autoMergeMinor ?? DEFAULT_POLICY.autoMergeMinor,
      mergeOnly: entry.mergeOnly ?? DEFAULT_POLICY.mergeOnly,
    });
  }
  return {
    mode: modeOverride ?? raw.mode,
    repos,
    policies,
    remediation,
    bots: raw.bots ?? [],
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
