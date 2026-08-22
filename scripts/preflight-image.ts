/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { execFileSync, spawnSync } from "node:child_process";

// Preflight for `make up`: refuse to start an image that cannot run the roles
// compose asks it to run.
//
// `.env.example` defaults to the published image, and no release has been cut
// since gitricorder was built - so `ghcr.io/no42-org/twiki:latest` still
// carries the pre-story-2 layout, with no `dist/tricorder.js` and no `core/`
// or `tricorder/` directories at all. Following the quickstart therefore ends
// in the collector crash-looping on:
//
//   Error: Cannot find module '/app/dist/tricorder.js'
//
// which says nothing about images, releases or what to do next. Compose then
// reports it as "dependency failed to start", pointing at the dependency
// rather than the cause.
//
// This turns that into one sentence. It is a preflight rather than a
// healthcheck because the answer is knowable before anything starts, and a
// container that cannot possibly work should not be started to find out.

// Both constants below fail SAFE, which is why this check needs no test of
// its own beyond running. Get either wrong - a typo in the path, or the
// /usr/bin/node guess that already cost a broken healthcheck once - and the
// probe fails against a GOOD image, so `make up` refuses everything and you
// find out on the next run. There is no way for a wrong constant to make this
// accept an image it should have rejected.

/** Where the read-side entrypoint lives inside the image. */
const ENTRYPOINT = "/app/dist/tricorder.js";
/** distroless puts node here, not /usr/bin/node. Verified against the image. */
const NODE = "/nodejs/bin/node";

function run(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

/** The image compose resolved, after .env interpolation. */
function resolveImage(): string {
  const images = run(["compose", "config", "--images"])
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
  const unique = [...new Set(images)];
  if (unique.length === 0) throw new Error("compose resolved no image");
  // All three services run one image (AD-13). If that ever stops being true,
  // say so rather than silently checking only the first.
  if (unique.length > 1) {
    throw new Error(
      `compose resolved ${unique.length} images (${unique.join(", ")}); ` +
        "this check assumes one image for every role (AD-13)",
    );
  }
  return unique[0] as string;
}

const image = resolveImage();

// Pull only when it is not already local, so a freshly built `twiki:dev` is
// not clobbered by a registry lookup that would fail anyway.
if (
  spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" })
    .status !== 0
) {
  process.stderr.write(`[preflight] pulling ${image}\n`);
  const pull = spawnSync("docker", ["pull", image], { stdio: "inherit" });
  if (pull.status !== 0) {
    process.stderr.write(`\n[preflight] could not pull ${image}.\n`);
    process.exit(1);
  }
}

const check = spawnSync(
  "docker",
  [
    "run",
    "--rm",
    "--entrypoint",
    NODE,
    image,
    "-e",
    `process.exit(require("node:fs").existsSync("${ENTRYPOINT}") ? 0 : 1)`,
  ],
  { stdio: "ignore" },
);

if (check.status !== 0) {
  process.stderr.write(
    `\n[preflight] ${image} cannot run gitricorder.\n\n` +
      `  It carries no ${ENTRYPOINT}, which means it predates the dashboard.\n` +
      `  Starting it would fail with "Cannot find module", which does not say this.\n\n` +
      "  Either build the current source and point compose at it:\n\n" +
      "      make image\n" +
      "      # then in .env:  IMAGE=twiki  TAG=dev\n\n" +
      "  or cut a release, after which the published tag carries it.\n\n",
  );
  process.exit(1);
}

process.stderr.write(
  `[preflight] ${image} carries the gitricorder entrypoint\n`,
);
