## Context

`twiki` is a TypeScript ESM CLI (Node ≥20), built with `tsc` to `dist/`, tested with vitest, distributed as a long-running poller. It has a Makefile gate (`make verify` = typecheck + test) but no CI, no linter, no container, and no release automation. This change adds the full build→test→release pipeline.

Two properties of the codebase shape every decision below:

1. **All runtime dependencies are pure JavaScript** (`@anthropic-ai/sdk`, `@octokit/*`, `yaml`, `zod`) — no native addons. The same compiled JS runs on every architecture; only the base image differs by arch. Multi-arch is therefore a *base-image* concern, not a *compile* concern — buildx emits both platforms with no QEMU-emulated build.
2. **twiki is a high-authority autonomous actor** holding a GitHub App private key and an Anthropic key, with merge/release power across many repos. Supply-chain hardening (SAST, image scan, SBOM, signing) is proportionate, not gold-plating.

Locked decisions from exploration: container + npm-tarball artifacts; full hardening; auto GitHub Release from the tag; `main` builds are a single **rolling `edge` pre-release** of the **next patch** version. (Superseded 2026-08-24: `main` publishes only `:rc` — see D2/D5.)

## Goals / Non-Goals

**Goals:**
- One deterministic mapping from trigger → published image tags, traceable to a commit.
- `main` continuously publishes a verifiable image (`:rc`); tags publish stable releases. (Amended 2026-08-24: `main` no longer carries a version — see D2.)
- `:latest` points to the most recently pushed **stable** version, never a pre-release. (Amended 2026-08-24: "highest" was dropped with the guard — see D3.)
- Every gate runs through Makefile targets so local and CI commands cannot drift.
- Every published image is signed and carries an SBOM; the gate blocks merges on lint/type/test/SAST failures.

**Non-Goals:**
- Publishing to the public npm registry (the tarball is a Release asset only).
- Standalone per-arch executables (Node SEA / `bun compile`) — the container is the per-arch artifact.
- `release-please` / `changesets` automation — the trigger is a hand-pushed `vX.Y.Z` tag.
- Deploying or running twiki anywhere — this is build + release, not runtime CD.
- Publishing from branches other than `main`.

## Decisions

### D1 — ~~One release workflow, parameterized stable vs. pre-release~~ SUPERSEDED

Superseded by `simplify-release-tagging` (2026-08-24). `release.yml` handles tags; `publish-rc.yml` handles `main`.

The original *Why* was that both paths produce the same artifact set, differing only by a flag. That stopped being true once `main` produced only an image: it publishes no tarball, no GitHub Release, and no version, so the shared parameterization had almost nothing left to share.

The rejected alternative named the real risk, and it still stands: **drift between the two files is the failure mode** — signing or scanning added to one and not the other. Both currently sign the index digest, scan with Trivy, and emit an SBOM. Keep it that way, or merge them back.

Note the two need *opposite* concurrency: `main` cancels superseded runs because only the newest commit needs to be `:rc`, while a tag must never cancel because a half-published release leaves some tags pushed and others not.

### D2 — ~~`main` version = the **next patch**, pre-released~~ SUPERSEDED

Superseded by `simplify-release-tagging` (2026-08-24). `main` no longer produces a versioned artifact at all: it publishes a single overwriting `:rc` image and nothing else, so there is no version string to derive and no `edge` pre-release to attach it to.

The original reasoning was sound and is kept because the ordering argument still applies to anyone tempted to reintroduce a `main` version: `2.3.1 < 2.3.2-dev.5 < 2.3.2 < 2.4.0 < 3.0.0`, so `X.Y.(Z+1)-dev.<n>` is unambiguously "the next release in progress" without predicting the bump, whereas `X.Y.Z-dev.n` would sort *below* the already-released `X.Y.Z`.

What actually retired it was cost, not correctness: deriving it required the full tag list on every build, and the per-commit `:sha-<short>` tags that accompanied it accumulated 53 permanent multi-arch manifests with nothing consuming them.

### D3 — ~~`:latest` = highest **non-prerelease** semver, guarded~~ SUPERSEDED

Superseded by `simplify-release-tagging` (2026-08-24). There is no guard. `:latest` follows whichever stable tag was pushed most recently, and no floating major tag `:X` is published at all.

The original *Why* remains correct and is worth keeping, because it named a real failure: `docker/metadata-action`'s `latest=auto` checks "is this a tag event," not "is this the newest version," so a backport would repoint `:latest` backward.

Two things retired it.

