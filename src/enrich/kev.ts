/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { CVE_ID } from "../core/cve.js";
import type {
  CachedValidator,
  EnrichmentPort,
  KevCatalogue,
  KevFetchOutcome,
} from "./port.js";

// CISA's Known Exploited Vulnerabilities catalogue.
//
// Measured 2026-08-17: 1.5MB, 1666 entries, every `cveID` well-formed and
// unique. Only the ids are kept, 27KB of them, because membership is the only
// question the ranking chain asks. Re-fetched daily, so the detail is a fetch
// away if a later story wants it.

export const KEV_URL =
  "https://www.cisa.gov/sites/default/files/feeds/known_exploited_vulnerabilities.json";

/** Reject a body larger than this rather than buffering it. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export type KevFetchResult = KevCatalogue;

/**
 * Turn CISA's payload into a catalogue, or refuse.
 *
 * The refusal is the point. An empty or unrecognisable catalogue mapped to an
 * empty set would make EVERY lookup answer "not in KEV", which is a confident
 * negative on the chain's most significant term: exactly the failure this
 * dashboard exists to prevent, and it would look like good news on every row.
 * A real KEV catalogue is never empty.
 */
export function parseKev(body: unknown): KevFetchResult {
  const doc = body as {
    catalogVersion?: unknown;
    dateReleased?: unknown;
    count?: unknown;
    vulnerabilities?: unknown;
  } | null;

  if (!doc || typeof doc !== "object" || !Array.isArray(doc.vulnerabilities)) {
    throw new Error("KEV payload has no vulnerabilities array");
  }
  if (doc.vulnerabilities.length === 0) {
    throw new Error("KEV catalogue is empty, which it never legitimately is");
  }

  const ids = new Set<string>();
  let unreadable = 0;
  for (const entry of doc.vulnerabilities) {
    const id = (entry as { cveID?: unknown } | null)?.cveID;
    if (typeof id !== "string" || !CVE_ID.test(id.trim())) {
      unreadable++;
      continue;
    }
    ids.add(id.trim().toUpperCase());
  }

  if (ids.size === 0) {
    throw new Error("KEV catalogue yielded no readable CVE ids");
  }

  const claimedCount = typeof doc.count === "number" ? doc.count : null;
  // CISA's own count against what actually arrived. A body truncated in
  // transit parses cleanly and reports zero unreadable, so without this it
  // would look like a complete catalogue that happens to be smaller.
  if (claimedCount !== null && doc.vulnerabilities.length < claimedCount) {
    throw new Error(
      `KEV payload is truncated: CISA declared ${claimedCount} entries, ${doc.vulnerabilities.length} arrived`,
    );
  }

  return {
    version: typeof doc.catalogVersion === "string" ? doc.catalogVersion : "",
    released: typeof doc.dateReleased === "string" ? doc.dateReleased : "",
    claimedCount,
    cveIds: [...ids].sort(),
    unreadable,
  };
}

export class HttpEnrichment implements EnrichmentPort {
  constructor(
    private readonly url: string = KEV_URL,
    private readonly fetchImpl: typeof fetch = fetch,
    /** Overridable so a test can prove the cap without a 32MB fixture. */
    private readonly maxBodyBytes: number = MAX_BODY_BYTES,
  ) {}

  /** The endpoint this instance will call. Exposed so a test can pin it. */
  endpoint(): string {
    return this.url;
  }

  async fetchKev(cached: CachedValidator | null): Promise<KevFetchOutcome> {
    // A timeout, because this is the one dependency outside GitHub and a hung
    // response would otherwise stall the whole collection cycle.
    const headers: Record<string, string> = {
      accept: "application/json",
      // Public CDNs commonly throttle or reject the default Node agent.
      "user-agent": "gitricorder (+https://github.com/no42-org/twiki)",
    };
    // Both validators when both exist: RFC 9110 says a server receiving both
    // must prefer If-None-Match, and a CDN that only honours one still gets
    // its chance to answer 304 (AD-25).
    if (cached?.etag) headers["if-none-match"] = cached.etag;
    if (cached?.lastModified)
      headers["if-modified-since"] = cached.lastModified;
    // Whether a validator actually went on the wire. NOT `cached !== null`:
    // an all-null validator is truthy but adds no header, and accepting a
    // 304 for it would confirm a catalogue against nothing, forever - the
    // self-sustaining freeze this lane's history warns about.
    const conditional =
      "if-none-match" in headers || "if-modified-since" in headers;
    const res = await this.fetchImpl(this.url, {
      signal: AbortSignal.timeout(60_000),
      headers,
    });
    if (res.status === 304) {
      if (!conditional || !cached) {
        // A 304 answers a conditional request. We did not make one, so the
        // origin (or a broken proxy) is confirming a validator we never sent.
        throw new Error("KEV fetch answered 304 to an unconditional request");
      }
      return { kind: "not_modified", validator: cached };
    }
    if (!res.ok) {
      throw new Error(`KEV fetch failed: HTTP ${res.status}`);
    }
    // A captive portal or proxy answers 200 with HTML. Parsing that would
    // throw somewhere less legible than here.
    const type = res.headers?.get?.("content-type") ?? "";
    if (type && !type.includes("json")) {
      throw new Error(`KEV response is not JSON: ${type}`);
    }
    const declared = Number(res.headers?.get?.("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > this.maxBodyBytes) {
      throw new Error(`KEV response too large: ${declared} bytes`);
    }
    return {
      kind: "fresh",
      catalogue: parseKev(await this.readJson(res)),
      validator: {
        etag: res.headers?.get?.("etag") ?? null,
        lastModified: res.headers?.get?.("last-modified") ?? null,
      },
    };
  }

  /**
   * Read the body with a byte cap that holds even when no length is declared.
   *
   * The header check above is a cheap fast-fail, nothing more: a chunked or
   * gzip-encoded response carries no content-length, so `res.json()` alone
   * would buffer an unbounded body and the guard's comment would be a lie. A
   * misbehaving mirror behind TRICORDER_KEV_URL is exactly the scenario the
   * cap exists for.
   */
  private async readJson(res: Response): Promise<unknown> {
    // Test fakes and some polyfills expose no body stream; a real fetch
    // Response always does.
    if (!res.body) return res.json();
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > this.maxBodyBytes) {
        await reader.cancel();
        throw new Error(
          `KEV response too large: exceeded ${this.maxBodyBytes} bytes`,
        );
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  }
}
