/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import {
  type Config,
  isAllowlisted,
  loadConfig,
  remediationFromEnv,
} from "./core/config.js";
import type { Mode } from "./core/types.js";
import { createGitHubFromEnv } from "./github/octokit-adapter.js";
import { ClaudeAdvisor } from "./twiki/advisor.js";
import { JsonlAudit } from "./twiki/audit.js";
import {
  ConsoleNotifier,
  dedupePathFor,
  MatrixNotifier,
  type Notifier,
  WebhookNotifier,
} from "./twiki/notify.js";
import type { RunDeps } from "./twiki/run.js";
import { schedule } from "./twiki/scheduler.js";

// Entrypoint. Reads the environment, loads config and constructs dependencies,
// then hands off to the scheduler in src/twiki/. Everything below the handoff
// is write-side behaviour; everything above it is wiring a second entrypoint
// could reuse.

function buildNotifier(env = process.env): Notifier {
  if (env.TWIKI_SLACK_WEBHOOK_URL) {
    return new WebhookNotifier(
      env.TWIKI_SLACK_WEBHOOK_URL,
      "slack",
      dedupePathFor("slack", env),
    );
  }
  if (env.TWIKI_DISCORD_WEBHOOK_URL) {
    return new WebhookNotifier(
      env.TWIKI_DISCORD_WEBHOOK_URL,
      "discord",
      dedupePathFor("discord", env),
    );
  }
  if (
    env.TWIKI_MATRIX_HOMESERVER &&
    env.TWIKI_MATRIX_TOKEN &&
    env.TWIKI_MATRIX_ROOM
  ) {
    return new MatrixNotifier(
      env.TWIKI_MATRIX_HOMESERVER,
      env.TWIKI_MATRIX_TOKEN,
      env.TWIKI_MATRIX_ROOM,
      dedupePathFor("matrix", env),
    );
  }
  return new ConsoleNotifier();
}

function buildDeps(config: Config, env = process.env): RunDeps {
  return {
    github: createGitHubFromEnv((repo) => isAllowlisted(config, repo), env),
    advisor: new ClaudeAdvisor({ model: env.TWIKI_MODEL }),
    notifier: buildNotifier(env),
    audit: new JsonlAudit(env.TWIKI_AUDIT_PATH),
    now: () => new Date().toISOString(),
    log: (msg) => console.error(`[twiki] ${msg}`),
  };
}

async function main(): Promise<void> {
  const env = process.env;
  const configPath = env.TWIKI_CONFIG ?? "repos.yaml";
  const modeOverride = env.TWIKI_MODE as Mode | undefined;
  const config = loadConfig(configPath, modeOverride, remediationFromEnv(env));
  const deps = buildDeps(config, env);

  console.error(
    `[twiki] mode=${config.mode} repos=${config.repos.length} ` +
      `(${env.TWIKI_ONCE ? "single run" : "polling"})`,
  );

  await schedule(config, deps, {
    once: Boolean(env.TWIKI_ONCE),
    pollMinutes: Number(env.TWIKI_POLL_MINUTES ?? "60"),
    log: (msg) => console.error(`[twiki] ${msg}`),
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
