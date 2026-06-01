## ADDED Requirements

### Requirement: Settled condition for release
The service SHALL cut a patch release for a repository only when all of the following hold: no open Dependabot PR remains that the policy would merge; `main` CI is green; and there exist merged-but-unreleased dependency commits (commits between the latest release tag and `main` HEAD attributable to Dependabot).

#### Scenario: All settled conditions met
- **WHEN** a repository has no remaining mergeable Dependabot PRs, `main` is green, and there are unreleased dependency commits
- **THEN** the service SHALL cut exactly one patch release for that repository

#### Scenario: Mergeable PRs still open
- **WHEN** a repository still has an open Dependabot PR that the policy would merge
- **THEN** the service SHALL NOT cut a release yet

#### Scenario: Stuck red PR does not block release
- **WHEN** a repository's only remaining open Dependabot PR is red (and thus not something the policy would merge) and the other settled conditions hold
- **THEN** the service SHALL cut the release and SHALL report the red PR separately

#### Scenario: No unreleased dependency changes
- **WHEN** there are no merged-but-unreleased dependency commits
- **THEN** the service SHALL NOT cut a release

#### Scenario: main is red
- **WHEN** `main` CI is not green
- **THEN** the service SHALL NOT cut a release and SHALL report `main` as broken

### Requirement: Patch release via pushed tag
When releasing, the service SHALL compute the next patch version from the latest release tag (`vX.Y.Z` to `vX.Y.Z+1`) and SHALL trigger the release by pushing that tag, relying on the repository's own tag-triggered workflow to build and publish.

#### Scenario: Next patch version computed and tagged
- **WHEN** the latest release tag is `vX.Y.Z` and the repository is settled
- **THEN** the service SHALL push tag `vX.Y.Z+1`

#### Scenario: Exactly one release per settle
- **WHEN** multiple dependency PRs were merged before the repository settled
- **THEN** the service SHALL produce a single patch release covering them, not one per merged PR

#### Scenario: Repository lacks a tag-triggered workflow
- **WHEN** a settled repository has no tag-triggered release workflow
- **THEN** the service SHALL treat the repository as merge-only, SHALL NOT push a release tag, and SHALL report the gap
