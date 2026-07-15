# apps/web — BV-SALA product web (isolated prototype)

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.

## ⚠️ Boundary — read this first

This directory is the **product marketing / savings-verifier prototype for
BV-SALA**, and it lives **only** in the `bivelio-savings-layer` repository.

**It is NOT the official `bivelio.com` corporate website.** The official site is
maintained in a **separate repository** on purpose. Nothing in this repo may:

- edit, overwrite, or replace the official BiVelio website;
- deploy to or point DNS at the `bivelio.com` production domain;
- share build/deploy pipelines with the official site.

When this prototype is ready to go live it will be published under a **dedicated
subdomain/route** (e.g. a product page), decided and wired up deliberately —
never by clobbering the corporate site. Do not add any deploy configuration
(`vercel.json`, `vercel.ts`, `CNAME`, workflows, etc.) that targets the official
domain from this repo.

## What this is

A single, self-contained `index.html` — **no framework, no build step, no
dependencies** — that runs the real BV-SALA token accounting in the browser:

- **Format verifier** — paste any JSON, see live token counts for compact JSON,
  TOON and CSV, and which one the selector picks (including instruction
  overhead). This is the `compressed_tokens` ledger, computed client-side.
- **Bill projector** — enter your traffic and watch call-avoidance, context
  reduction and output restriction compound into a monthly saving and ROI.

Everything runs locally in the visitor's browser; **no data leaves the page**.

## Run it locally

Zero-dependency static server (Node ≥ 18, no installs):

```bash
pnpm web:dev          # from the repo root  → http://localhost:4321
# or directly:
node apps/web/serve.mjs
```

Or just open `apps/web/index.html` in a browser.

## Roadmap (CP-1)

This static prototype is the design source. In CP-1 it becomes a proper
`apps/web` **Next.js** app that imports the real `@bivelio/savings-layer`
package (so marketing numbers are guaranteed identical to product numbers) and
is deployed to a dedicated BV-SALA product surface — still fully separate from
the official corporate site.
