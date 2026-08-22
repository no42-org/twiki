# Copyright 2026 Ronny Trommer <ronny@no42.org>
# SPDX-License-Identifier: MIT

.PHONY: install build typecheck lint test verify audit pack release-plan image run dev clean up down logs ps preflight

# Local image coordinates (CI multi-arch publish is driven by the release
# workflow's buildx action; this single-arch build is for local use + CI scan).
IMAGE ?= twiki
TAG ?= dev

install:
	npm install

build:
	rm -rf dist
	npm run build

typecheck:
	npm run typecheck

lint:
	npm run lint

# node:sqlite emits one ExperimentalWarning per process. Suppress that one by
# name; never --no-warnings, which would hide a genuine warning too.
test:
	NODE_OPTIONS="--disable-warning=ExperimentalWarning" npm run test

# Aggregate gate used by CI: lint + typecheck + tests must pass. Keeping lint
# here means `make verify` locally matches what CI runs.
verify: lint typecheck test

# Report dependency advisories (non-fatal; surfaced on the CI run).
audit:
	npm audit --audit-level=high

# Build and pack the npm tarball; pass VERSION=x.y.z to stamp the version.
# Prints only the tarball filename on stdout (capture the last line).
pack: build
	@[ -z "$(VERSION)" ] || npm version --no-git-tag-version --allow-same-version "$(VERSION)" >/dev/null
	@npm pack --silent

# Compute the release version + image tags from git/env via the canonical
# semver logic; writes GitHub Actions step outputs (used by the release job).
release-plan:
	npx tsx scripts/release-plan.ts

# Build a loadable single-arch image (used locally and by the CI scan job).
image:
	docker buildx build --load -t $(IMAGE):$(TAG) .

# --- deployment (compose.yml; see the README) --------------------------------
# CI and local both go through make, never `docker compose` directly.
#
# The dashboard is published on 127.0.0.1 only. There is no authentication in
# front of it, so changing that mapping exposes every collected alert.

# Refuses an image that cannot run the roles compose asks it to run, so the
# failure names the cause instead of arriving as "Cannot find module".
preflight:
	npx tsx scripts/preflight-image.ts

up: preflight
	docker compose up -d

down:
	docker compose down

logs:
	docker compose logs -f

ps:
	docker compose ps

run: build
	node dist/index.js

dev:
	npm run dev

clean:
	rm -rf dist node_modules
