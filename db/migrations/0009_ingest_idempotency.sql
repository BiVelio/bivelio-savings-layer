-- 0009 · Idempotencia del ingest: un reintento deja de duplicar dinero.
--
-- CONTEXTO. `UsageEmitter.flush` reencola el lote INTACTO ante un error de red o
-- un 5xx (src/metering/emitter.ts): el `Entry` conserva su `requestId` y su `at`,
-- así que la reentrega es idéntica byte a byte. Y `ingest_usage_batch` acumula
-- sin comprobar nada (`x = x + excluded.x`).
--
-- El caso que lo dispara no es exótico: el servidor procesa el lote, escribe las
-- filas y la respuesta 202 se pierde de vuelta (timeout, corte, balanceador). El
-- cliente no distingue eso de "no llegó", reintenta, y peticiones, tokens y
-- DÓLARES se cuentan dos veces. En un producto que factura por lo que mide, eso
-- es facturar de más.
--
-- El arreglo va en el servidor, no en el cliente: el cliente no puede saber si su
-- lote llegó. Se recuerda qué requestId ya se contabilizó y se salta el repetido.

-- ---------------------------------------------------------------------------
-- Registro de lo ya contabilizado.
-- ---------------------------------------------------------------------------
create table if not exists bvsala.usage_ingest_seen (
  org_id     uuid not null references bvsala.organizations(id) on delete cascade,
  request_id text not null,
  seen_at    timestamptz not null default now(),
  primary key (org_id, request_id)
);

-- Para la purga por antigüedad (abajo). La PK ya cubre la búsqueda por petición.
create index if not exists usage_ingest_seen_age_idx
  on bvsala.usage_ingest_seen (seen_at);

-- Misma postura que el resto del esquema: RLS activa y sin políticas, así que
-- solo el service_role (que la salta) la toca. Nadie más necesita verla.
alter table bvsala.usage_ingest_seen enable row level security;
revoke all on bvsala.usage_ingest_seen from anon, authenticated;
grant all on bvsala.usage_ingest_seen to service_role;

-- RETENCIÓN. La tabla crece con cada petición medida, así que hay que podarla.
-- No se hace aquí dentro: purgar en el camino caliente encarece cada ingest para
-- ganar poco. Un reintento ocurre en segundos o minutos, nunca en días, así que
-- una ventana de 30 días es holgadísima. Programar como tarea periódica:
--
--     delete from bvsala.usage_ingest_seen where seen_at < now() - interval '30 days';
--
-- Nota: mientras no exista esa tarea la tabla solo crece. Es una fila de ~60
-- bytes por petición medida; a un millón de peticiones al mes son ~60 MB/mes.

-- ---------------------------------------------------------------------------
-- La RPC, ahora idempotente.
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE, nunca DROP+CREATE: un DROP se llevaría por delante las ACL
-- que fijaron la 0005 y la 0007 (solo service_role ejecuta), y la función
-- volvería a nacer invocable con la anon key.
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
begin
  if jsonb_array_length(records) > 1000 then
    raise exception 'ingest_usage_batch: batch too large (% records, max 1000)',
      jsonb_array_length(records) using errcode = '54000';
  end if;

  for r in select * from jsonb_array_elements(records) loop
    rid := r->>'requestId';

    -- Puerta de idempotencia. Un requestId sin valor no se puede deduplicar, así
    -- que se rechaza el lote entero en vez de contarlo dos veces en silencio: el
    -- validador de la app ya lo exige, y aquí se cierra la puerta de atrás.
    if rid is null or rid = '' then
      raise exception 'ingest_usage_batch: record without requestId cannot be de-duplicated'
        using errcode = '22023'; -- invalid_parameter_value
    end if;

    insert into bvsala.usage_ingest_seen (org_id, request_id)
      values (p_org, rid)
      on conflict (org_id, request_id) do nothing;

    -- FOUND es false cuando el ON CONFLICT no insertó: ya se contabilizó esta
    -- petición, así que se salta. Es lo que convierte el reintento en inocuo.
    if not found then
      continue;
    end if;

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

  -- Recalcular active_seats UNA vez por día tocado, no una por registro.
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

  -- OJO, cambio de semántica: `n` cuenta los registros NUEVOS aplicados, no los
  -- recibidos. Un lote reentregado entero devuelve 0, que es exactamente la
  -- señal de "esto ya estaba contado". Hoy nadie lee este valor
  -- (apps/web/app/api/metering/usage/route.ts:51 solo mira el error).
  return n;
end;
$$;

grant execute on function bvsala.ingest_usage_batch(uuid, jsonb) to service_role;
