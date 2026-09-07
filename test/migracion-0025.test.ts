import { existsSync, readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * La lección de 0011: ningún test tocaba los .sql y un CHECK rompió producción.
 * Y la regla 1 del runbook: la RPC se sustituye SIEMPRE cuerpo entero (CREATE
 * OR REPLACE), así que una 0025 copiada de 0022 en vez de 0024 borraría la
 * pieza de 0024 (versión por asiento) SIN NINGÚN ERROR — el síntoma sería mudo:
 * dejarían de sellarse versiones y el panel diría «sin declarar».
 *
 * Por eso este test exige a la vez las piezas de 0022, las de 0024 y las
 * propias, y compara el cuerpo LÍNEA A LÍNEA:
 *   · contra 0024 (cuando el fichero está: B1 se mergea DESPUÉS de A) fuera de
 *     los DOS bloques que 0025 cambia (insert de usage_daily y fold by_model);
 *   · contra 0022 (siempre, está en main) fuera de esos dos y del upsert de
 *     seat_activity que cambió 0024.
 */
const sql = readFileSync(new URL("../db/migrations/0025_dinero_de_la_elision_suelo.sql", import.meta.url), "utf8");
const sql22 = readFileSync(new URL("../db/migrations/0022_uso_por_modelo.sql", import.meta.url), "utf8");
const ruta24 = new URL("../db/migrations/0024_version_por_asiento.sql", import.meta.url);
const hay24 = existsSync(ruta24);

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

const BLOQUE_SEAT = "insert into bvsala.seat_activity (org_id, seat_id, day, requests, is_ci, last_seen_at,";
const BLOQUE_SEAT_22 = "insert into bvsala.seat_activity (org_id, seat_id, day, requests, is_ci, last_seen_at)";
const BLOQUE_USAGE = "insert into bvsala.usage_daily (";
const BLOQUE_MODELO = "insert into bvsala.usage_daily_by_model (";

describe("0025 — reproduce 0024 entero (y por tanto 0022) y cambia solo usage_daily y el fold por modelo", () => {
  it("conserva las piezas heredadas de 0022, una a una", () => {
    for (const pieza of [
      "batch too large",                     // tope de lote
      "record without requestId",            // requestId obligatorio
      "bvsala.usage_ingest_seen",            // idempotencia (0009)
      "r->>'basis' = 'shadow'",              // carril sombra (0021)
      "shadow_requests",                     //   … con sus columnas propias
      "bvsala.seat_activity",                // asientos
      "measured_actual_cost = bvsala.usage_daily.measured_actual_cost + excluded.measured_actual_cost", // acumulación measured (0010)
      "baseline_input_tokens = bvsala.usage_daily.baseline_input_tokens + excluded.baseline_input_tokens", // tokens (0015)
      "bvsala.usage_daily_by_model",         // fold por modelo (0022)
      "on conflict (org_id, day, model) do update",
      "bvsala.usage_sessions",               // atribución por sesión (0019)
      "on conflict (org_id, day, session_id, agent_id) do update",
      "active_seats",                        // recuento del día
      "grant execute on function bvsala.ingest_usage_batch(uuid, jsonb) to service_role", // ACL (nunca DROP+CREATE)
      "security definer",
    ]) {
      expect(sql, pieza).toContain(pieza);
    }
  });

  it("conserva las piezas de 0024 (la versión por asiento y el dinero medido por asiento), una a una", () => {
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
    // 0025 NO redefine semver_key: es de 0024 y ya está en prod cuando 0025 llega.
    expect(sql).not.toContain("create or replace function bvsala.semver_key");
  });

  it.skipIf(!hay24)("el cuerpo de la RPC es idéntico al de 0024 línea a línea fuera de los dos bloques que 0025 cambia", () => {
    const sql24 = readFileSync(ruta24, "utf8");
    const limpiar = (c: string) => sinBloque(sinBloque(c, BLOQUE_USAGE), BLOQUE_MODELO);
    // Si esto falla, alguien tocó (o perdió) algo de 0024 al copiar: revisar
    // el cuerpo contra 0024, no el diff (doctrina de 0015:70-79).
    expect(limpiar(cuerpoRpc(sql))).toBe(limpiar(cuerpoRpc(sql24)));
  });

  it("el cuerpo de la RPC es idéntico al de 0022 línea a línea fuera de los tres bloques que cambiaron 0024 y 0025", () => {
    const propio = sinBloque(sinBloque(sinBloque(cuerpoRpc(sql), BLOQUE_SEAT), BLOQUE_USAGE), BLOQUE_MODELO);
    const base = sinBloque(sinBloque(sinBloque(cuerpoRpc(sql22), BLOQUE_SEAT_22), BLOQUE_USAGE), BLOQUE_MODELO);
    expect(propio).toBe(base);
  });

  it("(aviso) sin 0024 en el árbol la comparación contra 0024 se salta: B1 se re-diffea cuando A esté en main", () => {
    // No es un fallo: documenta el estado. Con 0024 presente, el test de arriba corre.
    expect(typeof hay24).toBe("boolean");
  });
});

describe("0025 — lo propio: guard 0024, columnas, el ÚNICO check, y measured_* intactas", () => {
  it("aborta si falta la base 0024 antes de tocar nada — y exige la pieza de 0024 en la RPC viva", () => {
    expect(sql).toContain("0025: base 0024 ausente");
    expect(sql).toContain("to_regclass('bvsala.usage_daily_by_model') is null");
    expect(sql).toContain("column_name = 'client_version_min'");
    expect(sql).toContain("p.prosrc like '%clientVersion%'");
    // El guard va ANTES de cualquier cambio de esquema.
    expect(sql.indexOf("0025: base 0024 ausente")).toBeLessThan(sql.indexOf("alter table bvsala.usage_daily"));
    expect(sql.indexOf("0025: base 0024 ausente")).toBeLessThan(sql.indexOf("alter table bvsala.usage_daily_by_model"));
    expect(sql.indexOf("0025: base 0024 ausente")).toBeLessThan(sql.indexOf("create or replace function"));
  });

  it("el diagnóstico exige las DOS piezas en la RPC final (clientVersion Y eliminatedInputFloorCost)", () => {
    const diag = sql.slice(0, sql.indexOf("do $$"));
    expect(diag).toContain("p.prosrc like '%eliminatedInputFloorCost%'");
    expect(diag).toContain("p.prosrc like '%clientVersion%'");
  });

  it("añade las dos columnas a usage_daily y las dos a usage_daily_by_model, con default", () => {
    for (const col of [
      "add column if not exists eliminated_floor_cost        numeric(14,6) not null default 0",
      "add column if not exists eliminated_credited_requests bigint        not null default 0",
      "add column if not exists eliminated_input_tokens bigint        not null default 0",
      "add column if not exists eliminated_floor_cost   numeric(14,6) not null default 0",
    ]) {
      expect(sql, col).toContain(col);
    }
    expect(sql.split("add column if not exists").length - 1).toBe(4);
    // Ninguna columna nueva en seat_activity: eso fue 0024.
    expect(sql).not.toContain("alter table bvsala.seat_activity");
  });

  it("el ÚNICO check es ≥ 0 sobre las dos columnas nuevas, con drop if exists (re-ejecutable)", () => {
    expect(sql.split("add constraint").length - 1).toBe(1);
    expect(sql).toContain("drop constraint if exists usage_daily_elision_floor_no_negatives");
    const ini = sql.indexOf("add constraint usage_daily_elision_floor_no_negatives");
    const check = sql.slice(ini, sql.indexOf(");", ini));
    expect(check).toContain("eliminated_floor_cost        >= 0");
    expect(check).toContain("eliminated_credited_requests >= 0");
    // Nada de «suelo ≤ tokens × precio»: el servidor no conoce precios y un
    // CHECK que pudiera fallar revertiría el lote entero (0011).
    expect(check).not.toContain("eliminated_input_tokens");
    expect(check).not.toContain("*");
  });

  it("usage_daily: el suelo y la acreditada van al final, sumados en el conflict, y measured_* siguen LITERALES", () => {
    const rpc = cuerpoRpc(sql);
    // Las tres líneas de measured_* del insert de 0022, tal cual.
    // Por LÍNEA exacta: el insert del carril sombra empieza igual («insert
    // into bvsala.usage_daily (org_id, …») y va antes.
    const iniUsage = rpc.indexOf(`\n    ${BLOQUE_USAGE}\n`) + 1;
    expect(iniUsage).toBeGreaterThan(0);
    const values = rpc.slice(iniUsage, rpc.indexOf("on conflict (org_id, day) do update", iniUsage));
    expect(values).toContain("      medido,\n      medido * coalesce((r->>'baselineCost')::numeric, 0),\n      medido * coalesce((r->>'actualCost')::numeric, 0),\n");
    expect(values).toContain("measured_requests, measured_baseline_cost, measured_actual_cost,\n      eliminated_floor_cost, eliminated_credited_requests");
    expect(values).toContain("coalesce((r->>'eliminatedInputFloorCost')::numeric, 0),\n      case when coalesce((r->>'eliminatedInputFloorCost')::numeric, 0) > 0 then 1 else 0 end");
    // El conflict: las tres de measured_* de 0022 literales + las dos nuevas.
    for (const linea of [
      "measured_requests = bvsala.usage_daily.measured_requests + excluded.measured_requests,",
      "measured_baseline_cost = bvsala.usage_daily.measured_baseline_cost + excluded.measured_baseline_cost,",
      "measured_actual_cost = bvsala.usage_daily.measured_actual_cost + excluded.measured_actual_cost,",
      "eliminated_floor_cost = bvsala.usage_daily.eliminated_floor_cost + excluded.eliminated_floor_cost,",
      "eliminated_credited_requests = bvsala.usage_daily.eliminated_credited_requests + excluded.eliminated_credited_requests,",
    ]) {
      expect(rpc, linea).toContain(linea);
    }
    // El suelo JAMÁS multiplicado por `medido` ni sumado a measured_*.
    expect(rpc).not.toMatch(/medido \* coalesce\(\(r->>'eliminatedInputFloorCost'\)/);
    expect(rpc).not.toMatch(/measured_[a-z_]+ = [^\n]*eliminated/);
    // Y no toca el carril sombra (que hace `continue` antes).
    expect(rpc.indexOf("r->>'basis' = 'shadow'")).toBeLessThan(rpc.indexOf(BLOQUE_USAGE));
  });

  it("fold por modelo: tokens borrados y suelo POR MODELO, sumados en el conflict", () => {
    const rpc = cuerpoRpc(sql);
    const ini = rpc.indexOf(BLOQUE_MODELO);
    const bloque = rpc.slice(ini, rpc.indexOf("\n\n", ini));
    expect(bloque).toContain("eliminated_input_tokens, eliminated_floor_cost, updated_at");
    expect(bloque).toContain("coalesce((r->>'eliminatedInputTokens')::bigint, 0),\n      coalesce((r->>'eliminatedInputFloorCost')::numeric, 0),");
    expect(bloque).toContain("eliminated_input_tokens = bvsala.usage_daily_by_model.eliminated_input_tokens + excluded.eliminated_input_tokens,");
    expect(bloque).toContain("eliminated_floor_cost = bvsala.usage_daily_by_model.eliminated_floor_cost + excluded.eliminated_floor_cost,");
  });

  it("nunca DROP de función ni de tabla, y el grant va después de la RPC", () => {
    expect(sql.toLowerCase()).not.toContain("drop function");
    expect(sql.toLowerCase()).not.toContain("drop table");
    expect(sql.indexOf("grant execute on function bvsala.ingest_usage_batch(uuid, jsonb) to service_role"))
      .toBeGreaterThan(sql.indexOf("create or replace function bvsala.ingest_usage_batch"));
  });
});
