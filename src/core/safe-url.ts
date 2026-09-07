/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

/**
 * The one scheme check in front of every outbound link.
 *
 * hono/jsx writes an href verbatim, so a stored `javascript:` URL would
 * become a live one. Every URL the collectors store comes from GitHub, and
 * the link component announces "opens GitHub in a new tab", so the check is
 * the GitHub origin, not merely https: anything else is dropped to null and
 * the caller renders plain text instead of a link. Every view builder and
 * the link component call this rather than repeating the test (AD-40).
 */
export function safeUrl(url: string | null | undefined): string | null {
  return url?.startsWith("https://github.com/") ? url : null;
}
