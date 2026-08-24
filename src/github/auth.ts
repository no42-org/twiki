/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { readFileSync, type Stats, statSync } from "node:fs";
import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

// GitHub App authentication (design agent-D7, docs/design/dependabot-release-agent.md). The App mints short-lived per-install
// tokens; merges and tags then show as `twiki[bot]`, keeping the audit trail
// honest and the blast radius scoped per installation.

export interface AppAuthConfig {
  appId: string | number;
  privateKey: string;
}

/**
 * Read the key, and say which way it is unusable.
 *
 * The directory case is the one that actually happens and the one that reads
 * as nonsense: Docker creates a MISSING mount source as an empty DIRECTORY
 * rather than refusing to start, so a `*_KEY_PATH` typo on the host surfaces
 * inside the container as `EISDIR: illegal operation on a directory` - which
 * mentions neither keys nor mounts. `.env.example` has had to explain this in
 * prose because the error would not.
 *
 * The variable name travels with the message: twiki and gitricorder are
 * separate Apps (AD-21), so "which key" is the first thing the reader needs.
 */
function readKey(keyPath: string, prefix: string): string {
  const variable = `${prefix}_GITHUB_APP_PRIVATE_KEY_PATH`;
  let stats: Stats;
  try {
    stats = statSync(keyPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `${variable}=${keyPath} does not exist. The private key file must be ` +
          "present before the process starts.",
      );
    }
    throw new Error(
      `${variable}=${keyPath} cannot be inspected: ${err instanceof Error ? err.message : err}`,
    );
  }

  if (stats.isDirectory()) {
    throw new Error(
      `${variable}=${keyPath} is a directory, not a file. Under a container ` +
        "runtime this usually means the mount source did not exist on the " +
        "host, so a directory was created there instead of the key being " +
        "mounted. Check the host path.",
    );
  }

  try {
    return readFileSync(keyPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EACCES") {
      throw new Error(
        `${variable}=${keyPath} is not readable by uid ${process.getuid?.() ?? "unknown"}. ` +
          "The image runs as a non-root user; the key file must be readable by it.",
      );
    }
    throw new Error(
      `${variable}=${keyPath} could not be read: ${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Credentials for one App, chosen by environment-variable prefix.
 *
 * The prefix is a parameter because twiki and gitricorder are deliberately
 * DIFFERENT Apps with different permissions (AD-21): twiki can merge and tag,
 * gitricorder can only read. Sharing one credential would give the dashboard
 * the ability to write, which is the single thing its design rules out, so the
 * two must not be able to reach each other's variables by accident.
 */
export function loadAppAuthFromEnv(
  env = process.env,
  prefix: "TWIKI" | "TRICORDER" = "TWIKI",
): AppAuthConfig {
  const appId = env[`${prefix}_GITHUB_APP_ID`];
  const keyPath = env[`${prefix}_GITHUB_APP_PRIVATE_KEY_PATH`];
  const keyInline = env[`${prefix}_GITHUB_APP_PRIVATE_KEY`];
  if (!appId) throw new Error(`${prefix}_GITHUB_APP_ID is required`);
  const privateKey =
    keyInline ?? (keyPath ? readKey(keyPath, prefix) : undefined);
  if (!privateKey) {
    throw new Error(
      `Provide ${prefix}_GITHUB_APP_PRIVATE_KEY or ${prefix}_GITHUB_APP_PRIVATE_KEY_PATH`,
    );
  }
  return { appId, privateKey };
}

/**
 * Build an Octokit client authenticated as a specific installation. Octokit's
 * app-auth strategy refreshes the installation token automatically as it nears
 * expiry, so callers get short-lived credentials transparently.
 */
export function installationOctokit(
  auth: AppAuthConfig,
  installationId: number,
  /**
   * Test seam only: the transport this client issues through. It is a
   * parameter rather than a branch at the call site so that production and
   * tests build the client the SAME way - a factory that constructs inline
   * when stubbed and calls this when not would let a wrapper added here
   * later (request discipline, say) miss the tested path entirely, or vice
   * versa, with the suite green either way.
   */
  fetchImpl?: typeof fetch,
): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: auth.appId,
      privateKey: auth.privateKey,
      installationId,
    },
    ...(fetchImpl ? { request: { fetch: fetchImpl } } : {}),
  });
}
