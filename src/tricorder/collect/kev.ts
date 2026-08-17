/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { redact } from "../../core/redact.js";
import { KEV_SUBJECT } from "../../core/subject.js";
import type { EnrichmentPort } from "../../enrich/port.js";
import type { RunScope, StorePort } from "../store/port.js";

// The KEV lane (AD-15). Daily, one public JSON, no GitHub involved.

export const LANE = "kev";

export interface KevObservation {
  version: string;
  released: string;
  cveIds: readonly string[];
  /**
   * Entries CISA sent that we could not read.
   *
   * Persisted because the lookup needs it. A catalogue missing entries can
   * still prove a POSITIVE (an id present is present) but cannot prove a
   * negative, and only this field lets the reader downgrade the misses.
   */
  unreadable: number;
}

/**
 * How much of the catalogue may be unreadable before we distrust the fetch.
 *
 * A ratio, not a count, and not zero. Zero was the first version and it was a
 * trap: one malformed entry among 1666 discarded the whole fetch, and because
 * the next day's fetch would contain the same bad entry, the catalogue would
 * never update again. After two cadences the chain's top term went permanently
 * unknown with no way back. A fetch that is 99% readable is worth having;
 * one that is half missing is not.
 */
export const MAX_UNREADABLE_RATIO = 0.01;

export interface KevDeps {
  enrichment: EnrichmentPort;
  store: StorePort;
  now: () => string;
  log: (msg: string) => void;
}

export interface KevResult {
  outcome: "ok" | "partial" | "failed";
  listed: number;
  unreadable: number;
}

/** The installation column is not meaningful here; KEV is global. */
export const KEV_INSTALLATION = "cisa";

export async function collectKev(
  deps: KevDeps,
  scope: RunScope = "full",
): Promise<KevResult> {
  let run: ReturnType<StorePort["beginRun"]> | null = null;

  try {
    run = deps.store.beginRun({
      lane: LANE,
      installation: KEV_INSTALLATION,
      scope,
      startedAt: deps.now(),
    });

    const catalogue = await deps.enrichment.fetchKev();
    const { unreadable } = catalogue;
    const total = catalogue.cveIds.length + unreadable;
    const ratio = total === 0 ? 1 : unreadable / total;

    // Badly degraded, and we already hold something better: keep what we had
    // rather than replace it with a materially smaller list, exactly as the
    // coverage lane refuses to overwrite knowledge with a failure.
    //
    // Judged on a RATIO, not on "any unreadable at all". That was the first
    // version and it was a trap: one malformed entry among 1666 discarded the
    // fetch, the next day's fetch carried the same entry, and the catalogue
    // never updated again.
    const prior = deps.store.current(KEV_SUBJECT);
    if (ratio > MAX_UNREADABLE_RATIO && prior !== null) {
      const kept = (prior.payload as KevObservation).cveIds.length;
      deps.store.finishRun(
        run,
        "partial",
        deps.now(),
        `${unreadable} of ${total} entries unreadable; kept the previous catalogue`,
      );
      deps.log(
        `${LANE}: ${unreadable}/${total} unreadable, kept the previous ${kept} CVEs`,
      );
      // The count reports what is actually in the store, not zero for a run
      // that kept a full catalogue.
      return { outcome: "partial", listed: kept, unreadable };
    }

    const payload: KevObservation = {
      version: catalogue.version,
      released: catalogue.released,
      cveIds: catalogue.cveIds,
      unreadable,
    };
    deps.store.recordObservations(run, deps.now(), [
      { subject: KEV_SUBJECT, payload },
    ]);

    const outcome = unreadable > 0 ? "partial" : "ok";
    deps.store.finishRun(
      run,
      outcome,
      deps.now(),
      unreadable > 0 ? `${unreadable} entries unreadable` : undefined,
    );
    deps.log(
      `${LANE}: ${catalogue.cveIds.length} listed CVEs, catalogue ${catalogue.version}` +
        (unreadable > 0 ? `, ${unreadable} unreadable` : ""),
    );
    return {
      outcome,
      listed: catalogue.cveIds.length,
      unreadable,
    };
  } catch (err) {
    const detail = redact(err instanceof Error ? err.message : String(err));
    if (run) {
      try {
        deps.store.finishRun(run, "failed", deps.now(), detail);
      } catch {
        // The store is what failed. Nothing further to record.
      }
    }
    // A failed KEV fetch must leave every lookup UNKNOWN, never "not listed"
    // (AD-20). Writing nothing is what achieves that: the prior catalogue ages
    // out on its own freshness rather than being replaced by a lie.
    deps.log(`${LANE}: failed, ${detail}`);
    return { outcome: "failed", listed: 0, unreadable: 0 };
  }
}
