/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { FailingCheck } from "../core/types.js";
import type { PrOutcome, RepoResult, RunResult } from "./result.js";

const REMEDIATION_VERB = {
  reran: "re-ran CI",
  "would-rerun": "would re-run CI",
  rebased: "rebased",
  "would-rebase": "would rebase",
  "failed-rerun": "could NOT re-run CI",
  "failed-rebase": "could NOT rebase",
} as const;

/**
 * Bound the reason so one failure cannot cost the whole digest.
 *
 * safePlan's try block covers PlanSchema.parse, and a ZodError message is a
 * multi-kilobyte dump of issues. Interpolated raw, that pushes the digest past
 * Discord's 2000-character limit, the webhook answers 400, `deliver` throws,
 * and runOnce catches it into "notify failed" - losing the entire digest,
 * including any merges that DID happen. The Matrix notifier
 * already bounds its input for the same reason.
 */
const MAX_REASON_CHARS = 500;

function truncateReason(reason: string): string {
  return reason.length <= MAX_REASON_CHARS
    ? reason
    : `${reason.slice(0, MAX_REASON_CHARS)}… (truncated; see the log for the rest)`;
}

/** Failing check names plus a link to the first one with a URL. */
function summarizeFailing(checks: FailingCheck[]): string {
  const names = checks.map((c) => c.name).join(", ");
  const url = checks.find((c) => c.detailsUrl)?.detailsUrl;
  return url ? `${names} — ${url}` : names;
}

// A repo contributes "actionable" news when something happened or needs
// attention: an error, red main, an unprotected branch, any PR outcome, or a
// CI-remediation. A repository with none of these is routine, and reporting
// it every tick just spams the channel.
function repoHasActivity(repo: RepoResult): boolean {
  if (repo.error || repo.mainRed) return true;
  // A branch that could not be confirmed defended is news, and a QUIET
  // repository is exactly where one hides: nothing merging, so without this
  // the digest is suppressed and the fact is gathered every tick and shown on
  // none of them. `protection` is only set
  // when the branch is not confirmed protected, so this cannot spam.
  if (repo.protection) return true;
  if (repo.prs.length > 0) return true;
  return (repo.remediations ?? []).length > 0;
}

