# db — BV-SALA control-plane schema (Supabase Postgres)

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.

SQL migrations for BV-SALA's control-plane data on **Supabase Postgres**
(BiVelio's existing platform database). Auth is **Supabase Auth** — users live
in `auth.users`; these tables reference them.

## Schema isolation — everything lives in `bvsala`

The bound project is the **shared** BiVelio platform DB: its `public` schema
belongs to another app (100+ tables, incl. a different `organizations`). So the
entire BV-SALA control plane lives in a dedicated **`bvsala`** schema — zero
collision with `public`, sharing only `auth.users`. Consequences:

- The Supabase clients set `db: { schema: "bvsala" }` (`lib/supabase/{admin,server}.ts`).
- `bvsala` must be in the project's **Exposed schemas** (Data API / PostgREST),
  otherwise `.from()`/`.rpc()` return a "schema not exposed" error.
- Functions (`is_org_member`, `ingest_usage_batch`, `billable_seats`) are `bvsala.*`.

## Tables

| Table | Purpose |
| --- | --- |
| `organizations` | Tenants; plan + Stripe customer id |
| `org_members` | User↔org membership + role (owner/admin/member/billing) |
| `service_accounts` | Machine identities the SDK uses to call the control-plane API (only the key **hash** is stored) |
| `licenses` | Issued signed licenses (mirrors the licensing service) |
| `revocations` | Append-only revocation ledger (`seq bigserial`, `jti unique`); the SDK's `GET /licenses/revocations` publishes `max(seq)` + all jti. Never deleted → the revision stays monotonic |
| `subscriptions` | Stripe per-seat subscriptions |
| `seat_activity` | Raw per-`(org, seat, day)` grain the SDK reports (counts + `is_ci` only). The billing basis: `billable_seats()` counts distinct non-CI seats active ≥3 days/month. Stores no content |
| `usage_daily` | Daily usage rollups (fed atomically by `ingest_usage_batch`) — what the dashboard charts and billing reads |
| `medir_altas` | Who claimed the free **Measure** license for which org (0032): PK `user_id` (one org per verified account), unique `org_id`, the email **domain** only, and the operator's `bloqueada` flag. Service role only |

## Data-minimization

No table can hold a prompt or completion. The metering path stores counts/cost
only (see `@bivelio/protocol` `UsageRecord`). This is the privacy invariant.

## Row-Level Security

RLS is on for every org-scoped table: a signed-in user reads only rows for orgs
they belong to (`is_org_member()` + `auth.uid()`). Control-plane services write
with the **service role**, which bypasses RLS.

## Apply

```bash
# via Supabase CLI (recommended)
supabase db push
# or paste db/migrations/0001_init.sql into the Supabase SQL editor
```

Migrations are additive and numbered; add `0002_*.sql`, etc.
