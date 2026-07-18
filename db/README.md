# db — BV-SALA control-plane schema (Supabase Postgres)

> PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.

SQL migrations for BV-SALA's control-plane data on **Supabase Postgres**
(BiVelio's existing platform database). Auth is **Supabase Auth** — users live
in `auth.users`; these tables reference them.

## Tables

| Table | Purpose |
| --- | --- |
| `organizations` | Tenants; plan + Stripe customer id |
| `org_members` | User↔org membership + role (owner/admin/member/billing) |
| `service_accounts` | Machine identities the SDK uses to call the control-plane API (only the key **hash** is stored) |
| `licenses` | Issued signed licenses (mirrors the licensing service) |
| `subscriptions` | Stripe per-seat subscriptions |
| `usage_daily` | Daily usage rollups fed by the metering service — what the dashboard charts and billing reads |

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
