# Copyright 2026 Ronny Trommer <ronny@no42.org>
# SPDX-License-Identifier: MIT

.PHONY: install build typecheck lint test verify image run dev clean

# Local image coordinates (CI multi-arch publish is driven by the release
# workflow's buildx action; this single-arch build is for local use + CI scan).
IMAGE ?= twiki
TAG ?= dev

install:
	npm install

build:
	npm run build

typecheck:
	npm run typecheck

lint:
	npm run lint

test:
	npm run test

# Aggregate gate used by CI: typecheck + tests must pass.
verify: typecheck test

# Build a loadable single-arch image (used locally and by the CI scan job).
image:
	docker buildx build --load -t $(IMAGE):$(TAG) .

run: build
	node dist/index.js

dev:
	npm run dev

clean:
	rm -rf dist node_modules
