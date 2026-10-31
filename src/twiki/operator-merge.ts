/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { Config } from "../core/config.js";
import type {
  MergeRefusal,
  MergeRequest,
  MergeResponse,
} from "../core/merge.js";
import { foldSlug } from "../core/slug.js";
import type { GitHubPort } from "../github/port.js";
import type { AuditSink } from "./audit.js";
import { operatorMergeBlock } from "./gates.js";

export interface OperatorMergeDeps {
  config: Config;
  github: Pick<GitHubPort, "livePullRequest" | "prChecks" | "mergePR">;
  audit: AuditSink;
  now: () => string;
  log: (msg: string) => void;
}

const SLUG = /^[^/\s]+\/[^/\s]+$/;

function statusOf(err: unknown): number | null {
  const s = (err as { status?: unknown } | null)?.status;
  return typeof s === "number" ? s : null;
}

/**
 * Merge one pull request because the operator asked. The request comes from
 * outside, so nothing in it is trusted: the allowlist and the mode are
 * checked before any GitHub call, and the state is read live, not from the
 * store. The merge is pinned to the head sha that was gated, so a push in
 * between makes GitHub refuse it.
 */
export async function operatorMerge(
  request: MergeRequest,
  deps: OperatorMergeDeps,
): Promise<MergeResponse> {
  const { config, github, audit, now, log } = deps;
  let headSha: string | null = null;
  const done = (response: MergeResponse): MergeResponse => {
    audit.recordOperatorMerge(
      { repo: String(request.repo), number: request.number, response, headSha },
      now(),
    );
    return response;
  };
  const refuse = (refusal: MergeRefusal) =>
    done({ outcome: "refused", refusal });

  if (
    typeof request.repo !== "string" ||
    !SLUG.test(request.repo) ||
    !Number.isInteger(request.number) ||
    request.number < 1
  ) {
    return refuse("not-allowlisted");
  }
  // The store holds lowercased slugs but repos.yaml may declare mixed case.
  // GitHub calls use the declared spelling.
  const declared = config.declaredSlugs.get(foldSlug(request.repo));
  if (declared === undefined) return refuse("not-allowlisted");
  const [owner, name] = declared.split("/") as [string, string];
  const repo = { owner, name };
  if (config.mode !== "enforce") return refuse("shadow-mode");

  try {
    const live = await github.livePullRequest(repo, request.number);
    headSha = live.headSha;
    const checks = await github.prChecks(repo, live.headSha);
    const block = operatorMergeBlock(live, checks);
    if (block === "already-merged") return done({ outcome: "already-merged" });
    if (block) return refuse(block);

    try {
      await github.mergePR(repo, request.number, live.headSha);
    } catch (err) {
      const status = statusOf(err);
      if (status === 409) return refuse("head-changed");
      if (status === 405) {
        const again = await github.livePullRequest(repo, request.number);
        return again.state === "MERGED"
          ? done({ outcome: "already-merged" })
          : refuse("not-mergeable");
      }
      throw err;
    }
    return done({ outcome: "merged" });
  } catch (err) {
    log(
      `operator merge of ${request.repo}#${request.number} failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    throw err;
  }
}
