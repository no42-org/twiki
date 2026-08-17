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
}

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
    const unreadable = (catalogue as { unreadable?: number }).unreadable ?? 0;

    // A catalogue we could only partly read would answer "not listed" for
    // every CVE it dropped, and that is a false negative on the chain's most
    // significant term. Keep what we already had rather than replace it with a
    // smaller list, exactly as the coverage lane refuses to overwrite
    // knowledge with a failure.
    const prior = deps.store.current(KEV_SUBJECT);
    if (unreadable > 0 && prior !== null) {
      deps.store.finishRun(
        run,
        "partial",
        deps.now(),
        `${unreadable} entries unreadable; kept the previous catalogue`,
      );
      deps.log(`${LANE}: ${unreadable} unreadable, previous catalogue kept`);
      return { outcome: "partial", listed: 0, unreadable };
    }

    const payload: KevObservation = {
      version: catalogue.version,
      released: catalogue.released,
      cveIds: catalogue.cveIds,
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
