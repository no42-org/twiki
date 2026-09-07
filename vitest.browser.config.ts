/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { defineConfig } from "vitest/config";

// The browser project: tests that render a page in a real Chromium through
// Playwright. Separate from vitest.config.ts so `make test` never needs a
// browser; `make e2e` runs this one, and `make verify` runs both.
export default defineConfig({
  test: {
    include: ["test/browser/**/*.test.ts", "test/browser/**/*.test.tsx"],
    environment: "node",
    // Launching Chromium and seeding the store happen once per file, in a
    // hook; a page render is fast, but neither is instant on a cold cache.
    hookTimeout: 60_000,
    testTimeout: 30_000,
  },
});
