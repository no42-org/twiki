# Copyright 2026 Ronny Trommer <ronny@no42.org>
# SPDX-License-Identifier: MIT

.PHONY: install build typecheck lint test browsers e2e verify audit pack image run dev clean up down logs ps preflight

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

# The Chromium the browser project renders with, once per machine, into
# Playwright's user-level cache. On Linux the browser also needs OS libraries
# the runner image may lack, which --with-deps installs through apt; macOS
# ships them, and passing the flag there fails on sudo.
BROWSER_DEPS :=
ifeq ($(shell uname -s),Linux)
BROWSER_DEPS := --with-deps
endif

browsers:
	npx playwright install $(BROWSER_DEPS) chromium

# The browser project (test/browser/): real Chromium renders each page at
# phone and desktop width and measures overflow, which no unit test can see.
# Kept out of `test` so the unit suite needs no browser; run `make browsers`
# once first.
e2e:
	NODE_OPTIONS="--disable-warning=ExperimentalWarning" npm run test:browser

# Aggregate gate used by CI: lint + typecheck + tests + the browser project
# must pass. Keeping lint here means `make verify` locally matches what CI
# runs.
verify: lint typecheck test e2e

# Report dependency advisories (non-fatal; surfaced on the CI run).
audit:
	npm audit --audit-level=high

# Build and pack the npm tarball. package.json is the version of record and is
# never rewritten here: the release workflow refuses a tag that disagrees with
# it, so stamping a version at build time would only hide the disagreement.
# Prints only the tarball filename on stdout (capture the last line).
pack: build
	@npm pack --silent

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
