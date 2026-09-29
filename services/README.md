# services — BV-SALA control plane (Hetzner)

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.

Control-plane services. Customers self-host the **SDK** (data plane); their LLM
traffic never passes through here. These services carry licensing and
billing-telemetry only — **counts and metadata, never prompts or completions**.

Each service is split into a transport-agnostic core (`src/service.ts`, unit
tested) and a thin HTTP adapter (`src/server.ts`). Persistence is in-memory in
this CP-0 skeleton; production swaps in Postgres (system of record), Qdrant
(vectors), and ClickHouse/Timescale (analytics), behind Keycloak.

## licensing (`@bivelio/licensing-service`, default :8081)

Issues, validates and revokes Ed25519-signed licenses. The private signing key
lives only here; the SDK embeds the public key to verify **offline**.

```
GET  /health
GET  /public-key                     → { publicKey }              (embed in the SDK)
POST /licenses/issue                 { orgId, plan, seats, features, termDays?, graceDays? } → { token, payload }
POST /licenses/issue-measure         { orgId } → { token, payload }   (free «Measure» license: shadow mode, no features)
POST /licenses/validate              { token } → { status, entitlements }
POST /licenses/revoke                { jti }   → { revoked: true }
```

A `measure` license (the free «Measure» plan, see `docs/LICENCIA-MEDIR.md`) is
normalized on issue whatever the caller sends: no features, seats capped at
`MEASURE_LIMITS.seats`, and its real term in `measure_expires_at` — the classic
`expires_at` is set to `issued_at`, so a verifier that predates shadow mode sees it
expired and fails closed instead of running un-gated levers for free.

`ADMIN_TOKEN` (bearer) protects issue/revoke when set. `LICENSE_PRIVATE_KEY` /
`LICENSE_PUBLIC_KEY` (PEM) provide a stable keypair; otherwise an ephemeral one
is generated at boot and its public key is logged.

## metering (`@bivelio/metering-service`, default :8082)

Ingests usage records derived from the SDK's `SavingsReport` via
`usageRecordFromReport` (in `@bivelio/protocol`) and maintains per-org
aggregates that feed billing.

```
GET  /health
POST /usage                          UsageRecord | UsageRecord[] → { ingested }
GET  /usage/:orgId/summary           → { requests, avoidedLlm, activeSeats, savedCost, byCacheResult, … }
```

`INGEST_TOKEN` (bearer) protects ingest when set.

## Run locally

```bash
pnpm --filter @bivelio/licensing-service dev   # http://localhost:8081
pnpm --filter @bivelio/metering-service  dev   # http://localhost:8082
```

## Data-minimization invariant

`UsageRecord` has no field capable of holding prompt or completion text. The
control plane is structurally unable to receive customer content — this is both
the privacy promise and the reason cost-to-serve stays tiny.