/** True when at least one repo has actionable news worth posting this tick. */
export function hasActionableActivity(result: RunResult): boolean {
  // An advisor outage is news on its own. Without this, a quiet estate plus a
  // broken advisor suppresses the digest entirely, and the one run that most
  // needs reporting is the one nobody hears about.
  if (result.advisorFailed !== undefined) return true;
  return result.repos.some(repoHasActivity);
}

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

  if (result.advisorFailed !== undefined) {
    // At the top, before the repositories, because it changes how the held
    // lines below should be read: each is the absence of a decision, not a
    // decision to hold. The reason is included rather than just the fact -
    // "the advisor is down" and "the advisor is down because the account has
    // no credit" call for different actions.
    //
    // "did not produce a plan", NOT "could not be reached". safePlan catches
    // every throw from the advisor, and two of the causes are the opposite of
    // unreachable: a missing plan tool call, and a schema validation failure,
    // both of which mean it answered and the answer was unusable. Telling an
    // operator it was unreachable sends them to check credit and network,
    // which are fine, and away from the model output - where a validation
    // failure is also a plausible prompt-injection symptom.
    //
    // The scope line is load-bearing too. NOT everything below is advisor-
    // derived: a major bump is flagged before the plan is read. An earlier
    // version told the reader to discount everything, which would have
    // discounted an URGENT security flag.
    anyActivity = true;
    blocks.push(
      `\n🧠 *The advisor did not produce a plan, so nothing was merged on its advice.*` +
        `\n   Every "held" below is a decision not taken, not a decision to hold.` +
        `\n   Flagged majors are decided without the advisor and still stand.` +
        `\n   ${truncateReason(result.advisorFailed)}`,
    );
  }

  if (result.rulesOnly) {
    // Not activity on its own: it says how to read the lines below, and a
    // tick with nothing else to say is suppressed before this is built.
    blocks.push(
      "\n📏 *Rules-only: no changelog was read.* Merges below passed the gates alone.",
    );
  }

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
    // NO early return. This used to stop here, so a repository that merged
    // three pull requests and then failed rendered as the error alone - the
    // merges were hidden from the one surface with a human on the other end,
    // even once the executor stopped discarding them.
  }
  if (repo.stoppedEarly) {
    // Said, never left to inference. Otherwise the pull requests it never got
    // to look exactly like pull requests it checked and found nothing to do.
    // The cause is NOT asserted here. `repo.error` is rendered just above and
    // carries it; claiming "after a failed write" would be wrong whenever a
    // read was what threw.
    const n = repo.notEvaluated ?? 0;
    lines.push(
      `  ⏹️ stopped early` +
        (n > 0
          ? ` — ${n} pull request${n === 1 ? "" : "s"} not evaluated`
          : ""),
    );
  }
  if (repo.protection) {
    // Reported, never gated on (protection-is-a-fact D4). twiki merges into
    // this branch; whether anything defends it is
    // worth a line, and nothing here changes what twiki does.
    //
    // Only speaks when the branch is NOT confirmed defended. A line that
    // appears every tick stops being read, and the confirmed case carries no
    // information the operator can act on.
    const p = repo.protection;
    lines.push(
      p.state === "undefended"
        ? "  🔓 *main is undefended* — nothing gates what lands on it"
        : "  ❔ *main's defences could not be confirmed*",
    );
    for (const rs of p.inertRulesets) {
      // The trap this fact exists for: a ruleset named "main protection"
      // that enforces nothing reads as protection in every listing.
      lines.push(
        `     ↳ ruleset "${rs.name}" exists but does not enforce (${rs.enforcement})`,
      );
    }
    for (const src of p.unreadableSources) {
      // twiki's own limit, said as twiki's own limit. "Not protected" when
      // the truth is "may not look" sends the reader to settings that are
      // already correct.
      lines.push(`     ↳ twiki could not read ${src}`);
    }
  }
  if (repo.mainRed) {
    lines.push("  🔴 *main is RED*");
    for (const c of repo.mainFailingChecks ?? []) {
      lines.push(`     ↳ ${c.name}${c.detailsUrl ? ` (${c.detailsUrl})` : ""}`);
    }
  }

  const by = (s: PrOutcome["status"]) => repo.prs.filter((p) => p.status === s);

  for (const pr of by(shadow ? "would-merge" : "merged")) {
    const verb = shadow ? "would merge" : "merged";
    lines.push(`  ✅ ${verb} #${pr.number} — ${pr.title}`);
  }
  // If somehow merges exist in the non-active variant, still surface them.
  for (const pr of by(shadow ? "merged" : "would-merge")) {
    lines.push(`  ✅ ${pr.status} #${pr.number} — ${pr.title}`);
  }
  for (const pr of by("already-merged")) {
    lines.push(`  ☑️ already merged #${pr.number} — ${pr.title} (${pr.detail})`);
  }
  for (const pr of by("flagged-major")) {
    const mark = pr.security ? "🚨" : "🔶";
    lines.push(`  ${mark} flagged #${pr.number} — ${pr.title} (${pr.detail})`);
  }
  for (const pr of by("blocked")) {
    const extra = pr.failingChecks?.length
      ? ` — failing: ${summarizeFailing(pr.failingChecks)}`
      : "";
    lines.push(
      `  ⛔ blocked #${pr.number} — ${pr.title} (${pr.detail})${extra}`,
    );
  }
  for (const pr of by("held")) {
    lines.push(`  ✋ held #${pr.number} — ${pr.title} (${pr.detail})`);
  }

  for (const rem of repo.remediations ?? []) {
    const icon = rem.kind === "rerun" ? "🔁" : "🔄";
    lines.push(
      `  ${icon} ${REMEDIATION_VERB[rem.status]} ${rem.ref} — ${rem.detail}`,
    );
  }

  return lines;
}
