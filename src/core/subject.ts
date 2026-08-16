/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { RepoRef } from "./types.js";

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

export function repoSlug(repo: RepoRef): string {
  return `${repo.owner}/${repo.name}`;
}

export function repositorySubject(repo: RepoRef): Subject {
  return { type: "repository", key: repoSlug(repo) };
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
  return { type, key: `${repoSlug(repo)}#${alertNumber}` };
}

/** Issues, pull requests and workflow runs all have a GitHub node id. */
export function nodeSubject(
  type: "dependency_update_pr" | "workflow_run" | "issue",
  nodeId: string,
): Subject {
  return { type, key: nodeId };
}
