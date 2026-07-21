-- BV-SALA — migration 0006: harden bvsala.ingest_usage_batch (DoS cap + O(batch) fix)
-- PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.
--
-- Two follow-ups from the leak/scale sweep, both in the metering ingest RPC:
--
--  1. DoS defense-in-depth (deferred by 0005): the records array was uncapped.
--     0005 already revoked EXECUTE from anon/authenticated so the only caller is
--     the service_role metering route (which itself caps at 1000, see
--     apps/web/lib/metering/usage.ts). This adds the same hard cap at the DB layer
--     so even a buggy/compromised service path can't submit an unbounded batch
--     against the SHARED prod DB.
--
--  2. O(batch) amplification: the active_seats recompute (a full COUNT(DISTINCT
--     seat_id) scan of seat_activity) ran ONCE PER RECORD inside the loop — N
--     records => N scans. Because it was a FULL recount each iteration, only the
--     last iteration's value ever survived, so moving it to a single set-based
--     statement per touched day is BEHAVIOR-IDENTICAL but O(days) instead of
--     O(records).
--
-- ⚠️ Use CREATE OR REPLACE (never DROP+CREATE): it preserves the function owner and
-- the 0005 ACLs (EXECUTE revoked from public/anon/authenticated, granted to
-- service_role). A DROP+CREATE would reset EXECUTE to the Postgres PUBLIC default
-- and RE-OPEN the 0005 hole.

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
  days date[] := array[]::date[];
begin
  -- Hard cap (fail CLOSED). jsonb_array_length is STRICT: NULL -> NULL, so a NULL or
  -- empty array skips the guard and returns 0 exactly as before; a non-array scalar
  -- still errors inside jsonb_array_length (never a silent ingest). Keep this in
  -- lockstep with the app cap in apps/web/lib/metering/usage.ts.
  if jsonb_array_length(records) > 1000 then
    raise exception 'ingest_usage_batch: batch too large (% records, max 1000)',
      jsonb_array_length(records) using errcode = '54000'; -- program_limit_exceeded
  end if;

  for r in select * from jsonb_array_elements(records) loop
    d := (to_timestamp((r->>'at')::bigint / 1000.0) at time zone 'UTC')::date;
    days := days || d;

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

    n := n + 1;
  end loop;

  -- Recompute active_seats ONCE per touched day (set-based), not once per record.
  -- One correlated COUNT(DISTINCT) per distinct touched day; a day whose only
  -- activity is CI seats correctly recomputes to 0 (COUNT over zero rows = 0),
  -- matching the prior per-record behavior.
  if array_length(days, 1) is not null then
    update bvsala.usage_daily u
       set active_seats = (
         select count(distinct sa.seat_id) from bvsala.seat_activity sa
          where sa.org_id = p_org and sa.day = u.day and not sa.is_ci
       ),
       updated_at = now()
     where u.org_id = p_org and u.day = any(days);
  end if;

  return n;
end;
$$;
