/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

/**
 * A CVE id, as CISA and GitHub both write them.
 *
 * In core rather than in the KEV adapter: the read path needs it to reject an
 * identifier KEV is not indexed by, and importing it from `src/enrich/kev.ts`
 * dragged the HTTP client into the read-only web process.
 */
export const CVE_ID = /^CVE-\d{4}-\d{4,}$/i;
