-- 0030 — TU PROPIO BANCO: la verificación A/B opcional del SDK, en tablas propias.
--
-- Con `verification: { sampleRate }` activado en createSavingsLayer, el SDK manda
-- una fracción de las peticiones elegibles OTRA VEZ, sin optimizar, al proveedor
-- del cliente (después de servir; la respuesta se descarta) y reporta el par
-- medido en los dos lados: lo que costó la copia sin capa y lo que costó la
-- petición optimizada, los dos del contador del proveedor. El panel lo enseña en
-- Prueba › Tu banco (suelo del IC 95 % por bootstrap estratificado) y el cliente
-- se descarga cada par en CSV.
--
-- DOCTRINA: instrumento, JAMÁS base. No toca la función de ingest de uso, sus
-- tablas diarias (total y por modelo), los estados de cuenta sellados ni ninguna columna
-- de dinero medido. Canal propio (/api/metering/verification), función propia,
-- tablas propias. Un par nunca puede caer en la función de uso: el ingest de uso
-- rechaza basis 'verification' (400), y test/banco-propio-nunca-factura.test.ts
-- prohíbe que facturación, cierre o extracto lean estas tablas. Este fichero no
-- nombra ninguna de aquéllas ni borra ninguna función (lo fija su test). Por qué no es base (veredicto de los jueces del
-- roadmap, 2026-09): extrapolar N·d_low cobra peticiones que nadie midió, no ve
-- las colas negativas raras y sobrecobra por construcción el 2,5 % de los
-- periodos; ninguna línea de la factura del proveedor respalda la cifra.
--
-- Orden independiente de 0029: re-ejecutar 0025/0029 NO la regresa, y ella no
-- regresa a ninguna. Aditiva e idempotente (if not exists / or replace / drop
-- policy if exists).
--
-- Diagnóstico: to_regclass('bvsala.verification_samples') is not null
--   and to_regclass('bvsala.verification_daily') is not null
--   and to_regprocedure('bvsala.ingest_verification_batch(uuid, text, jsonb, jsonb)') is not null
--   and to_regprocedure('bvsala.verification_summary(uuid, date, date)') is not null

do $$
begin
  if to_regclass('bvsala.organizations') is null
     or to_regprocedure('bvsala.is_org_member(uuid)') is null then
    raise exception '0030: base ausente (organizations / is_org_member)';
  end if;
end $$;

-- ── Las muestras: una fila por petición comprobada (el CSV del cliente) ──────
create table if not exists bvsala.verification_samples (
  org_id                        uuid           not null references bvsala.organizations(id) on delete cascade,
  request_id                    text           not null,
  day                           date           not null,
  at                            timestamptz    not null,
  sort_key                      text           not null,   -- md5(request_id): orden aleatorio para el submuestreo del informe
  stratum                       text           not null,
  outcome                       text           not null,
  requested_model               text           not null,
  served_model                  text           not null,
  cache_result                  text           not null,
  optimized_cost                numeric(20,10) not null,
  optimized_input_tokens        bigint         not null default 0,
  optimized_cached_input_tokens bigint         not null default 0,
  optimized_output_tokens       bigint         not null default 0,
  naive_cost                    numeric(20,10),
  naive_input_tokens            bigint,
  naive_cached_input_tokens     bigint,
  naive_output_tokens           bigint,
  naive_finish_reason           text,
  naive_contract                text,
  input_per_1k                  numeric(20,10) not null,
  cached_input_per_1k           numeric(20,10),
  output_per_1k                 numeric(20,10) not null,
  created_at                    timestamptz    not null default now(),
  primary key (org_id, request_id)
);
-- Único CHECK: ≥ 0 (doctrina 0011/0029: un CHECK que pudiera saltar revierte el lote entero).
alter table bvsala.verification_samples drop constraint if exists verification_samples_no_negatives;
alter table bvsala.verification_samples add constraint verification_samples_no_negatives check (
  optimized_cost >= 0 and optimized_input_tokens >= 0 and optimized_cached_input_tokens >= 0
  and optimized_output_tokens >= 0 and coalesce(naive_cost,0) >= 0 and coalesce(naive_input_tokens,0) >= 0
  and coalesce(naive_cached_input_tokens,0) >= 0 and coalesce(naive_output_tokens,0) >= 0
  and input_per_1k >= 0 and coalesce(cached_input_per_1k,0) >= 0 and output_per_1k >= 0);
create index if not exists verification_samples_org_day_request on bvsala.verification_samples (org_id, day, request_id);
create index if not exists verification_samples_org_sort        on bvsala.verification_samples (org_id, sort_key);
create index if not exists verification_samples_day_brin        on bvsala.verification_samples using brin (day);
alter table bvsala.verification_samples enable row level security;
drop policy if exists verification_samples_read on bvsala.verification_samples;
create policy verification_samples_read on bvsala.verification_samples for select using (bvsala.is_org_member(org_id));
grant select on bvsala.verification_samples to authenticated;
grant all    on bvsala.verification_samples to service_role;

