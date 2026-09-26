-- 0031 — LO MEDIDO POR REFERENCIA, TAMBIÉN POR ASIENTO: seat_activity gana el
-- carril reference_* y la RPC lo acumula al grano de asiento-día.
--
-- EL HUECO QUE CIERRA (#317, riesgo 8 de la especificación de comisión): 0029
-- abrió el carril basis='reference' en usage_daily, usage_daily_by_model y
-- reference_hits, pero dejó seat_activity SIN él («el dinero medido por asiento
-- lo infraestima; documentado»). Con el interruptor COMISIONAR_REFERENCIA
-- encendido, el titular y el extracto ya suman la referencia como medida, y la
-- tarjeta de máquinas y el aviso de versión (que leen seat_activity) no: una
-- máquina cuyo ahorro de la semana son repeticiones valoradas con el contador de
-- la petición idéntica salía con «0 € medidos» y el panel avisaba en ámbar de
-- que no producía. Ninguna ruta de facturación lee el dinero de seat_activity
-- (los asientos se cobran por días activos; la comisión sale de usage_daily),
-- así que esto NO cambia lo que se cobra.
--
-- DOCTRINA:
--   · measured_* LITERALES; `medido` no cambia. El carril va en sus TRES columnas
--     propias (reference_requests, reference_baseline_cost, reference_actual_cost),
--     con los mismos nombres que en usage_daily (0029) y con las MISMAS tres
--     expresiones `case when r->>'basis' = 'reference' …` que el bloque de
--     usage_daily: Σ por asiento = Σ por día, registro a registro. El interruptor
--     sigue viviendo en la web; la base de datos solo acumula, nunca decide.
--   · ADITIVA: tres columnas con default (las filas existentes quedan en 0) y otra
--     versión de la RPC. Ningún DROP de datos.
--   · SIN CHECK en seat_activity (misma doctrina que 0024): un CHECK que pudiera
--     saltar revierte el LOTE entero y reproduce el bucle 500+reencolado que curó
--     0011. La no negatividad la garantiza la verja del ingest por registro.
--   · DINERO EN numeric(20,10), por la misma razón que 0029: la RPC suma registro
--     a registro, Postgres redondea cada `excluded.*` a la escala de la columna y
--     un acierto por referencia vale micro-dólares. A 6 decimales el asiento
--     sumaría otra cifra que usage_daily y que el CSV de reference_hits.
--
-- GUARD DE PRECONDICIÓN: esta RPC es el cuerpo ENTERO de 0029 (que ya lleva el de
-- 0025, 0024 y 0022) cambiando SOLO el bloque de seat_activity. Si prod no está en
-- 0029, el cuerpo copiado haría 500 a TODO ingest (escribe reference_hits y
-- reference_* de usage_daily). Por eso el fichero ABORTA antes de tocar nada:
-- aplicar 0029 primero (runbook, regla 2: orden ascendente).
--
-- NUMERACIÓN: 0031 y no 0030 porque el PR #324 (banco propio,
-- 0030_banco_propio.sql) ya había tomado ese número cuando se escribió esta.
-- 0030 crea tablas propias y NO toca ingest_usage_batch, así que la base de esta
-- RPC sigue siendo 0029, y 0031 no depende de 0030: su guard solo exige 0029. Si
-- una migración posterior a 0029 llega a tocar la RPC antes que esta, hay que
-- rebasar este cuerpo sobre esa y ajustar test/migracion-0031.test.ts.
--
-- REGLA 1 del runbook: 0031 lleva versión de la RPC — re-ejecutar 0029 (o cualquier
-- anterior) DESPUÉS de esta la regresa EN SILENCIO: deja de acumularse la referencia
-- por asiento (solo eso: usage_daily, reference_hits y el extracto siguen igual),
-- y la tarjeta de máquinas vuelve a infraestimar sin que nadie vea un error. Si
-- pasa, re-aplicar SOLO el bloque de la función de 0031.
--
-- Orden de despliegue: 1º 0031 por Management API (runbook: diagnóstico primero,
-- hora PITR anotada, begin/commit, token por fichero jamás impreso); 2º la web que
-- lee las columnas. En cualquier orden es inocuo: la web tolera que falte 0031 (lee
-- en escalera sin las columnas y la referencia por asiento sale a 0), y la web
-- anterior no lee las columnas nuevas.
--
-- Diagnóstico (solo lectura) — las DOS deben salir true tras aplicar; la segunda
-- exige A LA VEZ la pieza de 0024, la de 0025, la de 0029 y la de 0031 en la RPC viva:
--   select exists(select 1 from information_schema.columns where table_schema='bvsala' and table_name='seat_activity' and column_name='reference_baseline_cost') as columna_0031,
--          exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bvsala' and p.proname='ingest_usage_batch'
--                   and p.prosrc like '%reference_hits%' and p.prosrc like '%seat_activity.reference_baseline_cost%'
--                   and p.prosrc like '%eliminatedInputFloorCost%' and p.prosrc like '%clientVersion%') as rpc_0031;

