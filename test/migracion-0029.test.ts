import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * 0029 — MEDIDO POR REFERENCIA. La misma lección que 0025 (y que 0011): la RPC
 * se sustituye SIEMPRE cuerpo entero (CREATE OR REPLACE), así que una 0029
 * copiada de 0024 en vez de 0025 borraría el suelo de la elisión SIN NINGÚN
 * ERROR. Por eso este test exige a la vez las piezas de 0022, 0024 y 0025, y
 * compara el cuerpo LÍNEA A LÍNEA contra 0025 fuera de los DOS bloques que
 * 0029 cambia (insert de usage_daily y fold por modelo, que ahora escribe
 * también la fila de reference_hits).
 */
const sql = readFileSync(new URL("../db/migrations/0029_medido_por_referencia.sql", import.meta.url), "utf8");
const sql25 = readFileSync(new URL("../db/migrations/0025_dinero_de_la_elision_suelo.sql", import.meta.url), "utf8");

/** El texto de la RPC: desde su CREATE OR REPLACE hasta el `$$;` que la cierra. */
function cuerpoRpc(fuente: string): string {
  const ini = fuente.indexOf("create or replace function bvsala.ingest_usage_batch");
  expect(ini, "la RPC ingest_usage_batch tiene que estar").toBeGreaterThanOrEqual(0);
  const fin = fuente.indexOf("\n$$;", ini);
  expect(fin, "la RPC tiene que cerrarse con $$;").toBeGreaterThan(ini);
  return fuente.slice(ini, fin);
}

/**
 * Quita un bloque de la RPC: la línea que casa `marcador` (exacta, sin
 * indentación), sus comentarios inmediatamente anteriores y todo hasta la
 * primera línea en blanco. Lo demás tiene que ser IDÉNTICO entre versiones.
 */
function sinBloque(cuerpo: string, marcador: string): string {
  const lineas = cuerpo.split("\n");
  const ini = lineas.findIndex((l) => l.trim() === marcador);
  expect(ini, `el bloque «${marcador}» tiene que estar en la RPC`).toBeGreaterThan(0);
  let desde = ini;
  while (desde > 0 && lineas[desde - 1]!.trim().startsWith("--")) desde--;
  let hasta = ini;
  while (hasta < lineas.length && lineas[hasta]!.trim() !== "") hasta++;
  return [...lineas.slice(0, desde), ...lineas.slice(hasta)].join("\n");
}

/** Un bloque de la RPC: desde la línea del marcador hasta la primera línea en blanco. */
function bloque(cuerpo: string, marcador: string): string {
  const ini = cuerpo.indexOf(`\n    ${marcador}\n`);
  expect(ini, `el bloque «${marcador}» tiene que estar en la RPC`).toBeGreaterThan(0);
  return cuerpo.slice(ini + 1, cuerpo.indexOf("\n\n", ini + 1));
}

const BLOQUE_USAGE = "insert into bvsala.usage_daily (";
const BLOQUE_MODELO = "insert into bvsala.usage_daily_by_model (";

