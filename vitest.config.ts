/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Both extensions, so a .tsx test cannot be linted and typechecked while
    // silently never running.
    include: ["test/**/*.test.ts", "test/**/*.test.tsx"],
    // The browser project drives a real Chromium and is its own vitest
    // project (vitest.browser.config.ts, `make e2e`), so the unit suite
    // stays fast and runs where no browser is installed.
    exclude: [...configDefaults.exclude, "test/browser/**"],
    environment: "node",
  },
});
