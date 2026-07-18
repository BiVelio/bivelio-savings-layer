# BV-SALA — Master Commercialization & Integration Plan

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.
> This document is the single source of truth for turning `bivelio-savings-layer`
> into a commercial product integrated into the BiVelio platform and website.
> Prices and copy are placeholders; the mechanics are the plan.

## 0. Locked decisions (2026-07-15)

| Decision | Choice |
| --- | --- |
| **Infra (launch)** | **Vercel-first.** The product web + dashboard ship on **Vercel** at `savings.bivelio.com` (same place the corporate site already lives → least maintenance, no servers to run) with a **managed Postgres** (Neon) for BV-SALA's own data. The licensing + metering services are small HTTP endpoints that also run serverless on Vercel to start. **Hetzner is the scale option**, not the launch option: move cost-sensitive/heavy pieces there once volume makes the €-savings worth the ops work. Rationale: at small scale the money gap (~$20–40/mo Vercel vs ~€5–15/mo Hetzner) is negligible, and Vercel costs far less to *maintain*; the gap only matters at scale, by which point revenue funds ops. |
| **Identity & billing** | Reuse BiVelio's platform where already running (**Keycloak** SSO, **Hyperswitch** payments) so it's one BiVelio account + unified billing across the suite — this is what makes it a true *extension* of bivelio.com. If those aren't yet in production, launch with managed equivalents (Clerk / Stripe) and federate later. Decided at CP-1. |
| **Billing (launch)** | **Per-seat**, e.g. `$4/user/month`. Metered-by-volume and value-based (% of savings) are upsell/enterprise tiers later. |
| **Free / offline** | **Free self-hosted tier with a cap.** Local-only optimizations (exact cache, resolvers, format selector) work capped and offline. Semantic cache, learned thresholds, dashboards and cross-tenant optimization require a license. **No valid license → graceful degrade, never brick the customer's production.** |

## 1. Product shape: the control-plane / data-plane split

The core answer to "self-hosted but still pays us": the customer self-hosts the
**data plane** (their prompts and LLM calls never touch our infra → ~zero
cost-to-serve for us), while a **managed control plane on BiVelio's Hetzner** is
the mandatory, high-value dependency that carries licensing, the best IP, and
billing telemetry.

```
 CUSTOMER INFRA (data plane, self-hosted)         BIVELIO HETZNER (control plane)
┌───────────────────────────────────────┐       ┌──────────────────────────────────────┐
│  Their app                             │       │  Keycloak (identity, orgs, SSO)        │
│   └─ @bivelio/savings-layer  (SDK)     │       │  Licensing service  (issue/validate)   │
│        ├─ LicenseClient  ──────────────┼──────▶│  Entitlements API                      │
│        ├─ ControlPlaneClient ──────────┼──────▶│  Optimization control plane            │
│        │     • config / thresholds     │◀──────┼─    • config & learned thresholds      │
│        │     • semantic cache lookup   │◀─────▶│      • Qdrant + cross-encoder verifier │
│        │     • router model / hints    │◀──────┼─    • format-decision cache            │
│        └─ TelemetrySink (SavingsReport)┼──────▶│  Metering & usage  (ingest → aggregate)│
│                                        │       │  Billing (Hyperswitch subscriptions)   │
│   LLM traffic ─────► their provider    │       │  Analytics store (ClickHouse/Timescale)│
│   (NEVER through us)                   │       │  Dashboards + Admin + Marketing/Web     │
└───────────────────────────────────────┘       └──────────────────────────────────────┘
```

**Invariant:** by default the SDK sends the control plane only *metadata and
counts* (token totals, avoided calls, format chosen, cost deltas) — **never raw
prompts, completions, or customer data**. This is both a privacy guarantee we
sell and the reason our cost-to-serve stays tiny.

## 2. Repository & workspace layout (target)

Grow the current single package into a pnpm monorepo. The existing `src/`
becomes `packages/sdk` unchanged; new workspaces are added around it.

