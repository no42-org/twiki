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

/**
 * Reads gitricorder cannot work without, keyed by GitHub's own permission
 * name.
 *
 * Checking only that nothing is writable is half a check: an App scoped to
 * metadata alone passes it, reports OK, and then collects nothing forever. That
 * is the confident zero this command exists to prevent, arriving through the
 * credential instead of through a lane.
 */
export const REQUIRED_READS: Record<string, string> = {
  metadata: "any App needs it",
  vulnerability_alerts: "Dependabot alerts, the only EPSS-bearing endpoint",
  security_events: "code scanning alerts",
  secret_scanning_alerts: "secret scanning alerts",
  actions: "workflow run status",
  pull_requests: "dependency-update PRs and the review queue",
  issues: "untriaged issues",
};

/** Required reads this App does not hold. */
export function missingReads(permissions: Record<string, string>): string[] {
  return Object.keys(REQUIRED_READS)
    .filter((name) => permissions[name] === undefined)
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

/**
 * A repository whose declared default branch is not the one GitHub reports.
 *
 * Reported whether or not the repository declared the field, because an
 * undeclared `main` is exactly the assumption that goes stale: a repository
 * renamed to `master` after it was added never had a line to get wrong.
 */
export interface BranchMismatch {
  /** Position in repos.yaml, so the finding points at the entry to edit. */
  index: number;
  /** Case-folded slug, as every other repository in this report is. */
  slug: string;
  /** What the config resolved to, declared or inherited. */
  configured: string;
  /** What GitHub reports. Read, never written back. */
  actual: string;
}

export interface DoctorReport {
  app: { slug: string | null; name: string | null };
  /** What GitHub reported, so a name mismatch is visible rather than baffling. */
  permissions: Record<string, string> | null;
  /** Non-read permissions. Non-empty means AD-21 is violated. */
  writable: string[];
  /** Required reads the App does not hold. */
  missing: string[];
  installations: InstallationReport[];
  /** Watched repositories no installation can see, by slug. */
  orphaned: string[];
  /** Installations whose account GitHub did not name. */
  unnamed: number[];
  /** Watched repositories whose configured default branch GitHub disagrees with. */
  branchMismatches: BranchMismatch[];
  ok: boolean;
}

/** Account prefix of a watched repo, case-folded to match subject identity. */
function accountOf(repo: RepoRef): string {
  return repo.owner.toLowerCase();
}

export async function diagnose(
  app: GitHubAppPort,
  watched: readonly RepoRef[],
  /**
   * The configured default branch of a repository, which in production is
   * `resolveDefaultBranch` bound to the loaded config. Taken as a function
   * rather than as the config so this command keeps depending on nothing it
   * could write through.
   *
   * Required, with no default. A default of `main` would make dropping the
   * binding at the one call site compile and pass, and report every
   * correctly declared repository on `master` as a mismatch.
   */
  defaultBranchOf: (repo: RepoRef) => string,
): Promise<DoctorReport> {
  const identity = await app.identity();
  const permissions = identity.permissions;
  // A missing permissions object is "we could not tell", never "nothing is
  // writable". Reporting uncertainty as safety is the one thing a command
  // whose job is refusing an over-privileged App must not do.
  const writable = permissions === null ? [] : writablePermissions(permissions);
  const missing = permissions === null ? [] : missingReads(permissions);
  const installations = await app.listInstallations();

  // Each repository keeps its position in repos.yaml, so a finding can name
  // `repos[i]` the way the config parser names a field to go and fix.
  const wantedBy = new Map<string, { repo: RepoRef; index: number }[]>();
  watched.forEach((repo, index) => {
    const key = accountOf(repo);
    wantedBy.set(key, [...(wantedBy.get(key) ?? []), { repo, index }]);
  });

  const seen = new Set<string>();
  const reports: InstallationReport[] = [];
  const unnamed: number[] = [];
  const branchMismatches: BranchMismatch[] = [];

  for (const inst of installations) {
    if (inst.account === null) {
      // Cannot be matched against repos.yaml at all. Saying so beats inventing
      // a name that can never match, which would orphan every repository under
      // it and blame the allowlist.
      unnamed.push(inst.id);
      continue;
    }
    const wantedHere = wantedBy.get(inst.account.toLowerCase()) ?? [];
    if (wantedHere.length === 0) {
      // Nothing watched here, so enumerating its repositories would mint a
      // token and page through a listing to learn nothing.
      reports.push({
        account: inst.account,
        id: inst.id,
        repositorySelection: inst.repositorySelection,
        reachable: [],
        unreachable: [],
      });
      continue;
    }
    const repos = await app.listInstallationRepos(inst.id);
    // Case-folded, because repos.yaml is hand-written and GitHub supplies its
    // own casing. Comparing raw would report a reachable repository as missing
    // (AD-22).
    const visible = new Map(
      repos.map((r) => [repoSlug(r).toLowerCase(), r.defaultBranch] as const),
    );
    const wanted = wantedHere;

    const reachable: string[] = [];
    const unreachable: string[] = [];
    for (const { repo, index } of wanted) {
      const slug = repoSlug(repo).toLowerCase();
      if (visible.has(slug)) {
        reachable.push(slug);
        seen.add(slug);
        // Reachability is decided by the key alone: an entry whose branch
        // GitHub did not report is still a repository this installation can
        // see, and reporting it unreachable would be a worse answer than
        // skipping one comparison.
        //
        // The slug folds; the branch name does not, because git refs are
        // case-sensitive and `Main` really is a different branch.
        const actual = visible.get(slug);
        const configured = defaultBranchOf(repo);
        if (actual && configured !== actual) {
          branchMismatches.push({ index, slug, configured, actual });
        }
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
    permissions,
    writable,
    missing,
    installations: reports,
    orphaned,
    unnamed,
    branchMismatches: branchMismatches.sort((a, b) => a.index - b.index),
    ok:
      permissions !== null &&
      writable.length === 0 &&
      missing.length === 0 &&
      orphaned.length === 0 &&
      unnamed.length === 0 &&
      branchMismatches.length === 0,
  };
}

/** Render the report for a terminal. */
export function formatReport(r: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`App: ${r.app.slug ?? "?"} (${r.app.name ?? "unnamed"})`);

  if (r.permissions === null) {
    lines.push("");
    lines.push("REFUSING: GitHub reported no permissions for this App.");
    lines.push(
      "  That is not the same as read-only, and this command will not certify",
      "  an App whose access it could not read.",
    );
  } else if (r.writable.length > 0) {
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

  if (r.missing.length > 0) {
    lines.push("");
    lines.push(`Missing ${r.missing.length} required read permissions:`);
    for (const name of r.missing) {
      lines.push(`  ${name}  (${REQUIRED_READS[name]})`);
    }
    lines.push(
      "  Without these the lanes that need them collect nothing, forever, and",
      "  a repository that collects nothing must not render as a healthy zero.",
    );
    // Printed so a permission GitHub has renamed shows up as a name mismatch
    // rather than as a baffling "you did not grant something you did grant".
    lines.push(
      `  GitHub reported: ${
        Object.keys(r.permissions ?? {})
          .sort()
          .join(", ") || "(none)"
      }`,
    );
  }

  lines.push("");
  lines.push(`Installations: ${r.installations.length + r.unnamed.length}`);
  for (const i of r.installations) {
    const note = i.unreachable.length
      ? `${i.reachable.length} watched reachable, ${i.unreachable.length} NOT`
      : `${i.reachable.length} watched reachable`;
    lines.push(`  ${i.account} (${i.repositorySelection}): ${note}`);
    for (const slug of i.unreachable) lines.push(`    unreachable: ${slug}`);
  }
  for (const id of r.unnamed) {
    lines.push(
      `  installation ${id}: GitHub named no account for it, so nothing can be matched against repos.yaml`,
    );
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

  if (r.branchMismatches.length > 0) {
    lines.push("");
    lines.push(
      `${r.branchMismatches.length} watched repositories are on a different default branch than repos.yaml says.`,
      "Until that is fixed, a failed build on the real default branch reads as a",
      "build on just another branch, so a red main renders as quiet.",
    );
    for (const m of r.branchMismatches) {
      lines.push(
        `  ${m.slug}: repos[${m.index}].defaultBranch is ${m.configured}, GitHub says ${m.actual}`,
      );
    }
  }

  lines.push("");
  lines.push(r.ok ? "OK" : "NOT OK: see above.");
  return lines.join("\n");
}
