-- 0029 — MEDIDO POR REFERENCIA: el carril basis='reference' en columnas propias,
-- una fila por acierto (el CSV del cliente) y la regla sellada en cada extracto.
--
-- LA CLASE: una llamada EVITADA (acierto exacto o seguidor coalescido) cuya
-- repetición es BYTE A BYTE una petición que sí se ejecutó a través de la capa
-- SIN que la capa le quitara ni le añadiera nada. Su baseline no es un recuento
-- local: es el contador que el proveedor devolvió para esa petición idéntica
-- (y que el cliente ya pagó), valorado a la baja:
--
--   creditedInputTokens  = inputTokens − 8 · layerMessages
--   creditedOutputTokens = temperature === 0
--                            ? floor(0,95 · min(outputTokens, maxOutputTokens del lector))
--                            : 0
--   tierFactor           = min(1, tier servido de la poblada, 0,5 si el lector es diferible)
--   baselineCost         = tierFactor · (creditedInputTokens/1000 · cachedInputPer1k
--                                        + creditedOutputTokens/1000 · outputPer1k)
--   actualCost = 0 · netSavings = 1
--
-- Toda la entrada va a cachedInputPer1k, el MÍNIMO que el proveedor cobra por un
-- token de entrada aunque la ingenua acertara entera en su caché de prefijo; por
-- eso es un SUELO. El SDK lo calcula; el servidor no conoce precios y solo lo
-- acota (techo de la verja del ingest: apps/web/lib/metering/usage.ts degrada a
-- 'estimated' todo registro 'reference' incoherente, nunca lo rechaza).
--
-- DOCTRINA:
--   · measured_* LITERALES; `medido` no cambia. El carril va en sus TRES columnas
--     propias (reference_requests, reference_baseline_cost, reference_actual_cost)
--     y el interruptor vive en la web (COMISIONAR_REFERENCIA, lib/billing/tarifa.ts):
--     la base de datos solo acumula, nunca decide.
--   · Un registro reference suma a requests/avoided/tokens/baseline/actual como un
--     estimated: los totales de usage_daily y de usage_daily_by_model no cambian de
--     significado, y seat_activity no recibe dinero de referencia (el dinero medido
--     por asiento lo infraestima; documentado).
--   · El único CHECK nuevo por tabla es ≥ 0: un CHECK que pudiera saltar revierte el
--     LOTE entero y reproduce el bucle 500+reencolado que curó 0011. Las cotas
--     «reference_requests ≤ requests» y «measured + reference ≤ requests» se cumplen
--     por construcción (cada registro es measured, reference u otro, nunca dos) y NO
--     van en CHECK.
--   · reference_hits: una fila por acierto (org, request_id), idempotente, con RLS de
--     miembro. Es lo que baja el enlace del extracto (/api/org/reference-hits): el
--     cliente contrasta cada fila con el informe de la petición que sí corrió y con
--     el uso de su proveedor de ese día. Retención: 460 días (cron retencion).
--   · extractos gana el sello de la regla (regla_referencia) y sus tres cifras: el
--     documento cerrado dice qué regla valoró las repeticiones.
--
-- GUARD DE PRECONDICIÓN: esta RPC es el cuerpo ENTERO de 0025 (que ya lleva el de
-- 0024 y, por tanto, el de 0022) + las adiciones de este fichero. Si prod no está en
-- 0025, el cuerpo copiado haría 500 a TODO ingest. Por eso el fichero ABORTA antes de
-- tocar nada: aplicar 0024/0025 primero (runbook, regla 2: orden ascendente). 0026,
-- 0027 y 0028 no tocan la RPC: la base de este cuerpo es 0025.
--
-- REGLA 1 del runbook: 0029 lleva versión de la RPC — re-ejecutar 0025 (o cualquier
-- anterior) DESPUÉS de esta la regresa EN SILENCIO: dejan de acumularse las columnas
-- reference_* y de escribirse reference_hits, y el extracto dejaría de ver la
-- referencia sin que nadie vea un error. Si pasa, re-aplicar SOLO el bloque de la
-- función de 0029.
--
-- Orden de despliegue (doctrina emitter.ts: un 4xx del ingest descarta el lote SIN
-- reintento; npm es inmutable):
--   1º 0029 por Management API (runbook: diagnóstico primero, hora PITR anotada,
--      begin/commit, token por fichero jamás impreso). Inocua con la web actual: la
--      RPC nueva se comporta igual con los basis viejos.
--   2º `vercel --prod` desde la raíz del repo: la lista blanca del ingest acepta
--      basis 'reference' y sus dos campos opcionales, el cierre lee y sella las
--      columnas nuevas y el panel las pinta.
--   3º SOLO ENTONCES npm con el SDK que emite basis 'reference': contra una web sin
--      la lista blanca, el lote entero da 400 y se pierde.
--
-- Diagnóstico (solo lectura) — las CUATRO deben salir true tras aplicar; la última
-- exige A LA VEZ la pieza de 0024, la de 0025 y la de 0029 en la RPC viva:
--   select exists(select 1 from information_schema.columns where table_schema='bvsala' and table_name='usage_daily' and column_name='reference_baseline_cost') as columna_0029,
--          to_regclass('bvsala.reference_hits') is not null as tabla_0029,
--          exists(select 1 from information_schema.columns where table_schema='bvsala' and table_name='extractos' and column_name='regla_referencia') as extractos_0029,
--          exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='bvsala' and p.proname='ingest_usage_batch'
--                   and p.prosrc like '%reference_hits%' and p.prosrc like '%eliminatedInputFloorCost%' and p.prosrc like '%clientVersion%') as rpc_0029;

