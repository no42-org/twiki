/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { safeLog } from "../../core/log.js";
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

/**
 * The KEV feed is unauthenticated, so its validators have no token
 * generation. Nothing compares this value today (the KEV lane sends its
 * validator regardless of generation); the constant exists so the two save
 * sites cannot drift apart, and so any future comparison has one name to
 * compare against.
 */
export const KEV_TOKEN_GEN = "none";

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
  // The logger cannot throw, so nothing after finishRun can reach the catch
  // and rewrite a committed run as failed. This replaces a `finished` flag
  // that guarded the same hazard less directly.
  const log = safeLog(deps.log);

  try {
    run = deps.store.beginRun({
      lane: LANE,
      installation: KEV_INSTALLATION,
      scope,
      startedAt: deps.now(),
    });

    // Conditional only while a stored catalogue exists to keep (AD-25). A 304
    // confirms "what you have is current", which is only useful if we still
    // have it: with no present subject the validator is a leftover, and
    // honouring it would finish ok holding nothing.
    const url = deps.enrichment.endpoint();
    const prior = deps.store.current(KEV_SUBJECT);
    const cached =
      prior?.state === "present"
        ? deps.store.loadValidator(KEV_INSTALLATION, url)
        : null;

    const outcome = await deps.enrichment.fetchKev(
      cached ? { etag: cached.etag, lastModified: cached.lastModified } : null,
    );

    if (outcome.kind === "not_modified") {
      // CISA's own statement that the stored catalogue is still current: the
      // one condition under which advancing its verified_at is honest. This
      // is NOT the freshness top-up that froze the catalogue before; that one
      // touched on degraded fetches, this one only on a 304.
      deps.store.touchVerified([KEV_SUBJECT], deps.now());
      deps.store.saveValidator(
        KEV_INSTALLATION,
        url,
        { ...outcome.validator, tokenGen: KEV_TOKEN_GEN },
        deps.now(),
      );
      deps.store.finishRun(run, "ok", deps.now(), "not modified (304)");
      log(`${LANE}: not modified, catalogue confirmed current`);
      const kept = (prior?.payload as KevObservation | undefined)?.cveIds;
      return {
        outcome: "ok",
        listed: Array.isArray(kept) ? kept.length : 0,
        unreadable: 0,
      };
    }

    const { catalogue } = outcome;
    const { unreadable } = catalogue;

    if (unreadable > 0) {
      // Not stored, and deliberately not touched either. The prior keeps its
      // own verified_at and ages out on schedule; topping it up is what made
      // the freeze invisible last time. The stored validator is also left
      // alone: it still matches the last body we vouched for, and the feed
      // has demonstrably changed since, so the next conditional fetch gets a
      // 200 and a chance at a clean read.
      deps.store.finishRun(
        run,
        "partial",
        deps.now(),
        `${unreadable} entries unreadable; stored nothing`,
      );
      log(`${LANE}: ${unreadable} unreadable, stored nothing`);
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
    // Saved with the catalogue it validates, in the same sweep: a validator
    // for a body we refused to store would confirm 304s about nothing. An
    // all-null validator is never saved: it cannot make a request
    // conditional, and a stored one would count as "cached" while sending no
    // header, the state in which a broken proxy's 304 freezes the catalogue.
    // When the 200 carried no usable validator, any STORED one goes too: it
    // describes the previous body, and if the feed later reverts to exactly
    // that body, a 304 against it would confirm the newer catalogue as
    // current when the origin is serving the older one.
    if (outcome.validator.etag || outcome.validator.lastModified) {
      deps.store.saveValidator(
        KEV_INSTALLATION,
        url,
        { ...outcome.validator, tokenGen: KEV_TOKEN_GEN },
        deps.now(),
      );
    } else {
      deps.store.deleteValidator(KEV_INSTALLATION, url);
    }
    deps.store.finishRun(run, "ok", deps.now());

    log(
      `${LANE}: ${catalogue.cveIds.length} listed CVEs, catalogue ${catalogue.version}`,
    );
    return { outcome: "ok", listed: catalogue.cveIds.length, unreadable: 0 };
  } catch (err) {
    const detail = redact(err instanceof Error ? err.message : String(err));
    // The logger cannot throw, so nothing lands here after finishRun("ok"):
    // this can only be a fetch, parse or store failure on an unfinished run.
    if (run) {
      try {
        deps.store.finishRun(run, "failed", deps.now(), detail);
      } catch {
        // The store is what failed. Nothing further to record.
      }
    }
    // A failed fetch must leave every lookup UNKNOWN, never "not listed"
    // (AD-20). Writing nothing is what achieves that.
    log(`${LANE}: failed, ${detail}`);
    return { outcome: "failed", listed: 0, unreadable: 0 };
  }
}
