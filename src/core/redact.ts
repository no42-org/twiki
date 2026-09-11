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

/**
 * Remove credentials from `text`.
 *
 * `secrets` are removed by exact match, for a caller that holds the value and
 * knows the text may echo it. It exists because the pattern list above can
 * only recognise GitHub's shapes: a Matrix access token has no shape the
 * standard guarantees (`syt_` is Synapse's format, not Matrix's), so the only
 * honest way to strip one is to compare against the configured value. The
 * exact match runs first, so a secret that also matches a pattern is gone
 * before the pattern would rewrite it into something no longer equal to it.
 *
 * The argument is passed per call and nothing is registered: core stays pure,
 * and a caller that does not hold a secret cannot accidentally depend on some
 * other caller having configured one.
 *
 * An empty secret is skipped. That is the unset-env-var case, and splitting on
 * "" matches at every character boundary, which would rewrite the whole string.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret === "") continue;
    out = out.split(secret).join("REDACTED");
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
