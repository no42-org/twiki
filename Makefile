# Copyright 2026 Ronny Trommer <ronny@no42.org>
# SPDX-License-Identifier: MIT

.PHONY: install build typecheck test verify run dev clean

install:
	npm install

build:
	npm run build

typecheck:
	npm run typecheck

test:
	npm run test

# Aggregate gate used by CI: typecheck + tests must pass.
verify: typecheck test

run: build
	node dist/index.js

dev:
	npm run dev

clean:
	rm -rf dist node_modules
