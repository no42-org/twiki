/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import { DedupingNotifier } from "../notify/dedupe.js";
import type { Notifier } from "../notify/port.js";
import { MatrixTransport, WebhookTransport } from "../notify/transports.js";

// twiki's notifiers: the shared transports composed with the file-based
// de-duplication and the TWIKI_STATE_DIR rules that are twiki's own.
//
// The transports moved down into src/notify/ so gitricorder can post to
// Matrix without importing the write side, and so it does not inherit this
// file-based de-duplication — it de-duplicates per item through its store.
// Nothing about twiki moved with them: the constructors below, the dedupe
// file names and the env names are what they were.

export type { Notifier } from "../notify/port.js";

const DEFAULT_DEDUPE_PATH = ".twiki-last-digest";

/**
 * Where the notifier remembers the last digest it sent.
 *
 * A directory rather than a file, because the path is per transport. Unset
 * keeps the historical behaviour: a dotfile in the working directory.
 *
 * It exists because that working directory is a container's writable layer in
 * any real deployment, so the state died on every recreate and the first run
 * after a redeploy re-sent a notification byte-identical to the one already
 * delivered. De-duplication that a redeploy silently resets is not
 * de-duplication.
 */
export function dedupePathFor(
  flavor: string,
  env: NodeJS.ProcessEnv,
  log: (msg: string) => void = (m) => console.error(`[twiki] ${m}`),
): string | undefined {
  const dir = (env.TWIKI_STATE_DIR ?? "").trim();
  if (dir === "") return undefined;
  // Probed once, because DedupingNotifier swallows its write errors by design
  // (de-duplication must never break a run). Silence is the wrong answer for a
  // directory that does not exist or is not writable by the runtime user: the
  // state is then never persisted, de-duplication is off permanently, and a
  // digest is re-sent every poll with nothing anywhere saying why. Named here,
  // once, at startup.
  try {
    accessSync(dir, constants.W_OK);
  } catch {
    log(
      `TWIKI_STATE_DIR=${dir} is not writable; de-duplication is disabled and ` +
        `every poll will re-send its digest. Check the directory exists and ` +
        `is writable by this user (uid ${process.getuid?.() ?? "unknown"}).`,
    );
    return undefined;
  }
  return join(dir, `.twiki-last-digest.${flavor}`);
}

export class WebhookNotifier implements Notifier {
  private readonly inner: Notifier;

  constructor(
    webhookUrl: string,
    /** "slack" => {text}, "discord" => {content}. */
    flavor: "slack" | "discord" = "slack",
    dedupePath = `${DEFAULT_DEDUPE_PATH}.${flavor}`,
  ) {
    this.inner = new DedupingNotifier(
      new WebhookTransport(webhookUrl, flavor),
      dedupePath,
    );
  }

  send(text: string): Promise<void> {
    return this.inner.send(text);
  }
}

/**
 * The Matrix transport with twiki's run-over-run de-duplication in front of
 * it: an unchanged digest is not re-posted. A fresh transaction ID per send
 * is the transport's job, de-duplication of identical digests is this one's.
 */
export class MatrixNotifier implements Notifier {
  private readonly inner: Notifier;

  constructor(
    homeserver: string,
    accessToken: string,
    roomId: string,
    dedupePath = `${DEFAULT_DEDUPE_PATH}.matrix`,
  ) {
    this.inner = new DedupingNotifier(
      new MatrixTransport(homeserver, accessToken, roomId),
      dedupePath,
    );
  }

  send(text: string): Promise<void> {
    return this.inner.send(text);
  }
}

// Printing to stdout is the same on both sides and there is no de-duplication
// to compose, so this is the shared transport under the name twiki's wiring
// already uses, not a subclass that adds nothing.
export { ConsoleTransport as ConsoleNotifier } from "../notify/transports.js";
