-- BV-SALA billing (Stripe) — migration 0004
-- PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.
--
-- Adds the tables + columns the Stripe checkout/webhook flow needs, on top of
-- 0001 (organizations, subscriptions, licenses), 0002 (revocations) and 0003
-- (metering). Run in the bvsala-bound Supabase project's SQL editor. Writes come
-- from the service_role webhook (bypasses RLS + has GRANT ALL); authenticated
-- users only read their own org's subscription.

-- ---------------------------------------------------------------------------
-- 1. Stripe event idempotency ledger — dedupe redelivered webhooks by event.id.
-- ---------------------------------------------------------------------------
create table if not exists bvsala.stripe_events (
  id           text primary key,          -- Stripe event id (evt_…)
  type         text not null,
  received_at  timestamptz not null default now(),
  payload      jsonb
);

-- ---------------------------------------------------------------------------
-- 2. Append-only billing audit — one row per handled webhook branch (finance trail).
-- ---------------------------------------------------------------------------
create table if not exists bvsala.billing_audit (
  id        bigserial primary key,
  org_id    uuid,
  event_id  text,
  kind      text not null,   -- checkout | sub_upsert | sub_deleted | invoice_paid | invoice_failed | reissue | revoke
  detail    jsonb,
  at        timestamptz not null default now()
);
create index if not exists billing_audit_org_idx on bvsala.billing_audit(org_id, at);

-- ---------------------------------------------------------------------------
-- 3. Flesh out subscriptions to mirror Stripe (0001 shipped a thin version).
--    Upserts target the existing UNIQUE stripe_subscription_id.
-- ---------------------------------------------------------------------------
alter table bvsala.subscriptions add column if not exists stripe_customer_id   text;
alter table bvsala.subscriptions add column if not exists stripe_item_id       text;
alter table bvsala.subscriptions add column if not exists price_id             text;
alter table bvsala.subscriptions add column if not exists plan                 text;
alter table bvsala.subscriptions add column if not exists current_period_start timestamptz;
alter table bvsala.subscriptions add column if not exists cancel_at_period_end boolean not null default false;
alter table bvsala.subscriptions add column if not exists canceled_at          timestamptz;
alter table bvsala.subscriptions add column if not exists past_due_since       timestamptz;
alter table bvsala.subscriptions add column if not exists updated_at           timestamptz not null default now();

-- ---------------------------------------------------------------------------
-- 4. Organizations: opt-in prorated seat autoscale + a billing-contact email.
-- ---------------------------------------------------------------------------
alter table bvsala.organizations add column if not exists seat_autoscale boolean not null default false;
alter table bvsala.organizations add column if not exists billing_email  text;

-- ---------------------------------------------------------------------------
-- 5. Licenses: link to the paying subscription + Stripe invoice + supersession.
--    (id stays a uuid PK == token jti; Stripe mints bare-uuid jtis so they fit.)
-- ---------------------------------------------------------------------------
alter table bvsala.licenses add column if not exists subscription_id   uuid references bvsala.subscriptions(id) on delete set null;
alter table bvsala.licenses add column if not exists stripe_invoice_id text;
alter table bvsala.licenses add column if not exists superseded_at     timestamptz;
create index if not exists licenses_org_active_idx on bvsala.licenses(org_id) where not revoked;

-- ---------------------------------------------------------------------------
-- 6. Fix the latent RLS bug from 0001: sub_read passed the subscription row's
--    OWN id to is_org_member (should be org_id), so authenticated users could
--    never read their own subscription through PostgREST.
-- ---------------------------------------------------------------------------
drop policy if exists sub_read on bvsala.subscriptions;
create policy sub_read on bvsala.subscriptions for select using (bvsala.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- 7. Protect the billing ledgers: RLS on, NO select policy → only the
--    service_role (BYPASSRLS) reads/writes them. Grants belt-and-suspenders.
-- ---------------------------------------------------------------------------
alter table bvsala.stripe_events enable row level security;
alter table bvsala.billing_audit enable row level security;
grant all on bvsala.stripe_events to service_role;
grant all on bvsala.billing_audit to service_role;
grant usage, select on sequence bvsala.billing_audit_id_seq to service_role;
