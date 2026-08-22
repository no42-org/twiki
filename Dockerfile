# Copyright 2026 Ronny Trommer <ronny@no42.org>
# SPDX-License-Identifier: MIT

# Build runs on the native builder platform (BUILDPLATFORM) for every target
# arch: twiki's production dependencies are pure JavaScript, so the compiled
# dist/ and prod node_modules are architecture-independent and need no
# QEMU-emulated build. Only the distroless runtime base differs per TARGETARCH.

# --- build: install deps, compile TypeScript, prune to prod (pure JS) -------
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# Build, then prune dev deps in place so node_modules is production-only — one
# install instead of a second `npm ci --omit=dev`. Prod deps are pure JS, so
# the pruned tree is architecture-independent.
RUN npm run build && npm prune --omit=dev
# Empty mount points owned by the runtime user. Docker initialises a fresh
# named volume from the image's contents at that path, ownership included, so
# creating them here is what lets the non-root runtime user write there.
# Without this the volume is created owned by root and the process dies on
# first write: the collector with "unable to open database file" on every cold
# start, twiki with EACCES on its audit log. Both found by deploying, not by
# reading. Made here rather than in the runtime stage because distroless has no
# shell for RUN.
#
#   /data   gitricorder's SQLite database, shared by collect and web
#   /state  twiki's audit log and notification de-duplication state
RUN mkdir -p /data /state && chown 65532:65532 /data /state

# --- runtime: distroless, non-root, no shell/package manager ----------------
# Pinned by digest (the manifest-list digest, so multi-arch still resolves) for
# a reproducible, reviewable supply chain; Dependabot (docker, daily) bumps it.
# NOTE: distroless has no package manager, so base OS CVEs (e.g. openssl) are
# only resolved by an upstream rebuild — the Dependabot digest bump is how we
# pick that up; the CI Trivy scan surfaces it. nodejs24 is the newest distroless
# Node line, so the build base and @types/node are aligned to Node 24.
FROM gcr.io/distroless/nodejs24-debian12:nonroot@sha256:14d42e2511532589a7c7e01a753667a74fcc96266e137e8125006b87b0c32d0a AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package.json ./
# gitricorder's database lives here; the twiki role uses no database at all.
COPY --from=build --chown=65532:65532 /data /data
# twiki's own state. Not a database, and not shared with gitricorder.
COPY --from=build --chown=65532:65532 /state /state
# distroless/nodejs sets ENTRYPOINT ["/usr/bin/node"]; pass the script as CMD.
#
# One image, three roles (AD-13). twiki is the default so existing deployments
# are unaffected; the read side is reached by overriding the command.
# `compose.yml` is where those commands live - one home for them, rather than
# two copies here and there that drift apart.
#
# The commands carry --disable-warning=ExperimentalWarning, which suppresses
# node:sqlite's one-per-process warning BY NAME. Never --no-warnings, which
# would hide a genuine one.
#
# The collect and web roles share one SQLite file on a NAMED volume; the
# default twiki role uses no database and needs no such mount.
#
# Named, not a bind mount, and that is load-bearing: the /data seeded above
# gives a fresh named volume its ownership, which is what lets the non-root
# user write there. A bind mount overlays the host directory's ownership
# instead and hands back exactly the "unable to open database file" cold start
# those lines exist to prevent.
#
# Mount it WRITABLE for both roles, including web: WAL keeps its shared memory
# in a -shm file beside the database, so a read-only mount fails with
# SQLITE_CANTOPEN even
# though web's connection is readOnly. Start collect first on a cold start, and
# never copy the database while collect is running. See the README's "Sharing
# the database between the two roles".
CMD ["dist/index.js"]
