-- 0025 — el DINERO de la elisión del proveedor, a precio SUELO y en carril PROPIO.
--
-- EL HUECO: usage_daily cuenta desde 0015 los tokens que el proveedor borró
-- (eliminated_input_tokens: el conteo de `applied_edits` que la petición trae
-- de vuelta), pero ese conteo no tenía dinero. El panel decía «solo un conteo;
-- su valor se estima en la sombra», y eso deja de ser verdad: el gateway
-- (B2, posterior a 0.4.16) manda por registro `eliminatedInputFloorCost`, el
-- valor de esos tokens al precio de LECTURA de caché del modelo
-- (cachedInputPer1k del catálogo — JAMÁS inputPer1k: la lectura es lo MÍNIMO
-- que esos tokens habrían costado en cada turno siguiente; de ahí «suelo»).
--
-- DOCTRINA — «conteo del proveedor, precio suelo nuestro; jamás en measured_*»:
--   · Carril PROPIO (eliminated_floor_cost, eliminated_credited_requests), como
--     shadow_* en 0021. Se GUARDA el dólar, el panel enseña SOLO el conteo, y
--     nada de esto entra en measured_baseline_cost / measured_actual_cost ni en
--     la base de la comisión. El interruptor vive en la web
--     (COMISIONAR_ELISION_SUELO = false, apps/web/lib/billing/tarifa.ts, con
--     test que lo ancla): la base de datos solo acumula, nunca decide.
--   · POR QUÉ NO SE ENSEÑA EN EUROS: el suelo es el BRUTO del turno (lectura
--     evitada) sin restar la invalidación de prefijo que el MISMO corte provoca
--     en el mismo turno; la evidencia congelada da opus-4-8 NETO negativo.
--     Un dólar que el cliente no puede contrastar contra su factura no se pinta
--     (doctrina del recibo). El dinero llegará cuando el NETO por modelo esté
--     medido con el mecanismo real.
--   · measured_requests / measured_baseline_cost / measured_actual_cost quedan
--     LITERALES a 0022/0024 — test/migracion-0025.test.ts lo afirma línea a línea.
--   · `eliminated_credited_requests`: registros con suelo > 0, es decir, en los
--     que NUESTROS diales cambiaron la petición y el proveedor borró. El gateway
--     solo manda suelo > 0 cuando el borrado es atribuible a nuestros diales.
--   · usage_daily_by_model gana eliminated_input_tokens y eliminated_floor_cost:
--     sin ellos el suelo no se puede auditar POR MODELO, que es justo donde la
--     elisión sale neta negativa en unos y positiva en otros.
--   · EL ÚNICO CHECK ADMISIBLE: ≥ 0 en las dos columnas nuevas de usage_daily.
--     La verja del ingest (apps/web/lib/metering/usage.ts) ya rechaza un suelo
--     negativo y RECORTA el «dinero sin conteo» a 0, así que este CHECK no puede
--     saltar con un lote que pasó la verja. Un CHECK que pudiera fallar
--     revertiría el LOTE entero y reproduciría el bucle 500+reencolado que 0011
--     curó — por eso no hay ningún otro (ni «suelo ≤ tokens × precio»: el
--     servidor no conoce precios; esa cota es del techo de la verja).
--
-- GUARD DE PRECONDICIÓN: esta RPC es el cuerpo ENTERO de 0024 (que ya lleva el
-- de 0022 y el upsert ampliado de seat_activity con la versión del cliente y el
-- dinero medido por asiento) + las adiciones de este fichero. Si prod NO está
-- en 0024 (falta seat_activity.client_version_min o la RPC no menciona
-- 'clientVersion'), el cuerpo copiado haría 500 a TODO ingest (plpgsql resuelve
-- las columnas al ejecutar, no al crear) y el emisor descartaría lotes al
-- superar maxBuffer. Por eso el fichero ABORTA antes de tocar nada: aplicar
-- 0024 primero (runbook, regla 2: orden ascendente). Regla 1 del runbook: 0025
-- lleva versión de la RPC — re-ejecutar 0024 (o cualquier anterior) DESPUÉS de
-- esta la regresa en silencio: dejarían de acumularse el suelo y las
-- acreditadas, y el panel ocultaría la tarjeta como si nadie tuviera la palanca.
--
-- Orden de despliegue (doctrina emitter.ts: un 4xx del ingest descarta el lote
-- SIN reintento; npm es inmutable):
--   1º 0024 y ESTA migración por Management API, en la misma sesión y en orden
--      ascendente (runbook: diagnóstico primero, hora PITR anotada, begin/commit,
--      token por fichero jamás impreso).
--   2º `vercel --prod` desde la raíz del repo: la lista blanca del ingest acepta
--      `eliminatedInputFloorCost` (OPCIONAL: un 0.4.16 sigue en 202) y el panel
--      lee las columnas nuevas.
--   3º SOLO ENTONCES npm con un gateway que emita el campo (B2). Es el único
--      campo de CUERPO nuevo de todo el plan: contra una web sin la lista blanca
--      desplegada, el lote entero da 400 y se pierde.
-- Migración antes que web no es obligatorio para no romper (la RPC de 0022/0024
-- ignora la clave: solo se PIERDE el dólar hasta aplicarla); web antes que npm SÍ.
--
-- Diagnóstico (solo lectura) — las dos deben salir true tras aplicar; la
-- segunda exige A LA VEZ la pieza de 0024 y la de 0025 en la RPC final:
--   select exists(select 1 from information_schema.columns
--                 where table_schema='bvsala' and table_name='usage_daily'
--                   and column_name='eliminated_floor_cost') as columna_0025,
--          exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--                 where n.nspname='bvsala' and p.proname='ingest_usage_batch'
--                   and p.prosrc like '%eliminatedInputFloorCost%'
--                   and p.prosrc like '%clientVersion%') as rpc_0025;

