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
  type RepoPolicy,
  type RepoRef,
  parseRepoSlug,
  repoSlug,
} from "./types.js";

// Strict schemas: unknown keys are rejected so a typo in repos.yaml fails loudly
// rather than silently disabling a policy override.

const RepoEntrySchema = z
  .strictObject({
    repo: z.string().regex(/^[^/]+\/[^/]+$/, "must be owner/name"),
    autoMergeMinor: z.boolean().optional(),
    mergeOnly: z.boolean().optional(),
  });

const ConfigSchema = z.strictObject({
  mode: z.enum(["shadow", "enforce"]).default("shadow"),
  repos: z.array(RepoEntrySchema).min(1, "at least one repo required"),
});

export type RawConfig = z.infer<typeof ConfigSchema>;

export interface Config {
  mode: Mode;
  /** Allowlist of repos, in declaration order. */
  repos: RepoRef[];
  /** Resolved per-repo policy, keyed by "owner/name". */
  policies: Map<string, RepoPolicy>;
}

export function loadConfig(path: string, modeOverride?: Mode): Config {
  const raw = readFileSync(path, "utf8");
  const parsed = ConfigSchema.parse(parseYaml(raw));
  return buildConfig(parsed, modeOverride);
}

export function buildConfig(raw: RawConfig, modeOverride?: Mode): Config {
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
  return { mode: modeOverride ?? raw.mode, repos, policies };
}

export function resolvePolicy(config: Config, repo: RepoRef): RepoPolicy {
  return config.policies.get(repoSlug(repo)) ?? DEFAULT_POLICY;
}

export function isAllowlisted(config: Config, repo: RepoRef): boolean {
  return config.policies.has(repoSlug(repo));
}
