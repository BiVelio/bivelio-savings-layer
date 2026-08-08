-- 0010 · Separar el dinero MEDIDO del ESTIMADO en los agregados.
--
-- CONTEXTO. El SDK ya distingue de dónde sale cada baseline
-- (SavingsReport.cost.basis):
--
--   measured   — reconstruido desde el contador del proveedor. Es dinero, y el
--                cliente puede contrastarlo con su factura.
--   estimated  — la llamada se EVITÓ, así que nunca hubo contador del proveedor
--                y el baseline sale del estimador local. Es la mejor cifra
--                disponible, pero no está medida.
--   unmeasured — el proveedor no reportó uso. No se reclama nada.
--
-- Pero `usage_daily` tiene un solo par baseline_cost/actual_cost, así que al
-- agregar se suman los tres en la misma cifra y el panel enseña un "$X
-- ahorrado" que mezcla lo comprobable con lo modelado. Es exactamente lo que el
-- campo `basis` existe para impedir.
--
-- Se añaden columnas paralelas SOLO para la parte medida. Las existentes se
-- quedan como el total (compatibilidad: nada de lo que ya lee la tabla se
-- rompe), y el panel puede enseñar "de los cuales, medidos: $Y".

alter table bvsala.usage_daily
  add column if not exists measured_requests      bigint        not null default 0,
  add column if not exists measured_baseline_cost numeric(14,6) not null default 0,
  add column if not exists measured_actual_cost   numeric(14,6) not null default 0;

-- El dominio también aplica a las columnas nuevas (ver 0008). NOT VALID por la
-- misma razón: no escanear la tabla al desplegar.
alter table bvsala.usage_daily
  add constraint usage_daily_measured_no_negatives check (
    measured_requests      >= 0 and
    measured_baseline_cost >= 0 and
    measured_actual_cost   >= 0
  ) not valid;

-- Lo medido nunca puede exceder al total: es un subconjunto.
alter table bvsala.usage_daily
  add constraint usage_daily_measured_is_subset check (
    measured_requests <= requests
  ) not valid;

-- ---------------------------------------------------------------------------
-- La RPC, ahora repartiendo por `basis`.
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE, nunca DROP+CREATE: un DROP se llevaría las ACL de 0005 /
-- 0007 y la función volvería a nacer invocable con la anon key.
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
  rid text;
  medido integer;
begin
  if jsonb_array_length(records) > 1000 then
    raise exception 'ingest_usage_batch: batch too large (% records, max 1000)',
      jsonb_array_length(records) using errcode = '54000';
  end if;

  for r in select * from jsonb_array_elements(records) loop
    rid := r->>'requestId';
    if rid is null or rid = '' then
      raise exception 'ingest_usage_batch: record without requestId cannot be de-duplicated'
        using errcode = '22023';
    end if;

    -- Idempotencia (0009): un reintento no vuelve a contar.
    insert into bvsala.usage_ingest_seen (org_id, request_id)
      values (p_org, rid)
      on conflict (org_id, request_id) do nothing;
    if not found then
      continue;
    end if;

    -- Solo "measured" cuenta como dinero comprobable. Un registro sin `basis`
    -- viene de un SDK anterior a este cambio: se cuenta en el total y NO en lo
    -- medido, que es la lectura conservadora y la correcta.
    medido := case when r->>'basis' = 'measured' then 1 else 0 end;

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
      baseline_cost, actual_cost,
      measured_requests, measured_baseline_cost, measured_actual_cost
    ) values (
      p_org, d, 1,
      coalesce((r->>'avoidedLlm')::bigint, 0), coalesce((r->>'actualLlm')::bigint, 0),
      coalesce((r->>'eliminatedInputTokens')::bigint, 0), coalesce((r->>'compressedInputTokens')::bigint, 0),
      coalesce((r->>'providerCachedInputTokens')::bigint, 0),
      coalesce((r->>'baselineCost')::numeric, 0), coalesce((r->>'actualCost')::numeric, 0),
      medido,
      medido * coalesce((r->>'baselineCost')::numeric, 0),
      medido * coalesce((r->>'actualCost')::numeric, 0)
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
      measured_requests = bvsala.usage_daily.measured_requests + excluded.measured_requests,
      measured_baseline_cost = bvsala.usage_daily.measured_baseline_cost + excluded.measured_baseline_cost,
      measured_actual_cost = bvsala.usage_daily.measured_actual_cost + excluded.measured_actual_cost,
      updated_at = now();

    n := n + 1;
  end loop;

  if array_length(days, 1) is not null then
    update bvsala.usage_daily u
       set active_seats = (
             select count(distinct s.seat_id)
             from bvsala.seat_activity s
             where s.org_id = u.org_id and s.day = u.day and not s.is_ci
           ),
           updated_at = now()
     where u.org_id = p_org
       and u.day = any (select distinct unnest(days));
  end if;

  return n;
end;
$$;

grant execute on function bvsala.ingest_usage_batch(uuid, jsonb) to service_role;
