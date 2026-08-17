/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { redact } from "../../core/redact.js";
import { KEV_KEY, KEV_SUBJECT } from "../../core/subject.js";
import type { EnrichmentPort } from "../../enrich/port.js";
import type { RunScope, StorePort } from "../store/port.js";
import { type FreshnessPolicy, freshness } from "../web/freshness.js";

// The KEV lane (AD-15). Daily, one public JSON, no GitHub involved.

export const LANE = "kev";

/** Fraction of the prior catalogue below which a new one is treated as truncated. */
export const MIN_RETAINED_RATIO = 0.9;

export interface KevObservation {
  version: string;
  released: string;
  cveIds: readonly string[];
  /** CISA's declared count, kept so a later read can cross-check. */
  claimedCount?: number | null;
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
  /**
   * How long a stored catalogue stays trustworthy. Used to decide when to stop
   * holding a complete-but-ageing catalogue in favour of a degraded fresh one.
   */
  freshFor?: FreshnessPolicy;
}

/** The prior catalogue, only when it is one we could actually use. */
export function usablePrior(
  store: StorePort,
): { ids: readonly string[]; verifiedAt: string } | null {
  const row = store.current(KEV_SUBJECT);
  // Tombstoned rows keep their payload, so `!== null` is not enough: the
  // lookup rejects a resolved row, and a lane that "kept" one would report
  // holding a catalogue nothing can read.
  if (!row || row.state !== "present") return null;
  const payload = row.payload as KevObservation | undefined;
  // An unchecked cast here throws inside the try, and the outer catch would
  // then report a fetch failure that never happened.
  if (!payload || !Array.isArray(payload.cveIds)) return null;
  if (payload.cveIds.length === 0) return null;
  return { ids: payload.cveIds, verifiedAt: row.verifiedAt };
}

export interface KevResult {
  outcome: "ok" | "partial" | "failed";
  listed: number;
  unreadable: number;
}

/**
 * The installation column is not meaningful here; KEV is global.
 * Same constant as the subject key, so the two cannot drift.
 */
export const KEV_INSTALLATION = KEV_KEY;

/** The lane's cadence. Exported so the reader judges it on the same number. */
export const KEV_CADENCE_MS = 24 * 60 * 60_000;

/** After a failure, retry sooner than a full day. */
export const KEV_RETRY_MS = 60 * 60_000;

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
    // Denominator from what CISA actually sent, not the de-duplicated set:
    // duplicates collapse in parsing and would otherwise inflate the ratio the
    // whole guard rests on.
    const total =
      catalogue.claimedCount ?? catalogue.cveIds.length + unreadable;
    const ratio = total === 0 ? 1 : unreadable / total;

    // A catalogue that parsed perfectly can still be truncated. Nothing in the
    // unreadable count would show it, so size is checked separately.
    const prior = usablePrior(deps.store);
    const shrank =
      prior !== null &&
      catalogue.cveIds.length < prior.ids.length * MIN_RETAINED_RATIO;

    // Prefer a complete catalogue we already hold over a degraded new one,
    // but only while the one we hold is still fresh. Holding it forever was
    // the first version's trap: a feed that stays slightly broken would freeze
    // the catalogue, it would age past its budget, and the chain's top term
    // would go permanently unknown with no way back. Once the prior is close
    // to stale, the degraded fetch is the better of two imperfect answers.
    const priorStillGood =
      prior !== null &&
      (deps.freshFor === undefined ||
        freshness(prior.verifiedAt, new Date(deps.now()), deps.freshFor) ===
          "fresh");

    const degraded = ratio > MAX_UNREADABLE_RATIO || unreadable > 0 || shrank;
    if (degraded && prior !== null && priorStillGood) {
      const kept = prior.ids.length;
      deps.store.finishRun(
        run,
        "partial",
        deps.now(),
        shrank
          ? `catalogue shrank to ${catalogue.cveIds.length} from ${kept}; kept the previous one`
          : `${unreadable} of ${total} entries unreadable; kept the previous catalogue`,
      );
      deps.log(
        `${LANE}: ${shrank ? `shrank to ${catalogue.cveIds.length}` : `${unreadable}/${total} unreadable`}, kept the previous ${kept} CVEs`,
      );
      // The kept catalogue is still being confirmed, so its freshness must
      // advance. Without this a persistently degraded feed keeps a catalogue
      // that silently ages into stale, and the term goes unknown anyway.
      deps.store.touchVerified([KEV_SUBJECT], deps.now());
      // The count reports what is actually in the store, not zero for a run
      // that kept a full catalogue.
      return { outcome: "partial", listed: kept, unreadable };
    }

    const payload: KevObservation = {
      version: catalogue.version,
      released: catalogue.released,
      cveIds: catalogue.cveIds,
      claimedCount: catalogue.claimedCount,
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
