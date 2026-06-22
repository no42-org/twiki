# twiki

Autonomous Dependabot/Security PR manager for a set of GitHub repositories.
It merges green dependency PRs that are within policy, batch-cuts a single
patch release once the queue settles, and reports to chat — **safe by
construction**.

## Safety model (read this first)

twiki is an autonomous actor with merge and release authority across many
repos, and its LLM reads *untrusted third-party changelog text*. The
architecture makes that safe structurally, not by instruction:

```
   facts ──▶ LLM advisor (NO write tools) ──▶ typed JSON plan ──▶ executor
                                                                 re-checks every gate
                                                                 shadow: log │ enforce: act
```

- **The LLM never touches GitHub.** It only emits a plan (`merge`/`hold` per PR,
  `release`/`wait` per repo). Only the deterministic executor calls the API.
- **Gates are code, re-validated at execution time** — never merge if CI isn't
  green, never auto-merge a major, never release if `main` is red, only act on
  allowlisted repos. The plan can only *narrow* outcomes.
- **Prompt-injection is contained.** A poisoned changelog can at worst push the
  advisor toward `hold` (more conservative); it can never manufacture a merge or
  release. (See `test/injection.test.ts`.)

## How it decides

- **Auto-merge:** patch + minor bumps when green (minor configurable per repo).
  Majors are never auto-merged — they're flagged for a human; security majors
  are flagged urgently.
- **Batch release ("settled"):** cut one patch release for a repo only when
  *(a)* no open Dependabot PR remains that policy would merge, *(b)* `main` is
  green, and *(c)* there are merged-but-unreleased dependency commits. A stuck
  red PR doesn't block — it's reported.
- **Release mechanism:** the executor pushes the next `vX.Y.Z+1` tag; each
  repo's own tag-triggered workflow builds/publishes. Repos without one are
  reported as merge-only.
- **Stateless:** every tick re-derives truth from GitHub, so skipped or repeated
  runs self-heal.

## Configure

Copy `repos.example.yaml` to `repos.yaml` and list your repos (see that file for
per-repo `autoMergeMinor` / `mergeOnly` overrides).

### Environment

| Variable | Purpose | Default |
|----------|---------|---------|
| `TWIKI_CONFIG` | Path to the config file | `repos.yaml` |
| `TWIKI_MODE` | `shadow` or `enforce` (overrides config) | from config |
| `TWIKI_ONCE` | Run a single tick and exit (for external cron) | unset (polls) |
| `TWIKI_POLL_MINUTES` | Poll interval when not `ONCE` | `60` |
| `TWIKI_CI_REMEDIATION` | CI remediation (`on`/`off`); `off` keeps diagnostics, no writes | `on` |
| `TWIKI_MAX_CI_ATTEMPTS` | Max workflow attempts before twiki stops re-running (1-based; `2` = one re-run) | `2` |
| `TWIKI_GITHUB_APP_ID` | GitHub App ID | — (required) |
| `TWIKI_GITHUB_APP_PRIVATE_KEY` | App private key (PEM, inline) | — |
| `TWIKI_GITHUB_APP_PRIVATE_KEY_PATH` | App private key file path | — |
| `ANTHROPIC_API_KEY` | Advisor LLM key (read by the SDK) | — (required) |
| `TWIKI_MODEL` | Advisor model | `claude-sonnet-4-6` |
| `TWIKI_SLACK_WEBHOOK_URL` | Slack incoming webhook | — |
| `TWIKI_DISCORD_WEBHOOK_URL` | Discord webhook | — |
| `TWIKI_MATRIX_HOMESERVER` | Matrix homeserver base URL (Client-Server API) | — |
| `TWIKI_MATRIX_TOKEN` | Matrix access token | — |
| `TWIKI_MATRIX_ROOM` | Matrix room ID, e.g. `!abc:example.org` | — |
| `TWIKI_AUDIT_PATH` | Append-only JSONL audit log | `audit.jsonl` |

The chat target is chosen by precedence: **Slack** (if its webhook URL is set),
then **Discord**, then **Matrix** (when all three `TWIKI_MATRIX_*` vars are
set), otherwise the digest is printed to **stdout**.

## GitHub App setup

twiki authenticates as a GitHub App so merges/tags show as `twiki[bot]`,
tokens are short-lived, and the blast radius is scoped per install.

1. Create a GitHub App (org → Settings → Developer settings → GitHub Apps).
2. Grant these **repository permissions**:
   - **Contents:** Read & write (push tags, read workflow files, compare commits)
   - **Pull requests:** Read & write (merge, post `@dependabot rebase`)
   - **Actions:** Read & write (re-run failed CI jobs — CI remediation)
   - **Checks:** Read-only
   - **Commit statuses:** Read-only
   - **Metadata:** Read-only
3. No webhook is needed (twiki polls).
4. Generate a private key; store it as a secret and point
   `TWIKI_GITHUB_APP_PRIVATE_KEY[_PATH]` at it. Set `TWIKI_GITHUB_APP_ID`.
5. Install the App on exactly the repos in your allowlist.

## Run

```sh
make install     # install dependencies
make verify      # typecheck + tests (CI gate)
make run         # build and start (polls)
TWIKI_ONCE=1 make run   # single tick (e.g. external cron)
```

New here? The [Quick Start](docs/quickstart.md) walks through a shadow-mode run
with copy-paste examples for **Slack**, **Discord**, and **Matrix**.

## Rollout

1. Deploy in **shadow** mode (`mode: shadow`). twiki posts what it *would*
   merge/release and writes nothing.
2. Watch the digests across several daily cycles; confirm they match your
   judgment.
3. Flip to **enforce** (`mode: enforce` or `TWIKI_MODE=enforce`).
   Rollback is instant: flip back to `shadow`.

## Layout

```
src/
  config.ts      allowlist + per-repo policy (strict YAML schema)
  types.ts       domain types
  semver.ts      bump classification + next-patch tag (pure)
  gates.ts       deterministic safety gates + "settled" predicate (pure)
  plan.ts        the advisor's typed output contract (zod + JSON schema)
  advisor.ts     LLM advisor — one output tool, no write tools
  facts.ts       stateless per-tick fact gathering
  executor.ts    the ONLY component that mutates GitHub; re-validates gates
  report.ts      per-run chat digest
  notify.ts      Slack/Discord webhook delivery + de-dup
  audit.ts       append-only JSONL audit log
  run.ts         orchestrate one tick
  index.ts       entrypoint + scheduler
  github/        port interface, App auth, Octokit adapter
test/            pure-logic suites + injection + shadow e2e (fakes, no network)
```
