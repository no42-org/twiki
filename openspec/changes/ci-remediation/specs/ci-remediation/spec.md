## ADDED Requirements

### Requirement: Per-check failure detail and workflow-run refs are gathered for red CI
For every open Dependabot PR whose checks are not green, and for `main` when its checks are not green, the service SHALL gather, as part of the stateless per-tick fact gathering: (a) the set of failing check runs — each with its name, conclusion, and details URL; and (b) the owning workflow-run references — each with its run id, `run_attempt`, status, and conclusion — that the re-run predicate consumes. All of this detail SHALL be read-only and SHALL NOT influence any merge or release gate.

#### Scenario: Failing checks recorded for a red PR
- **WHEN** an open Dependabot PR has one or more check runs whose conclusion is failure/cancelled/timed-out
- **THEN** the facts for that PR SHALL include each failing check's name, conclusion, and details URL

#### Scenario: Workflow-run refs recorded for a red PR and red main
- **WHEN** a PR head or `main` has failing check runs backed by workflow runs
- **THEN** the facts SHALL include each owning workflow run's id, `run_attempt`, status, and conclusion, for both the PR head and `main`

#### Scenario: Failing checks recorded for red main
- **WHEN** `main`'s combined checks are not green
- **THEN** the facts for that repo SHALL include the failing check detail for `main`

#### Scenario: Green CI yields no failure detail
- **WHEN** a PR's or `main`'s checks are all green
- **THEN** no failing-check detail or workflow-run refs SHALL be gathered for it

### Requirement: Remediation facts are withheld from the advisor
The failing-check detail, workflow-run/attempt data, and branch-lag (`behind_by`) gathered for remediation SHALL be supplied only to the deterministic gates, executor, and reporter. The LLM advisor SHALL receive a projection of the facts that excludes these remediation fields, so that untrusted CI text cannot enter the advisor's context and the advisor cannot influence any remediation action.

#### Scenario: Advisor input excludes remediation fields
- **WHEN** the advisor is invoked for a tick
- **THEN** the facts passed to it SHALL NOT contain the failing-check detail, the workflow-run/attempt data, or `behind_by`

#### Scenario: Adding remediation facts does not change advisor behavior
- **WHEN** a repo gains failing-check detail compared with an otherwise identical run
- **THEN** the advisor's input — and therefore its plan — SHALL be unaffected by the presence of those remediation fields

### Requirement: The digest explains why CI is red
The per-run digest SHALL render a red PR's blocked line with the names of the failing checks (and a link to the logs) rather than a bare `ci-not-green`, and SHALL surface the failing checks for a red `main`.

#### Scenario: Blocked line names the failing checks
- **WHEN** a PR is reported as blocked by `ci-not-green` and failing-check detail is available
- **THEN** the digest line SHALL include the failing check name(s) and a details link

#### Scenario: Red main names the failing checks
- **WHEN** a repo's `main` is red
- **THEN** the digest SHALL list the failing check(s) on `main` so a human can locate the breakage

### Requirement: Eligibility for CI re-run is a pure, stateless predicate bounded by run attempts
The service SHALL decide whether a failed workflow run is eligible for an automatic re-run using a pure predicate with no I/O. A run SHALL be eligible only when ALL of the following hold: the run is completed (status `completed`) with a failing conclusion (`failure`, `cancelled`, or `timed_out`); and its `run_attempt` is strictly less than the configured attempt ceiling (`TWIKI_MAX_CI_ATTEMPTS`, default 2 — the initial run plus one automatic re-run). The ceiling SHALL be derived from GitHub's own `run_attempt` counter — which starts at 1 for the initial run and increments on each re-run — so that no twiki-side state is required and attempts cannot accumulate without limit across ticks. Both pull-request head runs and `main` runs SHALL be eligible under the same predicate.

#### Scenario: First failure is eligible for re-run
- **WHEN** a completed workflow run has a failing conclusion and its `run_attempt` (1 on the initial run) is below `TWIKI_MAX_CI_ATTEMPTS`
- **THEN** the predicate SHALL report the run as eligible for re-run

#### Scenario: In-progress run is never re-run
- **WHEN** a workflow run is not yet completed (for example a prior re-run is still running)
- **THEN** the predicate SHALL report it as not eligible, so no re-run is requested against an in-progress run

#### Scenario: Exhausted attempts are not re-run
- **WHEN** a failed run's `run_attempt` has reached `TWIKI_MAX_CI_ATTEMPTS` (by default, the initial run plus one re-run)
- **THEN** the predicate SHALL report it as not eligible, and the run SHALL be left for a human

#### Scenario: A failing main run is eligible on the same terms
- **WHEN** a `main` workflow run has a failing conclusion and a `run_attempt` below the ceiling
- **THEN** the predicate SHALL report it as eligible, since a flaky `main` job also blocks releases

