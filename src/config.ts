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
  return { mode: modeOverride ?? raw.mode, repos, policies, remediation };
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
