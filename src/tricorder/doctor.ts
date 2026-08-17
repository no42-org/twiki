/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { RepoRef } from "../core/types.js";
import { repoSlug } from "../core/types.js";
import type { GitHubAppPort } from "../github/port.js";

// Setup diagnostics for the read-only App (AD-21).
//
// This exists because every claim it checks is one somebody could believe was
// true while it was not: that the App cannot write, that it is installed where
// the allowlist expects, and that it can actually see the repositories it is
// meant to watch. A dashboard whose credential is quietly wrong reports
// confident zeros for everything it cannot reach, which is the failure this
// whole build is organised against.
//
// It writes nothing, to the store or to GitHub.

/** Permissions that would let the dashboard change something (AD-21). */
export function writablePermissions(
  permissions: Record<string, string>,
): string[] {
  return Object.entries(permissions)
    .filter(([, level]) => level !== "read")
    .map(([name, level]) => `${name}=${level}`)
    .sort();
}

export interface InstallationReport {
  account: string;
  id: number;
  repositorySelection: string;
  /** Watched repositories this installation can see. */
  reachable: string[];
  /** Watched repositories under this account that it cannot see. */
  unreachable: string[];
}

export interface DoctorReport {
  app: { slug: string | null; name: string | null };
  /** Non-read permissions. Non-empty means AD-21 is violated. */
  writable: string[];
  installations: InstallationReport[];
  /** Watched repositories no installation can see, by slug. */
  orphaned: string[];
  ok: boolean;
}

/** Account prefix of a watched repo, case-folded to match subject identity. */
function accountOf(repo: RepoRef): string {
  return repo.owner.toLowerCase();
}

export async function diagnose(
  app: GitHubAppPort,
  watched: readonly RepoRef[],
): Promise<DoctorReport> {
  const identity = await app.identity();
  const writable = writablePermissions(identity.permissions);
  const installations = await app.listInstallations();

  const wantedBy = new Map<string, RepoRef[]>();
  for (const repo of watched) {
    const key = accountOf(repo);
    wantedBy.set(key, [...(wantedBy.get(key) ?? []), repo]);
  }

  const seen = new Set<string>();
  const reports: InstallationReport[] = [];

  for (const inst of installations) {
    const repos = await app.listInstallationRepos(inst.id);
    // Case-folded, because repos.yaml is hand-written and GitHub supplies its
    // own casing. Comparing raw would report a reachable repository as missing
    // (AD-22).
    const visible = new Set(repos.map((r) => repoSlug(r).toLowerCase()));
    const wanted = wantedBy.get(inst.account.toLowerCase()) ?? [];

    const reachable: string[] = [];
    const unreachable: string[] = [];
    for (const repo of wanted) {
      const slug = repoSlug(repo).toLowerCase();
      if (visible.has(slug)) {
        reachable.push(slug);
        seen.add(slug);
      } else {
        unreachable.push(slug);
      }
    }

    reports.push({
      account: inst.account,
      id: inst.id,
      repositorySelection: inst.repositorySelection,
      reachable: reachable.sort(),
      unreachable: unreachable.sort(),
    });
  }

  const orphaned = watched
    .map((r) => repoSlug(r).toLowerCase())
    .filter((slug) => !seen.has(slug))
    .sort();

  return {
    app: { slug: identity.slug, name: identity.name },
    writable,
    installations: reports,
    orphaned,
    ok: writable.length === 0 && orphaned.length === 0,
  };
}

/** Render the report for a terminal. */
export function formatReport(r: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`App: ${r.app.slug ?? "?"} (${r.app.name ?? "unnamed"})`);

  if (r.writable.length > 0) {
    lines.push("");
    lines.push("REFUSING: this App holds write permissions.");
    lines.push(
      "  gitricorder must not be able to change anything (AD-21). Writing is",
      "  twiki's job, under twiki's separate credential.",
    );
    for (const p of r.writable) lines.push(`  ${p}`);
  } else {
    lines.push("Permissions: read-only throughout.");
  }

  lines.push("");
  lines.push(`Installations: ${r.installations.length}`);
  for (const i of r.installations) {
    const note = i.unreachable.length
      ? `${i.reachable.length} watched reachable, ${i.unreachable.length} NOT`
      : `${i.reachable.length} watched reachable`;
    lines.push(`  ${i.account} (${i.repositorySelection}): ${note}`);
    for (const slug of i.unreachable) lines.push(`    unreachable: ${slug}`);
  }

  if (r.orphaned.length > 0) {
    lines.push("");
    lines.push(
      `${r.orphaned.length} watched repositories no installation can see.`,
      "Until that is fixed they collect nothing, and a repository that collects",
      "nothing must never render as a healthy zero (AD-28).",
    );
    for (const slug of r.orphaned) lines.push(`  ${slug}`);
  }

  lines.push("");
  lines.push(r.ok ? "OK" : "NOT OK: see above.");
  return lines.join("\n");
}
