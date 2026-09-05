-- 0022 — uso por MODELO (desglose del panel por día × modelo).
--
-- EL HUECO: el `model` viaja en el cable (`src/metering/emitter.ts`) y PASA la
-- verja del ingest (`apps/web/lib/metering/usage.ts`, USAGE_ID_FIELDS lo valida
-- con charset estricto — jamás texto libre, seguro para GROUP BY), pero el RPC
-- de facturación lo TIRABA: agrega en usage_daily (org, día) y usage_sessions
-- (org, día, sesión, agente), y en ninguna hay modelo. El panel no podía
-- responder «¿qué modelo costó esto?» y no hay historial (el modelo nunca se
-- guardó; el pasado es irrecuperable — el desglose sale vacío hasta que entre
-- tráfico nuevo, y el reader degrada honesto: nunca inventa filas por modelo).
--
-- Diseño: tabla propia por (org, día, modelo), calcada de usage_sessions (0019).
-- NO se toca usage_daily: sus CHECK y sus totales quedan idénticos (lección de
-- 0011: un registro que suma distinto en dos tablas con CHECK cruzado revienta
-- el lote entero). El fold por modelo es SOLO-ADITIVO y va en el camino medido/
-- estimado, tras el upsert de usage_daily; los registros basis='shadow' ya hacen
-- `continue` antes (0021) → intactos, la sombra jamás entra aquí.
--
-- Orden de despliegue (doctrina emitter.ts: un 4xx del ingest descarta el lote
-- SIN reintento): 1º esta migración → el reader ya tolera que la tabla no exista
-- (degrada a vacío), así que la web funciona ANTES y DESPUÉS de aplicarla.

create table if not exists bvsala.usage_daily_by_model (
  org_id               uuid not null references bvsala.organizations(id) on delete cascade,
  day                  date not null,
  -- '' nunca: el fold usa coalesce(nullif(model,''),'unknown') → charset de la
  -- verja del ingest (identidad, no texto libre). 'unknown' agrupa lo que llegó
  -- sin modelo (SDK viejo, gateway viejo).
  model                text not null,
  requests             bigint not null default 0,
  baseline_cost        numeric(14, 6) not null default 0,
  actual_cost          numeric(14, 6) not null default 0,
  actual_input_tokens  bigint not null default 0,
  actual_output_tokens bigint not null default 0,
  updated_at           timestamptz not null default now(),
  primary key (org_id, day, model)
);
create index if not exists usage_daily_by_model_org_day_idx on bvsala.usage_daily_by_model (org_id, day);

alter table bvsala.usage_daily_by_model enable row level security;
-- Mismo modelo que usage_sessions (0019) / seat_activity (0003): los miembros
-- leen lo de su org; las escrituras solo entran por la RPC SECURITY DEFINER
-- (service_role).
create policy usage_daily_by_model_read on bvsala.usage_daily_by_model
  for select using (bvsala.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- La RPC, versión 0022. CREATE OR REPLACE sustituye el cuerpo ENTERO, así que
-- aquí se reproduce el de 0021 COMPLETO (tope de lote, requestId obligatorio,
-- idempotencia usage_ingest_seen, carril sombra que hace `continue`, seat_activity,
-- usage_daily con tokens y measured_*, usage_sessions, recuento de active_seats)
-- + UNA adición: tras el upsert de usage_daily, un fold por modelo en
-- usage_daily_by_model. Lo que hay que revisar es el cuerpo contra 0021, no el
-- diff (doctrina de 0015:70-79). Nunca DROP+CREATE: se perdería el grant a
-- service_role.
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

    insert into bvsala.seat_activity (org_id, seat_id, day, requests, is_ci, last_seen_at)
      values (p_org, coalesce(nullif(r->>'seatId',''), 'unknown'), d, 1,
              coalesce((r->>'ci')::boolean, false), now())
      on conflict (org_id, seat_id, day) do update
        set requests = bvsala.seat_activity.requests + 1, last_seen_at = now();

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