#### Scenario: Eligibility uses GitHub's attempt counter, not twiki memory
- **WHEN** twiki is restarted or a tick is repeated
- **THEN** the re-run bound SHALL still hold because it is computed from the run's current `run_attempt`, not from any stored counter

### Requirement: Eligibility for rebase is a pure, stateless predicate bounded by branch lag
The service SHALL decide whether a Dependabot PR should be refreshed using a pure predicate with no I/O. A PR SHALL be eligible for rebase only when ALL of the following hold: it is a Dependabot PR; it is within merge policy (a patch bump, or a minor bump where policy allows — never a major or indeterminate bump twiki would not merge); its head branch is known to be behind its base branch (`behind_by > 0`); and its own head checks are NOT red (green or pending). The `behind_by` value SHALL be treated as fail-closed: when it is unknown or unavailable for the current tick (GitHub computes it asynchronously), the PR SHALL NOT be eligible. Restricting rebase to not-red, within-policy PRs keyed off `behind_by` makes the action self-terminating — a refreshed PR becomes mergeable and is merged, while a PR that is red on its own merits is never rebased, so an actively advancing base cannot cause repeated rebases.

#### Scenario: Stale-but-otherwise-ready PR is eligible for rebase
- **WHEN** a within-policy Dependabot PR is behind its base (`behind_by > 0`) and its own checks are green or pending
- **THEN** the predicate SHALL report it as eligible for rebase

#### Scenario: Up-to-date PR is not rebased
- **WHEN** a Dependabot PR is level with its base (`behind_by == 0`)
- **THEN** the predicate SHALL report it as not eligible, so no rebase is requested

#### Scenario: PR red on its own merits is not rebased
- **WHEN** a Dependabot PR is behind its base but its own head checks are red
- **THEN** the predicate SHALL report it as not eligible, so an actively advancing `main` cannot trigger repeated rebases of a PR whose redness a rebase would not fix

#### Scenario: Unknown branch lag is fail-closed
- **WHEN** a PR's `behind_by` cannot be determined for the current tick
- **THEN** the predicate SHALL report it as not eligible, and the PR SHALL be re-evaluated on a later tick rather than rebased on uncertainty

### Requirement: Remediation actions are executed only by the executor, gated and mode-aware
The re-run and rebase actions SHALL be performed only by the deterministic executor, which SHALL re-validate the corresponding eligibility predicate immediately before acting, and SHALL respect `shadow` / `enforce` mode and the repository allowlist exactly as merge and release do. The LLM SHALL have no path to trigger either action.

#### Scenario: Enforce mode re-runs an eligible failed run
- **WHEN** the service runs in `enforce` mode and a failed workflow run is eligible for re-run at execution time
- **THEN** the executor SHALL re-run the failed jobs and SHALL report the re-run

#### Scenario: Enforce mode rebases a behind PR
- **WHEN** the service runs in `enforce` mode and a Dependabot PR is eligible for rebase at execution time
- **THEN** the executor SHALL request a Dependabot rebase (for example by posting `@dependabot rebase`) and SHALL report the rebase

#### Scenario: Shadow mode performs no remediation writes
- **WHEN** the service runs in `shadow` mode and an action would be eligible
- **THEN** the executor SHALL NOT re-run or rebase and SHALL report it as a would-do action

#### Scenario: Eligibility re-checked at execution time
- **WHEN** a check set or PR ceases to be eligible (for example it turned green, the run is no longer completed-failing, or `run_attempt` advanced) after facts were gathered
- **THEN** the executor SHALL use the re-validated current eligibility and SHALL skip the action

### Requirement: Remediation never authors code
The service SHALL NOT generate, commit, or push any change to application source in order to make CI pass. A red `main` caused by the application's own code SHALL be reported only, never auto-fixed.

#### Scenario: Red main from app source is reported, not fixed
- **WHEN** `main` is red because of the repository's own source or tests
- **THEN** the service SHALL report the failing checks and SHALL NOT attempt to modify the repository's code

#### Scenario: Remediation is limited to re-run and rebase
- **WHEN** a PR is blocked by `ci-not-green`
- **THEN** the only automatic actions available SHALL be re-running failed jobs and requesting a Dependabot rebase; no other write SHALL be performed to clear the failure

### Requirement: Remediation can be disabled by configuration
The service SHALL provide a configuration switch to disable CI remediation actions independently of the run mode. When remediation is disabled, the service SHALL still gather and report failing-check detail but SHALL perform no re-run or rebase.

#### Scenario: Disabled remediation still diagnoses
- **WHEN** CI remediation is disabled by configuration and a PR is red
- **THEN** the digest SHALL still name the failing checks but the executor SHALL NOT re-run or rebase
