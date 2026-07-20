-- BV-SALA control-plane schema — 0002: revocation ledger
-- PROPRIETARY AND CONFIDENTIAL — © 2026 BiVelio Inc. All Rights Reserved.
--
-- The SDK's revocation call-home (GET /licenses/revocations) reads this ledger,
-- signs it, and serves it. It is APPEND-ONLY: a revocation is a permanent fact, so
-- the published revision (`seq`) is genuinely monotonic and never rolls back — the
-- exact contract the client enforces (it rejects any list whose seq drops, and
-- treats the revoked set as sticky). NEVER delete from this table; re-revoking a
-- jti is a no-op (unique). The endpoint publishes seq = max(seq), revoked = all jti.

create table if not exists revocations (
  seq        bigserial primary key,     -- monotonic revision; published as the list `seq`
  jti        text not null unique,      -- revoked license id (== the license token jti)
  org_id     uuid references organizations(id) on delete set null,
  reason     text,
  revoked_at timestamptz not null default now()
);

-- Locked down: only the service role reads/writes this (the Vercel route uses the
-- service role, bypassing RLS). No policies => no anon/authenticated access. The
-- list is public anyway via the SIGNED endpoint — integrity comes from the Ed25519
-- signature, not from row visibility.
alter table revocations enable row level security;
