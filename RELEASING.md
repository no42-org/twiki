# Releasing

Versioning is [SemVer](https://semver.org/).
A release is triggered by pushing a `vX.Y.Z` tag; nothing else publishes.

## Cutting a release

`package.json` is the version of record.
The pipeline refuses a tag that disagrees with it, so the bump comes first and the tag names what the manifest already says.

```sh
npm version --no-git-tag-version 0.0.6      # or edit package.json
git commit -s -am "chore(release): v0.0.6"
git push                                     # land it on main, via a PR

git tag -a v0.0.6 -m "v0.0.6"
git push origin v0.0.6
```

If the tag and `package.json` disagree the release fails before anything is published, because the image and the tarball would otherwise self-report a version nobody can find.

## What the pipeline produces

Pushing `vX.Y.Z` runs `.github/workflows/release.yml`, which publishes:

| artifact | where |
| --- | --- |
| multi-arch image, `linux/amd64` + `linux/arm64` | `ghcr.io/no42-org/twiki` |
| image tags `:X.Y.Z`, `:X.Y`, `:latest` | GHCR |
| cosign keyless signature over the index digest | GHCR + the Rekor transparency log |
| SBOM (`twiki.sbom.spdx.json`, SPDX 2.3, syft) | GitHub Release asset |
| npm tarball carrying `dist/` | GitHub Release asset |
| GitHub Release with generated notes | Releases page |

A prerelease tag (`v1.2.0-rc.1`, anything containing `-`) gets its exact image tag and nothing else, and is marked `prerelease` on the Releases page.
It never receives `:X.Y` or `:latest`.

Pushes to `main` run `.github/workflows/publish-rc.yml`, which publishes a single `:rc` image that overwrites its predecessor.
`main` produces no version, no tarball, and no GitHub Release.

## Never push a lower stable tag

There is no guard.
`:latest` follows whichever stable tag was pushed most recently, not the highest, so pushing `v0.0.7` after `v0.1.0` exists **will** move `:latest` backward, silently.

This is a deliberate trade while no older release line is maintained; the reasoning is in `docs/design/ci-release-pipeline.md` D3.
When a maintained line does appear, restore a highest-stable comparison and apply it to *every* floating tag published, not only `:latest` — see [#66](https://github.com/no42-org/twiki/issues/66) for why that distinction matters.

## Verifying a published image

Verify against the **index** digest.
`cosign sign` signed the OCI image index that buildx pushed, not the per-architecture children beneath it.
Verifying a child fails with `no signatures found`, which reads like a missing signature rather than the wrong question being asked.

Get the index digest from the top-level `Digest:` line:

```sh
docker buildx imagetools inspect ghcr.io/no42-org/twiki:0.0.6
```

Then verify, pinning the workflow identity that was allowed to sign it:

```sh
cosign verify \
  --certificate-identity-regexp '^https://github\.com/no42-org/twiki/\.github/workflows/release\.yml@refs/tags/v0\.0\.6$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  ghcr.io/no42-org/twiki@sha256:<index-digest>
```

Omitting the identity flags is not verification.
Without them cosign will accept a signature from any workflow in any repository.

Inspect the SBOM from the Release assets:

```sh
gh release download v0.0.6 --pattern 'twiki.sbom.spdx.json'
jq '.packages | length' twiki.sbom.spdx.json
```

### Verifying the release files

The image and the files are signed separately, and verifying one says nothing about the other.
Through v0.0.8 the files shipped unsigned entirely (#97).

Download everything and check the artifacts against the checksums:

```sh
gh release download v0.0.9
sha256sum -c checksums.txt
```

Then verify that the checksums file itself was produced by this repository's release workflow:

```sh
cosign verify-blob \
  --certificate-identity-regexp '^https://github\.com/no42-org/twiki/\.github/workflows/release\.yml@refs/tags/v0\.0\.9$' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate checksums.txt.pem \
  --signature checksums.txt.sig \
  checksums.txt
```

Checking `sha256sum -c` alone proves only that the files match a list an attacker could have replaced along with them.
The signature is what makes the list trustworthy, so both steps are needed.

### Verifying build provenance

Every released artifact carries a SLSA provenance attestation recording which workflow, at which commit, built it.

For the image, against the index digest:

```sh
gh attestation verify oci://ghcr.io/no42-org/twiki@sha256:<index-digest> \
  --repo no42-org/twiki
```

For the files:

```sh
gh attestation verify twiki-0.0.9.tgz --repo no42-org/twiki
```

`--repo` is the point of the command.
Without it the attestation is checked for internal consistency and not against who was entitled to produce it.

## Repairing a floating tag

If `:latest` or `:X.Y` ends up pointing at the wrong image, retag in the registry.
Do **not** re-run the release workflow: the build is not reproducible, so a rerun repoints every tag that run owns — including the exact `:X.Y.Z` tag, which must never move.

```sh
docker buildx imagetools create \
  -t ghcr.io/no42-org/twiki:latest \
  ghcr.io/no42-org/twiki@sha256:<correct-index-digest>
```

This needs a token with `write:packages` (`gh auth refresh -s write:packages`).

## Pruning images

Never run a blanket untagged-version cleanup.
A multi-arch image is a tagged manifest list plus untagged per-architecture children, so deleting untagged versions breaks already-published releases.
Delete specific versions by ID instead:

```sh
gh api --paginate /orgs/no42-org/packages/container/twiki/versions \
  --jq '.[] | "id=\(.id) tags=[\(.metadata.container.tags | join(","))]"'
gh api -X DELETE /orgs/no42-org/packages/container/twiki/versions/<id>
```

**GHCR cannot remove a single tag.** Deletion works on a *version*, and a version carries every tag pointing at it, so a version shared between a retired tag and a real release cannot be cleaned up without destroying the release.

That is why `:0` is still published and frozen at `0.0.5`: it shares a version with `:0.0.5`. It is documented as dead in the README rather than deleted.

The lesson for anything published in future: a floating tag you might later want to retire should not be the only thing standing between you and a version you need to keep.
