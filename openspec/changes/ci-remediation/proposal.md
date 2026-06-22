## Why

Today a `ci-not-green` PR (or a red `main`) is a dead end: twiki reports a bare `gate: ci-not-green` and waits for a human, but it can't even say *which* check failed, and it never lifts a finger on the failures that are mechanically recoverable — a flaky job that passes on re-run, or a not-red Dependabot PR left unmergeable because its branch fell behind `main`. In a real run across six repos, this leaves dozens of patch/minor bumps stuck indefinitely. We can clear the *recoverable* subset automatically and make the rest legible — **without** the LLM ever writing code, so the safety-by-construction model is untouched.

## What Changes

- **Diagnose & report (read-only):** gather the *failing check-run* names, conclusions, and details URLs for red PRs and red `main` (twiki currently only knows green / red / pending). Surface them in the per-run digest so a `ci-not-green` line says *why* it is red and links the logs.
- **Re-run flaky CI (new executor action):** in enforce mode, re-trigger failed workflow jobs for a completed-failing run (PR head or `main`). Bounded **statelessly** by GitHub's own 1-based `run_attempt` counter — only re-run while `run_attempt < TWIKI_MAX_CI_ATTEMPTS` (default 2 = the run plus one re-run) — so twiki keeps no memory and cannot create a retry storm. Shadow mode reports *would re-run*.
- **Rebase stale PRs (new executor action):** in enforce mode, when a within-policy Dependabot PR is behind its base branch (`behind_by > 0`) and not red on its own merits, post `@dependabot rebase` so Dependabot regenerates it against current `main`. The not-red / within-policy guard keeps it self-terminating (it never loops a perpetually-behind, red PR), and unknown `behind_by` is fail-closed. Shadow mode reports *would rebase*.
- All three actions run through the **existing executor/gate discipline**: pure eligibility predicates in `gates.ts`, re-validated in `executor.ts` immediately before any write, gated on the repo allowlist and `shadow`/`enforce` mode exactly like merge and release.
- **Explicitly NOT changed:** the LLM gains no write capability. It never authors a code patch or commit. A red `main` caused by the application's own source is *reported, never auto-fixed* — that remains a human's job.

## Capabilities

### New Capabilities
- `ci-remediation`: the deterministic layer that (a) collects per-check failure detail for red PRs and red `main`, (b) decides — via pure, stateless predicates — whether a completed-failing run is eligible for an automatic re-run (bounded by `run_attempt`) or a within-policy, not-red Dependabot PR is eligible for a rebase (driven by `behind_by`), and (c) executes those re-run / rebase actions in enforce mode only, re-validating eligibility at execution time. The remediation facts are withheld from the LLM advisor by an explicit projection; this is mechanical recovery, not code authorship.

### Modified Capabilities
<!-- None at the spec level. The prior capabilities (safe-execution, reporting, repo-orchestration) are not yet archived into openspec/specs/, so their cross-cutting touch points are captured under Impact rather than as delta specs. -->

## Impact

- **GitHub port** (`src/github/port.ts` + `octokit-adapter.ts`): new **read** methods to list failed check runs with names/conclusions/details URLs and their owning workflow run id + `run_attempt`, and to read a PR's `behind_by`; new **write** methods to re-run failed jobs (`POST .../actions/runs/{id}/rerun-failed-jobs`) and to post a `@dependabot rebase` issue comment.
- **Facts** (`src/facts.ts`, `src/types.ts`): `RepoFacts`/`PullRequest` carry richer CI detail (failed checks + run id/attempt/status/conclusion) and `behindBy: number | null`, gathered statelessly each tick. A `toAdvisorFacts` projection strips these before the advisor sees them.
- **Gates** (`src/gates.ts`): new pure predicates `canRerunCi` (completed-failing run, `run_attempt < TWIKI_MAX_CI_ATTEMPTS`) and `canRebase` (Dependabot, within-policy, `behind_by > 0`, head not red), with no I/O.
- **Executor** (`src/executor.ts`): two new actions that re-validate the predicates before acting and respect `shadow`/`enforce`.
- **Reporting** (`src/report.ts`): richer `ci-not-green` lines (failing check names + link) plus `🔁 re-ran CI` / `would re-run` and `🔄 rebased` / `would rebase` outcome lines.
- **Config/env**: `TWIKI_MAX_CI_ATTEMPTS` (default 2) and a toggle to disable remediation (e.g. `TWIKI_CI_REMEDIATION=off`). Documented in README env table + quickstart.
- **GitHub App permissions**: re-running workflow jobs requires **Actions: Read & write** (the one new grant); posting the rebase comment uses the existing **Pull requests: Read & write** (issue comments on a PR are governed by the Pull requests permission — no separate Issues scope is needed). Documented as a new required permission.
- **Out of scope:** LLM-authored fixes to application source, fixing a red `main`'s own code, non-Dependabot PR rebasing, and webhook-driven (vs poll) triggering.
