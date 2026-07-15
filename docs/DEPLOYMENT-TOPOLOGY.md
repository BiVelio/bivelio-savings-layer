# BV-SALA — Deployment Topology ("an extension of bivelio.com")

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.

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

| URL | What | Repo | Host |
| --- | --- | --- | --- |
| `bivelio.com`, `www.bivelio.com` | Official corporate site — **UNTOUCHED** | *(separate corporate repo)* | its current host (Next.js / Vercel) |
| `savings.bivelio.com` | BV-SALA product web + savings verifier (`apps/web`) | **this repo** | Hetzner |
| `app.bivelio.com` | Customer dashboard (savings, keys, billing, team) | this repo (`apps/dashboard`, CP-1) | Hetzner |
| `id.bivelio.com` | Keycloak (identity / SSO / orgs) | infra | Hetzner |
| `api.bivelio.com` | Control plane — licensing + metering (path-routed) | this repo (`services/*`) | Hetzner |

Optional unified URL: the corporate site can add a **rewrite** so
`bivelio.com/savings` transparently serves `savings.bivelio.com` — a single URL
without merging codebases. That change lives in the corporate repo; this repo
never touches it. Subdomains are the primary, lowest-coupling approach.

## Physical picture

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
