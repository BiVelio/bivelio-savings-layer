-- 0032 — EL AHORRO NATIVO: la caché de prefijo DEL PROVEEDOR, en su carril propio y
-- FUERA de la comisión.
--
-- EL HUECO: desde #260 la capa no acredita el descuento de la caché de prefijo (es del
-- proveedor, no suyo), pero con Anthropic es la mayor parte del ahorro real (GSM8K con
-- Sonnet 5: 75 % medido, ~0,13 $ de 0,24 $ del prefijo; el informe propio declaraba
-- −0,0009 $). El cliente veía menos ahorro del que tenía y el panel no cuadraba con su
-- factura. DECISIÓN DEL DUEÑO: «mostrar el ahorro de la caché de prefijo del proveedor
-- aparte, sin comisión».
--
-- EL CARRIL: el SDK y el gateway publican `report.nativeSavings` (contador del proveedor
-- a precio de lista) y el emisor manda DOS cifras no negativas por registro:
--   · `nativeCacheReadSavings`  = leídos × (entrada − lectura cacheada), USD
--   · `nativeCacheWritePremium` = escritos × entrada × (prima − 1), USD
-- El NETO (lectura − prima) lo resta la web: aquí solo se acumulan no-negativos.
--
-- DOCTRINA — «del proveedor: se enseña, JAMÁS se cobra»:
--   · Columnas PROPIAS (native_cache_read_savings, native_cache_write_premium,
--     native_requests) en usage_daily y las dos de dólar en usage_daily_by_model.
--   · baseline_cost, actual_cost y measured_* quedan LITERALES a 0031:
--     test/migracion-0032.test.ts compara la RPC línea a línea fuera de los dos
--     bloques que cambian y afirma que ninguna expresión native entra en measured_*.
--   · NO HAY INTERRUPTOR para cobrarlo. apps/web/lib/billing/extracto.ts no lee estas
--     columnas y su test (extracto-carril-nativo.test.ts) afirma que la comisión no se
--     mueve ni un céntimo con un carril nativo enorme.
--   · numeric(20,10), como 0029/0031: la RPC suma registro a registro y una lectura de
--     caché vale micro-dólares; a 6 decimales se perdería.
--   · EL ÚNICO CHECK: ≥ 0 en usage_daily (la verja del ingest ya rechaza el signo y
--     recorta el dominio, así que no puede saltar con un lote que pasó la verja). Sin
--     CHECK en usage_daily_by_model (doctrina de 0024/0025).
--   · ADITIVA: columnas con default 0 y otra versión de la RPC. Ningún DROP de datos.
--
-- GUARD DE PRECONDICIÓN: esta RPC es el cuerpo ENTERO de 0031 (que lleva el de 0029,
-- 0025, 0024 y 0022) cambiando SOLO el bloque de usage_daily y el de
-- usage_daily_by_model. Si prod no está en 0031, el cuerpo copiado haría 500 a TODO
-- ingest (escribe seat_activity.reference_*). Por eso ABORTA antes de tocar nada.
--
-- NUMERACIÓN: si otra migración toma 0032 antes de fusionar esta, renumerar y rebasar
-- el cuerpo sobre la RPC de esa (y ajustar test/migracion-0032.test.ts).
--
-- REGLA 1 del runbook: 0032 lleva versión de la RPC — re-ejecutar 0031 (o anterior)
-- DESPUÉS de esta la regresa EN SILENCIO: deja de acumularse el ahorro nativo y la
-- tarjeta «Ahorro nativo activado» desaparece como si no hubiera caché. Si pasa,
-- re-aplicar SOLO el bloque de la función de 0032.
--
-- ORDEN DE DESPLIEGUE (doctrina emitter.ts: un 4xx del ingest descarta el lote SIN
-- reintento; npm es inmutable):
--   1º 0032 por Management API (runbook: diagnóstico primero, hora PITR anotada,
--      begin/commit, token por fichero jamás impreso).
--   2º `vercel --prod`: la lista blanca acepta los dos campos (OPCIONALES: un cliente
--      anterior sigue en 202) y el panel lee las columnas (en escalera: sin 0032 la
--      tarjeta no sale y el resto del panel sigue).
--   3º SOLO ENTONCES el npm cuyo emisor manda los campos: contra una web sin la lista
--      blanca, el lote entero da 400 y se pierde.
-- Migración antes que web no es obligatorio para no romper (la RPC de 0031 ignora las
-- claves: solo se PIERDE el dólar nativo hasta aplicarla); web antes que npm SÍ.
--
-- Diagnóstico (solo lectura) — las DOS deben salir true tras aplicar:
--   select exists(select 1 from information_schema.columns where table_schema='bvsala' and table_name='usage_daily' and column_name='native_cache_read_savings') as columna_0032,
--          exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bvsala' and p.proname='ingest_usage_batch'
--                   and p.prosrc like '%nativeCacheReadSavings%' and p.prosrc like '%seat_activity.reference_baseline_cost%'
--                   and p.prosrc like '%reference_hits%' and p.prosrc like '%eliminatedInputFloorCost%' and p.prosrc like '%clientVersion%') as rpc_0032;

