/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

// Scrub anything that looks like a credential (AD-16).
//
// This lives in core because it must apply wherever text reaches an operator
// or the store, not at one formatter. GitHub error messages are the realistic
// carrier: an auth failure can quote the credential it rejected, and that text
// is passed through to logs verbatim and persisted into `collection_run.detail`.
//
// Shapes: GitHub's token prefixes, fine-grained PATs, and the JWT an App mints
// to request an installation token.

const PATTERNS: readonly [RegExp, string][] = [
  [/gh[pousr]_[A-Za-z0-9]{8,}/g, "gh?_REDACTED"],
  [/github_pat_[A-Za-z0-9_]{8,}/g, "github_pat_REDACTED"],
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9._-]{8,}/g, "JWT_REDACTED"],
];

export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
