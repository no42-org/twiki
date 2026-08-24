# AGENTS.md

## Commands

Everything goes through `make`; CI runs the same targets.

```sh
make verify                 # lint + typecheck + test — the gate
make test                   # vitest
npx vitest run test/semver.test.ts -t "nextPatchTag"   # one test
make image                  # local single-arch build, tags twiki:dev
make up / down / logs / ps  # compose; `up` runs the image preflight first
```

Releases: bump `package.json`, commit, tag `vX.Y.Z`, push. See `RELEASING.md`.

## Architecture

Two roles from one image, sharing one SQLite file in WAL mode.

- **twiki** (`src/twiki/`) is the write side. It gathers facts per repo, asks an LLM advisor for a merge/release plan, and executes it. `shadow` reports what it would do; `enforce` acts. The advisor returns a plan through one tool and has no GitHub-mutating tool of its own.
- **gitricorder** (`src/tricorder/`) is the read side: collection lanes sweep alerts, CI failures, issues, update PRs and review requests into a store, and a web process serves them as one ranked queue. It authenticates as a **separate, read-only App** — that separation is the point, so do not merge the credentials.
- `src/core/` is pure and shared. `src/github/` is the port and its Octokit adapter. A lint rule enforces the module boundary; if it fails, the fix is the layering, not the rule.

Configuration is `repos.yaml` (allowlist and policy, strict-parsed) plus env. The allowlist is the entire universe — nothing is discovered.

## Gotchas

- **Node lives at `/nodejs/bin/node`**, not `/usr/bin/node`. The image is distroless: no shell, so `docker exec … sh` fails and only node can run. Guessing this once broke the healthcheck, and compose reported it as a *dependency* failure.
- **A green suite says nothing about whether a test can fail.** Three tests here were structurally unable to fail — a failure injected on the last item so the assertion held either way, a constant asserted against the constant it came from, and contract assertions that never bound. All three were found by mutation testing, not review.
- **Assert on the whole returned structure, not one field of it.** The `:latest` guard was tested and correct; the two sibling tags written beside it were unguarded and wrong for three months, because the test only ever looked at `:latest` (#66).
- **Do not write a comment claiming more than you checked.** The `/usr/bin/node` guess and a "the digest and the audit both see it" that was false each cost real time. If it is not verified, say so in the comment.
- **Wrap every read of something the environment supplies**, naming what was being read and why. A file the OS hands back, a config a human wrote, an env var. The errors in this codebase that name their cause are all inside abstractions the code owns; the ones that dump a raw `ZodError` or `EISDIR` are all at that boundary (#70, #73). `src/github/auth.ts` has careful sentences for a missing App ID and a missing key variable, and nothing for the `readFileSync` between them — which is the failure that actually happens.
- **Commit before running the mutation battery.** It uses `git checkout`, which will discard uncommitted work.
- **Timing:** a tick took 18.7s for three repositories. Do not use that for capacity planning — the earlier ~42s estimate came from benchmarking a repo that is not in the allowlist. Re-measure if the estate grows.
- **`openspec/` is gitignored.** Anything recorded only there is invisible to git and to everyone else. Durable decisions belong in an issue, a design doc, or the specs.

## Conventions

Conventional Commits. Every commit needs `git commit -s` plus an `Assisted-by: <Agent>:<model>` trailer before the sign-off. Work starts from an issue; PRs close it with a keyword.

Pin GitHub Actions to a commit SHA with the full version in a trailing comment. CI calls `make`, never the underlying tool.
