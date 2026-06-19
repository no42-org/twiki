/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { ClaudeAdvisor } from "./advisor.js";
import { JsonlAudit } from "./audit.js";
import { type Config, isAllowlisted, loadConfig } from "./config.js";
import { createGitHubFromEnv } from "./github/octokit-adapter.js";
import {
  ConsoleNotifier,
  MatrixNotifier,
  type Notifier,
  WebhookNotifier,
} from "./notify.js";
import { type RunDeps, runOnce } from "./run.js";
import type { Mode } from "./types.js";

// Entrypoint and scheduler. By default polls on an interval (~hourly); set
// TWIKI_ONCE=1 to run a single tick (e.g. driven by an external cron).

function buildNotifier(env = process.env): Notifier {
  if (env.TWIKI_SLACK_WEBHOOK_URL) {
    return new WebhookNotifier(env.TWIKI_SLACK_WEBHOOK_URL, "slack");
  }
  if (env.TWIKI_DISCORD_WEBHOOK_URL) {
    return new WebhookNotifier(env.TWIKI_DISCORD_WEBHOOK_URL, "discord");
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
  const config = loadConfig(configPath, modeOverride);
  const deps = buildDeps(config, env);

  console.error(
    `[twiki] mode=${config.mode} repos=${config.repos.length} ` +
      `(${env.TWIKI_ONCE ? "single run" : "polling"})`,
  );

  const tick = async () => {
    try {
      await runOnce(config, deps);
    } catch (err) {
      console.error(
        `[twiki] run failed: ${err instanceof Error ? err.stack : err}`,
      );
    }
  };

  await tick();
  if (env.TWIKI_ONCE) return;

  const minutes = Number(env.TWIKI_POLL_MINUTES ?? "60");
  setInterval(tick, minutes * 60_000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