-- ---------------------------------------------------------------------------
-- 1. Guard: la base 0029 (y por tanto 0025/0024/0022) tiene que estar. Abortar
--    es el resultado BUENO.
-- ---------------------------------------------------------------------------
do $$ begin
  if to_regclass('bvsala.reference_hits') is null
     or not exists (select 1 from information_schema.columns where table_schema='bvsala' and table_name='usage_daily' and column_name='reference_baseline_cost')
     or not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='bvsala' and p.proname='ingest_usage_batch'
                       and p.prosrc like '%reference_hits%' and p.prosrc like '%eliminatedInputFloorCost%' and p.prosrc like '%clientVersion%')
  then raise exception '0031: base 0029 ausente — aplicar 0029 antes, en orden ascendente'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. seat_activity: el carril medido por referencia por asiento-día. Con default
--    para que las filas existentes (y las que escriba la RPC de 0029 en la ventana
--    de despliegue) queden bien definidas: 0 peticiones, 0 dólares. Sin CHECK.
-- ---------------------------------------------------------------------------
alter table bvsala.seat_activity
  add column if not exists reference_requests      bigint         not null default 0,
  add column if not exists reference_baseline_cost numeric(20,10) not null default 0,
  add column if not exists reference_actual_cost   numeric(20,10) not null default 0;