-- ---------------------------------------------------------------------------
-- 1. Guard: la base 0031 (y por tanto 0029/0025/0024/0022) tiene que estar.
--    Abortar es el resultado BUENO.
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema='bvsala' and table_name='seat_activity' and column_name='reference_baseline_cost')
     or not exists (select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
                     where n.nspname='bvsala' and p.proname='ingest_usage_batch'
                       and p.prosrc like '%seat_activity.reference_baseline_cost%' and p.prosrc like '%reference_hits%'
                       and p.prosrc like '%eliminatedInputFloorCost%' and p.prosrc like '%clientVersion%')
  then raise exception '0032: base 0031 ausente — aplicar 0031 antes, en orden ascendente'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. usage_daily: el carril del ahorro nativo. Con default para que las filas
--    existentes (y las que escriba la RPC de 0031 en la ventana de despliegue)
--    queden bien definidas: 0 dólares, 0 peticiones.
-- ---------------------------------------------------------------------------
alter table bvsala.usage_daily
  add column if not exists native_cache_read_savings  numeric(20,10) not null default 0,
  add column if not exists native_cache_write_premium numeric(20,10) not null default 0,
  add column if not exists native_requests            bigint         not null default 0;

alter table bvsala.usage_daily
  drop constraint if exists usage_daily_native_no_negatives;
alter table bvsala.usage_daily
  add constraint usage_daily_native_no_negatives check (
    native_cache_read_savings  >= 0 and
    native_cache_write_premium >= 0 and
    native_requests            >= 0
  );

-- ---------------------------------------------------------------------------
-- 3. usage_daily_by_model: el mismo carril al grano de modelo — el panel lo
--    agrupa por proveedor. Sin CHECK (doctrina de 0024/0025).
-- ---------------------------------------------------------------------------
alter table bvsala.usage_daily_by_model
  add column if not exists native_cache_read_savings  numeric(20,10) not null default 0,
  add column if not exists native_cache_write_premium numeric(20,10) not null default 0;

-- ---------------------------------------------------------------------------
-- 4. La RPC, versión 0032. CREATE OR REPLACE sustituye el cuerpo ENTERO: aquí va
--    el de 0031 COMPLETO cambiando SOLO el bloque de usage_daily (tres columnas
--    nuevas al final, measured_* intactas) y el de usage_daily_by_model (dos
--    columnas nuevas). Lo que hay que revisar es el cuerpo contra 0031, no el
--    diff — test/migracion-0032.test.ts lo compara línea a línea fuera de esos
--    bloques. Nunca DROP+CREATE: se perdería el grant a service_role.
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
    -- 0032 · + el AHORRO NATIVO de la caché del proveedor en sus tres columnas propias al
    -- final (native_*). Jamás en baseline_cost/actual_cost ni en measured_*: la caché es
    -- del proveedor y no es comisionable.
    insert into bvsala.usage_daily (
      org_id, day, requests, avoided_llm, actual_llm,
      eliminated_input_tokens, compressed_input_tokens, provider_cached_input_tokens,
      baseline_input_tokens, actual_input_tokens, baseline_output_tokens, actual_output_tokens,
      baseline_cost, actual_cost,
      measured_requests, measured_baseline_cost, measured_actual_cost,
      eliminated_floor_cost, eliminated_credited_requests,
      reference_requests, reference_baseline_cost, reference_actual_cost,
      native_cache_read_savings, native_cache_write_premium, native_requests
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
      case when r->>'basis' = 'reference' then coalesce((r->>'actualCost')::numeric, 0) else 0 end,
      coalesce((r->>'nativeCacheReadSavings')::numeric, 0),
      coalesce((r->>'nativeCacheWritePremium')::numeric, 0),
      case when coalesce((r->>'nativeCacheReadSavings')::numeric, 0) > 0
             or coalesce((r->>'nativeCacheWritePremium')::numeric, 0) > 0 then 1 else 0 end
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
      native_cache_read_savings = bvsala.usage_daily.native_cache_read_savings + excluded.native_cache_read_savings,
      native_cache_write_premium = bvsala.usage_daily.native_cache_write_premium + excluded.native_cache_write_premium,
      native_requests = bvsala.usage_daily.native_requests + excluded.native_requests,
      updated_at = now();

    -- 0022 · desglose por modelo. Mismo tráfico no-sombra que usage_daily (la
    -- sombra ya hizo `continue`), agregado por (org, día, modelo). 'unknown'
    -- agrupa lo que llegó sin modelo. Aditivo: suma cifras que usage_daily ya
    -- contabiliza, en una tabla aparte — no toca los CHECK de usage_daily.
    -- 0025 · + los tokens borrados por el proveedor y su suelo, POR MODELO.
    -- 0029 · + las peticiones y el baseline medidos por referencia, POR MODELO.
    -- 0032 · + el ahorro nativo de la caché del proveedor, POR MODELO (y por tanto por proveedor).
    insert into bvsala.usage_daily_by_model (
      org_id, day, model,
      requests, baseline_cost, actual_cost, actual_input_tokens, actual_output_tokens,
      eliminated_input_tokens, eliminated_floor_cost, reference_requests, reference_baseline_cost,
      native_cache_read_savings, native_cache_write_premium, updated_at
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
      coalesce((r->>'nativeCacheReadSavings')::numeric, 0),
      coalesce((r->>'nativeCacheWritePremium')::numeric, 0),
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
      native_cache_read_savings = bvsala.usage_daily_by_model.native_cache_read_savings + excluded.native_cache_read_savings,
      native_cache_write_premium = bvsala.usage_daily_by_model.native_cache_write_premium + excluded.native_cache_write_premium,
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
