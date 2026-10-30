/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

// The three files the overview loads, read once at startup and served from
// memory. A fixed table rather than a directory, so no request path ever
// reaches the filesystem. Everything is same-origin: the deployment is private
// and the page makes no call to another host.

export interface Asset {
  body: string;
  contentType: string;
  /** The URL the page uses. The hash lets the file be cached for ever. */
  href: string;
}

export type Assets = Readonly<Record<string, Asset>>;

const PACKAGE = "@no42-org/lcars-47";

function read(name: string, why: string, locate: () => string): string {
  try {
    return readFileSync(locate(), "utf8");
  } catch (err) {
    throw new Error(
      `cannot load ${name}, which ${why}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function asset(
  name: string,
  contentType: string,
  body: string,
): [string, Asset] {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
  return [name, { body, contentType, href: `/assets/${name}?v=${hash}` }];
}

export function loadAssets(): Assets {
  const require = createRequire(import.meta.url);
  return Object.fromEntries([
    asset(
      "lcars.css",
      "text/css; charset=utf-8",
      read(`${PACKAGE}/css`, "styles the overview", () =>
        require.resolve(`${PACKAGE}/css`),
      ),
    ),
    asset(
      "lcars.iife.js",
      "text/javascript; charset=utf-8",
      read(`${PACKAGE}/iife`, "defines the overview's components", () =>
        require.resolve(`${PACKAGE}/iife`),
      ),
    ),
    asset(
      "overview-client.js",
      "text/javascript; charset=utf-8",
      read("overview-client.js", "drives the overview's filters and sort", () =>
        fileURLToPath(new URL("./overview-client.js", import.meta.url)),
      ),
    ),
  ]);
}