-- ── Los recuentos: peticiones por día y por estrato o exclusión ─────────────
-- Son el N_h de la post-estratificación del informe (el peso de cada estrato) y
-- la tabla de exclusiones del panel. Solo cuentas.
create table if not exists bvsala.verification_daily (
  org_id   uuid   not null references bvsala.organizations(id) on delete cascade,
  day      date   not null,
  category text   not null,
  requests bigint not null default 0,
  primary key (org_id, day, category)
);
alter table bvsala.verification_daily drop constraint if exists verification_daily_no_negatives;
alter table bvsala.verification_daily add constraint verification_daily_no_negatives check (requests >= 0);
create index if not exists verification_daily_day_brin on bvsala.verification_daily using brin (day);
alter table bvsala.verification_daily enable row level security;
drop policy if exists verification_daily_read on bvsala.verification_daily;
create policy verification_daily_read on bvsala.verification_daily for select using (bvsala.is_org_member(org_id));
grant select on bvsala.verification_daily to authenticated;
grant all    on bvsala.verification_daily to service_role;

-- ── Idempotencia por lote: un reintento del SDK (mismo batchId) no cuenta dos veces ──
create table if not exists bvsala.verification_batches_seen (
  org_id   uuid        not null references bvsala.organizations(id) on delete cascade,
  batch_id text        not null,
  seen_at  timestamptz not null default now(),
  primary key (org_id, batch_id)
);
create index if not exists verification_batches_seen_brin on bvsala.verification_batches_seen using brin (seen_at);
alter table bvsala.verification_batches_seen enable row level security;   -- sin política: solo service_role
grant all on bvsala.verification_batches_seen to service_role;

-- ── El ingest propio. La ruta valida (lista blanca, apps/web/lib/verificacion/
-- wire.ts); esto solo escribe, atómico por lote. ───────────────────────────────
create or replace function bvsala.ingest_verification_batch(p_org uuid, p_batch_id text, p_samples jsonb, p_counts jsonb)
returns integer language plpgsql security definer set search_path = bvsala as $$
declare s jsonb; c jsonb; n integer := 0; k integer;
begin
  if p_org is null or coalesce(length(p_batch_id),0) = 0 then raise exception 'verification batch without org or id'; end if;
  if jsonb_typeof(p_samples) is distinct from 'array' or jsonb_typeof(p_counts) is distinct from 'array' then
    raise exception 'verification batch: samples and counts must be arrays'; end if;
  if jsonb_array_length(p_samples) > 500 or jsonb_array_length(p_counts) > 200 then
    raise exception 'verification batch too large'; end if;
  insert into bvsala.verification_batches_seen (org_id, batch_id) values (p_org, p_batch_id)
    on conflict (org_id, batch_id) do nothing;
  if not found then return 0; end if;   -- lote repetido (reintento): ya contado
  for s in select value from jsonb_array_elements(p_samples) loop
    insert into bvsala.verification_samples (org_id, request_id, day, at, sort_key, stratum, outcome,
      requested_model, served_model, cache_result, optimized_cost, optimized_input_tokens,
      optimized_cached_input_tokens, optimized_output_tokens, naive_cost, naive_input_tokens,
      naive_cached_input_tokens, naive_output_tokens, naive_finish_reason, naive_contract,
      input_per_1k, cached_input_per_1k, output_per_1k)
    values (p_org, s->>'requestId',
      (to_timestamp((s->>'at')::bigint / 1000.0) at time zone 'utc')::date,
      to_timestamp((s->>'at')::bigint / 1000.0), md5(s->>'requestId'),
      s->>'stratum', s->>'outcome', s->>'requestedModel', s->>'servedModel', s->>'cacheResult',
      (s->>'optimizedCost')::numeric, (s->>'optimizedInputTokens')::bigint,
      (s->>'optimizedCachedInputTokens')::bigint, (s->>'optimizedOutputTokens')::bigint,
      (s->>'naiveCost')::numeric, (s->>'naiveInputTokens')::bigint,
      (s->>'naiveCachedInputTokens')::bigint, (s->>'naiveOutputTokens')::bigint,
      s->>'naiveFinishReason', s->>'naiveContract',
      (s->>'inputPer1k')::numeric, (s->>'cachedInputPer1k')::numeric, (s->>'outputPer1k')::numeric)
    on conflict (org_id, request_id) do nothing;
    get diagnostics k = row_count; n := n + k;
  end loop;
  for c in select value from jsonb_array_elements(p_counts) loop
    insert into bvsala.verification_daily (org_id, day, category, requests)
    values (p_org, (c->>'day')::date, c->>'category', (c->>'requests')::bigint)
    on conflict (org_id, day, category) do update
      set requests = bvsala.verification_daily.requests + excluded.requests;
  end loop;
  return n;
end $$;
revoke all on function bvsala.ingest_verification_batch(uuid, text, jsonb, jsonb) from public, anon, authenticated;
grant execute on function bvsala.ingest_verification_batch(uuid, text, jsonb, jsonb) to service_role;

-- Resumen EXACTO del panel (recuentos por resultado y estrato, coste de las copias).
-- SECURITY INVOKER: corre con la RLS de quien consulta; un no-miembro recibe cero filas.
create or replace function bvsala.verification_summary(p_org uuid, p_from date, p_to date)
returns table (outcome text, stratum text, samples bigint, naive_cost numeric,
               naive_truncated bigint, naive_contract_missed bigint)
language sql stable security invoker set search_path = bvsala as $$
  select outcome, stratum, count(*)::bigint, coalesce(sum(naive_cost), 0),
         count(*) filter (where naive_finish_reason = 'length')::bigint,
         count(*) filter (where naive_contract = 'missed')::bigint
    from bvsala.verification_samples
   where org_id = p_org and day >= p_from and day <= p_to
   group by outcome, stratum
$$;
revoke all on function bvsala.verification_summary(uuid, date, date) from public, anon;
grant execute on function bvsala.verification_summary(uuid, date, date) to authenticated, service_role;