```
bivelio-savings-layer/
├── packages/
│   ├── sdk/                     # current @bivelio/savings-layer (data plane)
│   ├── license-client/          # LicenseClient: validate signed license, expose entitlements
│   ├── control-plane-client/    # ControlPlaneClient: config, semantic lookup, telemetry push
│   └── protocol/                # shared wire types (license, entitlements, usage records)
├── services/                    # control plane (Hetzner)
│   ├── licensing/               # issue / validate / revoke; signs entitlements
│   ├── metering/                # ingest SavingsReport → usage records → aggregates
│   ├── billing/                 # Hyperswitch: plans, subscriptions, invoices, dunning
│   ├── optimization/            # config/threshold distribution; server-side router + semantic cache (Qdrant)
│   ├── telemetry/               # analytics ingestion (ClickHouse/Timescale)
│   └── admin/                   # back-office, license issuance, tenant ops
├── apps/
│   ├── web/                     # marketing site + pricing + docs (Next.js)
│   └── dashboard/               # customer dashboard: savings, keys, usage, billing, team
├── deploy/                      # Hetzner IaC (Terraform/Ansible), Docker/Compose/K8s, Keycloak realm
└── (existing) docs/, benchmarks/, examples/, test/
```

## 3. Identity & multi-tenancy (Keycloak)

- **Keycloak realm `bivelio`** is the identity provider for the whole suite, so
  BV-SALA users log in with the same BiVelio account (SSO across the platform).
- Entities: **Organization (tenant)** → **Users** (with roles: owner, admin,
  member, billing) → **Service accounts / API clients** (machine identities the
  SDK uses).
- Every license, usage record, subscription and dashboard view is scoped by
  `org_id`. This maps 1:1 onto the SDK's existing `context.tenantId` and the
  cache-key tenant isolation already implemented — the security model is
  consistent end to end.
- Enterprise later: SAML/OIDC federation so customers bring their own IdP.

## 4. Licensing & entitlements

