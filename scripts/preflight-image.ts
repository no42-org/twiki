/*
 * Copyright 2026 Ronny Trommer <ronny@no42.org>
 * SPDX-License-Identifier: MIT
 */

import { execFileSync, spawnSync } from "node:child_process";

// Preflight for `make up`: refuse to start an image that cannot run the roles
// compose asks it to run.
//
// This judges the image on capability, never on which tag was chosen. Any
// image carrying the entrypoint is accepted, wherever it came from.
//
// It was written when the published `:latest` predated gitricorder and could
// not run it; v0.0.5 fixed that, and the check is still worth keeping, because
// the failure it prevents is illegible. A missing entrypoint crash-loops the
// collector on:
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
const local =
  spawnSync("docker", ["image", "inspect", image], { stdio: "ignore" })
    .status === 0;

// Always try to pull, because every tag worth running here is mutable: `:rc`
// is overwritten on every merge to main, and `:latest` moves on every release.
// Checking only for a local copy meant a cached image was started silently and
// indefinitely - a week-old `:rc` looks exactly like a current one, and the
// stale copy also makes this very check refuse an image that is actually fine.
//
// A failed pull is only fatal when there is nothing local to fall back on. A
// locally built `twiki:dev` exists in no registry, so its pull always fails and
// must not be treated as an error.
process.stderr.write(`[preflight] pulling ${image}\n`);
// Progress on stdout stays visible; stderr is captured so that the expected
// failure for a local-only build ("pull access denied for twiki") is not
// printed as if something had gone wrong. It is shown only when it is fatal.
const pull = spawnSync("docker", ["pull", image], {
  stdio: ["ignore", "inherit", "pipe"],
  encoding: "utf8",
});
if (pull.status !== 0) {
  if (!local) {
    process.stderr.write(pull.stderr ?? "");
    process.stderr.write(`\n[preflight] could not pull ${image}.\n`);
    process.exit(1);
  }
  process.stderr.write(
    `[preflight] ${image} is not in a registry; using the local copy.\n`,
  );
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
      "  Point .env at a tag that carries it:\n\n" +
      "      TAG=latest   # newest stable release\n" +
      "      TAG=rc       # current state of main\n\n" +
      "  or build the current source and run that instead:\n\n" +
      "      make image\n" +
      "      # then in .env:  IMAGE=twiki  TAG=dev\n\n",
  );
  process.exit(1);
}

process.stderr.write(
  `[preflight] ${image} carries the gitricorder entrypoint\n`,
);
