## ADDED Requirements

### Requirement: CI runs the Makefile gate on pull requests and main
On every pull request targeting `main` and every push to `main`, CI SHALL run the quality gate exclusively through Makefile targets (`make verify`, `make lint`), never by invoking the underlying tools directly.

#### Scenario: Pull request runs the full gate
- **WHEN** a pull request targeting `main` is opened or updated
- **THEN** CI SHALL run `make lint` (Biome lint + format check), `make verify` (typecheck + vitest), and report a required status check

#### Scenario: Lint or format violation fails the gate
- **WHEN** Biome reports a lint error or a formatting difference
- **THEN** `make lint` SHALL exit non-zero and the CI status SHALL fail

#### Scenario: A failing test blocks merge
- **WHEN** any vitest test fails on a pull request
- **THEN** the CI status SHALL fail and the branch protection gate SHALL block merge

### Requirement: Static analysis and dependency audit
CI SHALL run CodeQL static analysis for JavaScript/TypeScript and an npm dependency audit on pull requests and pushes to `main`, and CodeQL SHALL additionally run on a weekly schedule.

#### Scenario: CodeQL analyzes changes
- **WHEN** a pull request is opened or code is pushed to `main`
- **THEN** CodeQL SHALL analyze the `javascript-typescript` language and surface findings in the security tab

#### Scenario: Scheduled CodeQL baseline
- **WHEN** the weekly schedule fires
- **THEN** CodeQL SHALL run against `main` independent of any push

#### Scenario: Vulnerable dependency surfaced
- **WHEN** `npm audit` detects a known vulnerability in the dependency tree
- **THEN** CI SHALL report it on the run

### Requirement: Built image is scanned before any publish
CI SHALL build the container image via `make image` and scan it with Trivy. On pull requests the image SHALL NOT be pushed to any registry.

#### Scenario: Pull request builds and scans but does not push
- **WHEN** a pull request triggers CI
- **THEN** the image SHALL be built and Trivy-scanned, and SHALL NOT be pushed to ghcr.io

#### Scenario: Image scan reports vulnerabilities
- **WHEN** Trivy finds vulnerabilities in the built image
- **THEN** the findings SHALL be reported on the CI run

### Requirement: Least-privilege workflow permissions
Each workflow job SHALL declare an explicit least-privilege `permissions` block, defaulting to read-only and elevating only the specific scopes a job needs.

#### Scenario: Gate jobs are read-only
- **WHEN** a job only lints, builds, tests, or scans
- **THEN** its `permissions` SHALL grant no write scopes beyond those required to report results
