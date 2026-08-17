/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { redact } from "../../core/redact.js";
import { KEV_KEY, KEV_SUBJECT } from "../../core/subject.js";
import type { EnrichmentPort } from "../../enrich/port.js";
import type { RunScope, StorePort } from "../store/port.js";

// The KEV lane (AD-15). Daily, one public JSON, no GitHub involved.

export const LANE = "kev";

/**
 * The one name CISA is known by, as an installation.
 * Same constant as the subject key, so the two cannot drift.
 */
export const KEV_INSTALLATION = KEV_KEY;

/** The lane's cadence. Exported so the reader judges it on the same number. */
export const KEV_CADENCE_MS = 24 * 60 * 60_000;

/** After a failure, retry sooner than a full day. */
export const KEV_RETRY_MS = 60 * 60_000;

export interface KevObservation {
  version: string;
  released: string;
  cveIds: readonly string[];
}

export interface KevDeps {
  enrichment: EnrichmentPort;
  store: StorePort;
  now: () => string;
  log: (msg: string) => void;
}

export interface KevResult {
  outcome: "ok" | "partial" | "failed";
  /** CVEs in the catalogue this run stored. Zero when it stored nothing. */
  listed: number;
  /** Entries CISA sent that we could not read. */
  unreadable: number;
}

/**
 * Collect the CISA KEV catalogue.
 *
 * ONE RULE: store a catalogue only when we can vouch for all of it. Anything
 * else writes nothing at all and finishes `partial`.
 *
 * This replaces three rounds of increasingly elaborate machinery, all of it
 * built on a misdiagnosis. The fear was that a persistently degraded feed
 * would freeze the catalogue, so each version tried harder to keep something
 * usable: keep the prior, then keep it only while fresh, then keep its
 * freshness topped up. The last of those froze the catalogue permanently AND
 * made it read as fresh with trustworthy negatives, which is worse than the
 * problem it was solving.
 *
 * A frozen catalogue was never the danger. Serving stale data as current is.
 * Writing nothing lets the prior age out on its own and the chain's first term
 * go `unknown`, which is what AD-20 asks for, and a single clean fetch heals it
 * immediately. Nothing here can produce a confident "not in KEV" from a
 * catalogue we could not fully read.
 */
export async function collectKev(
  deps: KevDeps,
  scope: RunScope = "full",
): Promise<KevResult> {
  let run: ReturnType<StorePort["beginRun"]> | null = null;
  let finished = false;

  try {
    run = deps.store.beginRun({
      lane: LANE,
      installation: KEV_INSTALLATION,
      scope,
      startedAt: deps.now(),
    });

    const catalogue = await deps.enrichment.fetchKev();
    const { unreadable } = catalogue;

    if (unreadable > 0) {
      // Not stored, and deliberately not touched either. The prior keeps its
      // own verified_at and ages out on schedule; topping it up is what made
      // the freeze invisible last time.
      deps.store.finishRun(
        run,
        "partial",
        deps.now(),
        `${unreadable} entries unreadable; stored nothing`,
      );
      finished = true;
      deps.log(`${LANE}: ${unreadable} unreadable, stored nothing`);
      return { outcome: "partial", listed: 0, unreadable };
    }

    deps.store.recordObservations(run, deps.now(), [
      {
        subject: KEV_SUBJECT,
        payload: {
          version: catalogue.version,
          released: catalogue.released,
          cveIds: catalogue.cveIds,
        } satisfies KevObservation,
      },
    ]);
    deps.store.finishRun(run, "ok", deps.now());
    finished = true;

    deps.log(
      `${LANE}: ${catalogue.cveIds.length} listed CVEs, catalogue ${catalogue.version}`,
    );
    return { outcome: "ok", listed: catalogue.cveIds.length, unreadable: 0 };
  } catch (err) {
    const detail = redact(err instanceof Error ? err.message : String(err));
    // Only if the run has not already been finished. Otherwise a throw from
    // logging would rewrite a successful run as a failure that never happened.
    if (run && !finished) {
      try {
        deps.store.finishRun(run, "failed", deps.now(), detail);
      } catch {
        // The store is what failed. Nothing further to record.
      }
    }
    // A failed fetch must leave every lookup UNKNOWN, never "not listed"
    // (AD-20). Writing nothing is what achieves that.
    try {
      deps.log(`${LANE}: failed, ${detail}`);
    } catch {
      // Even the logger. Nothing throws past this boundary (AD-16), and a
      // logger that throws inside the catch would escape the lane and take the
      // whole cycle with it.
    }
    return { outcome: "failed", listed: 0, unreadable: 0 };
  }
}
