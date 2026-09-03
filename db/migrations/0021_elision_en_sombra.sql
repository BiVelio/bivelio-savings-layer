-- 0021 — el carril SOMBRA de la elisión (S2 del plan de la pasarela).
--
-- EL PORQUÉ: el replay del corpus (03-09, PR #194) eligió política ganadora
-- (v0, +20,6 % neto de invalidación). El siguiente paso del plan es medir esa
-- política EN VIVO sin tocar un byte del tráfico: el gateway calcula qué
-- HABRÍA elidido y con qué ahorro, y lo reporta con `basis:"shadow"`.
--
-- DOCTRINA (la misma que separó measured de estimated en 0010): la sombra es
-- HIPOTÉTICA. Jamás entra en la base de la comisión, jamás se suma a measured,
-- jamás engorda el titular del panel. Por eso tiene columnas PROPIAS: sin
-- ellas, un registro sombra se disfrazaría de «ahorro estimado» en el extracto
-- y hincharía el titular.
--
-- EL REGISTRO SOMBRA APORTA CERO a requests / avoided_llm / actual_llm /
-- totales / seat_activity / usage_sessions. Si aportara, saltaría el CHECK
-- usage_daily_calls_add_up (0011) — que revierte el LOTE entero y reproduce el
-- bucle 500+reencolado que 0011 curó — y contaminaría los asientos activos.
--
-- Orden de despliegue (doctrina emitter.ts: un 4xx del ingest descarta el lote
-- SIN reintento, y npm es inmutable): 1º esta migración → 2º la verja del
-- servidor acepta "shadow" → 3º panel/extracto → 4º el gateway lo emite.

alter table bvsala.usage_daily
  add column if not exists shadow_requests      bigint        not null default 0,
  add column if not exists shadow_baseline_cost numeric(14,6) not null default 0,
  add column if not exists shadow_actual_cost   numeric(14,6) not null default 0;

alter table bvsala.usage_daily
  drop constraint if exists usage_daily_shadow_no_negatives;
-- shadow_actual puede superar a shadow_baseline (una política puede PERDER
-- dinero — v2 lo demostró), pero ninguna de las tres cifras puede ser negativa.
alter table bvsala.usage_daily
  add constraint usage_daily_shadow_no_negatives check (
    shadow_requests      >= 0 and
    shadow_baseline_cost >= 0 and
    shadow_actual_cost   >= 0
  );

-- ---------------------------------------------------------------------------
-- La RPC, versión 0021. CREATE OR REPLACE sustituye el cuerpo ENTERO, así que
-- aquí se reproduce el de 0019 COMPLETO (tope de lote, requestId obligatorio,
-- idempotencia usage_ingest_seen, seat_activity, usage_daily con tokens y
-- measured_*, usage_sessions, recuento de active_seats) + UNA adición: un
-- registro con basis='shadow' acumula SOLO en las columnas shadow_* y no toca
-- nada más. Lo que hay que revisar es el cuerpo contra 0019, no el diff
-- (doctrina de 0015:70-79). Nunca DROP+CREATE: se perdería el grant a
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
    -- ni usage_sessions ni en el recuento de active_seats. El requestId del
    -- gateway lleva sufijo ':shadow' para no chocar en usage_ingest_seen con
    -- el registro medido de la MISMA petición (la idempotencia por (org, rid)
    -- se tragaría en silencio al segundo de los dos).
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