-- ---------------------------------------------------------------------------
-- 1. Guard: la base 0025 (y por tanto 0024/0022) y los extractos (0016) tienen
--    que estar. Abortar es el resultado BUENO.
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (
       select 1 from information_schema.columns
        where table_schema = 'bvsala' and table_name = 'usage_daily'
          and column_name = 'eliminated_floor_cost')
     or not exists (
       select 1 from information_schema.columns
        where table_schema = 'bvsala' and table_name = 'usage_daily_by_model'
          and column_name = 'eliminated_floor_cost')
     or to_regclass('bvsala.extractos') is null
     or not exists (
       select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'bvsala' and p.proname = 'ingest_usage_batch'
          and p.prosrc like '%eliminatedInputFloorCost%'
          and p.prosrc like '%clientVersion%')
  then
    raise exception '0029: base 0025 ausente — aplicar 0024/0025 antes, en orden ascendente';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. usage_daily: el carril medido por referencia. Con default para que las
--    filas existentes (y las que escriba la RPC de 0025 en la ventana de
--    despliegue) queden bien definidas: 0 peticiones, 0 dólares.
-- ---------------------------------------------------------------------------
alter table bvsala.usage_daily
  add column if not exists reference_requests      bigint        not null default 0,
  add column if not exists reference_baseline_cost numeric(14,6) not null default 0,
  add column if not exists reference_actual_cost   numeric(14,6) not null default 0;

alter table bvsala.usage_daily
  drop constraint if exists usage_daily_reference_no_negatives;
-- Ninguna de las tres puede ser negativa. Es el único CHECK: la verja del ingest
-- ya garantiza ≥ 0 por registro, y la suma de no-negativos no baja de 0.
alter table bvsala.usage_daily
  add constraint usage_daily_reference_no_negatives check (
    reference_requests      >= 0 and
    reference_baseline_cost >= 0 and
    reference_actual_cost   >= 0
  );

