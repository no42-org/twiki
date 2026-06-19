## ADDED Requirements

### Requirement: main version is the next patch, pre-released
For a push to `main`, the pipeline SHALL derive the version from `git describe --tags --match 'v*'` as `X.Y.(Z+1)-dev.<n>+<shortsha>`, where `vX.Y.Z` is the most recent tag and `n` is the number of commits since it.

#### Scenario: Next-patch pre-release computed
- **WHEN** the latest tag is `v2.3.1` and `main` is 5 commits ahead at `1a2b3c4`
- **THEN** the derived version SHALL be `2.3.2-dev.5+1a2b3c4`

#### Scenario: Ordering relative to releases
- **WHEN** the derived version is `2.3.2-dev.5`
- **THEN** it SHALL sort greater than `2.3.1` and less than `2.3.2`, `2.4.0`, and `3.0.0`

### Requirement: Stable GitHub Release from a tag
When a non-prerelease `vX.Y.Z` tag is pushed, the pipeline SHALL create a GitHub Release for that tag with auto-generated notes derived from Conventional-Commits history, not marked as a pre-release.

#### Scenario: Release published with changelog
- **WHEN** tag `v2.3.1` is pushed
- **THEN** a GitHub Release for `v2.3.1` SHALL be created with generated notes and `prerelease=false`

### Requirement: Single rolling edge pre-release for main
Pushes to `main` SHALL update one GitHub pre-release attached to a moving `edge` tag, replacing its assets each push, rather than creating a new release per commit.

#### Scenario: Edge pre-release updated in place
- **WHEN** a second commit lands on `main`
- **THEN** the existing `edge` pre-release SHALL be updated with the new assets, and no additional release entry SHALL be created

#### Scenario: Edge is flagged pre-release
- **WHEN** the `edge` release is published or updated
- **THEN** it SHALL have `prerelease=true`

### Requirement: npm tarball attached to releases
The pipeline SHALL build the project and attach an arch-independent `npm pack` tarball that includes the compiled `dist/` output to both stable and `edge` releases.

#### Scenario: Tarball includes built output
- **WHEN** the tarball is produced
- **THEN** it SHALL contain the compiled `dist/` (via the package `files` allowlist), not an empty package

#### Scenario: Tarball on stable and edge
- **WHEN** a stable tag or a `main` push is published
- **THEN** the corresponding Release (stable or `edge`) SHALL carry the tarball asset

### Requirement: Checkout includes tag history
Publish jobs SHALL check out full history with tags so version derivation and the highest-stable-version guard can resolve correctly.

#### Scenario: Full history fetched
- **WHEN** a publish job checks out the repository
- **THEN** it SHALL fetch all tags and history (e.g. `fetch-depth: 0`) before deriving versions
