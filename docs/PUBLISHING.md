# Publishing `@bivelio/savings-layer`

**Decision (2026-07-20): PUBLIC npm, "public-inert".** `pnpm add @bivelio/savings-layer`
works for anyone with zero auth — the friction-free path. The code is readable, but the
package is **fail-closed**: it refuses to run without a valid signed license, so the
**license is the gate, not the registry**. Chosen over a private registry because the SDK
runs client-side (the bundle ships to every paying customer anyway), so gating *install*
buys little while adding real onboarding friction.

- **Runtime gate:** `createSavingsLayer` throws `LicenseError` without an active license.
- **Nothing secret ships:** the tarball is what `files` in `package.json` lists: `dist/`,
  `docs/terminales/`, `skills/`, `README.md` and `LICENSE`. It embeds the Ed25519
  **public** key (for offline verification). The **private** key is never part of the
  package: the release workflow refuses a tarball that contains a PEM private key, as
  text or base64-encoded. Confirm with `npm pack --dry-run`. Where the private key is
  kept (Vercel, plus the owner's local copy) is in `docs/RUNBOOK-ROTACION-DE-CLAVE.md`.

## Publish (maintainer)

Releases are published by `.github/workflows/publish.yml` with **npm trusted
publishing** (OIDC): GitHub hands the workflow a short-lived identity token and npm
exchanges it for a one-time publish credential. No npm token is stored anywhere. This
replaces the `NPM_TOKEN` secret. All nine runs of the old workflow failed: the seven that
reached `npm publish` (v0.1.0, v0.2.0 twice, v0.4.1, v0.4.22, v0.4.23 and v0.4.24) failed
there with `EOTP`, because the token required a second factor that CI cannot provide; the
other two (v0.2.0) failed earlier, in Tests and Typecheck (`gh run list --workflow
publish.yml`, checked 2026-09-27).

To release: bump `version` in `package.json`, merge, and cut a GitHub Release `vX.Y.Z`.
The workflow runs three jobs, each with the minimum permission:

1. **`verificar`** (`contents: read`): install, build, typecheck, tests, tag == version,
   `npm pack` **once**, then the tarball checks (paywall closed, no source maps, public
   key embedded in the SDK and in the gateway, no private key in any file) and a
   CycloneDX SBOM of that same tarball (`scripts/sbom.ts`). Its output is the tarball's
   SHA-512.
2. **`publicar`** (`id-token: write`, environment `npm`): the only job that can request
   an OIDC token. It installs nothing (no project dependencies, no other npm: it fails if
   the runner's npm is older than 11.5.1) and does no checkout; besides Node, npm and its
   own inline scripts, the only code it runs is two GitHub actions (`setup-node`,
   `download-artifact`), pinned by major tag, not by SHA. It checks that the tarball it received has the SHA-512 that
   `verificar` reported as its job output (which does not travel with the artifact),
   publishes it **by path**, with `--provenance` when the repository is public, and then
   checks that the registry serves the same SHA-512 (and, when public, a provenance
   attestation). What the hash check does not prove: that nothing touched the tarball
   inside `verificar`, where third-party install scripts run, before it was hashed.
3. **`sbom`** (`contents: write`): attaches `bivelio-savings-layer-X.Y.Z.cdx.json` to
   the Release once the version is on npm (even if the registry check after it fails).

`test/cadena-de-suministro.test.ts` fails in CI if the workflow loses `id-token: write`,
`--provenance`, the tarball checks or the SBOM, or brings back a stored token.
`bash scripts/simular-ci.sh <branch>` runs the same checks and the SBOM in a clean clone.

### One-time setup on npmjs.com (owner) — required before the next Release

Without this step, the next Release fails at "Publish to npm".

1. npmjs.com → package `@bivelio/savings-layer` → **Settings** → **Trusted Publisher**
   → **GitHub Actions**, with exactly these values (all fields are case-sensitive):

   | Field | Value |
   |---|---|
   | Organization or user | `BiVelio` |
   | Repository | `bivelio-savings-layer` |
   | Workflow filename | `publish.yml` |
   | Environment name | `npm` |

2. Cut the next Release and check the run is green. This is the first real test:
   trusted publishing cannot be exercised without publishing. If "Publish to npm" fails
   with an authentication error, re-check the four values above.
3. Once a release has gone out through CI, retire the old token:
   - npmjs.com → package **Settings** → **Publishing access** → *Require two-factor
     authentication and disallow tokens* (npm's recommendation once trusted publishing
     is set up).
   - npmjs.com → **Access Tokens**: revoke the token that was stored as `NPM_TOKEN`.
   - GitHub → repository **Settings** → **Secrets and variables** → **Actions**: delete
     `NPM_TOKEN`.

   `deprecate.yml` still authenticates with `NPM_TOKEN`, because OIDC only covers
   `npm publish`, and it already fails with `EOTP` today (BITACORA-2026-08-11). Once the
   token is gone, deprecate from a maintainer machine:
   `npm deprecate @bivelio/savings-layer@X.Y.Z "<message>" --otp=<code>`.

The `npm` environment is created by the first run, with no rules. **Required reviewers
are not available here:** on GitHub Free, Pro and Team they only exist for public
repositories, and this organization is on Team with a private repository
(https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments,
checked 2026-09-27). On the current plan, the human gate is who can cut a Release.
What Team does offer for private repositories is **deployment branches and tags**:
optionally, GitHub → Settings → Environments → `npm` → *Deployment branches and tags* →
*Selected branches and tags* → add the tag rule `v*`, so that only a run on a `v*` tag
can enter the environment npm trusts.

### Versions npm 11 refuses without `--tag`

The workflow publishes with npm 11, which (unlike npm 10) refuses, without `--tag`, a
prerelease version (`1.2.3-rc.1`) and any version lower than the highest one already
published (`lib/commands/publish.js`,
https://github.com/npm/cli/blob/v11.19.0/lib/commands/publish.js, checked 2026-09-27).
The workflow passes no `--tag`, so today only a normal release above the latest one
publishes. A prerelease or a fix on an older line needs the workflow to pass `--tag`
first.

### If the check after publishing fails

"El registro sirve el tarball verificado" runs **after** `npm publish`. If it fails, the
version is already on npm: do **not** re-run the Release (it would fail with "cannot
publish over"). If the log says the registry did not serve the version within 5
minutes, check by hand that `npm view @bivelio/savings-layer@X.Y.Z dist.integrity` matches
the SHA-512 in the log. If it says the registry serves a different SHA-512, treat it as
an incident. The SBOM is still attached to the Release in both cases.

### Provenance needs a public repository

npm only generates provenance when the source repository is public, even for public
packages (https://docs.npmjs.com/trusted-publishers, checked 2026-09-27). While
`BiVelio/bivelio-savings-layer` is private, the workflow publishes **without**
provenance and says so with a warning in the run. If the repository is made public, the
next release gets `--provenance` with no change to the workflow. Whether to make it
public is the owner's decision.

Trusted publishing also requires `repository.url` in `package.json` to match this
repository exactly; it is set to `git+https://github.com/BiVelio/bivelio-savings-layer.git`.
This undoes the removal of `repository` in #279 (5ff2718), which was made because npm
showed it as a link to a repository that does not exist. It still does, in effect: while
the repository is private, the "Repository" link on npmjs.com is a 404 for the public.
That is the cost of trusted publishing from a private repository.

### Manual fallback

If CI cannot publish, the owner publishes by hand **the tarball that `verificar`
already checked**, never a new build, as in BITACORA-2026-08-11:

1. The `verificar` job of that run must be green. If it is not, do not publish by hand:
   fix it and cut a new Release.
2. `gh run download <run-id> --name paquete` fetches `bivelio-savings-layer-X.Y.Z.tgz`
   and its SBOM. Check that `shasum -a 512 bivelio-savings-layer-X.Y.Z.tgz` prints the
   SHA-512 that the `verificar` job logged in its "Hash del tarball verificado" step.
3. `npm publish ./bivelio-savings-layer-X.Y.Z.tgz --access public --otp=<code>`.

A manual publish carries no provenance, and SECURITY.md has to list that version as
published by hand.

## Customer install (zero friction)

```
pnpm add @bivelio/savings-layer
```
No `.npmrc`, no token. The only credential is the **license key** (runtime), minted in the
dashboard and passed to `createSavingsLayer({ licenseKey })`.

## If you ever need to hide the code (revisit)

The only way to keep the algorithm private is to NOT ship it to the client — i.e. run it
server-side / as a proxy, which trades away the near-zero cost-to-serve model. A private
registry (GitHub Packages / Cloudsmith) only stops *non-customers* from downloading it; a
paying customer can always read their installed bundle. Not worth the friction today.
