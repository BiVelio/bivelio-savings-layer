# BV-SALA — Deployment Topology ("an extension of bivelio.com")

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.

## Launch decision (2026-07-18): Vercel-first

Launch on **Vercel** (same place the corporate site lives) for least maintenance;
**Hetzner is the scale option**, adopted later only when volume makes the €-savings
worth the ops work. The subdomain model below is identical either way — only the
"Host" column changes. See `docs/COMMERCIALIZATION-PLAN.md` §0.

## The core idea

BV-SALA is **not** hosted *inside* the official `bivelio.com` site. It hangs off
the **same brand domain** as a set of subdomains, sharing one login and one
design system. To the user it is "all BiVelio"; to us it is separate repos and
separate hosts. The corporate apex stays exactly where it is — you only **add
subdomain DNS records** pointing at Hetzner.

Three things make it feel like one product, not a bolt-on:

1. **Same apex domain** — everything is `*.bivelio.com`.
2. **Same identity** — one BiVelio account via **Keycloak SSO** works on the
   corporate site, the product, and the dashboard ("Sign in with BiVelio").
3. **Same brand** — shared color tokens (already aligned), fonts, header/footer.

## Domain map

| URL | What | Repo | Host (launch → scale) |
| --- | --- | --- | --- |
| `bivelio.com`, `www.bivelio.com` | Official corporate site — **UNTOUCHED** | *(separate corporate repo)* | its current host (Vercel) |
| `savings.bivelio.com` | BV-SALA product web + savings verifier + dashboard (`apps/web`) | **this repo** | Vercel → (Hetzner at scale) |
| `savings.bivelio.com/api/*` | Product API for the browser (dashboard actions, auth callbacks) | this repo | Vercel functions |
| `api.savings.bivelio.com` | **Machine-to-machine control-plane API** the customer SDK calls — licensing (validate/refresh) + metering (usage ingest) | this repo (`services/*`) | Vercel functions → (Hetzner at scale) |

**Do you need `api.savings.bivelio.com`?** Yes — but it's a naming/organization
choice, not extra infrastructure. The SDK running in *customers'* infra needs a
stable, dedicated endpoint to phone home for license validation and usage
reporting, kept separate from the browser-facing site (its own versioning, CORS,
rate limits). Two equivalent ways to run it on Vercel:

- **Simplest to start:** keep it inside the same app under
  `savings.bivelio.com/api/*` (one Vercel project, one deploy). Point the SDK there.
- **Cleaner for a public API:** attach `api.savings.bivelio.com` as an extra
  domain on the same Vercel project (or a small second project) — a tidy,
  stable host for third-party SDK integration. Recommended once external
  customers integrate.

Either way it's the **same code and the same Vercel project family** — no new
servers. `api.bivelio.com` (platform-wide gateway) stays available for later if
BiVelio wants one API host across all products.

Optional unified URL: the corporate site can add a **rewrite** so
`bivelio.com/savings` transparently serves `savings.bivelio.com` — a single URL
without merging codebases. That change lives in the corporate repo; this repo
never touches it. Subdomains are the primary, lowest-coupling approach.

## Physical picture (Hetzner / scale option)

> On **Vercel (launch)** there is nothing to run here — Vercel does TLS, routing,
> and scaling automatically. You just assign the subdomains to the Vercel
> project(s) in the dashboard and add DNS records (below). The reverse-proxy
> picture applies only if/when you move to Hetzner at scale.

```
                        ┌──────────────────────────────┐
      DNS (bivelio.com) │  apex + www  ─────────────────┼──► Corporate site (Vercel)   [separate repo]
                        │  savings.  ┐                   │
                        │  app.      │                   │
                        │  id.       ├─ A/AAAA ──────────┼──► Hetzner load balancer / VM
                        │  api.      ┘                   │       │
                        └──────────────────────────────┘        ▼
                                                          ┌─────────────────────────────┐
                                                          │ Reverse proxy (Caddy/Traefik)│  auto-TLS
                                                          │  savings. → apps/web         │
                                                          │  app.     → dashboard        │
                                                          │  id.      → Keycloak         │
                                                          │  api.     → licensing/metering│
                                                          └─────────────────────────────┘
                                                             │ Postgres · Redis · Qdrant · ClickHouse
```

The corporate DNS **target for the apex never changes**. You add records for the
product subdomains only, pointing at the Hetzner endpoint. Corporate (Vercel) and
product (Hetzner) coexist under one brand, fully decoupled.

## DNS records to add (product only)

```
savings   A/AAAA   → <hetzner-ip>
app       A/AAAA   → <hetzner-ip>
id        A/AAAA   → <hetzner-ip>
api       A/AAAA   → <hetzner-ip>
# apex (@) and www are NOT touched — they stay on the corporate site's host.
```

## Reverse proxy (Hetzner) — auto-TLS, subdomain routing

A single proxy terminates TLS (Let's Encrypt) for the product subdomains and
routes to containers. Example Caddyfile lives in `deploy/Caddyfile.example`.
The corporate apex is deliberately **absent** from it.

## Two independent pipelines (isolation preserved)

- **Corporate site:** its own repo → its own host (Vercel). We never deploy it.
- **BV-SALA:** this repo → CI builds the containers → deploys to Hetzner
  (`deploy/`). No shared deploy surface, no shared DNS target for the apex.

This is exactly the boundary in `apps/web/README.md`: same brand, same login,
same look — separate code, separate host, separate pipeline.

## Why this answers "where do we mount it"

You don't "mount it in" bivelio.com. You **extend the brand domain**: add a few
subdomain DNS records → Hetzner, put a reverse proxy in front of the product +
control-plane containers, and wire Keycloak so the login is shared. The corporate
site keeps running untouched, and users experience one continuous BiVelio.
