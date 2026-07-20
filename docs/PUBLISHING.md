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

1. `package.json` is set: no `private`, `"publishConfig": { "access": "public" }`.
2. **npmjs.com prep (one-time):** an npm account that owns the **`@bivelio`** org (free for
   public packages), plus an **automation/granular access token** with publish rights for
   the scope. Add it to the repo as the **`NPM_TOKEN`** GitHub secret.
3. **Cut a GitHub Release** (bump the version in `package.json` first). The workflow
   `.github/workflows/publish.yml` builds and runs `npm publish --access public` with
   `NPM_TOKEN`. Nothing ships automatically — the Release is the trigger.

## Customer install (zero friction)

```
pnpm add @bivelio/savings-layer
```
No `.npmrc`, no token. The only credential is the **license key** (runtime), minted in the
dashboard and passed to `createSavingsLayer({ licenseKey })`.

## Not yet done (needs you)

- [ ] Create/confirm the **`@bivelio` org on npmjs.com** + an automation token.
- [ ] Add the **`NPM_TOKEN`** GitHub repo secret.
- [ ] **Publish** — cut a GitHub Release (`v0.1.0`).

## If you ever need to hide the code (revisit)

The only way to keep the algorithm private is to NOT ship it to the client — i.e. run it
server-side / as a proxy, which trades away the near-zero cost-to-serve model. A private
registry (GitHub Packages / Cloudsmith) only stops *non-customers* from downloading it; a
paying customer can always read their installed bundle. Not worth the friction today.
