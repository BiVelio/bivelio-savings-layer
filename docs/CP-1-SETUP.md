# CP-1 — Setup checklist (Vercel + Supabase + Stripe)

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.

CP-1 turns BV-SALA into a signup-able, billable product at `savings.bivelio.com`,
reusing BiVelio's existing platform: **Supabase** (auth + Postgres), **Stripe**
(billing), **Vercel** (hosting). This is the list of accounts/keys to provision.
The application code is built in this repo; you plug in the accounts.

## What you provision vs what I build

| You provision (accounts/keys) | I build (in this repo) |
| --- | --- |
| Supabase project (or reuse the platform one), run the DB migration | Next.js app on Vercel (`apps/web`): landing/verifier + auth + dashboard |
| Stripe account, per-seat product/price, webhook | Supabase Auth wiring (signup/login/session, org creation) |
| Vercel project for `apps/web` + the `savings.bivelio.com` domain | Stripe per-seat checkout + webhook → `subscriptions` |
| Set the env vars below in Vercel | Control-plane API (Vercel functions): license validate + usage ingest, backed by Postgres |
| | License signing keypair generation helper |

## 1. Supabase

Reuse BiVelio's existing Supabase (the one behind `auth.bivelio.com`) or create a
dedicated project. Then apply the schema:

```bash
supabase db push        # applies db/migrations/0001_init.sql   (see db/README.md)
```

Collect: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`.

## 2. Stripe

- Create a **Product** "BV-SALA Pro" with a **per-seat recurring Price**
  (€4/seat/month — the live currency is **EUR**). Note the `price_id`.
- Add a webhook to `https://savings.bivelio.com/api/stripe/webhook` for
  `customer.subscription.*` and `checkout.session.completed`.

Collect: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO_SEAT`.

## 3. License signing keypair

Generate once; the private key stays server-side (Vercel env), the public key is
what the SDK embeds to verify offline:

```bash
node -e "import('@bivelio/license-client').then(m=>{const k=m.generateLicenseKeypair();console.log('PRIVATE:\n'+k.privateKey);console.log('PUBLIC:\n'+k.publicKey)})"
```

Collect: `LICENSE_PRIVATE_KEY`, `LICENSE_PUBLIC_KEY`.

## 4. Vercel

Create a **new** Vercel project (not the corporate one), Root Directory
`apps/web`, add domain `savings.bivelio.com`, and set all env vars below.

## Environment variables

| Name | Where | Secret |
| --- | --- | --- |
| `SUPABASE_URL` | app + functions | no |
| `SUPABASE_ANON_KEY` | app (browser) | no |
| `SUPABASE_SERVICE_ROLE_KEY` | functions only | **yes** |
| `STRIPE_SECRET_KEY` | functions only | **yes** |
| `STRIPE_WEBHOOK_SECRET` | webhook fn | **yes** |
| `STRIPE_PRICE_PRO_SEAT` | checkout fn | no |
| `LICENSE_PRIVATE_KEY` | licensing fn only | **yes** |
| `LICENSE_PUBLIC_KEY` | published to SDKs | no |

## Request flows CP-1 wires up

```
Signup/login ─► Supabase Auth ─► create organization + owner membership (Postgres)
Subscribe    ─► Stripe Checkout ─► webhook ─► subscriptions + org.plan (Postgres) ─► issue license
SDK (customer infra):
   validate  ─► POST savings.bivelio.com/api/licensing/validate  (service-account key)
   usage     ─► POST savings.bivelio.com/api/metering/usage       → usage_daily rollup
Dashboard    ─► reads usage_daily + subscriptions (RLS-scoped to the user's org)
```

## Note on the API host

Start with `savings.bivelio.com/api/*` (one Vercel project). Attach
`api.savings.bivelio.com` to the same project later for a clean public M2M API.
See `docs/DEPLOYMENT-TOPOLOGY.md`.
