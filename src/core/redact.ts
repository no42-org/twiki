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
 * The shortest configured value treated as a credential.
 *
 * The same 8 the pattern list above requires, and it is a floor on what may be
 * rewritten, not on what may be configured. Redaction exists to PRESERVE the
 * diagnostic while removing the credential from it; below this length the
 * removal costs more than it buys. `TWIKI_MATRIX_TOKEN=" "` would otherwise
 * turn every space in a homeserver's error into a marker, and test/matrix.test.ts
 * really does construct a notifier with the token `tok`, which would rewrite the
 * word "token" in any body that explained the failure.
 *
 * The cost is stated rather than hidden: a caller whose real credential is
 * shorter than this gets no exact-match protection. No GitHub or Matrix
 * credential is.
 */
const MIN_SECRET_LENGTH = 8;

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
 * A secret that is blank, or shorter than MIN_SECRET_LENGTH once trimmed, is
 * skipped: those are the unset and misconfigured env-var cases, and splitting
 * on one of them rewrites ordinary text rather than a credential. The marker is
 * shaped like the pattern list's, so a reader of a redacted message knows a
 * configured secret was removed and not, say, a JWT.
 */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const secret of secrets) {
    if (secret.trim().length < MIN_SECRET_LENGTH) continue;
    out = out.split(secret).join("SECRET_REDACTED");
  }
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}
