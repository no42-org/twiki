## Why

Keeping dependencies current across a set of GitHub repositories is repetitive, easy to neglect, and risky to fully automate with blind rules — yet doing it by hand is slow and inconsistent. We want an autonomous agent that merges green Dependabot/Security PRs, cuts a single patch release once the dependency queue settles, and reports what happened — **without** ever becoming a footgun that can merge a breaking change or release a broken `main`.

## What Changes

- Introduce **twiki**, a standalone TypeScript service (Claude Agent SDK) that manages an allowlisted set of GitHub repositories on a scheduled (~hourly) poll, re-deriving all state from GitHub each tick (stateless by design).
- Discover and classify Dependabot and Security PRs by semver impact (patch / minor / major) per repo.
- **Auto-merge** patch and minor bumps when CI is green; **never** auto-merge majors — flag them for a human, with security majors flagged urgently.
- **Batch-release**: cut exactly one patch release per repo only when *settled* — no open Dependabot PR we'd still merge, `main` CI green, and merged-but-unreleased dependency commits exist. Release is performed by pushing a computed `vX.Y.Z+1` tag; each repo's existing tag-triggered workflow does the build/publish.
- Authenticate as a **GitHub App** (`twiki[bot]` identity, per-repo install, short-lived tokens).
- Send a **Slack/Discord digest** per run summarizing merges, holds, releases, and anything that snagged red.
- Ship **shadow/dry-run mode first**: the service reports what it *would* do and performs no writes; an explicit flag flips it to enforcing.
- **Safety architecture (core, not optional):** the LLM is a *structured advisor* that emits a typed JSON plan; only deterministic executor code calls the GitHub API, re-validating every gate before acting. This structurally contains prompt-injection from untrusted third-party changelog text embedded in Dependabot PR bodies — a hijacked LLM can at worst be too conservative, never too permissive.

## Capabilities

### New Capabilities
- `repo-orchestration`: configured allowlist (`repos.yaml` + per-repo policy), scheduled poll loop, and stateless per-tick derivation of truth from GitHub (open PRs, `main` status, commits since latest tag).
- `pr-evaluation`: discovery and semver classification of Dependabot/Security PRs, and the LLM judgment layer that emits a typed per-PR/per-repo decision plan with reasons and risk assessment.
- `safe-execution`: deterministic gate engine and executor that re-validates every gate (CI green, ≤ minor, `main` green, on-allowlist) and either acts or logs depending on shadow/enforce mode; the LLM never touches the GitHub API directly.
- `batch-release`: detection of the *settled* condition per repo and cutting of a single patch release by pushing a computed `vX.Y.Z+1` tag.
- `reporting`: per-run Slack/Discord digest of merges, holds (with reasons), releases, and red/blocked items.

### Modified Capabilities
<!-- None — greenfield project, no existing specs. -->

## Impact

- **New service** `twiki` (TypeScript, Claude Agent SDK) — new codebase, no existing code affected.
- **External dependencies**: Claude Agent SDK, GitHub App (registration + private key secret), GitHub REST/GraphQL API, Slack/Discord webhook, an LLM API key.
- **Per-managed-repo expectation**: each repo must have a tag-triggered release workflow (the agent pushes the tag; the repo owns the publish). Repos lacking one are merge-only until they add it.
- **Configuration**: `repos.yaml` (allowlist + per-repo policy), a shadow/enforce flag, and secrets (GitHub App key, LLM key, chat webhook).
- **Out of scope (v1)**: opening PRs for Dependabot alerts that lack them, webhook-driven triggering (poll only), and non-patch (minor/major) release bumps.
