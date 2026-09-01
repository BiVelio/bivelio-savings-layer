-- 0019 — atribución por sesión y subagente (adelantada de S2 por valor de flota).
--
-- EL HUECO: el gateway ya reenvía las cabeceras x-claude-code-session-id /
-- x-claude-code-agent-id que Claude Code emite, pero el metering las tiraba:
-- la atribución del panel llegaba hasta el ASIENTO (máquina) y una flota no
-- podía responder «¿qué sesión / qué subagente costó esto?». Son identidades
-- OPACAS de sesión y agente — la doc de Anthropic prohíbe tratarlas como
-- identificador de usuario, y aquí viajan con el mismo cierre de canal que
-- seat_id (charset estricto en la verja del ingest; jamás texto libre).
--
-- Diseño: tabla propia por (org, día, sesión, agente) — agent_id '' es el
-- agente principal; una fila por subagente. NO se toca usage_daily: sus CHECK
-- y sus totales quedan idénticos (la lección de 0011: un registro que suma
-- distinto en dos tablas con CHECK cruzado revienta el lote entero).
--
-- Orden de despliegue: esta migración y la verja del servidor van ANTES de que
-- ningún SDK/gateway emita sessionId (0.4.7). Un RPC viejo con un campo nuevo
-- lo ignora (r->>'sessionId' nunca leído); un servidor viejo con un SDK nuevo
-- devuelve 400 y pierde el lote — por eso servidor primero, npm después.

create table if not exists bvsala.usage_sessions (
  org_id               uuid not null references bvsala.organizations(id) on delete cascade,
  day                  date not null,
  session_id           text not null,
  -- '' = el agente principal de la sesión; cada subagente trae su propio id.
  agent_id             text not null default '',
  requests             bigint not null default 0,
  actual_llm           bigint not null default 0,
  actual_input_tokens  bigint not null default 0,
  actual_output_tokens bigint not null default 0,
  actual_cost          numeric(14, 6) not null default 0,
  first_seen_at        timestamptz not null default now(),
  last_seen_at         timestamptz not null default now(),
  primary key (org_id, day, session_id, agent_id)
);
create index if not exists usage_sessions_org_day_idx on bvsala.usage_sessions (org_id, day);

alter table bvsala.usage_sessions enable row level security;
-- Mismo modelo que seat_activity (0003): los miembros leen lo de su org; las
-- escrituras solo entran por la RPC SECURITY DEFINER (service_role).
create policy usage_sessions_read on bvsala.usage_sessions for select using (bvsala.is_org_member(org_id));

-- ---------------------------------------------------------------------------
-- La RPC, versión 0019. CREATE OR REPLACE sustituye el cuerpo ENTERO, así que
-- aquí se reproduce el de 0015 COMPLETO (tope de lote, requestId obligatorio,
-- idempotencia usage_ingest_seen, seat_activity, usage_daily con las columnas
-- de tokens y measured_*, recuento de active_seats) + UNA adición: si el
-- registro trae sessionId, se acumula también en usage_sessions. Lo que hay
-- que revisar es el cuerpo contra 0015, no el diff (doctrina de 0015:70-79).
-- Nunca DROP+CREATE: se perdería el grant a service_role.
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
