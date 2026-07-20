-- BV-SALA control-plane schema — 0003: seat metering (per-seat billing basis)
-- PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.
--
-- Lives in the isolated `bvsala` schema (see 0001). The SDK reports counts-only
-- usage tagged with a per-machine seatId. We store the RAW seat-day grain so a
-- billable-seat count can be computed over a whole billing period — which CANNOT
-- be recovered by summing usage_daily.active_seats ints.
--
-- Seat model (LOCKED 2026-07-20, industry-grounded): a seat is a distinct, active,
-- server-deduped MACHINE identity; it is BILLABLE only if active on >= 3 distinct
-- days in a calendar month (Snyk / Datadog-CI activity-threshold pattern), and CI /
-- ephemeral identities (is_ci) are excluded. Content never lands here — seat_id is a
-- pattern-constrained identity string, every other column a typed number.

create table if not exists bvsala.seat_activity (
  org_id        uuid not null references bvsala.organizations(id) on delete cascade,
  seat_id       text not null,
  day           date not null,
  requests      bigint not null default 0,
  is_ci         boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_seen_at  timestamptz not null default now(),
  primary key (org_id, seat_id, day)
);
create index if not exists seat_activity_org_day_idx on bvsala.seat_activity (org_id, day);

alter table bvsala.seat_activity enable row level security;
-- Members read their own org's seat activity (dashboard); writes go only through the
-- SECURITY DEFINER RPC below (service-role), so no anon/authenticated write policy.
create policy seat_activity_read on bvsala.seat_activity for select using (bvsala.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- Atomic ingest: fold a batch of usage records into seat_activity + usage_daily.
-- Additive upserts make concurrent (serverless cold-start) writers race-safe. The
-- day is the UTC calendar day of the record's `at` (unix ms). active_seats is the
-- day's distinct NON-CI seats. SECURITY DEFINER so the Vercel route (service role)
-- can call it; org is passed by the caller (server-derived from the SA key).
-- ---------------------------------------------------------------------------
create or replace function bvsala.ingest_usage_batch(p_org uuid, records jsonb)
returns integer
language plpgsql
security definer
set search_path = bvsala
as $$
declare
  r jsonb;
  d date;
  n integer := 0;
begin
  for r in select * from jsonb_array_elements(records) loop
    d := (to_timestamp((r->>'at')::bigint / 1000.0) at time zone 'UTC')::date;

    insert into bvsala.seat_activity (org_id, seat_id, day, requests, is_ci, last_seen_at)
      values (p_org, coalesce(nullif(r->>'seatId',''), 'unknown'), d, 1,
              coalesce((r->>'ci')::boolean, false), now())
      on conflict (org_id, seat_id, day) do update
        set requests = bvsala.seat_activity.requests + 1, last_seen_at = now();

    insert into bvsala.usage_daily (
      org_id, day, requests, avoided_llm, actual_llm,
      eliminated_input_tokens, compressed_input_tokens, provider_cached_input_tokens,
      baseline_cost, actual_cost
    ) values (
      p_org, d, 1,
      coalesce((r->>'avoidedLlm')::bigint, 0), coalesce((r->>'actualLlm')::bigint, 0),
      coalesce((r->>'eliminatedInputTokens')::bigint, 0), coalesce((r->>'compressedInputTokens')::bigint, 0),
      coalesce((r->>'providerCachedInputTokens')::bigint, 0),
      coalesce((r->>'baselineCost')::numeric, 0), coalesce((r->>'actualCost')::numeric, 0)
    )
    on conflict (org_id, day) do update set
      requests = bvsala.usage_daily.requests + excluded.requests,
      avoided_llm = bvsala.usage_daily.avoided_llm + excluded.avoided_llm,
      actual_llm = bvsala.usage_daily.actual_llm + excluded.actual_llm,
      eliminated_input_tokens = bvsala.usage_daily.eliminated_input_tokens + excluded.eliminated_input_tokens,
      compressed_input_tokens = bvsala.usage_daily.compressed_input_tokens + excluded.compressed_input_tokens,
      provider_cached_input_tokens = bvsala.usage_daily.provider_cached_input_tokens + excluded.provider_cached_input_tokens,
      baseline_cost = bvsala.usage_daily.baseline_cost + excluded.baseline_cost,
      actual_cost = bvsala.usage_daily.actual_cost + excluded.actual_cost,
      updated_at = now();

    update bvsala.usage_daily set active_seats = (
      select count(distinct seat_id) from bvsala.seat_activity
      where org_id = p_org and day = d and not is_ci
    ) where org_id = p_org and day = d;

    n := n + 1;
  end loop;
  return n;
end;
$$;

-- Billable seats for an org in the month containing p_month: distinct NON-CI seats
-- active on >= 3 distinct days. This is what reconciliation compares to the paid
-- subscription quantity (and what the fair-use / true-up logic reads).
create or replace function bvsala.billable_seats(p_org uuid, p_month date)
returns integer
language sql
stable
security definer
set search_path = bvsala
as $$
  select count(*)::int from (
    select seat_id
    from bvsala.seat_activity
    where org_id = p_org
      and not is_ci
      and day >= date_trunc('month', p_month)
      and day <  date_trunc('month', p_month) + interval '1 month'
    group by seat_id
    having count(distinct day) >= 3
  ) s;
$$;

grant all on all tables    in schema bvsala to service_role;
grant all on all sequences in schema bvsala to service_role;
grant select on all tables in schema bvsala to authenticated, anon;
