/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from "node:fs";
import { Octokit } from "@octokit/rest";
import { createAppAuth } from "@octokit/auth-app";

// GitHub App authentication (design D7). The App mints short-lived per-install
// tokens; merges and tags then show as `twiki[bot]`, keeping the audit trail
// honest and the blast radius scoped per installation.

export interface AppAuthConfig {
  appId: string | number;
  privateKey: string;
}

export function loadAppAuthFromEnv(env = process.env): AppAuthConfig {
  const appId = env.TWIKI_GITHUB_APP_ID;
  const keyPath = env.TWIKI_GITHUB_APP_PRIVATE_KEY_PATH;
  const keyInline = env.TWIKI_GITHUB_APP_PRIVATE_KEY;
  if (!appId) throw new Error("TWIKI_GITHUB_APP_ID is required");
  const privateKey = keyInline ?? (keyPath ? readFileSync(keyPath, "utf8") : undefined);
  if (!privateKey) {
    throw new Error(
      "Provide TWIKI_GITHUB_APP_PRIVATE_KEY or TWIKI_GITHUB_APP_PRIVATE_KEY_PATH",
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
): Octokit {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: auth.appId,
      privateKey: auth.privateKey,
      installationId,
    },
  });
}
