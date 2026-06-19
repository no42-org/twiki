## Why

`twiki` has source, tests, and a Makefile gate but **no CI/CD**: nothing builds it, runs its tests on PRs, ships a runnable artifact, or guards its supply chain. That is a sharp gap for this particular service — twiki is an autonomous actor that holds a GitHub App private key and an Anthropic key and merges/releases across many repos. It deserves a hardened, reproducible pipeline more than most. We also want a single, predictable mapping from git tags to published container images so that "what's running" is always traceable to a commit, and so `main` continuously publishes a verifiable pre-release of the next version.

## What Changes

- Add **GitHub Actions CI** on pull requests and pushes to `main` that runs the Makefile quality gate — Biome lint/format, `tsc` typecheck, vitest — plus **CodeQL** SAST, **npm audit**, and a **Trivy** scan of the built image. CI is invoked exclusively through Makefile targets (`make verify`, new `make lint`, new `make image`).
- Add a multi-stage **Dockerfile** (+ `.dockerignore`) producing a non-root, distroless runtime image, and **Biome** config — the tooling the gate and the artifacts depend on.
- Add a **release pipeline** keyed on triggers, both flowing through one workflow:
  - **push tag `v*`** → a *stable* release: multi-arch image (`linux/amd64,linux/arm64`) pushed to **ghcr.io** as `:X.Y.Z :X.Y :X`, plus `:latest` **only when the tag is the highest non-prerelease version**; a normal **GitHub Release** with auto-generated Conventional-Commits notes; an arch-independent **npm pack** tarball attached.
  - **push to `main`** → a *rolling pre-release*: the same multi-arch image as `:main` and `:sha-<short>` and `:X.Y.Z-dev.<n>+<sha>` (the **next patch**, pre-released), and a single continuously-updated **`edge` GitHub pre-release** entry carrying the latest tarball/SBOM. Never `:latest`.
- **Sign every published image with cosign (keyless/OIDC)** and attach an **SBOM** (syft); least-privilege `permissions:` per job.
- Add **Dependabot** for `npm`, `github-actions`, and `docker`; **all actions pinned to immutable SHAs** with full-semver comments, kept current by Dependabot.

## Capabilities

### New Capabilities
- `ci-quality-gate`: PR/main CI running the Makefile gate (lint, typecheck, test) plus CodeQL, npm audit, and image scanning; merge-blocking.
- `container-image-publishing`: multi-arch GHCR images with a deterministic tag scheme (stable semver tags + guarded `:latest`; rolling `:main`/`:sha`/`-dev` pre-release tags), cosign signatures, and SBOMs.
- `release-publication`: version derivation (next-patch `-dev` pre-release for `main` via `git describe`), stable GitHub Releases from tags with auto changelog, a single rolling `edge` pre-release for `main`, and an npm tarball asset.
- `dependency-automation`: Dependabot config across npm/actions/docker with SHA-pinning discipline.

### Modified Capabilities
<!-- None — additive; no existing spec governs build/release. -->

## Impact

- **New, non-runtime code**: `.github/workflows/*`, `.github/dependabot.yml`, `Dockerfile`, `.dockerignore`, `biome.json`, `tsconfig.build.json`.
- **Application source touched (minimally)**: adopting Biome reformats `src/` and `test/` to the new standard (whitespace only). Two files also get behavior-preserving lint fixes — `src/audit.ts` (string concat → template literal) and `src/advisor.ts` (`!x || x.type…` → optional chain); the test suite still passes 39/39.
- **Pre-existing build bug fixed**: `tsconfig.json` (`rootDir: "."` plus test files in `include`) made `tsc` emit `dist/src/index.js` and compile tests into `dist/` — breaking the `bin`/`start`/container entrypoint (`dist/index.js`) and polluting the tarball. A dedicated `tsconfig.build.json` now emits `src/` → `dist/` root; `tsconfig.json` continues to drive typecheck over `src` + `test`.
- **`package.json`**: add a `"files": ["dist"]` entry (so `npm pack` ships the built output — `dist/` is gitignored and would otherwise be omitted), a Biome dev dependency, `lint`/`lint:fix` scripts, and point `build` at `tsconfig.build.json`.
- **`Makefile`**: add `lint` and `image` targets; CI calls these, never the tools directly.
- **Registry**: publishes to `ghcr.io/no42-org/twiki`; requires `packages: write` and `id-token: write` (cosign) GITHUB_TOKEN permissions — no long-lived secrets.
- **Release trigger**: a human (or another tool) pushes an annotated `vX.Y.Z` tag; the pipeline does the rest.
- **Out of scope**: publishing to the public npm registry (tarball is attached to the Release only); standalone per-arch binaries (Node SEA/bun); release-please/changesets (the trigger is a hand-pushed tag); deploying/running twiki anywhere (this is build+release, not runtime CD); non-`main` branch publishing.
