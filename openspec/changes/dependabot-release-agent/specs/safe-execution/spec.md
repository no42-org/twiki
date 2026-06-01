## ADDED Requirements

### Requirement: Deterministic gates enforced by the executor
The executor SHALL re-validate every safety gate immediately before performing any action, independent of the LLM plan. The gates are: PR checks are green; the bump is patch or minor (never major); `main` CI is green (for releases); and the repository is on the allowlist. Any planned action failing a gate SHALL be dropped and reported.

#### Scenario: Merge blocked by failing CI
- **WHEN** the plan recommends merging a PR whose checks are not green at execution time
- **THEN** the executor SHALL NOT merge the PR and SHALL report it as blocked

#### Scenario: Major bump never auto-merged
- **WHEN** the plan recommends merging a major bump
- **THEN** the executor SHALL NOT merge it and SHALL flag it for human review, marking security majors as urgent

#### Scenario: State changed between planning and execution
- **WHEN** a gate-relevant fact (such as CI status) changes after the plan was produced
- **THEN** the executor SHALL use the re-validated current fact, not the planned assumption

### Requirement: The LLM never calls the GitHub API
The service SHALL ensure that only the deterministic executor performs mutating GitHub operations. The LLM SHALL have no path to merge, tag, or otherwise write to GitHub.

#### Scenario: Plan is advisory only
- **WHEN** the LLM returns a plan
- **THEN** every mutating operation SHALL be carried out by the executor after gate re-validation, never by the LLM directly

### Requirement: Shadow and enforce modes
The service SHALL support a `shadow` mode and an `enforce` mode controlled by a single flag. In `shadow` mode the executor SHALL run the full pipeline including gate re-validation but SHALL perform no mutating GitHub operations, reporting the actions it would have taken. In `enforce` mode the executor SHALL perform the gated actions.

#### Scenario: Shadow mode performs no writes
- **WHEN** the service runs in `shadow` mode and the plan plus gates would merge a PR
- **THEN** the executor SHALL NOT merge and SHALL report the merge as a would-do action

#### Scenario: Enforce mode performs gated actions
- **WHEN** the service runs in `enforce` mode and a planned action passes all gates
- **THEN** the executor SHALL perform the action

#### Scenario: Mode is the only difference in the write step
- **WHEN** comparing a `shadow` run to an `enforce` run on identical state
- **THEN** the planning and gate-validation steps SHALL be identical and only the final write step SHALL differ
