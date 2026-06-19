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
# distroless/nodejs sets ENTRYPOINT ["/usr/bin/node"]; pass the script as CMD.
CMD ["dist/index.js"]
