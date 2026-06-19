# Copyright 2026 Ronny Trommer <ronny@no42.org>
# SPDX-License-Identifier: MIT

# Build runs on the native builder platform (BUILDPLATFORM) for every target
# arch: twiki's production dependencies are pure JavaScript, so the compiled
# dist/ and prod node_modules are architecture-independent and need no
# QEMU-emulated build. Only the distroless runtime base differs per TARGETARCH.

# --- build: install all deps + compile TypeScript ---------------------------
FROM --platform=$BUILDPLATFORM node:20-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- deps: production-only node_modules (pure JS, arch-independent) ----------
FROM --platform=$BUILDPLATFORM node:20-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# --- runtime: distroless, non-root, no shell/package manager ----------------
FROM gcr.io/distroless/nodejs20-debian12:nonroot AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# distroless/nodejs sets ENTRYPOINT ["/usr/bin/node"]; pass the script as CMD.
CMD ["dist/index.js"]
