# apps/web — BV-SALA product web (savings.bivelio.com)

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.

## ⚠️ Boundary — read this first

This is the **product web for BV-SALA** (marketing + savings verifier), served at
`savings.bivelio.com`. It lives **only** in this repo.

**It is NOT the official `bivelio.com` corporate website.** The corporate site is
a **separate repo and a separate Vercel project** and must never be edited,
redeployed, or have its domain reassigned from here. This app deploys to its
**own** Vercel project with the **`savings.` subdomain only** — the apex (`@`) and
`www` stay on the corporate project, untouched.

## What this is

A framework-free `index.html` that runs the **real BV-SALA optimizer** in the
visitor's browser — not a re-implementation. The page imports
`vendor/bv-sala.js`, a self-contained ESM bundle compiled from the exact same
TypeScript the SDK ships (`src/`, minified, no sourcemap). So:

- **Panel A (format verifier)** runs the product's real `FormatSelector` on
  whatever JSON you paste — same token counting, same activation thresholds.
- **Panel B (bill projector)** can run the whole execution pipeline
  (`createSavingsLayer`) over a representative workload and set its levers from a
  **measured** run — real cache hits, format compression, output budgets and
  provider-cached input — then applies **your** prices to project the bill.

The LLM is mocked (no keys, no network), but every optimization decision is the
product's real logic. Everything runs locally; **no data leaves the page**.

## Run it locally

```bash
pnpm web:build        # compile src/ → apps/web/vendor/bv-sala.js (part of `pnpm build`)
pnpm web:dev          # → http://localhost:4321  (zero-dependency static server)
```

`vendor/bv-sala.js` is committed so the static deploy needs no build step. Regenerate
it with `pnpm web:build` (or `pnpm build`) whenever `src/` changes, so the verifier
stays byte-identical to the shipped SDK.

## Deploy to Vercel (savings.bivelio.com)

Launch host is **Vercel** (least maintenance; same platform as the corporate
site). Steps:

1. **Create a NEW Vercel project** (do not reuse the corporate project). Set its
   **Root Directory to `apps/web`**. It deploys as a static site — no build
   command needed. `vercel.json` here adds clean URLs + security headers.
2. In that project's **Domains**, add `savings.bivelio.com`.
3. In DNS for `bivelio.com`, add the record Vercel shows for the subdomain
   (a `CNAME` `savings` → Vercel). The apex and `www` are **not** touched.
4. Remove `<meta name="robots" content="noindex">` from `index.html` when you're
   ready to be indexed (kept while it's a prototype).

That's it — no servers, TLS and scaling are automatic.

## The API surface (api.savings.bivelio.com)

The customer SDK phones home for **license validation** and **usage reporting**.
That machine-to-machine API is added in CP-1 as Vercel functions. Start simple
(`savings.bivelio.com/api/*`) or attach `api.savings.bivelio.com` to the same
project for a clean public API host — same code, same project family, no new
servers. See [`docs/DEPLOYMENT-TOPOLOGY.md`](../../docs/DEPLOYMENT-TOPOLOGY.md).

## Roadmap (CP-1)

This static page is the landing, and it **already imports the real
`@bivelio/savings-layer`** (browser-safe bundle) — so the marketing numbers are
guaranteed identical to the product's, no Next.js required. CP-1 next adds, in
the same `savings.bivelio.com` project, a surface for **user registration** and
the **dashboard + billing**, and exposes the SDK's licensing/metering endpoints
as Vercel functions.