-- ---------------------------------------------------------------------------
-- 3. usage_daily_by_model: el mismo carril al grano de modelo, para auditar
--    dónde se valoran las repeticiones. Sin CHECK (misma razón que 0024/0025).
-- ---------------------------------------------------------------------------
alter table bvsala.usage_daily_by_model
  add column if not exists reference_requests      bigint        not null default 0,
  add column if not exists reference_baseline_cost numeric(14,6) not null default 0;

-- ---------------------------------------------------------------------------
-- 4. extractos: las tres cifras del carril y el SELLO de la regla que las valoró
--    ('' sin referencia; 'referencia-v1' si entró en la base; 'referencia-v1:excluida'
--    si se enseñó como contexto). El cierre las escribe; un extracto cerrado
--    sigue siendo inmutable (upsert ignore-duplicates).
-- ---------------------------------------------------------------------------
alter table bvsala.extractos
  add column if not exists requests_referencia   bigint        not null default 0,
  add column if not exists base_referencia_usd   numeric(14,6) not null default 0,
  add column if not exists ahorro_referencia_usd numeric(14,6) not null default 0,
  add column if not exists regla_referencia      text          not null default '';

alter table bvsala.extractos
  drop constraint if exists extractos_referencia_no_negativos;
alter table bvsala.extractos
  add constraint extractos_referencia_no_negativos check (
    requests_referencia   >= 0 and
    base_referencia_usd   >= 0 and
    ahorro_referencia_usd >= 0
  );

-- ---------------------------------------------------------------------------
-- 5. reference_hits: una fila por acierto medido por referencia. Clave
--    (org, request_id) — el mismo requestId que usage_ingest_seen, así que un
--    reintento del emisor no duplica filas. Dinero en numeric(20,10): un acierto
--    de gpt-4o-mini vale 1e-5 USD y el CSV tiene que cuadrar con el informe.
-- ---------------------------------------------------------------------------
create table if not exists bvsala.reference_hits (
  org_id                 uuid           not null references bvsala.organizations(id) on delete cascade,
  request_id             text           not null,
  day                    date           not null,
  model                  text           not null,
  cache_result           text           not null,
  reference_request_id   text,
  reference_at           timestamptz,
  baseline_input_tokens  bigint         not null default 0,
  baseline_output_tokens bigint         not null default 0,
  baseline_cost          numeric(20,10) not null default 0,
  created_at             timestamptz    not null default now(),
  primary key (org_id, request_id)
);
create index if not exists reference_hits_org_day on bvsala.reference_hits (org_id, day);

alter table bvsala.reference_hits enable row level security;
-- Mismo modelo que usage_daily_by_model (0022) / extractos (0016): los miembros
-- leen lo de su org; las escrituras solo entran por la RPC SECURITY DEFINER
-- (service_role). Re-ejecutable: la política se borra antes de crearla.
drop policy if exists reference_hits_read on bvsala.reference_hits;
create policy reference_hits_read on bvsala.reference_hits
  for select using (bvsala.is_org_member(org_id));

grant select on bvsala.reference_hits to authenticated;
grant all    on bvsala.reference_hits to service_role;

-- ---------------------------------------------------------------------------
-- 6. La RPC, versión 0029. CREATE OR REPLACE sustituye el cuerpo ENTERO, así
--    que aquí se reproduce el de 0025 COMPLETO (tope de lote, requestId
--    obligatorio, idempotencia usage_ingest_seen, carril sombra que hace
--    `continue`, seat_activity con versión min/max + sin_version + dinero
--    medido por asiento, usage_daily con tokens, measured_* y el suelo de la
--    elisión, fold por modelo, usage_sessions, recuento de active_seats)
--    cambiando SOLO dos bloques: el insert/conflict de usage_daily (tres
--    columnas nuevas al final, measured_* intactas) y el fold por modelo (dos
--    columnas nuevas + la fila de reference_hits). Lo que hay que revisar es el
--    cuerpo contra 0025, no el diff (doctrina de 0015:70-79) —
--    test/migracion-0029.test.ts lo compara línea a línea fuera de esos
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
