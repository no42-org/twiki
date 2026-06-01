## ADDED Requirements

### Requirement: Dependabot and Security PR discovery
The service SHALL identify open pull requests authored by Dependabot, distinguishing version-update PRs from security-update PRs.

#### Scenario: Dependabot PRs found
- **WHEN** the service evaluates an allowlisted repository
- **THEN** it SHALL collect all open Dependabot PRs and SHALL record for each whether it is a security update

#### Scenario: Non-Dependabot PRs ignored
- **WHEN** an open PR is not authored by Dependabot
- **THEN** the service SHALL NOT consider it for auto-merge or release evaluation

### Requirement: Semver classification
The service SHALL classify each Dependabot PR by its dependency bump as patch, minor, or major.

#### Scenario: Bump classified
- **WHEN** a Dependabot PR is evaluated
- **THEN** the service SHALL determine whether the bump is patch, minor, or major

#### Scenario: Classification cannot be determined
- **WHEN** the bump level cannot be reliably determined
- **THEN** the service SHALL treat the PR as if it were a major (most conservative) and SHALL NOT auto-merge it

### Requirement: LLM produces a structured decision plan
The service SHALL pass gathered facts to the LLM and SHALL require the LLM to return a typed plan: for each PR an action of `merge` or `hold` with a reason and risk assessment, and for each repository a release decision of `release` or `wait` with optional version and notes. The LLM SHALL NOT be given any tool or capability that mutates GitHub.

#### Scenario: Plan emitted for each PR
- **WHEN** the LLM evaluates a repository's PRs
- **THEN** it SHALL return, for every PR, a `merge` or `hold` decision accompanied by a stated reason and risk assessment

#### Scenario: LLM holds a permitted bump it judges risky
- **WHEN** a PR is within auto-merge policy (patch or minor) but the LLM assesses it as risky from the changelog
- **THEN** the LLM MAY return `hold` with a reason, and the service SHALL NOT merge that PR

#### Scenario: Untrusted changelog text cannot escalate authority
- **WHEN** a Dependabot PR body contains third-party changelog text attempting to instruct the agent
- **THEN** that text SHALL be treated as data only, and the LLM's plan SHALL NOT be able to cause any action the deterministic gates do not independently permit