-- ---------------------------------------------------------------------------
-- 3. La RPC, versión 0031. CREATE OR REPLACE sustituye el cuerpo ENTERO, así que
--    aquí se reproduce el de 0029 COMPLETO, byte a byte, cambiando SOLO el bloque
--    de seat_activity (tres columnas nuevas al final del insert y sus tres
--    acumulaciones al final del conflict; measured_* intactas). Lo que hay que
--    revisar es el cuerpo contra 0029, no el diff (doctrina de 0015:70-79) —
--    test/migracion-0031.test.ts lo compara línea a línea fuera de ese bloque.
--    Nunca DROP+CREATE: se perdería el grant a service_role.
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

    insert into bvsala.usage_ingest_seen (org_id, request_id)
      values (p_org, rid)
      on conflict (org_id, request_id) do nothing;
    if not found then
      continue;
    end if;

    d := (to_timestamp((r->>'at')::bigint / 1000.0) at time zone 'UTC')::date;

    -- 0021 · el carril sombra: hipotético por construcción. Solo shadow_*;
    -- cero en requests/avoided/actual/tokens/measured, nada en seat_activity
    -- ni usage_sessions ni usage_daily_by_model ni en el recuento de active_seats.
    -- El requestId del gateway lleva sufijo ':shadow' para no chocar en
    -- usage_ingest_seen con el registro medido de la MISMA petición.
    if r->>'basis' = 'shadow' then
      insert into bvsala.usage_daily (org_id, day, requests, shadow_requests, shadow_baseline_cost, shadow_actual_cost)
        values (p_org, d, 0, 1,
                coalesce((r->>'baselineCost')::numeric, 0),
                coalesce((r->>'actualCost')::numeric, 0))
      on conflict (org_id, day) do update set
        shadow_requests = bvsala.usage_daily.shadow_requests + excluded.shadow_requests,
        shadow_baseline_cost = bvsala.usage_daily.shadow_baseline_cost + excluded.shadow_baseline_cost,
        shadow_actual_cost = bvsala.usage_daily.shadow_actual_cost + excluded.shadow_actual_cost,
        updated_at = now();
      n := n + 1;
      continue;
    end if;

    medido := case when r->>'basis' = 'measured' then 1 else 0 end;
    days := days || d;

    -- 0024 · versión del cliente y dinero medido por asiento. `clientVersion`
    -- lo sella el servidor desde la cabecera (jamás viene del cuerpo); NULL o
    -- '' = ese registro no declaró versión. min/max por orden SEMVER vía
    -- semver_key, NUNCA lexicográfico (0.10.0 > 0.4.16); un NULL nunca pisa un
    -- valor guardado, y un valor guardado que no casara el patrón cede ante uno
    -- que sí (semver_key NULL). El dinero medido es el mismo fold que usage_daily.
    -- 0031 · + lo medido POR REFERENCIA por asiento, en sus tres columnas propias al
    -- final (reference_*), con las MISMAS tres expresiones que el bloque de usage_daily.
    -- measured_* siguen LITERALES: la referencia jamás se multiplica por `medido`.
    insert into bvsala.seat_activity (org_id, seat_id, day, requests, is_ci, last_seen_at,
                                      client_version_min, client_version_max, requests_sin_version,
                                      measured_baseline_cost, measured_actual_cost,
                                      reference_requests, reference_baseline_cost, reference_actual_cost)
      values (p_org, coalesce(nullif(r->>'seatId',''), 'unknown'), d, 1,
              coalesce((r->>'ci')::boolean, false), now(),
              nullif(r->>'clientVersion',''), nullif(r->>'clientVersion',''),
              case when nullif(r->>'clientVersion','') is null then 1 else 0 end,
              medido * coalesce((r->>'baselineCost')::numeric, 0),
              medido * coalesce((r->>'actualCost')::numeric, 0),
              case when r->>'basis' = 'reference' then 1 else 0 end,
              case when r->>'basis' = 'reference' then coalesce((r->>'baselineCost')::numeric, 0) else 0 end,
              case when r->>'basis' = 'reference' then coalesce((r->>'actualCost')::numeric, 0) else 0 end)
      on conflict (org_id, seat_id, day) do update set
        requests = bvsala.seat_activity.requests + 1,
        last_seen_at = now(),
        client_version_min = case
          when excluded.client_version_min is null then bvsala.seat_activity.client_version_min
          when bvsala.seat_activity.client_version_min is null then excluded.client_version_min
          when bvsala.semver_key(bvsala.seat_activity.client_version_min) is null then excluded.client_version_min
          when bvsala.semver_key(excluded.client_version_min) < bvsala.semver_key(bvsala.seat_activity.client_version_min) then excluded.client_version_min
          else bvsala.seat_activity.client_version_min end,
        client_version_max = case
          when excluded.client_version_max is null then bvsala.seat_activity.client_version_max
          when bvsala.seat_activity.client_version_max is null then excluded.client_version_max
          when bvsala.semver_key(bvsala.seat_activity.client_version_max) is null then excluded.client_version_max
          when bvsala.semver_key(excluded.client_version_max) > bvsala.semver_key(bvsala.seat_activity.client_version_max) then excluded.client_version_max
          else bvsala.seat_activity.client_version_max end,
        requests_sin_version   = bvsala.seat_activity.requests_sin_version + excluded.requests_sin_version,
        measured_baseline_cost = bvsala.seat_activity.measured_baseline_cost + excluded.measured_baseline_cost,
        measured_actual_cost   = bvsala.seat_activity.measured_actual_cost + excluded.measured_actual_cost,
        reference_requests      = bvsala.seat_activity.reference_requests + excluded.reference_requests,
        reference_baseline_cost = bvsala.seat_activity.reference_baseline_cost + excluded.reference_baseline_cost,
        reference_actual_cost   = bvsala.seat_activity.reference_actual_cost + excluded.reference_actual_cost;

    -- 0025 · el carril del borrado del proveedor va en sus DOS columnas propias
    -- al final: `eliminatedInputFloorCost` (suelo a precio de lectura de caché,
    -- ya recortado por la verja del ingest) y una acreditada si ese suelo > 0.
    -- measured_* siguen siendo EXACTAMENTE las de 0022/0024: el suelo jamás
    -- entra ahí (ni multiplicado por `medido` ni de ninguna otra forma).
    -- 0029 · + el carril MEDIDO POR REFERENCIA en sus tres columnas propias al final (reference_*).
    -- measured_* siguen LITERALES: `medido` no cambia y un registro 'reference' suma a
    -- requests/avoided/tokens/baseline/actual exactamente como un estimated.
    insert into bvsala.usage_daily (
      org_id, day, requests, avoided_llm, actual_llm,
      eliminated_input_tokens, compressed_input_tokens, provider_cached_input_tokens,
      baseline_input_tokens, actual_input_tokens, baseline_output_tokens, actual_output_tokens,
      baseline_cost, actual_cost,
      measured_requests, measured_baseline_cost, measured_actual_cost,
      eliminated_floor_cost, eliminated_credited_requests,
      reference_requests, reference_baseline_cost, reference_actual_cost
    ) values (
      p_org, d, 1,
      coalesce((r->>'avoidedLlm')::bigint, 0), coalesce((r->>'actualLlm')::bigint, 0),
      coalesce((r->>'eliminatedInputTokens')::bigint, 0), coalesce((r->>'compressedInputTokens')::bigint, 0),
      coalesce((r->>'providerCachedInputTokens')::bigint, 0),
      coalesce((r->>'baselineInputTokens')::bigint, 0), coalesce((r->>'actualInputTokens')::bigint, 0),
      coalesce((r->>'baselineOutputTokens')::bigint, 0), coalesce((r->>'actualOutputTokens')::bigint, 0),
      coalesce((r->>'baselineCost')::numeric, 0), coalesce((r->>'actualCost')::numeric, 0),
      medido,
      medido * coalesce((r->>'baselineCost')::numeric, 0),
      medido * coalesce((r->>'actualCost')::numeric, 0),
      coalesce((r->>'eliminatedInputFloorCost')::numeric, 0),
      case when coalesce((r->>'eliminatedInputFloorCost')::numeric, 0) > 0 then 1 else 0 end,
      case when r->>'basis' = 'reference' then 1 else 0 end,
      case when r->>'basis' = 'reference' then coalesce((r->>'baselineCost')::numeric, 0) else 0 end,
      case when r->>'basis' = 'reference' then coalesce((r->>'actualCost')::numeric, 0) else 0 end
    )
    on conflict (org_id, day) do update set
      requests = bvsala.usage_daily.requests + excluded.requests,
      avoided_llm = bvsala.usage_daily.avoided_llm + excluded.avoided_llm,
      actual_llm = bvsala.usage_daily.actual_llm + excluded.actual_llm,
      eliminated_input_tokens = bvsala.usage_daily.eliminated_input_tokens + excluded.eliminated_input_tokens,
      compressed_input_tokens = bvsala.usage_daily.compressed_input_tokens + excluded.compressed_input_tokens,
      provider_cached_input_tokens = bvsala.usage_daily.provider_cached_input_tokens + excluded.provider_cached_input_tokens,
      baseline_input_tokens = bvsala.usage_daily.baseline_input_tokens + excluded.baseline_input_tokens,
      actual_input_tokens = bvsala.usage_daily.actual_input_tokens + excluded.actual_input_tokens,
      baseline_output_tokens = bvsala.usage_daily.baseline_output_tokens + excluded.baseline_output_tokens,
      actual_output_tokens = bvsala.usage_daily.actual_output_tokens + excluded.actual_output_tokens,
      baseline_cost = bvsala.usage_daily.baseline_cost + excluded.baseline_cost,
      actual_cost = bvsala.usage_daily.actual_cost + excluded.actual_cost,
      measured_requests = bvsala.usage_daily.measured_requests + excluded.measured_requests,
      measured_baseline_cost = bvsala.usage_daily.measured_baseline_cost + excluded.measured_baseline_cost,
      measured_actual_cost = bvsala.usage_daily.measured_actual_cost + excluded.measured_actual_cost,
      eliminated_floor_cost = bvsala.usage_daily.eliminated_floor_cost + excluded.eliminated_floor_cost,
      eliminated_credited_requests = bvsala.usage_daily.eliminated_credited_requests + excluded.eliminated_credited_requests,
      reference_requests = bvsala.usage_daily.reference_requests + excluded.reference_requests,
      reference_baseline_cost = bvsala.usage_daily.reference_baseline_cost + excluded.reference_baseline_cost,
      reference_actual_cost = bvsala.usage_daily.reference_actual_cost + excluded.reference_actual_cost,
      updated_at = now();

    -- 0022 · desglose por modelo. Mismo tráfico no-sombra que usage_daily (la
    -- sombra ya hizo `continue`), agregado por (org, día, modelo). 'unknown'
    -- agrupa lo que llegó sin modelo. Aditivo: suma cifras que usage_daily ya
    -- contabiliza, en una tabla aparte — no toca los CHECK de usage_daily.
    -- 0025 · + los tokens borrados por el proveedor y su suelo, POR MODELO.
    -- 0029 · + las peticiones y el baseline medidos por referencia, POR MODELO.
    insert into bvsala.usage_daily_by_model (
      org_id, day, model,
      requests, baseline_cost, actual_cost, actual_input_tokens, actual_output_tokens,
      eliminated_input_tokens, eliminated_floor_cost, reference_requests, reference_baseline_cost, updated_at
    ) values (
      p_org, d, coalesce(nullif(r->>'model', ''), 'unknown'),
      1,
      coalesce((r->>'baselineCost')::numeric, 0),
      coalesce((r->>'actualCost')::numeric, 0),
      coalesce((r->>'actualInputTokens')::bigint, 0),
      coalesce((r->>'actualOutputTokens')::bigint, 0),
      coalesce((r->>'eliminatedInputTokens')::bigint, 0),
      coalesce((r->>'eliminatedInputFloorCost')::numeric, 0),
      case when r->>'basis' = 'reference' then 1 else 0 end,
      case when r->>'basis' = 'reference' then coalesce((r->>'baselineCost')::numeric, 0) else 0 end,
      now()
    )
    on conflict (org_id, day, model) do update set
      requests = bvsala.usage_daily_by_model.requests + excluded.requests,
      baseline_cost = bvsala.usage_daily_by_model.baseline_cost + excluded.baseline_cost,
      actual_cost = bvsala.usage_daily_by_model.actual_cost + excluded.actual_cost,
      actual_input_tokens = bvsala.usage_daily_by_model.actual_input_tokens + excluded.actual_input_tokens,
      actual_output_tokens = bvsala.usage_daily_by_model.actual_output_tokens + excluded.actual_output_tokens,
      eliminated_input_tokens = bvsala.usage_daily_by_model.eliminated_input_tokens + excluded.eliminated_input_tokens,
      eliminated_floor_cost = bvsala.usage_daily_by_model.eliminated_floor_cost + excluded.eliminated_floor_cost,
      reference_requests = bvsala.usage_daily_by_model.reference_requests + excluded.reference_requests,
      reference_baseline_cost = bvsala.usage_daily_by_model.reference_baseline_cost + excluded.reference_baseline_cost,
      updated_at = now();
    -- 0029 · una fila por acierto medido por referencia (CSV del cliente). Idempotente.
    if r->>'basis' = 'reference' then
      insert into bvsala.reference_hits (
        org_id, request_id, day, model, cache_result, reference_request_id, reference_at,
        baseline_input_tokens, baseline_output_tokens, baseline_cost
      ) values (
        p_org, rid, d, coalesce(nullif(r->>'model', ''), 'unknown'), coalesce(r->>'cacheResult', ''),
        nullif(r->>'referenceRequestId', ''),
        case when r->>'referenceAt' is null then null
             else to_timestamp(((r->>'referenceAt')::double precision) / 1000.0) end,
        coalesce((r->>'baselineInputTokens')::bigint, 0),
        coalesce((r->>'baselineOutputTokens')::bigint, 0),
        coalesce((r->>'baselineCost')::numeric, 0)
      )
      on conflict (org_id, request_id) do nothing;
    end if;

    -- 0019 · atribución por sesión/subagente. Solo si el registro la trae; un
    -- registro sin sessionId (SDK, gateway viejo) no crea filas aquí. agent_id
    -- '' agrupa al agente principal.
    if coalesce(nullif(r->>'sessionId', ''), '') <> '' then
      insert into bvsala.usage_sessions (
        org_id, day, session_id, agent_id,
        requests, actual_llm, actual_input_tokens, actual_output_tokens, actual_cost, last_seen_at
      ) values (
        p_org, d, r->>'sessionId', coalesce(nullif(r->>'agentId', ''), ''),
        1,
        coalesce((r->>'actualLlm')::bigint, 0),
        coalesce((r->>'actualInputTokens')::bigint, 0),
        coalesce((r->>'actualOutputTokens')::bigint, 0),
        coalesce((r->>'actualCost')::numeric, 0),
        now()
      )
      on conflict (org_id, day, session_id, agent_id) do update set
        requests = bvsala.usage_sessions.requests + excluded.requests,
        actual_llm = bvsala.usage_sessions.actual_llm + excluded.actual_llm,
        actual_input_tokens = bvsala.usage_sessions.actual_input_tokens + excluded.actual_input_tokens,
        actual_output_tokens = bvsala.usage_sessions.actual_output_tokens + excluded.actual_output_tokens,
        actual_cost = bvsala.usage_sessions.actual_cost + excluded.actual_cost,
        last_seen_at = now();
    end if;

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
