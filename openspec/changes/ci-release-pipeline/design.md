## Context

`twiki` is a TypeScript ESM CLI (Node ≥20), built with `tsc` to `dist/`, tested with vitest, distributed as a long-running poller. It has a Makefile gate (`make verify` = typecheck + test) but no CI, no linter, no container, and no release automation. This change adds the full build→test→release pipeline.

Two properties of the codebase shape every decision below:

1. **All runtime dependencies are pure JavaScript** (`@anthropic-ai/sdk`, `@octokit/*`, `yaml`, `zod`) — no native addons. The same compiled JS runs on every architecture; only the base image differs by arch. Multi-arch is therefore a *base-image* concern, not a *compile* concern — buildx emits both platforms with no QEMU-emulated build.
2. **twiki is a high-authority autonomous actor** holding a GitHub App private key and an Anthropic key, with merge/release power across many repos. Supply-chain hardening (SAST, image scan, SBOM, signing) is proportionate, not gold-plating.

Locked decisions from exploration: container + npm-tarball artifacts; full hardening; auto GitHub Release from the tag; `main` builds are a single **rolling `edge` pre-release** of the **next patch** version.

## Goals / Non-Goals

**Goals:**
- One deterministic mapping from trigger → published image tags, traceable to a commit.
- `main` continuously publishes a verifiable pre-release of the next version; tags publish stable releases.
- `:latest` always points to the highest shipped **stable** version — never a backport, never a pre-release.
- Every gate runs through Makefile targets so local and CI commands cannot drift.
- Every published image is signed and carries an SBOM; the gate blocks merges on lint/type/test/SAST failures.

**Non-Goals:**
- Publishing to the public npm registry (the tarball is a Release asset only).
- Standalone per-arch executables (Node SEA / `bun compile`) — the container is the per-arch artifact.
- `release-please` / `changesets` automation — the trigger is a hand-pushed `vX.Y.Z` tag.
- Deploying or running twiki anywhere — this is build + release, not runtime CD.
- Publishing from branches other than `main`.

## Decisions

### D1 — One release workflow, parameterized stable vs. pre-release
A single workflow handles both `push: tags: v*` and `push: branches: main`. The trigger selects a `prerelease` boolean and the version; everything downstream (multi-arch build, GHCR push, signing, SBOM, Release publication, tarball) is shared.

- *Why:* "main is the next release" and "main builds are pre-releases" describe the *same* artifact set as a stable release, only flagged. One workflow removes duplicated build/sign/publish logic and guarantees the two paths stay identical except for the flag.
- *Alternative:* Separate `ci-publish-main.yml` and `release.yml`. Rejected — drift between the two is exactly the failure mode (e.g. signing added to one, not the other).

### D2 — `main` version = the **next patch**, pre-released
For `main`, the version is derived from `git describe --tags --match 'v*'`: with last tag `vX.Y.Z` and `n` commits since, the build is **`X.Y.(Z+1)-dev.<n>+<shortsha>`**.

- *Why (the load-bearing reason):* SemVer precedence. Labeling main `X.Y.Z-dev.n` sorts *below* the already-released `X.Y.Z` — main would look older than what's shipped. `X.Y.(Z+1)-dev.n` is strictly greater than every released version yet strictly less than **any** real next bump:
  `2.3.1 < 2.3.2-dev.5 < 2.3.2 < 2.4.0 < 3.0.0`.
  So it is unambiguously "the next release in progress" regardless of whether the next tag turns out to be patch, minor, or major — no need to predict the bump.
- *Bonus:* The `-dev` pre-release segment makes the D3 `:latest` guard exclude it for free, exactly as it excludes `-rc.N`.
- *Alternative:* `0.0.0-main.<sha>`. Rejected — discards "next release" ordering semantics.

### D3 — `:latest` = highest **non-prerelease** semver, guarded
`:latest` is applied only when the pushed tag is the highest non-prerelease version across all tags (`git tag --sort=-v:refname` filtered to stable). Pre-releases (`-rc.N`, `-dev.N`) and `main` builds never receive `:latest`, `:X.Y`, or `:X`.

- *Why:* `docker/metadata-action`'s `latest=auto` only checks "is this a tag event," not "is this the newest version." A backport tag (`v1.4.9` pushed after `v2.0.0` exists) would wrongly repoint `:latest` backward. An explicit highest-semver guard prevents that.
- *Alternative:* `latest=auto`. Rejected — silently wrong on backports.

### D4 — Multi-arch via buildx base image only (no QEMU compile)
`docker buildx build --platform linux/amd64,linux/arm64` produces a manifest list. Because the app is pure JS (Context #1), no cross-compilation or emulated build step is needed — each platform is the same `dist/` on an arch-appropriate Node base.

- *Why:* Cheap, fast multi-arch with no QEMU build emulation.
- *Watch item:* If a native-addon dependency is ever added, this assumption breaks and the build stage would need per-arch emulation or cross-build; called out so a future dep change revisits it.

### D5 — `main` pre-releases are a single rolling `edge` entry
Pushes to `main` update one GitHub pre-release attached to a moving `edge` tag (assets replaced each push), rather than creating a new pre-release per commit.

- *Why:* Clean Releases page, a stable download URL (`/releases/tag/edge`), and the `+<sha>` build metadata plus the immutable container `:sha-<short>` tag preserve exact per-commit traceability. Per-commit GitHub releases would flood the list and need retention cleanup.
- *Alternative:* One pre-release per commit. Rejected — clutter and cleanup burden for no traceability gain over the container `:sha` tag.

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
