## Context

`twiki` is a greenfield service. It manages an allowlisted set of GitHub repositories: merging green Dependabot/Security PRs within policy, cutting a single patch release once the dependency queue settles, and reporting to chat. The defining constraint is **trust**: the service is an autonomous actor with merge and release authority across many repos, and the LLM at its core reads *untrusted third-party text* (changelogs embedded in Dependabot PR bodies). The architecture must make that bold setup safe by construction, not by instruction.

Locked product decisions (from exploration): standalone TypeScript Agent SDK service; GitHub App auth; hourly scheduled poll; auto-merge patch+minor only; batch/debounce release via pushed patch tag; Slack/Discord digest; shadow-mode-first rollout.

## Goals / Non-Goals

**Goals:**
- Autonomously merge green Dependabot/Security PRs that are within policy (patch + minor).
- Cut exactly one patch release per repo when the dependency queue has settled and `main` is green.
- Make the LLM *structurally* incapable of merging or releasing — it advises, code acts.
- Contain prompt injection so a hijacked LLM can only be too conservative, never too permissive.
- Be stateless where possible: re-derive truth from GitHub each tick so a skipped or repeated run stays correct.
- Ship dry-run first; flip to enforcing via one flag.

**Non-Goals:**
- Opening PRs for Dependabot alerts that lack them (Dependabot does this when configured).
- Webhook-driven triggering (poll only in v1; webhooks are a later latency optimization).
- Minor or major *release* bumps (patch releases only).
- Auto-merging majors (always human-gated).
- Owning each repo's publish pipeline (the agent pushes a tag; the repo's existing workflow builds/publishes).

## Decisions

### D1 — The LLM is a structured advisor, not an actor
The LLM receives gathered facts and emits a **typed JSON plan**: per-PR `{ action: merge | hold, reason, riskAssessment }` and per-repo `{ action: release | wait, version?, notes? }`. It is given **no write tools**. Only the deterministic executor calls the GitHub API.

- *Why:* It cleanly separates judgment (taste, risk-reading, prose) from authority (merging, tagging). The LLM cannot be talked — or injected — into an unsafe action because it has no path to one.
- *Alternatives considered:* Give the LLM `mergePR`/`pushTag` tools guarded by a system prompt. Rejected — relies on the LLM *remembering* rules and resisting injection; the safety boundary becomes probabilistic instead of structural.
- *Implementation note:* The advisor is realized with the Anthropic SDK using a single forced output-tool that emits the typed plan, and **no other tools**. This satisfies "no write tools" by construction (the only tool returns JSON) and is more stable/verifiable than wiring the agentic Agent SDK loop for what is a single structured-output call. It sits behind an `Advisor` interface so the implementation can be swapped later.

### D2 — Deterministic gates re-validated at execution time
The executor re-checks **every** gate immediately before acting, regardless of what the plan says: CI is green; bump is ≤ minor; `main` is green (for release); repo is on the allowlist. A plan entry failing any gate is dropped and reported.

- *Why:* Facts can change between fact-gathering and execution; and the plan is advisory. Re-validation means the LLM's plan can only ever *narrow* what happens — the gates are the floor.
- *Alternatives considered:* Trust the plan (the LLM already saw the facts). Rejected — TOCTOU risk and removes the structural guarantee.

### D3 — Prompt-injection containment via the D1+D2 boundary
Dependabot PR bodies embed release notes authored by third parties. The LLM reads them to assess risk. Because of D1 (no write tools) and D2 (re-validated gates), the worst a poisoned changelog can do is push the LLM toward `hold` — a *more conservative* outcome. It cannot manufacture a merge or release.

- *Why:* This is the explicit reason judgment and safety are separate layers; injected text is confined to the advisory channel.
- *Mitigation detail:* Untrusted changelog text is passed to the LLM clearly demarcated as data, never as instructions; the executor ignores any "action" the LLM asserts that the gates don't permit.

### D4 — Stateless per-tick derivation from GitHub
Each poll re-derives everything from GitHub's current state: open Dependabot PRs and their check status, `main` CI status, and commits since the latest release tag. There is no authoritative local database of "what I've done."

