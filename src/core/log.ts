/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

/**
 * Wrap a logger so it can never take its caller down.
 *
 * A lane's contract is that nothing throws past its boundary (AD-16), and the
 * logger was the loophole: an EPIPE on a closed stdout inside the success path
 * landed in the lane's catch AFTER finishRun had committed `ok`, so the lane
 * returned `failed` for a run whose row said ok, and a TRICORDER_ONCE cron
 * exit went non-zero on a collection that delivered everything.
 */
export function safeLog(log: (msg: string) => void): (msg: string) => void {
  return (msg) => {
    try {
      log(msg);
    } catch {
      // Nowhere to report a broken logger except the logger.
    }
  };
}
