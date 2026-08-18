/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import type { Subject, SubjectType } from "../../core/subject.js";
import type { RepoRef } from "../../core/types.js";
import type { StorePort } from "../store/port.js";

// The AD-23 tombstone guard for node-keyed subjects, shared by the update-PR
// and issue lanes. It existed as two verbatim copies, and a fix landing in
// one would have left the other lane wrongly concluding what a sweep it did
// not run had seen. The caller has already established scope === "full" and
// outcome === "ok"; this answers only "which stored rows may that sweep
// conclude are gone".

/**
 * Node-id keys carry no owner, so scope and allowlist are judged from the
 * payload's `repo` field. A row whose payload cannot answer is left alone: a
 * wrong tombstone silently wipes real state (AD-23).
 */
export function nodeTombstones(
  store: StorePort,
  type: SubjectType,
  seen: ReadonlySet<string>,
  installation: string,
  isWatched: (repo: RepoRef) => boolean,
): Subject[] {
  return store
    .currentByType(type)
    .filter((c) => c.state === "present")
    .filter((c) => !seen.has(c.subject.key))
    .filter((c) => {
      const repo = (c.payload as { repo?: unknown } | undefined)?.repo;
      if (typeof repo !== "string") return false;
      const [owner = "", name = ""] = repo.split("/");
      if (owner.toLowerCase() !== installation.toLowerCase()) return false;
      return isWatched({ owner, name });
    })
    .map((c) => c.subject);
}
