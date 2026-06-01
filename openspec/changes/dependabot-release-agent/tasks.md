## 1. Project scaffold

- [x] 1.1 Initialize TypeScript service project (package.json, tsconfig, lint/format, Makefile targets for build/test/run)
- [x] 1.2 Add the Claude Agent SDK, GitHub API client, and a chat (Slack/Discord) webhook client as dependencies
- [x] 1.3 Define config loading for `repos.yaml` (allowlist + per-repo policy) and a `mode: shadow | enforce` flag
- [x] 1.4 Add typed config schema with validation that rejects unknown repos and malformed policy overrides

## 2. GitHub App authentication

- [x] 2.1 Implement GitHub App auth: load private key, mint short-lived per-install tokens
- [x] 2.2 Implement a GitHub client wrapper that scopes calls to allowlisted repos only
- [x] 2.3 Document App registration + installation steps and required permissions in the repo README

## 3. Fact gathering (stateless derivation)

- [x] 3.1 Implement discovery of open Dependabot PRs, flagging security updates (pr-evaluation)
- [x] 3.2 Implement check-status retrieval per PR (green/red/pending)
- [x] 3.3 Implement `main` CI status retrieval per repo
- [x] 3.4 Implement latest-tag lookup and "commits since tag attributable to Dependabot" derivation
- [x] 3.5 Batch the above via GraphQL where possible to limit API calls per tick

## 4. Semver classification

- [x] 4.1 Implement patch/minor/major classification from the Dependabot PR
- [x] 4.2 Treat indeterminate bumps as major (conservative) per spec

## 5. LLM advisor (structured plan)

- [x] 5.1 Define the typed plan schema: per-PR {action: merge|hold, reason, riskAssessment}, per-repo {action: release|wait, version?, notes?}
- [x] 5.2 Build the Agent SDK session with NO write tools; pass facts in, get a schema-validated plan out
- [x] 5.3 Pass untrusted changelog text demarcated strictly as data, never as instructions
- [x] 5.4 Validate/parse the plan; reject and re-prompt on schema mismatch

## 6. Deterministic gate engine

- [x] 6.1 Implement gates as pure functions: CI-green, bump ≤ minor, main-green, on-allowlist
- [x] 6.2 Unit-test each gate independently of the LLM (including state-changed-after-plan cases)
- [x] 6.3 Implement the "settled" predicate as a pure function (batch-release D5)

## 7. Executor

- [x] 7.1 Implement plan → gate re-validation → action pipeline; drop and record any plan entry failing a gate
- [x] 7.2 Implement merge action for PRs passing all gates (enforce mode)
- [x] 7.3 Implement next-patch-version computation and tag push (enforce mode), re-checking latest tag just before push
- [x] 7.4 Implement major-bump flagging for human review, marking security majors urgent
- [x] 7.5 Detect repos lacking a tag-triggered release workflow and mark them merge-only
- [x] 7.6 Wire the `mode` flag so shadow runs the full pipeline but performs no writes

## 8. Reporting

- [x] 8.1 Implement the per-run digest: merged, held (with reasons), released (with versions), majors flagged, red/blocked, broken main
- [x] 8.2 Mark shadow-mode actions as would-do in the digest
- [x] 8.3 Implement Slack/Discord delivery and minimal de-duplication

## 9. Orchestration loop

- [x] 9.1 Implement the scheduled poll (~hourly) that runs the full pipeline across all allowlisted repos
- [x] 9.2 Ensure a skipped/failed run self-heals on the next tick (no reliance on local action state)
- [x] 9.3 Add a minimal audit log of decisions and actions (non-authoritative)

## 10. Verification & rollout

- [x] 10.1 Add unit tests covering gate behavior, settled predicate, and semver classification edge cases
- [x] 10.2 Add an injection test: a poisoned changelog cannot produce any action the gates don't permit
- [x] 10.3 Add an end-to-end test in shadow mode against fixture GitHub state
- [ ] 10.4 Deploy in shadow mode, observe digests across several cycles, then flip to enforce (rollback = flip to shadow)
