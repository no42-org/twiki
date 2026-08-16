## Context

twiki re-derives all state from GitHub each tick and decides per-PR/per-repo actions through a strict pipeline: facts → LLM advisor (no write tools) → typed plan → deterministic executor that re-validates pure gates and acts only in `enforce` mode. CI status is currently coarse: `branchChecks` and `prChecks` collapse everything to `CheckStatus = "green" | "red" | "pending"` (`src/types.ts`, `src/facts.ts`). The `mergeBlock` gate emits `ci-not-green` whenever `pr.checks !== "green"` (`src/gates.ts`), and the digest prints that string verbatim (`src/report.ts`).

This change adds a *deterministic remediation layer* for the recoverable subset of red CI — flaky jobs and stale Dependabot branches — plus the diagnostics needed to make the rest legible. It deliberately stays inside the existing safety envelope: the LLM is not consulted for any of it.

## Goals / Non-Goals

**Goals:**
- Tell the human *which* checks failed (PR and `main`), with links.
- Automatically re-run failed workflow jobs that may be flaky, with a hard, stateless upper bound on attempts.
- Automatically refresh stale, not-red Dependabot PRs that are blocked by an out-of-date branch (behind base), so they re-run against current `main` and become mergeable. (PRs red on their own merits are reported, not rebased — see D3.)
- Keep every new write inside the executor, behind a pure gate, mode-aware, allowlist-scoped — identical discipline to merge/release.
- Preserve statelessness: no new persisted counters or cursors.

**Non-Goals:**
- No LLM-authored code, commits, or patches. A red `main` from the app's own code is reported, never fixed.
- No rebasing of non-Dependabot PRs.
- No log *interpretation* in v1 (we surface check names + URLs; we do not parse stack traces). The advisor is not extended.
- No new persistence or webhook triggering.

## Decisions

### D1 — Bound re-runs with GitHub's `run_attempt`, not twiki state
The natural way to cap retries ("re-run at most N times") needs a counter, which collides with the stateless invariant (D4 of the base design). GitHub already tracks this: every workflow run carries `run_attempt`, which **starts at 1** for the initial run and increments on each re-run. The gate is `run_attempt < TWIKI_MAX_CI_ATTEMPTS` (default `2`), evaluated fresh each tick from live data. Restarting twiki, replaying a tick, or running `TWIKI_ONCE` repeatedly cannot exceed the bound because the bound lives in GitHub.

The variable is named **`_ATTEMPTS`, not `_RERUNS`**, deliberately: because `run_attempt` is 1-based, a value of `2` permits the initial run *plus one* re-run. Naming it `_RERUNS` would be off by one — an operator setting `_RERUNS=1` (expecting one re-run) would get `run_attempt < 1`, i.e. *zero* re-runs. `_ATTEMPTS` makes the comparison read truthfully.

The predicate also requires the run to be **`status == "completed"` with a failing conclusion** (`failure`/`cancelled`/`timed_out`). Without this, a still-running re-run (attempt already incremented, checks `pending`) could be re-triggered, and `rerun-failed-jobs` returns 403 against an in-progress run. Completed-and-failing is the only re-runnable state.

This bound and predicate apply identically to **PR-head runs and `main` runs** — a flaky `main` job blocks releases, so it is in scope (see D8).

*Alternatives considered:* (a) an audit-log scan to count prior re-runs — reintroduces state and is fragile; (b) a per-tick "one re-run per run" with no cap — unbounded across ticks. Rejected both.

### D2 — `rerun-failed-jobs`, not `rerun` (whole run)
Re-run only the *failed* jobs (`POST /repos/{o}/{r}/actions/runs/{run_id}/rerun-failed-jobs`) rather than the entire run. Cheaper, and it preserves already-green jobs. We map a red check set → its workflow run id(s) via the check runs' `details_url` / the checks API, dedupe by run id, and re-run each eligible run once per tick.

### D3 — Rebase via `@dependabot rebase` comment, not `update-branch`
For Dependabot PRs the idiomatic refresh is the `@dependabot rebase` command comment: Dependabot force-pushes a clean rebase and regenerates the manifest/lockfile correctly. The REST `update-branch` endpoint instead creates a merge commit from base, which Dependabot does not own and which muddies its PRs.

Eligibility is **not** `behind_by > 0` alone — that thrashes. On an actively advancing `main`, a perpetually-behind PR would be rebased every tick, and rebasing does nothing for a PR that is red on its own merits (a real test break). So `canRebase` requires *all* of: it is a Dependabot PR; it is **within merge policy** (one twiki would actually merge); `behind_by > 0`; and **its own head checks are NOT red** (green or pending). This makes the action self-terminating: a stale-but-otherwise-ready PR is rebased once, becomes mergeable, and is merged out of the open set; a red-on-its-merits PR is never rebased, so an advancing base cannot loop it.

`behind_by` comes from `compare base...head`. It is **fail-closed**: GitHub computes mergeability asynchronously, so when `behind_by` is unknown/unavailable for the tick the PR is treated as *not eligible* and re-evaluated next tick — never rebased on uncertainty. (`mergeable_state === "behind"` is deliberately *not* used as the source of truth; it is undocumented and unstable.)

*Alternative considered:* `PUT /pulls/{n}/update-branch`. Rejected for Dependabot PRs for the reasons above; could be a fallback for non-Dependabot PRs, which are out of scope here.

