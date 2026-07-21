-- BV-SALA — migration 0005: LOCK DOWN the bvsala Data-API functions (CRITICAL security fix)
-- PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.
--
-- ⚠️ RUN THIS ASAP. 0001_init.sql line 26 blanket-granted EXECUTE on ALL bvsala
-- functions to anon + authenticated, and Postgres also grants EXECUTE to PUBLIC by
-- default. Because the bvsala schema is exposed over PostgREST, ANYONE holding the
-- public anon key (it ships in the browser bundle) can call the SECURITY DEFINER
-- functions directly:
--   POST /rest/v1/rpc/ingest_usage_batch   (Content-Profile: bvsala)  { p_org, records }
-- p_org is caller-controlled, so this BYPASSES the bvk_ Bearer auth on
-- /api/metering/usage and lets anyone forge seat_activity/usage_daily for ANY org
-- (billing bypass + fabricated "proof" numbers), and the uncapped records array is a
-- DoS on the SHARED prod database. billable_seats is likewise readable by anyone
-- (leaks each org's paid-seat count). This locks both to service_role only.

-- 1. Stop AUTO-granting every future bvsala function to anon/authenticated (root cause).
alter default privileges in schema bvsala revoke all on functions from anon, authenticated;

-- 2. Revoke EXECUTE on the caller-controlled SECURITY DEFINER functions from every
--    non-privileged role (public covers the Postgres default grant).
revoke execute on function bvsala.ingest_usage_batch(uuid, jsonb) from public, anon, authenticated;
revoke execute on function bvsala.billable_seats(uuid, date)       from public, anon, authenticated;

-- 3. They are only ever invoked by the service_role (the bvk_-authenticated metering
--    route derives p_org server-side; reconciliation runs server-side too).
grant execute on function bvsala.ingest_usage_batch(uuid, jsonb) to service_role;
grant execute on function bvsala.billable_seats(uuid, date)       to service_role;

-- NOTE: bvsala.is_org_member(uuid) is intentionally LEFT callable — it is used inside
-- the RLS policies and only ever reports membership of the CURRENT auth.uid(), so it
-- is not exploitable with a caller-supplied argument.
--
-- FOLLOW-UP (defense in depth, separate change): add a hard `jsonb_array_length(records)`
-- cap inside ingest_usage_batch so even a service_role caller can't submit an unbounded
-- batch, and keep all ingestion behind the bvk_-authenticated /api/metering/usage route.
