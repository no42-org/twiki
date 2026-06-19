## ADDED Requirements

### Requirement: Multi-arch images published to GHCR
On a publish trigger (a `v*` tag or a push to `main`), the pipeline SHALL build a multi-architecture image for `linux/amd64` and `linux/arm64` as a single manifest list and push it to `ghcr.io/no42-org/twiki` (a public package).

#### Scenario: Both architectures in one manifest
- **WHEN** a publish trigger fires
- **THEN** the pushed tag SHALL resolve to a manifest list containing `linux/amd64` and `linux/arm64`

#### Scenario: Pure-JS build needs no emulated compile
- **WHEN** the multi-arch image is built
- **THEN** the build SHALL produce both platforms from the same compiled `dist/` without a QEMU-emulated build step

### Requirement: Stable tag image tag scheme
When the trigger is a non-prerelease tag `vX.Y.Z`, the pipeline SHALL push the image as `:X.Y.Z`, `:X.Y`, and `:X`.

#### Scenario: Semver tags applied
- **WHEN** tag `v2.3.1` is pushed and it parses as a non-prerelease version
- **THEN** the image SHALL be published as `:2.3.1`, `:2.3`, and `:2`

#### Scenario: Pre-release tag is exact only
- **WHEN** tag `v2.4.0-rc.1` is pushed
- **THEN** the image SHALL be published as `:2.4.0-rc.1` and SHALL NOT receive `:2.4`, `:2`, or `:latest`

### Requirement: `:latest` tracks the highest stable version only
The pipeline SHALL apply `:latest` only when the pushed tag is the highest non-prerelease version among all tags. It SHALL NOT apply `:latest` to pre-releases or to `main` builds.

#### Scenario: Newest stable release moves latest
- **WHEN** `v2.3.1` is pushed and no higher stable tag exists
- **THEN** `:latest` SHALL point to the `v2.3.1` image

#### Scenario: Backport does not move latest backward
- **WHEN** `v1.4.9` is pushed while `v2.0.0` already exists
- **THEN** `:latest` SHALL remain on the `v2.0.0` image and SHALL NOT move to `v1.4.9`

#### Scenario: main never gets latest
- **WHEN** a push to `main` is published
- **THEN** the build SHALL NOT receive `:latest`

### Requirement: main rolling pre-release image tags
When the trigger is a push to `main`, the pipeline SHALL publish the image as `:main`, `:sha-<short>`, and the derived next-patch pre-release version `:X.Y.Z-dev.<n>+<sha>` (build-metadata normalized for tag syntax).

#### Scenario: main tags applied
- **WHEN** a commit lands on `main`
- **THEN** the image SHALL be published as `:main` and an immutable `:sha-<short>` tag

### Requirement: Published images are signed and carry an SBOM
Every image pushed to GHCR SHALL be signed with cosign using keyless OIDC signing, and an SBOM SHALL be generated for it.

#### Scenario: Keyless signature on publish
- **WHEN** an image is pushed to ghcr.io
- **THEN** the pipeline SHALL produce a cosign keyless signature for the pushed digest using the workflow OIDC identity

#### Scenario: SBOM generated
- **WHEN** an image is published
- **THEN** an SBOM (syft) SHALL be generated for that image
