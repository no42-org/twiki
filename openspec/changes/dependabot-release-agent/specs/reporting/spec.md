## ADDED Requirements

### Requirement: Per-run chat digest
The service SHALL send a digest to a configured Slack/Discord channel after each run, summarizing what happened across all evaluated repositories.

#### Scenario: Digest sent after a run
- **WHEN** a run completes
- **THEN** the service SHALL send a single digest summarizing the run's outcomes

#### Scenario: Digest distinguishes shadow from enforce
- **WHEN** the service runs in `shadow` mode
- **THEN** the digest SHALL clearly mark actions as would-do rather than performed

### Requirement: Digest content
The digest SHALL report merged PRs, held PRs with their reasons, releases cut (with versions), majors flagged for human review, and any red or blocked items including a broken `main`.

#### Scenario: Held PR includes a reason
- **WHEN** a PR was held (by policy or LLM judgment)
- **THEN** the digest SHALL include that PR and the stated reason it was held

#### Scenario: Release reported with version
- **WHEN** a patch release was cut for a repository
- **THEN** the digest SHALL include the repository and the released version

#### Scenario: Broken main surfaced
- **WHEN** a repository's `main` is red
- **THEN** the digest SHALL surface it as a blocking issue distinct from routine holds

#### Scenario: Security major flagged urgently
- **WHEN** a security update is a major bump and therefore not auto-merged
- **THEN** the digest SHALL flag it for human review and mark it urgent
