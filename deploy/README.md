# deploy — BV-SALA product + control plane (Hetzner)

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.

Infrastructure templates for deploying the BV-SALA **product** (marketing/
verifier web, dashboard) and **control plane** (licensing, metering, Keycloak)
to Hetzner as subdomains of `bivelio.com`. See
[`docs/DEPLOYMENT-TOPOLOGY.md`](../docs/DEPLOYMENT-TOPOLOGY.md) for the full
picture.

## ⚠️ Boundary

These files deploy the **product surface only** — `savings.`, `app.`, `id.`,
`api.` subdomains. The official **corporate site at the `bivelio.com` apex is a
separate repo on its own host and is never deployed, proxied, or replaced from
here**. The apex is deliberately absent from every file in this directory.

## Files

- `Caddyfile.example` — reverse proxy: subdomain routing + automatic TLS.
- `docker-compose.example.yml` — single-host starting stack (proxy, web,
  licensing, metering, Keycloak, Postgres, Qdrant). Reuses the BiVelio platform
  stack; scale out as revenue grows.

These are **templates** (`.example`), not wired to any CI pipeline. Copy, fill in
real upstreams/secrets, and deploy deliberately. Dockerfiles for `web`,
`licensing`, `metering` are added in CP-1 alongside the CI pipeline.

## Shape it becomes an "extension of bivelio.com"

1. DNS: add `savings`/`app`/`id`/`api` records → Hetzner (apex untouched).
2. Reverse proxy terminates TLS and routes each subdomain to its container.
3. Keycloak (`id.bivelio.com`) provides shared SSO across corporate + product.
4. Shared brand tokens + header/footer make it look continuous.