### D4 — Pure predicates in `gates.ts`, writes in `executor.ts`
Two new pure functions:
- `canRerunCi(run, maxAttempts): boolean` → `run.status === "completed" && isFailing(run.conclusion) && run.runAttempt < maxAttempts`
- `canRebase(pr, policy): boolean` → `pr.isDependabot && withinMergePolicy(pr, policy) && pr.behindBy != null && pr.behindBy > 0 && pr.checks !== "red"`

The executor re-validates these immediately before acting (state may have changed since facts were gathered — e.g. CI turned green, or `run_attempt` advanced) and honors `shadow`/`enforce` and the allowlist exactly like the merge path. This keeps remediation eligibility unit-testable with fakes and no network, matching the existing `gates.test.ts` pattern.

### D5 — New facts are additive, read-only, and hidden from the advisor
`RepoFacts`/`PullRequest` gain optional fields: failed-check detail (`{ name, conclusion, detailsUrl }[]`), the owning workflow runs (`{ runId, runAttempt, status, conclusion }`), and `behindBy: number | null`. These never feed `mergeBlock`/`isSettled` — they only drive remediation and reporting — so existing merge/release behavior is provably unchanged.

Crucially, the advisor's input *is* the facts object, so adding these fields would otherwise leak untrusted CI text into the LLM prompt. To keep the "LLM has no remediation influence / untrusted CI text never enters the advisor" guarantee **structural rather than asserted**, the advisor is fed an explicit projection `toAdvisorFacts(facts)` that strips the remediation fields. The advisor type is narrowed to that projection so a future field cannot silently reach the prompt — omitting it from the projection is a type error, not a runtime surprise.

### D6 — Config switches
- `TWIKI_MAX_CI_ATTEMPTS` (default `2` — initial run plus one re-run) — upper bound for D1. Named `_ATTEMPTS` because the bound is 1-based `run_attempt` (see D1).
- `TWIKI_CI_REMEDIATION` (default `on`; `off` disables both write actions while keeping diagnostics). Lets an operator adopt diagnostics first and turn on the writes later, mirroring the shadow→enforce rollout philosophy.

### D7 — GitHub App permission bump
Re-running workflow jobs requires **Actions: Read & write** — the only new permission. Posting the `@dependabot rebase` comment uses the **Pull requests: Read & write** scope the App already holds (issue comments on a pull request are governed by the Pull requests permission, not a separate Issues permission). Documented in README + quickstart §1a as the one added grant; the App must be reinstalled/approved for the added Actions scope.

### D8 — `main` re-runs are in scope; rebase stays PR-only
A flaky `main` job blocks releases just as a flaky PR job blocks merges, so the re-run predicate (D1) applies to `main` runs on identical terms (completed-failing, bounded by `run_attempt`), governed by the same `TWIKI_CI_REMEDIATION` toggle — no separate flag. Rebase, by contrast, is meaningful only for a PR branch behind its base, so it stays PR-only. This resolves the earlier open question; the safety bound is the same `run_attempt` ceiling, which already contains the blast radius.

## Risks / Trade-offs

- **Re-running a *deterministic* failure wastes CI minutes up to the cap.** → `TWIKI_MAX_CI_ATTEMPTS` defaults to 2 (one re-run); `rerun-failed-jobs` limits cost to the failed jobs only; deterministic failures exhaust the cap in one re-run and then surface to a human.
- **Re-triggering an in-progress run errors (`rerun-failed-jobs` → 403).** → `canRerunCi` requires `status == "completed"` with a failing conclusion, so an in-flight prior re-run is never re-triggered (D1).
- **Rebase thrash on an actively advancing `main`.** → `canRebase` fires only for a within-policy PR whose own checks are not red (D3), so a red-on-its-merits PR is never rebased and a refreshed PR is merged out of the open set — the action self-terminates instead of looping each tick.
- **`behind_by` can be momentarily `unknown` (GitHub computes it async).** → Modeled as `behindBy: number | null`; `null` is *not eligible* (fail-closed): skip this tick, re-evaluate next. Never rebase on uncertainty.
- **Mapping check runs → workflow run ids is API-shaped and can be partial.** → If a failing check has no resolvable workflow run (e.g. an external status check, not a GitHub Action), it is reported but not re-runnable; we never guess a run id.
- **Added Actions:write broadens the App's scope.** → Narrowly required for re-run; documented; operators who decline can set `TWIKI_CI_REMEDIATION=off` and keep diagnostics-only.
- **Prompt-injection surface unchanged.** → The LLM is not involved in remediation at all; the new remediation fields are stripped from the advisor's input by the `toAdvisorFacts` projection (D5), so failing-check text is rendered to chat but never enters the advisor context and never gates a write.

## Migration Plan

1. Ship behind the existing shadow/enforce model; remediation writes only ever fire in `enforce`.
2. Land diagnostics + pure predicates + facts first (no writes) so operators see richer digests immediately; this is safe to deploy with `TWIKI_CI_REMEDIATION=off`.
3. Grant the App **Actions: Read & write** and reinstall; then enable `TWIKI_CI_REMEDIATION=on` in `enforce`.
4. Rollback is instant and granular: `TWIKI_CI_REMEDIATION=off` disables the writes while keeping diagnostics; full rollback is `shadow`.

## Open Questions

- **Resolved — `main` re-run scope:** in scope, same `run_attempt` bound and same `TWIKI_CI_REMEDIATION` toggle (D8).
- **Resolved — attempt-cap default:** `TWIKI_MAX_CI_ATTEMPTS = 2` (initial run plus one re-run) as the conservative default; configurable upward.
- Should `update-branch` be offered as a fallback for the (currently out-of-scope) non-Dependabot PRs that lack a `@dependabot rebase` path? Deferred — out of scope for this change.