**License = a signed, offline-verifiable token** (JWT/PASETO signed with
BiVelio's private key) embedding:

```jsonc
{
  "org_id": "org_123",
  "plan": "pro",
  "seats": 25,
  "features": ["semantic_cache", "dashboards", "learned_thresholds"],
  "issued_at": "...",
  "expires_at": "...",          // long-lived (e.g. 30–90d), refreshed online
  "grace_days": 14
}
```

**Validation flow (in `license-client`):**
1. SDK boots with a license key (or fetches the signed token from the licensing
   service using the API client credentials).
2. `LicenseClient` verifies the signature locally against the embedded public
   key → works **offline**.
3. Periodically (e.g. daily) it re-validates online for **revocation** and to
   pick up plan changes; on network failure it keeps working until
   `expires_at + grace_days`.
4. Entitlements are exposed to the pipeline: e.g. semantic cache and learned
   thresholds are only enabled if `features` includes them.

**Graceful degradation (decided policy):** an expired/absent/revoked license
does **not** stop the customer's production. It drops BV-SALA to the **free
local tier** (exact cache, resolvers, format selector, strict output — all the
Phase 1–2 local wins) and disables the managed features. We protect their
uptime; we protect our revenue by gating the *high-value* features, not the
basic ones.

**Anti-tamper (defense in depth, not DRM theater):**
- The most valuable IP (learned thresholds, router/verifier models, semantic
  cache, cross-tenant optimizations, dashboards) lives **only** in the control
  plane and is never shipped — cracking the client loses the best part.
- Usage records are **signed by the SDK's service-account credentials**;
  server-side decisions (semantic hits, router calls we serve) are known to us
  directly, so value-based billing can't be inflated for those.
- Sampling/audit + anomaly detection on reported vs server-observed counts.

## 5. Metering & billing (Hyperswitch)

**What we meter** comes straight from the already-designed `SavingsReport`:
`calls.avoidedLlm`, `tokens.eliminated/compressed/providerCached`,
`cost.baselineEstimate/actual/netSavings`, per request, aggregated per `org_id`.

**Launch model — per-seat:**
- Active seats per org per month → Hyperswitch subscription (`$X/seat/month`).
- "Active seat" = a user/service-account that generated ≥1 optimized request in
  the period (definition configurable). Seat counts flow metering → billing.

**Upsell models (later, same telemetry):**
- **Metered:** price per 1k optimized decisions or per 1M optimized tokens.
- **Value-based:** a % of `netSavings` dollars. Requires server-verified savings
  (§4 anti-tamper). Strongest pitch: *"we bill a fraction of what we save you."*

**Billing pipeline:** metering service aggregates usage → billing service maps
to Hyperswitch plans/subscriptions → invoices, proration, dunning, tax. Failed
payment → license auto-downgrades to free tier at next validation (graceful).

## 6. Web & platform integration

**Marketing web (`apps/web`, Next.js):** landing, the four-ledger story, live
savings calculator (reuse the real `FormatSelector`/`SavingsLedger` in the
browser — genuine, not mocked), pricing page, docs, "self-host in 5 minutes",
EU-data-residency trust page. Deployable on Hetzner (Node) or Vercel; content is
static/SSR and provider-agnostic.

**Customer dashboard (`apps/dashboard`):**
- Savings analytics (from telemetry): avoided calls, four ledgers, cost saved,
  net savings %, by model/route/format, with the ablation view.
- License & API-key management, seat management, team/roles (Keycloak).
- Usage & billing (Hyperswitch portal embed): plan, invoices, payment method.
- Config: thresholds, which features are on, safety policies, knowledge epochs.

**BiVelio platform integration:**
- BV-SALA appears as a **product tile** in the BiVelio suite, single sign-on via
  Keycloak, **unified billing** via the shared Hyperswitch account, shared org
  model. A customer already on another BiVelio product enables BV-SALA without a
  second signup — this cross-sell is a major advantage of doing it in-platform.

## 7. Deployment topology & cost-to-serve (Hetzner)

**Services** run as containers on Hetzner dedicated/cloud (Docker Compose → K8s
as scale grows), fronted by a load balancer, with Postgres (system of record),
Redis (hot cache/rate limits), Qdrant (semantic vectors), and ClickHouse/
Timescale (analytics). IaC in `deploy/`.

**The 200k × $4 math (per-seat, Model 2):**
- Revenue: 200k seats × $4 = **$800k/mo ≈ $9.6M ARR**.
- Cost-to-serve: we move **no tokens**. Traffic to us = license checks (~1–24/
  day/seat) + telemetry batches + optional semantic lookups. Even at ~200M
  lightweight decisions/day (~2.3k req/s avg, higher peaks), this is a handful of
  Hetzner boxes + Postgres/Redis/Qdrant/ClickHouse ≈ **€3k–12k/month**.
- **Gross margin > 98%.** The economics only break if we ever proxy tokens
  (Model 3) — which the architecture deliberately avoids.

**Reliability:** control-plane outages must never take down customer production
→ the SDK's offline grace + local-tier fallback (§4) is the safety net. Target
control-plane availability is about *our* billing/telemetry integrity, not the
customer's request path.

### 7.1 Incremental infra scaling — you never pre-pay for scale

The €3k–12k/month figure above is the cost **at ~200k seats**, i.e. against
~$800k/month of revenue. **You do not pay that on day one.** Infra is
usage-proportional and revenue-proportional: you provision the next tier only
once the current one is already paid for by existing customers. Two structural
facts keep the early cost near zero:

1. **It starts on a single small box.** At design-partner scale everything
   (Keycloak, Postgres, the services, Qdrant, ClickHouse) co-locates in one
   Docker-Compose stack on one Hetzner Cloud VM.
2. **Marginal cost ≈ 0 because it's integrated into the BiVelio platform.**
   Keycloak, Hyperswitch and Qdrant already run for the BiVelio suite. BV-SALA's
   control-plane services are *added alongside* existing infra rather than a
   net-new cluster — so at launch you are mostly reusing what BiVelio already
   pays for.

Free self-hosted-tier customers also cost ~nothing: they run locally and only
hit us for lightweight license checks.

| Stage | Seats (paid) | Infra shape | ~Infra cost/mo | ~Revenue/mo (@$4) | Infra as % of revenue |
| --- | --- | --- | --- | --- | --- |
| **0 — Design partners** | 0–100 | 1 small Cloud VM, Docker Compose, all-in-one (or reuse existing BiVelio infra) | **€10–40** | $0–400 | covered by first handful of seats |
| **1 — Early traction** | 100–1,000 | 2–3 Cloud VMs (split DB), backups | **€50–200** | $400–4,000 | ~5% ↓ |
| **2 — Growth** | 1k–20k | Dedicated (AX) boxes, separate Postgres/Qdrant/ClickHouse, LB, Redis | **€300–1,500** | $4k–80k | ~2–4% |
| **3 — Scale** | 20k–200k | HA cluster, read replicas, sharded analytics | **€3k–12k** | $80k–800k | <1.5% |

The rule: **the scale-cost only appears with the scale-revenue.** At every stage
infra is a small, shrinking fraction of revenue, and the first paying customers
already cover the box they run on.

## 8. Security, privacy, compliance

- **Data minimization (headline promise):** raw prompts/completions never leave
  customer infra by default. Only counts/metadata reach us. This is contractual
  and enforced in `control-plane-client` (allowlist of fields).
- **EU residency** via Hetzner (Germany/Finland) — a genuine differentiator vs
  US-cloud competitors.
- **GDPR / DPA:** we are a processor of limited metadata; publish a DPA, ROPA,
  subprocessor list, retention windows. Tenant isolation already enforced in the
  cache-key design.
- **Secrets & keys:** license signing keys in an HSM/KMS; key rotation plan;
  service-account credential lifecycle.
- **Audit logs** for license issuance, plan changes, admin actions.
- **SOC 2 Type II** as an enterprise-tier milestone.

## 9. Pricing & packaging (framework; numbers TBD)

| Tier | Who | Includes | Billing |
| --- | --- | --- | --- |
| **Free (self-hosted)** | Individuals / evals | Local wins (exact cache, resolvers, format selector, strict output), capped volume, community support | $0 |
| **Pro** | Teams / startups | + semantic cache, learned thresholds, dashboards, telemetry, email support | **per-seat** (`$4`-ish launch anchor) |
| **Team** | Scaleups | + SSO, roles, higher caps, SLAs | per-seat + platform fee |
| **Enterprise** | Large orgs / regulated | + SAML, private/on-prem control plane, value-based option, SOC2, DPA, dedicated support | custom / value-based |

Note: `$4/seat` is a strong PLG anchor for individual devs; land-and-expand into
Team/Enterprise is where margin compounds. Pricing page + exact numbers are a
later workstream (as you said), but the packaging above is the structure.

## 10. Delivery roadmap (commercial, on top of the technical roadmap)

Technical Phases 3–6 (Adaptive-RAG retrieval, LLMLingua, semantic cache,
constrained-decoding backends) continue in parallel; the semantic cache (Phase
5) is also the first *managed* feature, so it's shared work.

| Milestone | Scope | Exit criteria |
| --- | --- | --- |
| **CP-0 Foundations** ✅ *(done)* | ✅ `packages/protocol` (wire types + `usageRecordFromReport`) · ✅ `packages/license-client` (offline Ed25519 verify + grace-period degrade + entitlements) · ✅ SDK `LicenseGate` wired into the pipeline (semantic cache & long-context compression are entitlement-gated) · ✅ `services/licensing` (issue/validate/revoke HTTP service) · ✅ `services/metering` (usage ingest + per-org aggregation HTTP service) | SDK boots with a signed license; entitlements gate features; SavingsReports map to usage records that land in the metering store — **all verified end-to-end** |
| **CP-1 Billing & signup** | Keycloak realm + org/seat model, Hyperswitch per-seat subscriptions, self-serve signup, pricing page, basic dashboard (savings + keys + billing) | A customer can sign up, get a license, install the SDK, see savings, and be billed per seat |
| **CP-2 Managed control plane** | `control-plane-client`, server-side semantic cache (Qdrant) + verifier, config/threshold distribution, format-decision cache; metered + value-based metering option (server-verified) | Managed features measurably beat local-only; value-based savings are tamper-resistant |
| **CP-3 Platform integration** | SSO across BiVelio suite, unified Hyperswitch billing, in-suite product tile, cross-sell | Existing BiVelio customers enable BV-SALA with one click, unified invoice |
| **CP-4 Enterprise & compliance** | SAML/OIDC federation, private/on-prem control plane, SLAs, SOC 2, DPA/ROPA | First enterprise contract closable on compliance + private deployment |

## 11. Open decisions & questions (for the later pricing/registration workstream)

- Exact price points per tier and the free-tier cap (requests/tokens/seats).
- "Active seat" definition for billing (any request vs threshold).
- Whether value-based billing launches at all, and the % if so.
- Analytics store choice (ClickHouse vs TimescaleDB) — both fit Hetzner.
- Web frontend host (Hetzner Node vs Vercel) — content is portable either way.
- Trial mechanics (time-boxed Pro vs feature-limited free).
- Support model & SLAs per tier.

## 12. Immediate next build step (proposed)

Start **CP-0** inside this repo: convert to a pnpm monorepo, add
`packages/protocol` + `packages/license-client` (offline signature verification,
entitlements, grace-period degrade) and wire a `LicenseClient` hook into the
existing pipeline so `semantic_cache` / `learned_thresholds` respect
entitlements. This is pure, testable code with no external dependency and turns
the library into a licensable product without touching customer request paths.
