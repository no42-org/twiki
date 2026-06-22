## 1. Types & facts (read-only foundation)

- [x] 1.1 Add `FailingCheck` type `{ name, conclusion, detailsUrl }` and a `WorkflowRunRef` `{ runId, runAttempt, status, conclusion }` to `src/types.ts`
- [x] 1.2 Extend `PullRequest` with optional `failingChecks: FailingCheck[]`, `workflowRuns: WorkflowRunRef[]`, and `behindBy: number | null` (null = unknown/fail-closed), plus a Dependabot marker if not already present
- [x] 1.3 Extend `RepoFacts` with optional `mainFailingChecks: FailingCheck[]` and `mainWorkflowRuns: WorkflowRunRef[]`
- [x] 1.4 Confirm the new fields are NOT referenced by `mergeBlock`/`isSettled` (read-only, remediation/reporting only)
- [x] 1.5 Add `toAdvisorFacts(facts)` projection (and a narrowed `AdvisorFacts` type) that strips the remediation fields; route `advisor.ts` input through it so a future field cannot leak into the prompt without a type error

## 2. GitHub port — read methods

- [x] 2.1 Add `failingChecks(repo, ref): Promise<FailingCheck[]>` to `src/github/port.ts` (PR head SHA and `main`)
- [x] 2.2 Add `workflowRunsForSha(repo, sha): Promise<WorkflowRunRef[]>` exposing `run_attempt`, `status`, and `conclusion`
- [x] 2.3 Add `behindBy(repo, pr): Promise<number | null>` (via `compare base...head`; return `null` when GitHub cannot determine it — fail-closed, never coerce to 0-or-positive)
- [x] 2.4 Implement all three in `src/github/octokit-adapter.ts` (checks API + actions runs + compare)
- [x] 2.5 Wire them into `gatherFacts` in `src/facts.ts` — only fetch failing-check/run detail when checks are not green; gather `behindBy` per open PR

## 3. Pure gates (predicates)

- [x] 3.1 Add `canRerunCi(run: WorkflowRunRef, maxAttempts: number): boolean` → `run.status === "completed" && isFailing(run.conclusion) && run.runAttempt < maxAttempts` to `src/gates.ts` (add an `isFailing` helper for `failure`/`cancelled`/`timed_out`)
- [x] 3.2 Add `canRebase(pr: PullRequest, policy: RepoPolicy): boolean` → `isDependabot(pr) && withinMergePolicy(pr, policy) && pr.behindBy != null && pr.behindBy > 0 && pr.checks !== "red"`
- [x] 3.3 Unit tests in `test/gates.test.ts`: re-run boundary at `run_attempt === maxAttempts`; in-progress / non-failing conclusion not eligible; rebase eligible only when behind + within-policy + head not red; `behindBy === null` (unknown) and `behindBy === 0` not eligible; major/indeterminate bump not eligible

## 4. Config & env

- [x] 4.1 Parse `TWIKI_MAX_CI_ATTEMPTS` (default `2` — initial run plus one re-run) and `TWIKI_CI_REMEDIATION` (default `on`, `off` disables writes) in the env/config layer
- [x] 4.2 Thread the two settings into the executor/run wiring (`src/index.ts` / `src/run.ts`)

## 5. GitHub port — write methods

- [x] 5.1 Add `rerunFailedJobs(repo, runId): Promise<void>` → `POST /repos/{o}/{r}/actions/runs/{run_id}/rerun-failed-jobs`
- [x] 5.2 Add `requestDependabotRebase(repo, prNumber): Promise<void>` → post `@dependabot rebase` PR comment (uses existing Pull requests: write — no Issues scope)
- [x] 5.3 Implement both in `octokit-adapter.ts`; add to the port fake used in tests

## 6. Executor — remediation actions

- [x] 6.1 In `src/executor.ts`, for each completed-failing run (PR head **and** `main`), re-validate `canRerunCi` and (in enforce) call `rerunFailedJobs` per unique eligible run; dedupe run ids
- [x] 6.2 Re-validate `canRebase` and (in enforce) call `requestDependabotRebase`
- [x] 6.3 Short-circuit both when `TWIKI_CI_REMEDIATION=off` (diagnostics still produced); skip writes entirely in `shadow` (report would-do)
- [x] 6.4 Emit outcome records (re-ran / would re-run / rebased / would rebase / not-eligible) into the run result
- [x] 6.5 Append remediation actions to the audit log alongside merges/releases

## 7. Reporting

- [x] 7.1 Render `ci-not-green` blocked lines with failing-check names + details link (fallback to bare text when detail absent)
- [x] 7.2 Render red-`main` failing-check list under the `🔴 main is RED` line
- [x] 7.3 Add outcome lines: `🔁 re-ran CI` / `would re-run` and `🔄 rebased` / `would rebase`

## 8. End-to-end & safety tests

- [x] 8.1 Shadow e2e (fakes): eligible PR reports `would re-run` / `would rebase`, no port write methods invoked
- [x] 8.2 Enforce e2e (fakes): eligible run → `rerunFailedJobs` called once; behind not-red PR → rebase requested once
- [x] 8.3 Statelessness test: repeated ticks do not exceed `TWIKI_MAX_CI_ATTEMPTS` (bound comes from `run_attempt`); an in-progress prior re-run is not re-triggered
- [x] 8.4 Anti-thrash test: a behind PR that is red on its own head checks is never rebased across repeated ticks even as `main` advances
- [x] 8.5 `TWIKI_CI_REMEDIATION=off`: diagnostics present, zero remediation writes
- [x] 8.6 Injection/safety test: `toAdvisorFacts` output contains no remediation fields, so failing-check text never reaches the advisor and never gates a write; red `main` from app code triggers no code-authoring path
- [x] 8.7 Main re-run test: a completed-failing `main` run within the attempt ceiling is re-run in enforce mode

## 9. Docs & permissions

- [x] 9.1 README: add `TWIKI_MAX_CI_ATTEMPTS` and `TWIKI_CI_REMEDIATION` to the env table; document **Actions: Read & write** as the one new required GitHub App permission (rebase uses existing Pull requests: write)
- [x] 9.2 Quickstart §1a: add **Actions: Read & write** to the grant list and note the reinstall/approval step
- [x] 9.3 `make verify` passes (typecheck + tests) — CI gate green
