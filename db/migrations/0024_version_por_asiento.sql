-- 0024 — versión del cliente y dinero medido POR ASIENTO (el canal de versión).
--
-- EL HUECO: el panel no podía decir «esta máquina corre un gateway anterior a la
-- palanca de tarifa» ni «esta máquina no ahorra un euro medido». seat_activity
-- (0003) guarda por (org, asiento, día) solo requests / is_ci / last_seen_at;
-- la versión del proceso no viajaba por ningún sitio, y el dinero medido solo
-- se acumulaba por día en usage_daily (0010/0015), sin grano de asiento.
--
-- QUÉ VIAJA Y POR DÓNDE: la versión llega en la CABECERA del lote
-- (x-bvsala-version: «gateway/0.4.16» o «sdk/0.4.16»), no en el cuerpo. Un
-- campo nuevo en el cuerpo tumba el lote entero contra un servidor que no lo
-- conozca (lista blanca del ingest → 400 → sin reintento, doctrina de
-- emitter.ts); una cabecera la ignora. El servidor la valida (patrón estricto,
-- jamás texto libre) y la SELLA en cada registro como `clientVersion` antes de
-- llamar a esta RPC. Un cuerpo que traiga `clientVersion` por su cuenta sigue
-- dando 400: solo el servidor escribe la versión.
--
-- DOCTRINA: la verja REAL del aviso del panel es el DINERO
-- (measured_baseline_cost − measured_actual_cost por asiento), no la versión.
-- La versión EXPLICA por qué un asiento no ahorra («gateway anterior a la
-- palanca», «sin declarar»); nunca decide sola. Por eso las cinco columnas van
-- juntas en la misma fila.
--
-- Diseño:
--   · client_version_min / client_version_max: la MENOR y la MAYOR versión
--     vista ese día en ese asiento, por orden SEMVER (0.10.0 > 0.4.16), nunca
--     lexicográfico. NULL = ningún registro del día declaró versión; un
--     registro sin versión NUNCA pisa un min/max ya guardado.
--   · requests_sin_version: cuántos registros del día llegaron sin versión
--     (gateway/SDK anteriores al canal). Distingue «no declara» de «declara
--     una vieja».
--   · measured_baseline_cost / measured_actual_cost: el mismo fold medido que
--     usage_daily (medido = basis='measured'; lo estimado aporta 0), al grano
--     de asiento. Aditivo: suma cifras que usage_daily ya contabiliza, en otra
--     tabla — los CHECK de usage_daily quedan intactos (lección de 0011).
--   · SIN restricciones nuevas sobre seat_activity, a propósito: un CHECK que
--     fallase revertiría el LOTE entero y reproduciría el bucle 500+reencolado
--     que 0011 curó. Ninguna cifra de aquí puede ser negativa por construcción
--     (contadores +1/+0 y productos medido × coste con medido ∈ {0,1}).
--   · bvsala.semver_key(text) → int[]: helper IMMUTABLE STRICT que devuelve
--     NULL si el texto no casa el patrón. JAMÁS lanza: un valor raro no puede
--     tumbar el ingest. Sin grant propio: solo la invoca la RPC (SECURITY
--     DEFINER, mismo dueño); 0007 ya revoca por defecto el EXECUTE a public.
--
-- GUARD DE PRECONDICIÓN: esta RPC es la de 0022 + UN upsert distinto. Si prod
-- no estuviera en 0022 (tabla usage_daily_by_model; columnas shadow_* de
-- 0021), el cuerpo copiado haría 500 a TODO ingest y el emisor descartaría
-- lotes al superar maxBuffer. Por eso el fichero ABORTA antes de tocar nada si
-- falta la base: aplicar 0021/0022 primero (runbook, regla 2: orden
-- ascendente). 0023 es solo datos (update de licencias): no toca la RPC, la
-- base de este cuerpo es 0022.
--
-- Orden de despliegue (doctrina emitter.ts: un 4xx del ingest descarta el lote
-- SIN reintento):
--   1º ESTA migración por Management API (runbook: diagnóstico primero, hora
--      PITR anotada, begin/commit, token por fichero jamás impreso).
--   2º `vercel --prod` desde la raíz del repo: la web sella clientVersion y el
--      panel lee las columnas nuevas.
--   3º npm con la cabecera (la primera versión que la emite).
-- Ninguna permutación rompe (cabecera ignorada por una web vieja; clave
-- `clientVersion` ignorada por la RPC 0022, que lee por nombre; columna ausente
-- tolerada por el lector del panel), pero este orden evita ventanas de «sin
-- declarar». Regla 1 del runbook: 0024 lleva versión de la RPC — re-ejecutar
-- 0022 (o cualquier anterior) DESPUÉS la regresa en silencio.
--
-- Diagnóstico (solo lectura) — las dos deben salir true tras aplicar:
--   select exists(select 1 from information_schema.columns
--                 where table_schema='bvsala' and table_name='seat_activity'
--                   and column_name='client_version_min') as columna_0024,
--          exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace
--                 where n.nspname='bvsala' and p.proname='ingest_usage_batch'
--                   and p.prosrc like '%clientVersion%') as rpc_0024;

