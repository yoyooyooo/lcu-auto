# Release operations

**Current distribution: source checkout + build + global shim. npm publication is deferred until the maintainer account is usable. No publish tag should be pushed solely to test a blocked registry account.**

The package identity is `lcu-auto`; the repository is `yoyooyooo/lcu-auto`. Releases use annotated immutable `vX.Y.Z` tags. Only stable versions are enabled; prerelease publishing is deliberately rejected rather than silently assigned to `latest`.

## Prepare a release

Update the version in `package.json` and the changelog, then run `bun run build` to synchronize the generated source version. Review and commit the change to `main`, push it, and wait for the CI matrix.

```sh
bun run release:precheck
bun run release --execute
```

The precheck requires a clean checkout on `main` equal to fetched `origin/main`, runs source checks and the real packed-install smoke, checks registry state, and does not publish or create a tag. Execution repeats those checks, creates an annotated tag and pushes only that tag. A pushed tag is never moved to repair a failed release.

The [publish workflow](https://github.com/yoyooyooo/lcu-auto/blob/main/.github/workflows/publish.yml) verifies repository, exact tag/version/commit, ancestry to main and package identity. A new publish must come from the current main tip. It serializes releases, refuses to move `latest` backward, and publishes the exact tarball verified by `pack:check`.

## First npm publish

The real initial version is **0.4.0**, not a placeholder. A maintainer first logs in to the official registry using npm web authorization. Use a genuine terminal, or the OS's `script` utility when a non-interactive shell prevents npm from presenting its web flow. Do not print or share authorization URLs, cookies, OTPs or token values.

```sh
npm login --auth-type=web --registry=https://registry.npmjs.org/
bun run check
bun run pack:check
npm publish ./.artifacts/lcu-auto-0.4.0.tgz --access public --auth-type=web --registry=https://registry.npmjs.org/
npm view lcu-auto@0.4.0 version dist.integrity --registry=https://registry.npmjs.org/
```

Open the packed manifest before publishing. It must have the intended name, version and bin, and no `catalog:`, `workspace:` or private-registry dependency. Publish the tarball, not the source directory. The path starts with `./` or is absolute to avoid npm interpreting it as a GitHub shorthand.

Local publishing cannot produce GitHub Actions provenance. The bootstrap version is explicitly recorded as such; later CI versions require provenance. Do not use `--provenance` in an unsupported local environment or invent a success claim from npm's initial progress output.

## Configure trusted publishing

After the first version exists, add a GitHub Actions trusted publisher on the package's npm Access page:

| Field                | Value                    |
| -------------------- | ------------------------ |
| Organization or user | `yoyooyooo`              |
| Repository           | `lcu-auto`               |
| Workflow filename    | `publish.yml`            |
| Environment          | Empty                    |
| Allowed action       | Allow direct npm publish |

This identity is the GitHub owner/repository/workflow, not the npm username. The workflow uses `id-token: write` and a current npm CLI. Do not add `NPM_TOKEN` or `NODE_AUTH_TOKEN` to Actions; do not let setup-node insert a dummy registry token.

Saving the trusted-publisher form is not proof that OIDC publish works. An actual later tag must pass publication, registry readback, provenance verification and clean consumer installation. The first bootstrap tag can repair/create its GitHub Release only if the existing registry integrity matches its exact packed bytes.

## Verification and recovery

The workflow polls official registry visibility after a publish, compares `dist.integrity` to the actual uploaded archive and verifies the `latest` tag. A fresh directory installs that exact registry version and runs the Node CLI. For CI provenance, npm verifies attestation signatures and the release script checks the subject digest, repository, workflow, tag and commit.

GitHub Releases are created only after those checks. Re-running an existing release may repair metadata/assets, but must not republish an existing version or move its tag. If the registry already contains a version with different bytes, stop and bump the version. If a network response is lost, inspect registry state before retrying a write.

The first maintainer-local publish and subsequent OIDC publishes are separate claims. Consult actual workflow runs and registry metadata rather than treating the presence of workflow YAML as delivery proof.
