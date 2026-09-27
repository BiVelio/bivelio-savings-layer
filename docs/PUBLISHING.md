# Publishing `@bivelio/savings-layer`

**Decision (2026-07-20): PUBLIC npm, "public-inert".** `pnpm add @bivelio/savings-layer`
works for anyone with zero auth — the friction-free path. The code is readable, but the
package is **fail-closed**: it refuses to run without a valid signed license, so the
**license is the gate, not the registry**. Chosen over a private registry because the SDK
runs client-side (the bundle ships to every paying customer anyway), so gating *install*
buys little while adding real onboarding friction.

- **Runtime gate:** `createSavingsLayer` throws `LicenseError` without an active license.
- **Nothing secret ships:** the tarball is `dist/` only + README + LICENSE. It embeds the
  Ed25519 **public** key (for offline verification); the **private** key never leaves the
  control plane. Confirm with `npm pack --dry-run`.

## Publish (maintainer)

Releases are published by `.github/workflows/publish.yml` with **npm trusted
publishing** (OIDC): GitHub hands the workflow a short-lived identity token and npm
exchanges it for a one-time publish credential. No npm token is stored anywhere. This
replaces the `NPM_TOKEN` secret: every Release that reached the publish step (v0.2.0,
v0.4.1, v0.4.22, v0.4.23 and v0.4.24) failed there with `EOTP`, because the token
required a second factor that CI cannot provide.

To release: bump `version` in `package.json`, merge, and cut a GitHub Release `vX.Y.Z`.
The workflow runs three jobs, each with the minimum permission:

1. **`verificar`** (`contents: read`): install, build, typecheck, tests, tag == version,
   `npm pack` **once**, then the tarball checks (paywall closed, no source maps, public
   key embedded in the SDK and in the gateway) and a CycloneDX SBOM of that same tarball
   (`scripts/sbom.ts`).
2. **`publicar`** (`id-token: write`, environment `npm`): the only job that can request
   an OIDC token, and it installs no dependencies. It publishes the verified tarball
   **by path**, with `--provenance` when the repository is public, and then checks that
   the registry serves the same SHA-512 (and, when public, a provenance attestation).
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

Optional: the `npm` environment is created by the first run, with no rules. Adding
**required reviewers** to it (GitHub → Settings → Environments → `npm`) makes every
publish wait for a human approval.

### Provenance needs a public repository

npm only generates provenance when the source repository is public, even for public
packages (https://docs.npmjs.com/trusted-publishers, checked 2026-09-27). While
`BiVelio/bivelio-savings-layer` is private, the workflow publishes **without**
provenance and says so with a warning in the run. If the repository is made public, the
next release gets `--provenance` with no change to the workflow. Whether to make it
public is the owner's decision.

Trusted publishing also requires `repository.url` in `package.json` to match this
repository exactly; it is set to `git+https://github.com/BiVelio/bivelio-savings-layer.git`.

### Manual fallback

If CI cannot publish, the owner publishes the verified tarball by path from a clean
checkout of the tag, as in BITACORA-2026-08-11:
`npm publish <path to .tgz> --access public --otp=<code>`. A manual publish carries no
provenance.

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
