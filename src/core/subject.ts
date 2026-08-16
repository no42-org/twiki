/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { type RepoRef, repoSlug } from "./types.js";

// A subject is the thing an observation is about. Identity is (type, key), and
// every key is produced by the one function for its type, never composed at a
// call site: two lanes writing the same real-world thing under different keys
// would silently fork the projection (AD-22).

export const SUBJECT_TYPES = [
  "repository",
  "dependabot_alert",
  "code_scanning_alert",
  "secret_scanning_alert",
  "dependency_update_pr",
  "workflow_run",
  "issue",
] as const;

export type SubjectType = (typeof SUBJECT_TYPES)[number];

export interface Subject {
  type: SubjectType;
  key: string;
}

/**
 * GitHub owner and repository names are case-insensitive, and RepoRef values
 * come from user-authored repos.yaml. Without folding case here, `No42-Org/x`
 * from config and `no42-org/x` from an API path become two subjects for one
 * repository: the silent projection fork this file exists to prevent.
 *
 * Only the subject KEY is folded. core/types.ts's repoSlug is left alone
 * because twiki matches its allowlist with it, and changing that would change
 * write-path behaviour.
 */
function subjectSlug(repo: RepoRef): string {
  return repoSlug(repo).toLowerCase();
}

export function repositorySubject(repo: RepoRef): Subject {
  return { type: "repository", key: subjectSlug(repo) };
}

/**
 * Security alerts carry no node id, so they key on the repository plus the
 * per-repository alert number. The type discriminates the three families, so
 * Dependabot alert 7 and code-scanning alert 7 in one repository are distinct
 * subjects rather than one contested row.
 */
export function alertSubject(
  type: "dependabot_alert" | "code_scanning_alert" | "secret_scanning_alert",
  repo: RepoRef,
  alertNumber: number,
): Subject {
  return { type, key: `${subjectSlug(repo)}#${alertNumber}` };
}

/** Issues, pull requests and workflow runs all have a GitHub node id. */
export function nodeSubject(
  type: "dependency_update_pr" | "workflow_run" | "issue",
  nodeId: string,
): Subject {
  return { type, key: nodeId };
}
