-- 0015 — los tokens que el SDK ya emitía y la base tiraba.
--
-- EL HUECO: `src/metering/emitter.ts` manda SIETE contadores de tokens por
-- petición, y `usage_daily` solo persistía TRES (eliminated, compressed,
-- provider_cached). Los cuatro que contestan la pregunta más elemental que un
-- cliente le hace a su panel —«¿cuántos tokens he gastado?» y «¿cuántos me
-- habéis ahorrado?»— llegaban a la ingesta y se descartaban en silencio.
--
-- Los tres que sí se guardaban son ATRIBUCIÓN: dicen POR QUÉ palanca se ahorró.
-- Ninguno de ellos es el TOTAL, y no se pueden sumar para obtenerlo: son libros
-- distintos y `eliminated + compressed + provider_cached` no es «lo ahorrado»
-- (mezclarlos es justo la cifra de vanidad que el producto se niega a publicar).
-- El total sale de la diferencia entre baseline y actual, y para eso hacen falta
-- las cuatro columnas de aquí.
--
-- Con ellas el panel puede decir, por fin:
--     gastados  = actual_input_tokens   + actual_output_tokens
--     ahorrados = (baseline_input_tokens  - actual_input_tokens)
--               + (baseline_output_tokens - actual_output_tokens)

alter table bvsala.usage_daily
  add column if not exists baseline_input_tokens  bigint not null default 0,
  add column if not exists actual_input_tokens    bigint not null default 0,
  add column if not exists baseline_output_tokens bigint not null default 0,
  add column if not exists actual_output_tokens   bigint not null default 0;

-- El dominio también aplica a las columnas nuevas (ver 0008). NOT VALID por la
-- misma razón: no escanear la tabla al desplegar. Postgres SÍ las verifica en
-- cada INSERT/UPDATE nuevo, que es lo que importa.
alter table bvsala.usage_daily
  add constraint usage_daily_token_totals_no_negatives check (
    baseline_input_tokens  >= 0 and
    actual_input_tokens    >= 0 and
    baseline_output_tokens >= 0 and
    actual_output_tokens   >= 0
  ) not valid;

-- ═══════════════════════════════════════════════════════════════════════════
-- LO QUE AQUÍ **NO** SE RESTRINGE, Y ES DELIBERADO
-- ═══════════════════════════════════════════════════════════════════════════
--
-- La restricción que pide el cuerpo —`actual_input_tokens <= baseline_input_tokens`,
-- o sea «la capa nunca gasta más de lo que habría costado sin ella»— NO se añade.
-- Es falsa, y falla exactamente cuando más importa que los datos entren.
--
-- Una petición cuya respuesta incumple el contrato dispara una reparación: una
-- SEGUNDA llamada completa cuya entrada se suma a `actualInput` y que, por
-- doctrina de la capa, se DESCUENTA del baseline (`estimateCost`:
-- `actualInput - repairInput`) para que el reintento no se pague a sí mismo en
-- el informe. Resultado: `actual > baseline`, y con signo negativo en el ahorro.
-- No es un dato corrupto, es una pérdida real y medida — contra
-- claude-sonnet-4-5 con herramientas + contrato llegó a ser un 60% de sobrecoste
-- (arreglado en #84, pero el escenario sigue siendo posible).
--
-- Poner esa restricción repetiría, agravado, el defecto que 0011 tuvo que
-- corregir: el CHECK saltaría, la transacción del lote entero revertiría, la ruta
-- devolvería 500, y el emisor reencolaría el lote al frente PARA SIEMPRE. La org
-- dejaría de reportar —panel congelado, asientos sin contar, facturación de
-- menos— y precisamente el día en que la capa le costó dinero al cliente. El
-- único invariante que sí se puede afirmar es que ningún contador es negativo,
-- que es lo que hay arriba.
--
-- El signo negativo se enseña; no se esconde detrás de un CHECK.

-- ---------------------------------------------------------------------------
-- La RPC, ahora guardando también los cuatro totales.
-- ---------------------------------------------------------------------------
-- CREATE OR REPLACE, nunca DROP+CREATE: un DROP se llevaría las ACL de 0005 y la
-- ruta de ingesta perdería el permiso de ejecución sin que nada lo dijera.
-- Es la de 0010 palabra por palabra, con cuatro columnas más. Se reproduce
-- ENTERA y no por partes porque `CREATE OR REPLACE` sustituye el cuerpo completo:
-- omitir aquí el tope de lote, la exigencia de `requestId` o el `usage_ingest_seen`
-- de 0009 no daría ningún error — simplemente devolvería la idempotencia al
-- estado anterior, y un lote reintentado volvería a contarse. Al revisar este
-- fichero, lo que hay que comparar es el cuerpo contra 0010, no el diff.
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
    -- viene de un SDK anterior a ese cambio: se cuenta en el total y NO en lo
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
