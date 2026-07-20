# Publishing `@bivelio/savings-layer` (private, gated)

**Decision (2026-07-20):** distribute via a **private gated registry** so the
algorithm bundle is never public. Customers authenticate to install; the
**license key** (runtime auth, passed to `createSavingsLayer`) is separate from
the **registry token** (install auth, in `.npmrc`).

Verified: the packaged tarball installs + enforces the license correctly in a
clean project — run `pnpm demo:install`.

---

## Option A — GitHub Packages (recommended: zero new infra)

The repo already lives at `github.com/BiVelio`, so its package registry
(`npm.pkg.github.com`) needs nothing stood up; scoped packages are private to the
org by default.

**Publish (maintainer):**
1. In `package.json`: add `"publishConfig": { "registry": "https://npm.pkg.github.com" }`
   and remove `"private": true` (a hard block on `npm publish`; GitHub keeps the
   package private via org visibility, not the `access` field).
2. Publish via CI on a tag using the built-in `GITHUB_TOKEN` (no manual token):

   ```yaml
   # .github/workflows/publish.yml
   on: { release: { types: [published] } }
   jobs:
     publish:
       runs-on: ubuntu-latest
       permissions: { contents: read, packages: write }
       steps:
         - uses: actions/checkout@v4
         - uses: actions/setup-node@v4
           with: { node-version: 20, registry-url: https://npm.pkg.github.com }
         - run: corepack enable && pnpm install --frozen-lockfile && pnpm run build:all
         - run: npm publish
           env: { NODE_AUTH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }
   ```

**Customer install** (a `read:packages` token you grant them):
```
# .npmrc
@bivelio:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${BIVELIO_NPM_TOKEN}
```
```
pnpm add @bivelio/savings-layer
```

> The dashboard install snippet currently references `npm.bivelio.com`. If you go
> with GitHub Packages, update `apps/web/app/dashboard/components/InstallLicensePanel.tsx`
> (and the landing) to `npm.pkg.github.com`.

## Option B — self-hosted `npm.bivelio.com` (Verdaccio) or Cloudsmith

Full control, a vanity host, and non-GitHub customer auth — but needs a box
(Hetzner + DNS + TLS) or a managed SaaS (Cloudsmith/Bytesafe). Pick this if you
want `npm.bivelio.com` (already referenced in the web) to be a real registry.

---

## Not yet done (needs you)

- [ ] **Pick the host** — GitHub Packages (ready now) vs self-hosted `npm.bivelio.com`.
- [ ] **Flip `private:true` → publish** — deliberately blocked today so nothing
      ships to public npm by accident.
- [ ] **Customer token issuance** — wire per-customer registry tokens to the plan
      (dashboard), distinct from the license key.