-- ---------------------------------------------------------------------------
-- 1. Guard: la base 0024 (y por tanto 0021/0022) tiene que estar. Abortar es
--    el resultado BUENO.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('bvsala.usage_daily_by_model') is null
     or not exists (
       select 1 from information_schema.columns
        where table_schema = 'bvsala' and table_name = 'seat_activity'
          and column_name = 'client_version_min')
     or not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'bvsala' and p.proname = 'ingest_usage_batch'
          and p.prosrc like '%clientVersion%')
  then
    raise exception '0025: base 0024 ausente — aplicar 0021/0022/0024 antes, en orden ascendente';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. usage_daily: el carril del borrado del proveedor. Con default para que
--    las filas existentes (y las que escriba la RPC de 0024 en la ventana de
--    despliegue) queden bien definidas: 0 dólares, 0 acreditadas.
-- ---------------------------------------------------------------------------
alter table bvsala.usage_daily
  add column if not exists eliminated_floor_cost        numeric(14,6) not null default 0,
  add column if not exists eliminated_credited_requests bigint        not null default 0;

alter table bvsala.usage_daily
  drop constraint if exists usage_daily_elision_floor_no_negatives;
-- Ninguna de las dos puede ser negativa. Es el único CHECK: la verja del
-- ingest ya garantiza ≥ 0 por registro, y la suma de no-negativos no baja de 0.
alter table bvsala.usage_daily
  add constraint usage_daily_elision_floor_no_negatives check (
    eliminated_floor_cost        >= 0 and
    eliminated_credited_requests >= 0
  );

-- ---------------------------------------------------------------------------
-- 3. usage_daily_by_model: el mismo carril al grano de modelo, para poder
--    auditar dónde el suelo compensa y dónde no. Sin CHECK (misma razón que
--    0024: ninguna cifra puede ser negativa por construcción).
-- ---------------------------------------------------------------------------
alter table bvsala.usage_daily_by_model
  add column if not exists eliminated_input_tokens bigint        not null default 0,
  add column if not exists eliminated_floor_cost   numeric(14,6) not null default 0;

