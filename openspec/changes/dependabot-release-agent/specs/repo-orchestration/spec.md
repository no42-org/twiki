## ADDED Requirements

### Requirement: Repository allowlist configuration
The service SHALL operate only on repositories listed in a `repos.yaml` allowlist, and SHALL support per-repository policy overrides within that file.

#### Scenario: Repository not on the allowlist
- **WHEN** a Dependabot PR exists in a repository that is not present in `repos.yaml`
- **THEN** the service SHALL take no action on that repository and SHALL NOT include it in the run

#### Scenario: Per-repository policy override
- **WHEN** a repository in `repos.yaml` sets an override (for example, disabling minor auto-merge or marking the repo merge-only)
- **THEN** the service SHALL apply that override in place of the default policy for that repository

### Requirement: Scheduled polling loop
The service SHALL evaluate all allowlisted repositories on a recurring schedule (approximately hourly) without requiring inbound webhooks.

#### Scenario: Scheduled tick runs
- **WHEN** the poll interval elapses
- **THEN** the service SHALL begin a new run that evaluates every allowlisted repository

#### Scenario: A run is skipped or fails
- **WHEN** a scheduled run is missed or aborts before completion
- **THEN** the next run SHALL re-evaluate current state from GitHub and proceed correctly without relying on the skipped run

### Requirement: Stateless per-tick state derivation
The service SHALL derive all decision-relevant state from GitHub's current state on each tick, including open Dependabot/Security PRs and their check status, `main` CI status, and commits since the latest release tag. The service SHALL NOT depend on a local authoritative record of prior actions to make decisions.

#### Scenario: Truth re-derived each run
- **WHEN** a new run begins
- **THEN** the service SHALL query GitHub for the current PRs, check statuses, `main` status, and latest tag rather than trusting cached decision state

#### Scenario: Repeated run does not double-act
- **WHEN** an action (such as a merge) was already completed in a prior run
- **THEN** the current run SHALL observe the updated GitHub state and SHALL NOT repeat the action