-- ---------------------------------------------------------------------------
-- 1. Guard: la base 0021/0022 tiene que estar. Abortar es el resultado BUENO.
-- ---------------------------------------------------------------------------
do $$
begin
  if to_regclass('bvsala.usage_daily_by_model') is null
     or not exists (
       select 1 from information_schema.columns
        where table_schema = 'bvsala' and table_name = 'usage_daily'
          and column_name = 'shadow_requests')
     or not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'bvsala' and p.proname = 'ingest_usage_batch'
          and p.prosrc like '%usage_daily_by_model%')
  then
    raise exception '0024: base 0022 ausente — aplicar 0021/0022 antes';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. semver_key: «gateway/0.4.16» → {0,4,16}; «sdk/0.10.0-beta.1» → {0,10,0};
--    cualquier otra cosa → NULL. Los arrays de int se comparan elemento a
--    elemento, que es exactamente el orden semver. El patrón es el MISMO que
--    valida el servidor antes de sellar: lo que entra aquí ya casa; el NULL es
--    la red por si algún día no casara (nunca un error).
-- ---------------------------------------------------------------------------
create or replace function bvsala.semver_key(v text)
returns int[]
language sql
immutable
strict
as $$
  select case
    when v ~ '^(gateway|sdk)/[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(-[0-9A-Za-z.-]{1,16})?$'
    then array[
      split_part(regexp_replace(split_part(v, '/', 2), '-.*$', ''), '.', 1)::int,
      split_part(regexp_replace(split_part(v, '/', 2), '-.*$', ''), '.', 2)::int,
      split_part(regexp_replace(split_part(v, '/', 2), '-.*$', ''), '.', 3)::int
    ]
    else null
  end
$$;

-- ---------------------------------------------------------------------------
-- 3. Las cinco columnas. Con default para que las filas que ya existen (y las
--    que escriba una RPC anterior en la ventana de despliegue) queden bien
--    definidas: 0 requests sin versión y 0 dinero medido, versión NULL.
-- ---------------------------------------------------------------------------
alter table bvsala.seat_activity
  add column if not exists client_version_min     text,
  add column if not exists client_version_max     text,
  add column if not exists requests_sin_version   bigint        not null default 0,
  add column if not exists measured_baseline_cost numeric(14,6) not null default 0,
  add column if not exists measured_actual_cost   numeric(14,6) not null default 0;

-- ---------------------------------------------------------------------------
-- 4. La RPC, versión 0024. CREATE OR REPLACE sustituye el cuerpo ENTERO, así
--    que aquí se reproduce el de 0022 COMPLETO (tope de lote, requestId
--    obligatorio, idempotencia usage_ingest_seen, carril sombra que hace
--    `continue`, seat_activity, usage_daily con tokens y measured_*, fold por
--    modelo en usage_daily_by_model, usage_sessions, recuento de active_seats)
--    cambiando SOLO el upsert de seat_activity: sella versión min/max por
--    orden semver, cuenta los registros sin versión y acumula el dinero medido
--    del asiento. `medido` ya venía calculado antes del upsert. Lo que hay que
--    revisar es el cuerpo contra 0022, no el diff (doctrina de 0015:70-79) —
--    test/migracion-0024.test.ts lo compara línea a línea fuera del upsert.
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

    insert into bvsala.usage_daily (
      org_id, day, requests, avoided_llm, actual_llm,
      eliminated_input_tokens, compressed_input_tokens, provider_cached_input_tokens,
      baseline_input_tokens, actual_input_tokens, baseline_output_tokens, actual_output_tokens,
      baseline_cost, actual_cost,
      measured_requests, measured_baseline_cost, measured_actual_cost
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
      medido * coalesce((r->>'actualCost')::numeric, 0)
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
      updated_at = now();

    -- 0022 · desglose por modelo. Mismo tráfico no-sombra que usage_daily (la
    -- sombra ya hizo `continue`), agregado por (org, día, modelo). 'unknown'
    -- agrupa lo que llegó sin modelo. Aditivo: suma cifras que usage_daily ya
    -- contabiliza, en una tabla aparte — no toca los CHECK de usage_daily.
    insert into bvsala.usage_daily_by_model (
      org_id, day, model,
      requests, baseline_cost, actual_cost, actual_input_tokens, actual_output_tokens, updated_at
    ) values (
      p_org, d, coalesce(nullif(r->>'model', ''), 'unknown'),
      1,
      coalesce((r->>'baselineCost')::numeric, 0),
      coalesce((r->>'actualCost')::numeric, 0),
      coalesce((r->>'actualInputTokens')::bigint, 0),
      coalesce((r->>'actualOutputTokens')::bigint, 0),
      now()
    )
    on conflict (org_id, day, model) do update set
      requests = bvsala.usage_daily_by_model.requests + excluded.requests,
      baseline_cost = bvsala.usage_daily_by_model.baseline_cost + excluded.baseline_cost,
      actual_cost = bvsala.usage_daily_by_model.actual_cost + excluded.actual_cost,
      actual_input_tokens = bvsala.usage_daily_by_model.actual_input_tokens + excluded.actual_input_tokens,
      actual_output_tokens = bvsala.usage_daily_by_model.actual_output_tokens + excluded.actual_output_tokens,
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
