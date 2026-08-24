# Security Policy

## Reporting a vulnerability

**Report privately, not in a public issue.**

Use GitHub's private vulnerability reporting: [open a draft advisory](https://github.com/no42-org/twiki/security/advisories/new). It is enabled on this repository, and it gives us a private thread to work in and a coordinated disclosure path.

If that route is unavailable to you, email <ronny@no42.org>.

Please include what you did, what happened, and what you expected. A reproduction matters more than a severity rating.

This is a single-maintainer project, so expect a first response in days rather than hours. You will get an acknowledgement that a human has read it, and an honest answer about timing.

## Supported versions

The most recent release only. This project is pre-1.0 and there are no maintained older lines, so a fix ships in the next release rather than being backported.

## What twiki can do, and what it cannot

Worth reading before deciding whether something is a vulnerability. `README.md` § *Safety model* has the full picture; the short version:

twiki is an autonomous actor with merge and release authority, and its LLM advisor reads untrusted third-party changelog text. The containment is structural rather than instructional:

- **The advisor holds no write tools.** It returns a typed plan (`merge`/`hold` per PR, `release`/`wait` per repo). Only the deterministic executor calls the GitHub API.
- **Gates are code and re-validated at execution time.** Never merge on red CI, never auto-merge a major, never release when `main` is red, only ever act on allowlisted repositories. A plan can only *narrow* what happens, never widen it.
- **The read side is a separate App, read-only by construction.** gitricorder authenticates as its own GitHub App holding no write permission at all. Sharing one credential between the two sides would hand the dashboard the ability to write, which is the single thing its design rules out.

So a poisoned changelog steering the advisor toward `hold` is expected and safe. A poisoned changelog producing a merge, a release, or any write the gates would refuse is a vulnerability, and we want to hear about it. `test/injection.test.ts` covers the cases we know of.

## Especially interested in

- Anything that lets the advisor's output cause a write the executor's gates should have refused.
- Anything that lets the read-only side write, or reach twiki's credentials.
- Credential exposure: private keys or API keys reaching logs, the digest, the audit trail, or an image layer.
- A path that acts on a repository outside the configured allowlist.

## Out of scope

- Findings against a dependency with no demonstrated impact here. Report those upstream; Dependabot already watches this repository.
- Vulnerabilities requiring an attacker who already controls the host, the container runtime, or the GitHub App's private key.
- The dashboard having no authentication. That is documented and deliberate: it binds to `127.0.0.1` only. Publishing it on another interface is a deployment mistake, and `compose.yml` says so.

## Supply chain

Released images are signed with cosign keyless (GitHub OIDC) and carry an SBOM. `RELEASING.md` has the `cosign verify` command, including the part that is easy to get wrong: verify against the image **index** digest, not a per-architecture child.
