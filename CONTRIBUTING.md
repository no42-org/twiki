# Contributing

Thanks for looking. This is a small, single-maintainer project, so the process is short — but two things about commits are non-negotiable, and both are enforced.

## Every commit needs a sign-off

```sh
git commit -s -m "fix(collect): ..."
```

`-s` appends a `Signed-off-by:` line with your git identity. That certifies the [Developer Certificate of Origin](https://developercertificate.org/): you wrote the change, or you have the right to submit it under this project's MIT licence.

It must be a **human** identity. Never an agent, a bot, or a tool name. The signer is the person taking responsibility.

## AI-assisted commits say so

Much of this repository was written with an AI assistant, and the commits say which one. If you used one, add an `Assisted-by:` trailer **before** the sign-off:

```
fix(collect): stop the alert lane hammering a rate-limited installation

Assisted-by: ClaudeCode:claude-opus-5
Signed-off-by: Ada Lovelace <ada@example.com>
```

Format is `AGENT_NAME:MODEL_VERSION`, optionally followed by tools used. Order matters: `Assisted-by:` first, `Signed-off-by:` last, no blank line between them, or `git interpret-trailers` reads only the last block.

**Assistance does not move responsibility.** The `Signed-off-by:` human is accountable for reviewing the change, understanding it, and for its licence compliance — the same as if they had typed it. A trailer is a disclosure, not a disclaimer.

## Getting a change in

1. **Start from an issue.** Open one first, or comment on an existing one, so the problem is agreed before the solution is written. Bug reports are more useful than patches for problems nobody has confirmed yet.
2. **Branch, and make the change.**
3. **`make verify` must pass** — lint, typecheck and the full test suite. CI runs the same target, so a green local run means a green PR.
4. **Open a PR** with `Closes #<issue>` in the body. `main` is protected: a PR and four green checks are required.

Everything runs through `make`, never the underlying tool directly, so local and CI cannot drift. `make test` for the suite; `npx vitest run test/<file> -t "<name>"` for one test.

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/): `<type>(scope): description`, where type is one of `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `chore`, `ci`, `build`, `revert`. Breaking changes take a `!` or a `BREAKING CHANGE:` footer — release notes are generated from these, so the type is what a reader sees.

## What good looks like here

Read a few existing commits and comments before writing. Two habits this codebase cares about more than most:

**A comment must not claim more than was checked.** A guess written as a statement of fact has cost real time here more than once. If it is unverified, say so in the comment.

**A green test proves nothing until you have seen it fail.** Three tests in this repository turned out to be structurally unable to fail. When you add a test, break the code it covers and confirm it goes red.

`AGENTS.md` has the architecture in brief and the gotchas worth knowing before touching anything.

## Reporting a vulnerability

Not here — see [SECURITY.md](SECURITY.md). Do not open a public issue for a security problem.
