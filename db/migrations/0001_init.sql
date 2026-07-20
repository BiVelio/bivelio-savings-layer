-- BV-SALA control-plane schema (Supabase Postgres)
-- PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.
--
-- Holds ONLY control-plane data: organizations, memberships, licenses,
-- subscriptions and usage rollups. It never stores prompts or completions —
-- the metering path carries counts/cost only (see @bivelio/protocol UsageRecord).
--
-- ISOLATED SCHEMA `bvsala`: the bound Supabase project is the SHARED BiVelio
-- platform database (its `public` schema belongs to another app). BV-SALA lives
-- entirely in its own `bvsala` schema so it can never collide with `public`,
-- while still sharing the project's `auth.users` (memberships FK into it).
--
-- Auth is Supabase Auth: users live in auth.users. Row-Level Security scopes
-- every read to the caller's organizations. Control-plane writes (issuing
-- licenses, ingesting usage) run with the service role, which bypasses RLS.

create extension if not exists pgcrypto;

create schema if not exists bvsala;

-- Expose the schema to the roles the Data API (PostgREST) authenticates as. RLS
-- still governs what anon/authenticated can actually see; service_role bypasses it.
grant usage on schema bvsala to anon, authenticated, service_role;
alter default privileges in schema bvsala grant all on tables to service_role;
alter default privileges in schema bvsala grant all on sequences to service_role;
alter default privileges in schema bvsala grant all on functions to anon, authenticated, service_role;
alter default privileges in schema bvsala grant select on tables to authenticated, anon;

-- ---------------------------------------------------------------------------
-- Organizations (tenants) and membership
-- ---------------------------------------------------------------------------
create table if not exists bvsala.organizations (
  id                 uuid primary key default gen_random_uuid(),
  name               text not null,
  plan               text not null default 'free'
                       check (plan in ('free','pro','team','enterprise')),
  stripe_customer_id text unique,
  created_at         timestamptz not null default now()
);

create table if not exists bvsala.org_members (
  org_id     uuid not null references bvsala.organizations(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  role       text not null default 'member'
               check (role in ('owner','admin','member','billing')),
  created_at timestamptz not null default now(),
  primary key (org_id, user_id)
);
create index if not exists org_members_user_idx on bvsala.org_members(user_id);

-- ---------------------------------------------------------------------------
-- Service accounts — machine identities the SDK uses to call the control plane.
-- Only the key HASH is stored; the plaintext key is shown once at creation.
-- ---------------------------------------------------------------------------
create table if not exists bvsala.service_accounts (
  id          uuid primary key default gen_random_uuid(),
  org_id      uuid not null references bvsala.organizations(id) on delete cascade,
  label       text not null,
  key_hash    text not null,          -- sha256 of the API key
  key_prefix  text not null,          -- first chars, for display ("bvk_ab12…")
  last_used_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists service_accounts_org_idx on bvsala.service_accounts(org_id);
create unique index if not exists service_accounts_hash_idx on bvsala.service_accounts(key_hash);

-- ---------------------------------------------------------------------------
-- Licenses (issued by the licensing service; token is the signed JWT-like blob)
-- ---------------------------------------------------------------------------
create table if not exists bvsala.licenses (
  id          uuid primary key default gen_random_uuid(),  -- == token jti
  org_id      uuid not null references bvsala.organizations(id) on delete cascade,
  plan        text not null check (plan in ('free','pro','team','enterprise')),
  seats       integer not null default 1,
  features    text[] not null default '{}',
  issued_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  grace_days  integer not null default 14,
  revoked     boolean not null default false,
  token       text not null,
  created_at  timestamptz not null default now()
);
create index if not exists licenses_org_idx on bvsala.licenses(org_id);

-- ---------------------------------------------------------------------------
-- Stripe subscriptions (per-seat billing)
-- ---------------------------------------------------------------------------
create table if not exists bvsala.subscriptions (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references bvsala.organizations(id) on delete cascade,
  stripe_subscription_id text unique,
  status                text not null default 'incomplete',
  seats                 integer not null default 1,
  current_period_end    timestamptz,
  created_at            timestamptz not null default now()
);
create index if not exists subscriptions_org_idx on bvsala.subscriptions(org_id);

-- ---------------------------------------------------------------------------
-- Usage rollups — daily aggregates fed by the metering service. This is what
-- the dashboard charts and what per-seat / metered billing reads.
-- ---------------------------------------------------------------------------
create table if not exists bvsala.usage_daily (
  org_id                        uuid not null references bvsala.organizations(id) on delete cascade,
  day                           date not null,
  requests                      bigint not null default 0,
  avoided_llm                   bigint not null default 0,
  actual_llm                    bigint not null default 0,
  eliminated_input_tokens       bigint not null default 0,
  compressed_input_tokens       bigint not null default 0,
  provider_cached_input_tokens  bigint not null default 0,
  baseline_cost                 numeric(14,6) not null default 0,
  actual_cost                   numeric(14,6) not null default 0,
  active_seats                  integer not null default 0,
  updated_at                    timestamptz not null default now(),
  primary key (org_id, day)
);

-- ---------------------------------------------------------------------------
-- Row-Level Security: a user only ever reads their own orgs' rows.
-- Control-plane services use the service role, which bypasses RLS for writes.
-- ---------------------------------------------------------------------------
create or replace function bvsala.is_org_member(target_org uuid)
returns boolean
language sql stable security definer set search_path = bvsala
as $$
  select exists (
    select 1 from bvsala.org_members m
    where m.org_id = target_org and m.user_id = auth.uid()
  );
$$;

alter table bvsala.organizations    enable row level security;
alter table bvsala.org_members      enable row level security;
alter table bvsala.service_accounts enable row level security;
alter table bvsala.licenses         enable row level security;
alter table bvsala.subscriptions    enable row level security;
alter table bvsala.usage_daily      enable row level security;

create policy org_read   on bvsala.organizations    for select using (bvsala.is_org_member(id));
create policy mem_read   on bvsala.org_members      for select using (bvsala.is_org_member(org_id));
create policy sa_read    on bvsala.service_accounts for select using (bvsala.is_org_member(org_id));
create policy lic_read   on bvsala.licenses         for select using (bvsala.is_org_member(org_id));
create policy sub_read   on bvsala.subscriptions    for select using (bvsala.is_org_member(org_id));
create policy usage_read on bvsala.usage_daily      for select using (bvsala.is_org_member(org_id));

-- Explicit grants (belt-and-suspenders alongside the default privileges above).
grant all    on all tables    in schema bvsala to service_role;
grant all    on all sequences in schema bvsala to service_role;
grant select on all tables    in schema bvsala to authenticated, anon;