describe("0029 — reproduce 0025 entero (y por tanto 0024 y 0022) y cambia solo usage_daily y el fold por modelo", () => {
  it("conserva las piezas heredadas de 0022, una a una", () => {
    for (const pieza of [
      "batch too large",
      "record without requestId",
      "bvsala.usage_ingest_seen",
      "r->>'basis' = 'shadow'",
      "shadow_requests",
      "bvsala.seat_activity",
      "measured_actual_cost = bvsala.usage_daily.measured_actual_cost + excluded.measured_actual_cost",
      "baseline_input_tokens = bvsala.usage_daily.baseline_input_tokens + excluded.baseline_input_tokens",
      "bvsala.usage_daily_by_model",
      "on conflict (org_id, day, model) do update",
      "bvsala.usage_sessions",
      "on conflict (org_id, day, session_id, agent_id) do update",
      "active_seats",
      "grant execute on function bvsala.ingest_usage_batch(uuid, jsonb) to service_role",
      "security definer",
    ]) {
      expect(sql, pieza).toContain(pieza);
    }
  });

  it("conserva las piezas de 0024 (versión por asiento y dinero medido por asiento), una a una", () => {
    const rpc = cuerpoRpc(sql);
    for (const pieza of [
      "client_version_min, client_version_max, requests_sin_version,",
      "nullif(r->>'clientVersion','')",
      "case when nullif(r->>'clientVersion','') is null then 1 else 0 end",
      "bvsala.semver_key(excluded.client_version_min) < bvsala.semver_key(bvsala.seat_activity.client_version_min)",
      "bvsala.semver_key(excluded.client_version_max) > bvsala.semver_key(bvsala.seat_activity.client_version_max)",
      "when excluded.client_version_min is null then bvsala.seat_activity.client_version_min",
      "requests_sin_version   = bvsala.seat_activity.requests_sin_version + excluded.requests_sin_version",
      "measured_baseline_cost = bvsala.seat_activity.measured_baseline_cost + excluded.measured_baseline_cost",
      "measured_actual_cost   = bvsala.seat_activity.measured_actual_cost + excluded.measured_actual_cost",
    ]) {
      expect(rpc, pieza).toContain(pieza);
    }
  });

  it("conserva las piezas de 0025 (el suelo de la elisión en su carril propio)", () => {
    const rpc = cuerpoRpc(sql);
    for (const pieza of [
      "eliminated_floor_cost = bvsala.usage_daily.eliminated_floor_cost + excluded.eliminated_floor_cost",
      "when coalesce((r->>'eliminatedInputFloorCost')::numeric, 0) > 0 then 1 else 0 end",
      "eliminated_credited_requests = bvsala.usage_daily.eliminated_credited_requests + excluded.eliminated_credited_requests,",
      "eliminated_floor_cost = bvsala.usage_daily_by_model.eliminated_floor_cost + excluded.eliminated_floor_cost,",
    ]) {
      expect(rpc, pieza).toContain(pieza);
    }
  });

  it("el cuerpo de la RPC es idéntico al de 0025 línea a línea fuera de los dos bloques que 0029 cambia", () => {
    const limpiar = (c: string) => sinBloque(sinBloque(c, BLOQUE_USAGE), BLOQUE_MODELO);
    // Si esto falla, alguien tocó (o perdió) algo de 0025 al copiar: revisar el
    // cuerpo contra 0025, no el diff (doctrina de 0015:70-79).
    expect(limpiar(cuerpoRpc(sql))).toBe(limpiar(cuerpoRpc(sql25)));
  });

  it("no redefine semver_key (es de 0024 y ya está en prod cuando 0029 llega)", () => {
    expect(sql).not.toContain("create or replace function bvsala.semver_key");
  });
});

