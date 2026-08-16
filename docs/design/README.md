# Design decisions

Design rationale for the three changes that shaped twiki. Source code and CI
comments cite these decisions by number.

| Document | Covers |
| --- | --- |
| [dependabot-release-agent.md](dependabot-release-agent.md) | The agent itself: advisor/executor split, gates, statelessness, release-by-tag, App auth |
| [ci-release-pipeline.md](ci-release-pipeline.md) | Release workflow, versioning, image publishing, supply-chain hardening |
| [ci-remediation.md](ci-remediation.md) | Bounded CI re-runs and rebase handling |

## Citing a decision

**Each document numbers its decisions independently from D1.** `D7` means three
different things depending on which document you are in. Always qualify the
reference with the document, for example `design agent-D7` or
`design release-D4`, never a bare `D7`.

| Prefix | Document |
| --- | --- |
| `agent-D*` | dependabot-release-agent.md |
| `release-D*` | ci-release-pipeline.md |
| `remediation-D*` | ci-remediation.md |

These documents were previously kept under `openspec/`, which is an AI tool
working directory and is not tracked. They live here because tracked source and
CI comments point at them.
