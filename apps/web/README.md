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

A single, self-contained `index.html` — no framework, no build step — that runs
the real BV-SALA token accounting in the browser (format verifier + bill
projector). Everything runs locally in the visitor's browser; **no data leaves
the page**.

## Run it locally

```bash
pnpm web:dev          # → http://localhost:4321  (zero-dependency static server)
```

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

This static page is the landing. CP-1 adds, in the same `savings.bivelio.com`
project, a Next.js surface for **user registration** and the **dashboard +
billing**, and exposes the SDK's licensing/metering endpoints as Vercel
functions. When it becomes Next.js it will import the real
`@bivelio/savings-layer` package (via a browser-safe entry) so the marketing
numbers are guaranteed identical to the product's.