-- ---------------------------------------------------------------------------
-- 4. La RPC, versión 0025. CREATE OR REPLACE sustituye el cuerpo ENTERO, así
--    que aquí se reproduce el de 0024 COMPLETO (tope de lote, requestId
--    obligatorio, idempotencia usage_ingest_seen, carril sombra que hace
--    `continue`, seat_activity con versión min/max + sin_version + dinero
--    medido por asiento, usage_daily con tokens y measured_*, fold por modelo
--    en usage_daily_by_model, usage_sessions, recuento de active_seats)
--    cambiando SOLO dos bloques: el insert/conflict de usage_daily (dos
--    columnas nuevas al final, measured_* intactas) y el fold por modelo (dos
--    columnas nuevas). Lo que hay que revisar es el cuerpo contra 0024, no el
--    diff (doctrina de 0015:70-79) — test/migracion-0025.test.ts lo compara
--    línea a línea fuera de esos bloques. Nunca DROP+CREATE: se perdería el
--    grant a service_role.
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
    insert into bvsala.seat_activity (org_id, seat_id, day, requests, is_ci, last_seen_at,
                                      client_version_min, client_version_max, requests_sin_version,
                                      measured_baseline_cost, measured_actual_cost)
      values (p_org, coalesce(nullif(r->>'seatId',''), 'unknown'), d, 1,
              coalesce((r->>'ci')::boolean, false), now(),
              nullif(r->>'clientVersion',''), nullif(r->>'clientVersion',''),
              case when nullif(r->>'clientVersion','') is null then 1 else 0 end,
              medido * coalesce((r->>'baselineCost')::numeric, 0),
              medido * coalesce((r->>'actualCost')::numeric, 0))
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
        measured_actual_cost   = bvsala.seat_activity.measured_actual_cost + excluded.measured_actual_cost;

    -- 0025 · el carril del borrado del proveedor va en sus DOS columnas propias
    -- al final: `eliminatedInputFloorCost` (suelo a precio de lectura de caché,
    -- ya recortado por la verja del ingest) y una acreditada si ese suelo > 0.
    -- measured_* siguen siendo EXACTAMENTE las de 0022/0024: el suelo jamás
    -- entra ahí (ni multiplicado por `medido` ni de ninguna otra forma).
    insert into bvsala.usage_daily (
      org_id, day, requests, avoided_llm, actual_llm,
      eliminated_input_tokens, compressed_input_tokens, provider_cached_input_tokens,
      baseline_input_tokens, actual_input_tokens, baseline_output_tokens, actual_output_tokens,
      baseline_cost, actual_cost,
      measured_requests, measured_baseline_cost, measured_actual_cost,
      eliminated_floor_cost, eliminated_credited_requests
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
      case when coalesce((r->>'eliminatedInputFloorCost')::numeric, 0) > 0 then 1 else 0 end
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
      updated_at = now();

    -- 0022 · desglose por modelo. Mismo tráfico no-sombra que usage_daily (la
    -- sombra ya hizo `continue`), agregado por (org, día, modelo). 'unknown'
    -- agrupa lo que llegó sin modelo. Aditivo: suma cifras que usage_daily ya
    -- contabiliza, en una tabla aparte — no toca los CHECK de usage_daily.
    -- 0025 · + los tokens borrados por el proveedor y su suelo, POR MODELO.
    insert into bvsala.usage_daily_by_model (
      org_id, day, model,
      requests, baseline_cost, actual_cost, actual_input_tokens, actual_output_tokens,
      eliminated_input_tokens, eliminated_floor_cost, updated_at
    ) values (
      p_org, d, coalesce(nullif(r->>'model', ''), 'unknown'),
      1,
      coalesce((r->>'baselineCost')::numeric, 0),
      coalesce((r->>'actualCost')::numeric, 0),
      coalesce((r->>'actualInputTokens')::bigint, 0),
      coalesce((r->>'actualOutputTokens')::bigint, 0),
      coalesce((r->>'eliminatedInputTokens')::bigint, 0),
      coalesce((r->>'eliminatedInputFloorCost')::numeric, 0),
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
      updated_at = now();

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
