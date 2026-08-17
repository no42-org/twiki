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

## gitricorder (the dashboard)

A second product in this repository, sharing `core/` and `github/` but nothing
else: twiki notifies and merges, gitricorder collects and shows. It is a
separate entrypoint (`dist/tricorder.js`) with two roles from one image.

```sh
tricorder collect   # writes: migrates the schema, then collects (see below)
tricorder web       # reads: serves the dashboard, read-only, never migrates
tricorder doctor    # checks the App setup; reads GitHub, writes nothing
```

### The read-only GitHub App

gitricorder uses **its own App**, separate from twiki's. This is the point, not
an inconvenience: twiki's App can merge, tag and re-run, and the dashboard must
hold no such capability. Sharing one credential would hand the read side the
ability to write.

Create a new GitHub App and grant **read-only** on exactly these, nothing more:

| Permission (UI) | API name | Why |
| --- | --- | --- |
| Metadata | `metadata` | mandatory for any App |
| Dependabot alerts | `vulnerability_alerts` | the security lane, and the only endpoint carrying EPSS |
| Code scanning alerts | `security_events` | security sweep |
| Secret scanning alerts | `secret_scanning_alerts` | security sweep |
| Actions | `actions` | workflow run status |
| Pull requests | `pull_requests` | dependency-update PRs and the review queue |
| Issues | `issues` | untriaged issues |

Grant no write permission at all, and subscribe to no webhook events: nothing
in gitricorder listens.

Install it on every account holding a watched repository, then point these at
it and run `tricorder doctor`:

| Variable | Meaning |
| --- | --- |
| `TRICORDER_GITHUB_APP_ID` | App ID |
| `TRICORDER_GITHUB_APP_PRIVATE_KEY` | private key (PEM, inline) |
| `TRICORDER_GITHUB_APP_PRIVATE_KEY_PATH` | or a path to it |

`doctor` exits non-zero and says why if the App holds any write permission, if
it is **missing** any read above, if a watched repository is not visible to its
installation, or if a watched repository has no installation at all.

The missing-read check matters as much as the write check: an App scoped to
metadata alone holds no write permission, passes every other test, and then
collects nothing forever. The API names are listed because a permission GitHub
renames should read as a name mismatch rather than as "you did not grant
something you did grant", so `doctor` prints what GitHub actually reported
alongside what it expected.

`collect` migrates the schema, then runs each lane on its own cadence: Dependabot
alerts every 15 minutes, coverage daily, and the CISA KEV catalogue daily.
KEV is the one non-GitHub request the system makes, and without it the ranking chain's first term can never evaluate.
Due-ness is read from the store rather than from memory, so a restart neither re-sweeps everything nor waits a full cadence before doing anything.
Set `TRICORDER_ONCE` to run a single cycle and exit, for cron.

| Variable | Meaning | Default |
| --- | --- | --- |
| `TRICORDER_DB` | SQLite database path. Relative paths land in the working directory, which in a container dies with it. | `tricorder.db` |
| `TRICORDER_HOST` | Bind address for `web`. | `127.0.0.1` |
| `TRICORDER_PORT` | Port for `web`. Decimal, 1-65535; `0` is rejected. | `8787` |
| `TWIKI_CONFIG` | Watched repositories. gitricorder shares twiki's `repos.yaml`: it is the entire universe for both. | `repos.yaml` |
| `TRICORDER_RETENTION_DAYS` | Days of observation history to keep. Unset keeps everything. | unset |
| `TRICORDER_RUN_RETENTION_DAYS` | Days of collection-run history to keep. Unset keeps everything. | unset |
| `TRICORDER_ONCE` | Run one collection cycle and exit, instead of looping. | unset (loops) |
| `TRICORDER_TICK_SECONDS` | How often `collect` wakes to look for due lanes. | `60` |
| `TRICORDER_VERBOSE` | Print Octokit's own request logging. Off by default because the coverage lane expects a 403 per repository with Dependabot switched off, and those would otherwise look like errors on a healthy run. | unset |

Both retention windows are off by default and a malformed value refuses to start rather than falling back to a default, because silently ignoring a typo in the one setting that deletes data is not a recoverable mistake.

Keeping observation history is cheap: the log appends only when a value actually **changes**, so a quiet estate adds very little. Run history is the asymmetric case, since `collection_run` gains a row per lane per installation per cycle whether or not anything happened. Nothing reads it beyond the latest run per key, and that row is never trimmed, so a lane that stopped months ago still appears on the collection-health view.

