## ADDED Requirements

### Requirement: Dependabot covers npm, actions, and docker
The repository SHALL configure Dependabot for the `npm` ecosystem (`package.json`), the `github-actions` ecosystem (workflow pins), and the `docker` ecosystem (Dockerfile base image).

#### Scenario: npm updates proposed
- **WHEN** a newer version of a tracked npm dependency is released
- **THEN** Dependabot SHALL open an update pull request for it

#### Scenario: Action pin updates proposed
- **WHEN** a newer release of a pinned GitHub Action is available
- **THEN** Dependabot SHALL open a pull request bumping the SHA pin and its version comment

#### Scenario: Base image updates proposed
- **WHEN** the Dockerfile base image has a newer tag
- **THEN** Dependabot SHALL open a pull request updating it

### Requirement: All actions pinned to immutable SHAs
Every `uses:` reference in every workflow SHALL be pinned to a full commit SHA, annotated with a trailing comment naming the full semver (`vX.Y.Z`) the SHA corresponds to.

#### Scenario: SHA pin with semver comment
- **WHEN** a workflow references a third-party action
- **THEN** it SHALL use a 40-character commit SHA followed by a `# vX.Y.Z` comment, not a mutable tag

#### Scenario: No mutable tag references
- **WHEN** any workflow is inspected
- **THEN** no `uses:` line SHALL reference a tag such as `@v4` or `@main`
