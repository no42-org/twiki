/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { PrOutcome, RepoResult, RunResult } from "./result.js";

// Builds the per-run chat digest. Shadow-mode actions are clearly marked as
// would-do; broken main and flagged majors are surfaced as distinct, prominent
// items rather than buried among routine holds.

export function buildDigest(result: RunResult): string {
  const shadow = result.mode === "shadow";
  const header = shadow
    ? "🟡 *twiki run — SHADOW (dry-run, no writes)*"
    : "🟢 *twiki run — ENFORCE*";

  const blocks: string[] = [header];
  let anyActivity = false;

  for (const repo of result.repos) {
    const lines = repoLines(repo, shadow);
    if (lines.length === 0) continue;
    anyActivity = true;
    blocks.push(`\n*${repo.repo}*`);
    blocks.push(...lines);
  }

  if (!anyActivity) {
    blocks.push("\n_No actionable items this run — all repos quiet._");
  }
  return blocks.join("\n");
}

function repoLines(repo: RepoResult, shadow: boolean): string[] {
  const lines: string[] = [];

  if (repo.error) {
    lines.push(`  ⚠️ error: ${repo.error}`);
    return lines;
  }
  if (repo.mainRed) {
    lines.push("  🔴 *main is RED* — releases blocked until fixed");
  }

  const by = (s: PrOutcome["status"]) =>
    repo.prs.filter((p) => p.status === s);

  for (const pr of by(shadow ? "would-merge" : "merged")) {
    const verb = shadow ? "would merge" : "merged";
    lines.push(`  ✅ ${verb} #${pr.number} — ${pr.title}`);
  }
  // If somehow merges exist in the non-active variant, still surface them.
  for (const pr of by(shadow ? "merged" : "would-merge")) {
    lines.push(`  ✅ ${pr.status} #${pr.number} — ${pr.title}`);
  }
  for (const pr of by("flagged-major")) {
    const mark = pr.security ? "🚨" : "🔶";
    lines.push(`  ${mark} flagged #${pr.number} — ${pr.title} (${pr.detail})`);
  }
  for (const pr of by("blocked")) {
    lines.push(`  ⛔ blocked #${pr.number} — ${pr.title} (${pr.detail})`);
  }
  for (const pr of by("held")) {
    lines.push(`  ✋ held #${pr.number} — ${pr.title} (${pr.detail})`);
  }

  const rel = repo.release;
  switch (rel.status) {
    case "released":
      lines.push(`  🚀 released ${rel.version}`);
      break;
    case "would-release":
      lines.push(`  🚀 would release ${rel.version}`);
      break;
    case "no-release-workflow":
      lines.push(`  ⚠️ ${rel.detail}`);
      break;
    case "skipped-merge-only":
      // Only interesting if it would otherwise have released — keep quiet.
      break;
    case "waiting":
      // Routine; omit unless nothing else happened for this repo.
      if (lines.length === 0) {
        lines.push(`  ⏳ waiting to release — ${rel.detail}`);
      }
      break;
  }

  return lines;
}
