## 1. Local tooling & Makefile

- [x] 1.1 Add Biome (`biome.json` + dev dependency) configured for TS/ESM lint + format
- [x] 1.2 Add `make lint` (Biome check) and `make image` (buildx build) targets; keep CI Makefile-driven
- [x] 1.3 Add `"files": ["dist"]` to `package.json` so `npm pack` ships the built output
- [x] 1.4 Run `make lint` locally and fix or baseline any findings on existing `src/`

## 2. Container image

- [x] 2.1 Write a multi-stage `Dockerfile`: build stage (`npm ci` + `make build`), distroless/slim runtime, non-root user, copies only `dist/` + prod deps
- [x] 2.2 Add `.dockerignore` (node_modules, .git, openspec, tests, secrets)
- [x] 2.3 Verify `make image` builds and the container runs `twiki` (single-tick smoke with `TWIKI_ONCE=1`)

## 3. CI quality gate (ci.yml)

- [x] 3.1 Trigger on `pull_request` → main and `push` → main; explicit least-privilege `permissions` per job
- [x] 3.2 Job: `make lint` + `make verify` (typecheck + vitest)
- [x] 3.3 Job: `make image` then Trivy scan; do NOT push on pull requests
- [x] 3.4 Job: `npm audit` reporting
- [x] 3.5 Pin all actions to SHAs with full-semver comments

## 4. CodeQL (codeql.yml)

- [x] 4.1 Trigger on PR, push→main, and a weekly schedule; language `javascript-typescript`
- [x] 4.2 `security-events: write` only on this job; SHA-pinned actions

## 5. Container publishing

- [x] 5.1 buildx `linux/amd64,linux/arm64` multi-arch build (QEMU only if ever needed — pure JS today)
- [x] 5.2 Tag scheme: stable `:X.Y.Z :X.Y :X`; pre-release exact-only; `:main` + `:sha-<short>` + `:X.Y.Z-dev.<n>` for main
- [x] 5.3 `:latest` guard — apply only when the pushed tag is the highest non-prerelease version (`git tag --sort=-v:refname`); never on pre-release or main
- [x] 5.4 Push to `ghcr.io/no42-org/twiki` (public package) with `packages: write`
- [x] 5.5 cosign keyless signing (`id-token: write`) of the pushed digest
- [x] 5.6 Generate SBOM (syft) for the published image

## 6. Version derivation

- [x] 6.1 Checkout with `fetch-depth: 0` (tags + history)
- [x] 6.2 Compute main version `X.Y.(Z+1)-dev.<n>+<shortsha>` from tags (unit-tested all cases)
- [x] 6.3 Parse tag version on the tag path; classify pre-release vs stable for downstream flags

## 7. Release publication (release.yml — one workflow, two triggers)

- [x] 7.1 Trigger on `push: tags: v*` and `push: branches: main`; derive `prerelease` + version (D1/D2)
- [x] 7.2 Build project, `npm pack` the tarball (includes `dist/` via 1.3)
- [x] 7.3 Tag path: create GitHub Release with Conventional-Commits auto-notes, `prerelease=false`, attach tarball + SBOM
- [x] 7.4 main path: upsert the single rolling `edge` pre-release (moving tag, `prerelease=true`), replace tarball + SBOM assets
- [x] 7.5 Reuse the container-publishing steps (section 5) so both paths publish identically

## 8. Dependabot

- [x] 8.1 Add `.github/dependabot.yml` for `npm`, `github-actions`, and `docker` ecosystems
- [x] 8.2 Sensible grouping (e.g. dev-deps, octokit) and schedule

## 9. Verification

- [ ] 9.1 Open a test PR — confirm lint/verify/CodeQL/scan run and block on failure, and no image is pushed
- [ ] 9.2 Push to a fork/test `main` — confirm `:main`, `:sha-…`, `:X.Y.Z-dev.n` images, signature, SBOM, and the rolling `edge` pre-release
- [ ] 9.3 Push a `v*` tag — confirm `:X.Y.Z :X.Y :X (+:latest)` images and a stable Release with changelog + tarball
- [ ] 9.4 Push a lower backport tag against a higher existing tag — confirm `:latest` does NOT move
- [ ] 9.5 `cosign verify` a published image and inspect the attached SBOM