The default bind is loopback, and there is no code path that defaults to
`0.0.0.0`. There is **no authentication in front of the dashboard**, so binding
it anywhere else exposes every collected alert to anything that can reach the
port. Doing so logs a warning; put your own authenticated proxy in front.

The `web` process opens the database read-only and refuses to start if the
schema is a version it was not built against, rather than serving misread rows.
Upgrading means restarting both roles, not just the collector.

### Sharing the database between the two roles

Both roles open one SQLite file in WAL mode.
Measured across two containers on one host bind mount: no corruption, no lock contention, and snapshot isolation holds.

Three constraints follow from how WAL works, and each is easy to get wrong:

- **Do not mount the data volume read-only, not even for `web`.**
  WAL keeps its shared memory in a `-shm` file beside the database, so SQLite must be able to write the *directory* even when the connection is `readOnly`.
  A `:ro` mount fails with `SQLITE_CANTOPEN`.
  The read-only guarantee comes from the handle, which SQLite enforces, not from the filesystem.
- **Never copy the database file while the collector is running.**
  A copy taken mid-write carries an uncheckpointed WAL, and on its own that file cannot be opened by a read-only handle at all: `web` fails with `SQLITE_CANTOPEN` until some write open repairs it.
  Restoring `<db>` and `<db>-wal` without `-shm` fails the same way.
  A cleanly stopped collector checkpoints on close, and the single file it leaves behind restores fine on its own.
  Stop the collector or use `VACUUM INTO` before taking a backup.
- **Start the collector before the web process on a cold start.**
  Any write open repairs a database left in the state above, and the collector's startup migration is that write open.

An ordinary crash needs no special handling.
A collector killed mid-transaction leaves `-wal` and `-shm` on disk, and with those present `web` opens the database and reads it without the collector running at all.

The database must be on a **local** filesystem.
WAL requires processes to share memory through that `-shm` file and mmap, which NFS and SMB do not provide reliably.
This was not tested here, and a network volume should be treated as unsupported.

## Layout

```
src/
  index.ts         entrypoint: env, config load, dependency wiring (twiki)
  tricorder.ts     entrypoint: role dispatch, store open, server (gitricorder)
  core/            shared domain, a closed leaf (see "Module boundaries" below)
    config.ts      allowlist + per-repo policy (strict YAML schema)
    semver.ts      bump classification + next-patch tag (pure)
    types.ts       domain types
  github/          read/write ports, App auth, Octokit adapter
    port.ts        GitHubReadPort, GitHubWritePort, GitHubPort
    auth.ts        GitHub App auth + installation token cache
    octokit-adapter.ts   the one adapter, implements both halves
  twiki/           the write side: everything that decides or mutates
    gates.ts       deterministic safety gates + "settled" predicate (pure)
    plan.ts        the advisor's typed output contract (zod + JSON schema)
    advisor.ts     LLM advisor, one output tool, no write tools
    facts.ts       stateless per-tick fact gathering
    executor.ts    the ONLY component that mutates GitHub; re-validates gates
    report.ts      per-run chat digest
    notify.ts      Slack/Discord/Matrix delivery + de-dup
    audit.ts       append-only JSONL audit log
    result.ts      per-run result types
    run.ts         orchestrate one tick
    scheduler.ts   single tick, or a tick every interval
  tricorder/       the read side: collect into a store, serve a page
    store/         append-only observations + materialised projection (node:sqlite)
    collect/       one lane per source; dependabot-alerts.ts is the first
    web/           freshness policy, view model, JSX components, routes, server
test/              pure-logic suites + ports + injection + shadow e2e (fakes, no network)
scripts/           release-plan (CI release glue), matrix-smoke
```

### Module boundaries

`src/core/` holds domain logic that more than one entrypoint may need: domain
types, pure functions and the config schema. It is a closed leaf: files in
`src/core/` may import `node:` builtins, third-party packages, and other files
inside `src/core/`. Nothing else.

The rule exists because a second read-only entrypoint is being added alongside
the write path. Anything both sides need moves down into `core/`; neither side
imports the other. If you are unsure where a new module belongs, ask whether
both entrypoints would need it. If only one would, it does not go in `core/`.

`src/twiki/` is the write side. `src/github/` splits its port in two:
`GitHubReadPort` has no mutating method, `GitHubWritePort` has only mutating
methods, and `GitHubPort` extends both for the one adapter that implements
them. A consumer given only the read port cannot merge, tag or re-run
anything, because the type has no such member. `test/ports.test.ts` pins that
with `@ts-expect-error`, so a write method leaking onto the read port fails
typecheck rather than review.