describe("0029 — lo propio: guard 0025, columnas, CHECK ≥ 0, reference_hits y measured_* intactas", () => {
  it("aborta si falta la base 0025 (o 0016) ANTES de tocar nada", () => {
    const guard = sql.indexOf("0029: base 0025 ausente");
    expect(guard).toBeGreaterThan(0);
    expect(sql).toContain("to_regclass('bvsala.extractos') is null");
    expect(sql).toContain("table_name = 'usage_daily_by_model'");
    for (const cambio of ["alter table", "create table", "create index", "create policy", "create or replace function"]) {
      expect(sql.indexOf(cambio), cambio).toBeGreaterThan(guard);
    }
    // El guard exige en la RPC viva la pieza de 0024 y la de 0025 a la vez.
    const bloqueGuard = sql.slice(sql.indexOf("do $$"), sql.indexOf("end $$;"));
    expect(bloqueGuard).toContain("p.prosrc like '%eliminatedInputFloorCost%'");
    expect(bloqueGuard).toContain("p.prosrc like '%clientVersion%'");
  });

  it("el diagnóstico de cabecera exige las TRES piezas en la RPC final (0024, 0025 y 0029)", () => {
    const diag = sql.slice(0, sql.indexOf("do $$"));
    expect(diag).toContain("p.prosrc like '%reference_hits%'");
    expect(diag).toContain("p.prosrc like '%eliminatedInputFloorCost%'");
    expect(diag).toContain("p.prosrc like '%clientVersion%'");
    expect(diag).toContain("to_regclass('bvsala.reference_hits') is not null as tabla_0029");
    expect(diag).toContain("column_name='regla_referencia'");
  });

  it("`medido` y las tres líneas measured_* son LITERALES a 0025", () => {
    const rpc = cuerpoRpc(sql);
    expect(rpc).toContain("medido := case when r->>'basis' = 'measured' then 1 else 0 end;");
    const usage = bloque(rpc, BLOQUE_USAGE);
    expect(usage).toContain(
      "      medido,\n      medido * coalesce((r->>'baselineCost')::numeric, 0),\n      medido * coalesce((r->>'actualCost')::numeric, 0),\n",
    );
    for (const linea of [
      "measured_requests = bvsala.usage_daily.measured_requests + excluded.measured_requests,",
      "measured_baseline_cost = bvsala.usage_daily.measured_baseline_cost + excluded.measured_baseline_cost,",
      "measured_actual_cost = bvsala.usage_daily.measured_actual_cost + excluded.measured_actual_cost,",
    ]) {
      expect(usage, linea).toContain(linea);
    }
  });

  it("usage_daily: las tres columnas reference_* al final, sus tres case y sus tres acumulaciones", () => {
    const usage = bloque(cuerpoRpc(sql), BLOQUE_USAGE);
    expect(usage).toContain(
      "measured_requests, measured_baseline_cost, measured_actual_cost,\n      eliminated_floor_cost, eliminated_credited_requests,\n      reference_requests, reference_baseline_cost, reference_actual_cost\n    ) values (",
    );
    expect(usage).toContain(
      "      case when coalesce((r->>'eliminatedInputFloorCost')::numeric, 0) > 0 then 1 else 0 end,\n" +
        "      case when r->>'basis' = 'reference' then 1 else 0 end,\n" +
        "      case when r->>'basis' = 'reference' then coalesce((r->>'baselineCost')::numeric, 0) else 0 end,\n" +
        "      case when r->>'basis' = 'reference' then coalesce((r->>'actualCost')::numeric, 0) else 0 end\n    )",
    );
    for (const linea of [
      "reference_requests = bvsala.usage_daily.reference_requests + excluded.reference_requests,",
      "reference_baseline_cost = bvsala.usage_daily.reference_baseline_cost + excluded.reference_baseline_cost,",
      "reference_actual_cost = bvsala.usage_daily.reference_actual_cost + excluded.reference_actual_cost,",
    ]) {
      expect(usage, linea).toContain(linea);
    }
    // El comentario de 0029 va pegado encima del insert (sinBloque lo retira con él).
    expect(cuerpoRpc(sql)).toContain(
      "    -- requests/avoided/tokens/baseline/actual exactamente como un estimated.\n    insert into bvsala.usage_daily (\n",
    );
  });

  it("⛔ la referencia JAMÁS entra en measured_* ni se multiplica por `medido`", () => {
    const rpc = cuerpoRpc(sql);
    expect(rpc).not.toMatch(/measured_[a-z_]+ = [^\n]*reference/);
    expect(rpc).not.toMatch(/medido \* [^\n]*reference/);
    // Y no toca el carril sombra (que hace `continue` antes).
    expect(rpc.indexOf("r->>'basis' = 'shadow'")).toBeLessThan(rpc.indexOf(`\n    ${BLOQUE_USAGE}\n`));
  });

  it("fold por modelo: las dos columnas, sus acumulaciones y la fila idempotente de reference_hits", () => {
    const modelo = bloque(cuerpoRpc(sql), BLOQUE_MODELO);
    expect(modelo).toContain("eliminated_input_tokens, eliminated_floor_cost, reference_requests, reference_baseline_cost, updated_at");
    expect(modelo).toContain(
      "reference_requests = bvsala.usage_daily_by_model.reference_requests + excluded.reference_requests,",
    );
    expect(modelo).toContain(
      "reference_baseline_cost = bvsala.usage_daily_by_model.reference_baseline_cost + excluded.reference_baseline_cost,",
    );
    expect(modelo).toContain("if r->>'basis' = 'reference' then");
    expect(modelo).toContain("insert into bvsala.reference_hits (");
    expect(modelo).toContain("on conflict (org_id, request_id) do nothing;");
    expect(modelo).toContain("nullif(r->>'referenceRequestId', '')");
    expect(modelo).toContain("to_timestamp(((r->>'referenceAt')::double precision) / 1000.0)");
    // Pegado sin línea en blanco tras el conflict: si no, sinBloque dejaría la
    // fila de reference_hits FUERA del bloque y la comparación contra 0025 fallaría.
    expect(modelo).toContain("      updated_at = now();\n    -- 0029 · una fila por acierto");
  });

  it("exactamente 9 columnas nuevas y 2 CHECK, y los CHECK solo dicen ≥ 0", () => {
    expect(sql.split("add column if not exists").length - 1).toBe(9);
    expect(sql.split("add constraint").length - 1).toBe(2);
    expect(sql).toContain("drop constraint if exists usage_daily_reference_no_negatives");
    expect(sql).toContain("drop constraint if exists extractos_referencia_no_negativos");
    for (const nombre of ["usage_daily_reference_no_negatives", "extractos_referencia_no_negativos"]) {
      const ini = sql.indexOf(`add constraint ${nombre}`);
      expect(ini, nombre).toBeGreaterThan(0);
      const check = sql.slice(ini, sql.indexOf(");", ini));
      expect(check).toContain(">= 0");
      // Nada de cotas cruzadas: un CHECK que pudiera fallar revierte el lote (0011).
      expect(check).not.toContain("*");
      expect(check).not.toContain("requests <=");
      expect(check).not.toMatch(/<=|<(?!=)|>(?!=)/);
    }
    // Ninguna columna nueva en seat_activity: el dinero por asiento no recibe referencia.
    expect(sql).not.toContain("alter table bvsala.seat_activity");
  });

  it("extractos: las cuatro columnas del carril, con default", () => {
    for (const col of [
      "add column if not exists requests_referencia   bigint        not null default 0",
      "add column if not exists base_referencia_usd   numeric(14,6) not null default 0",
      "add column if not exists ahorro_referencia_usd numeric(14,6) not null default 0",
      "add column if not exists regla_referencia      text          not null default ''",
    ]) {
      expect(sql, col).toContain(col);
    }
  });

  it("reference_hits: tabla con RLS de miembro, política re-ejecutable y dinero en numeric(20,10)", () => {
    expect(sql).toContain("create table if not exists bvsala.reference_hits (");
    expect(sql).toContain("primary key (org_id, request_id)");
    expect(sql).toContain("numeric(20,10)");
    expect(sql).toContain("alter table bvsala.reference_hits enable row level security;");
    expect(sql).toContain("drop policy if exists reference_hits_read on bvsala.reference_hits;");
    expect(sql).toContain("create policy reference_hits_read on bvsala.reference_hits");
    expect(sql).toContain("for select using (bvsala.is_org_member(org_id));");
    expect(sql).toContain("grant select on bvsala.reference_hits to authenticated;");
    expect(sql.indexOf("drop policy if exists reference_hits_read")).toBeLessThan(sql.indexOf("create policy reference_hits_read"));
  });

  it("nunca DROP de función ni de tabla, y el grant va después de la RPC", () => {
    expect(sql.toLowerCase()).not.toContain("drop function");
    expect(sql.toLowerCase()).not.toContain("drop table");
    expect(sql.lastIndexOf("grant execute on function bvsala.ingest_usage_batch(uuid, jsonb) to service_role")).toBeGreaterThan(
      sql.indexOf("create or replace function bvsala.ingest_usage_batch"),
    );
  });
});