- *Why:* Idempotency and resilience — a skipped, repeated, or crashed run self-heals on the next tick because truth lives in GitHub. It also makes the "settled" condition a pure function of observable state.
- *Trade-off:* Slightly more API calls per tick (mitigated by GraphQL batching and the App's higher rate limits). A small local store is kept only for non-authoritative concerns: an audit log and Slack-message de-duplication.

### D5 — "Settled" is a pure predicate
Release a patch for a repo iff: **(a)** no open Dependabot PR remains that the policy *would* merge, **AND (b)** `main` CI is green, **AND (c)** there exist merged-but-unreleased dependency commits (commits between latest tag and `main` HEAD attributable to Dependabot).

- *Why:* Batches the bumps into one release instead of releasing per-merge (avoids release spam). A stuck *red* Dependabot PR does not block release forever — it is not something we'd merge, so it doesn't count against (a); it is simply reported.
- *Alternatives considered:* A quiet-timer ("no merges for N hours"). Rejected — requires wall-clock state and is less predictable than a state predicate.

### D6 — Release by pushing a computed `vX.Y.Z+1` tag
The executor computes the next patch version from the latest tag and pushes the tag. Each managed repo's existing tag-triggered workflow performs the build/publish. The agent decides *when*; the repo owns *how*.

- *Why:* Avoids reinventing per-language release tooling; fits the convention that CI owns the publish steps. Repos without a tag-triggered workflow are merge-only until they add one.
- *Alternatives considered:* `workflow_dispatch` / `make release-patch`. Reasonable, but the tag is the most uniform, lowest-coupling trigger.

### D7 — GitHub App authentication
The service authenticates as a GitHub App (`twiki[bot]`), per-repo install, minting short-lived installation tokens.

- *Why:* Honest provenance in the audit log (merges show as the bot, not a human), scoped blast radius per install, short-lived rotated tokens, and App-tier rate limits.
- *Alternatives considered:* Fine-grained PAT. Rejected — coarse, long-lived, and attributes every action to a human, destroying the audit trail.

### D8 — Shadow-mode-first, single flag
A `mode: shadow | enforce` flag gates the executor's *write* step only. In shadow, the executor runs the full pipeline — fact-gathering, plan, gate re-validation — and **logs/reports** the actions it would take without calling any mutating API.

- *Why:* The plan→gate→execute path is identical in both modes, so shadow is a faithful preview, not a separate code path. Lets trust build before any write authority is exercised.

## Risks / Trade-offs

- **A gate is wrong / too permissive** → Shadow-mode-first (D8) surfaces bad decisions before they act; gates are re-validated (D2) and unit-tested as pure functions independent of the LLM.
- **Green CI is insufficient (a minor bump passes tests but breaks behavior CI misses)** → LLM risk assessment can `hold` a permitted bump (judgment narrows, never widens); majors are always human-gated; shadow run lets a human eyeball early merges.
- **Prompt injection via changelog** → Contained structurally by D1+D3; cannot escalate to an action.
- **Released a broken artifact** → Release is gated on `main` green and only fires when settled (D5); patch-only scope limits blast radius; each repo's own release workflow remains the final guard.
- **Statelessness costs API calls / hits rate limits** → GraphQL batching + App-tier limits (D7); poll interval is generous (~hourly) because dependency bumps are not latency-sensitive.
- **Repo lacks a tag-triggered release workflow** → Detected; that repo is merge-only and the gap is reported, never silently skipped.
- **Tag computation races a concurrent human release** → Executor reads the latest tag at execution time (D4) and re-checks just before pushing; a push conflict aborts that repo's release and reports it.

## Migration Plan

1. Register the GitHub App, store its private key as a secret, install on the allowlisted repos.
2. Deploy the service in `shadow` mode with `repos.yaml` populated.
3. Observe Slack/Discord digests across several daily cycles; confirm the would-do plan matches human judgment.
4. Flip `mode: enforce`. Rollback = flip back to `shadow` (no writes) — instant and total.

## Open Questions

- Where is the service hosted (container platform / scheduler), and how are secrets injected there?
- Slack vs Discord (or both) for the digest, and one channel vs per-repo routing?
- Per-repo policy overrides in `repos.yaml` — which knobs are worth exposing in v1 (e.g., disable minor auto-merge, mark a repo merge-only)?
- Audit-log store: structured logs only, or a small SQLite/file store for queryable history?