First, it was **under-applied**. The guard consulted the highest version for `:latest` only, while `:X` and `:X.Y` were written unconditionally one line above. A backport across a *minor* boundary therefore moved `:X` backward, which is [#66](https://github.com/no42-org/twiki/issues/66). The example chosen above (`v1.4.9` after `v2.0.0`) crosses a *major* boundary, which is the one backport shape where `:X` happens to be correct — so neither this design, nor the spec, nor the unit test ever probed it.

Second, it was **load-bearing for the wrong reasons**. Answering "is this the highest" required the whole tag list, which required `fetch-depth: 0` as its own spec requirement, plus a semver comparison implementation and its tests. Roughly 190 lines existed to defend against a backport this project has never performed except to test the guard.

**When this must come back:** the moment a maintained older release line exists. Restore a highest-stable comparison, and apply it to *every* floating tag published, not only `:latest` — that is the lesson of #66.


### D4 — Multi-arch via buildx base image only (no QEMU compile)
`docker buildx build --platform linux/amd64,linux/arm64` produces a manifest list. Because the app is pure JS (Context #1), no cross-compilation or emulated build step is needed — each platform is the same `dist/` on an arch-appropriate Node base.

- *Why:* Cheap, fast multi-arch with no QEMU build emulation.
- *Watch item:* If a native-addon dependency is ever added, this assumption breaks and the build stage would need per-arch emulation or cross-build; called out so a future dep change revisits it.

### D5 — ~~`main` pre-releases are a single rolling `edge` entry~~ SUPERSEDED

Superseded by `simplify-release-tagging` (2026-08-24). `main` publishes a single overwriting `:rc` image and no GitHub release at all.

The original reasoning — avoid flooding the Releases page, keep per-commit traceability via `:sha-<short>` — was right about the first half and paid too much for the second. The `:sha-<short>` tags were never consumed and 53 of them accumulated as permanent multi-arch manifests. `:rc` still resolves to a digest, so anyone needing an immutable reference pins that.

**Trade accepted:** `main` now leaves nothing on the Releases page, so there is no stable download URL for a `main` build.

### D6 — CI is Makefile-driven; add `lint` and `image`
Workflows call `make verify`, `make lint`, `make image` — never `npx biome`, `tsc`, `vitest`, or `docker build` directly (per repo convention). New targets: `lint` (Biome check) and `image` (buildx build).

- *Why:* Local and CI commands cannot diverge; changing a target updates both at once.

### D7 — Supply-chain hardening, proportionate to authority
CodeQL (`javascript-typescript`) on PR/main + weekly schedule; `npm audit` and Trivy image scan in CI; **cosign keyless (OIDC `id-token: write`)** signatures on every published image; **syft** SBOM attached to releases; least-privilege `permissions:` per job (read by default, `packages: write`/`id-token: write` only where needed); **all actions SHA-pinned** with full-semver comments, refreshed by Dependabot.

- *Why:* twiki holds high-value secrets and acts autonomously; a compromised image or dependency is a cross-repo blast radius. Keyless cosign avoids managing a signing key.

### D8 — Biome for lint + format
Adopt Biome (single fast binary, native TS/ESM, lint + format in one) over ESLint + Prettier.

- *Why:* No plugin/config sprawl, fast in CI, one tool to pin and update. The repo has no linter today, so there's no migration cost.

### D9 — `npm pack` must ship `dist/`
Add `"files": ["dist"]` to `package.json`. `dist/` is in `.gitignore`; with no `files` field, `npm pack` falls back to `.gitignore` and would publish a tarball **missing the built output**. The release job builds before packing.

- *Why:* Prevents silently shipping an empty/broken tarball — the failure is invisible until someone installs it.

### D10 — Multi-stage, non-root, distroless runtime
Build stage: `npm ci` + `make build` (tsc). Runtime stage: **`gcr.io/distroless/nodejs20-debian12:nonroot`**, copying only `dist/` and production `node_modules` and running as the bundled `nonroot` user (uid 65532). The distroless nodejs image bundles Node and CA certificates, so HTTPS to GitHub/Anthropic/webhooks works with no extra packages.

- *Why:* twiki is a high-authority actor holding a GitHub App private key; minimizing the runtime (no shell, no package manager, far fewer base-OS CVEs) is worth more than `exec`-debuggability. It is stateless and observed via its stderr logs and `audit.jsonl`, not by shelling in.
- *Debug escape hatch:* for an incident, run the `:debug` distroless variant (adds busybox) or `docker run` the same published `dist/` on a `node:20-slim` base for ad-hoc repro — neither requires changing the shipped image.
- *Alternative:* `node:20-slim`. Rejected as the default — a shell and apt surface buy little here and enlarge the attack surface around the private key.

## Resolved

- **Registry & visibility:** the repo is the public `github.com/no42-org/twiki`, so images publish to **`ghcr.io/no42-org/twiki`** and the GHCR package is **public** — anonymous `docker pull` and anonymous `cosign verify`, and free CodeQL default setup. Keyless verification targets the workflow OIDC identity: issuer `https://token.actions.githubusercontent.com`, identity matching `https://github.com/no42-org/twiki/.github/workflows/*`.
- **Runtime base:** distroless `nonroot` (D10), with a documented debug escape hatch rather than a shell in the shipped image.

## Risks / Open Questions

- **First `:latest`** requires at least one stable `v*` tag; until then only `edge`/`main` images exist. Acceptable for a pre-1.0 project.
- **`git describe` needs tag history** in the checkout — the workflow must `fetch-depth: 0` (or fetch tags) for D2 version derivation and the D3 highest-semver guard.
- **Distroless Node minor pinning** — `distroless/nodejs20-debian12` tracks Node 20.x on its own cadence; Dependabot's `docker` ecosystem watches the base tag, but major Node bumps (22/24) are a deliberate, manual base-image change.
