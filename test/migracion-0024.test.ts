import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * La lección de 0011: ningún test tocaba los .sql y un CHECK rompió producción.
 * La RPC se sustituye SIEMPRE cuerpo entero (CREATE OR REPLACE), así que 0024
 * tiene que reproducir el de 0022 COMPLETO — este test comprueba que ninguna
 * pieza heredada se cayó al copiar (una a una, como 0019), y además compara el
 * cuerpo de la RPC LÍNEA A LÍNEA con el de 0022 fuera del único bloque que
 * 0024 cambia (el upsert de seat_activity). Es la única verja que existe sobre
 * el SQL antes de prod; 0025 (B1) copiará ESTE cuerpo, no el de 0022.
 */
const sql = readFileSync(new URL("../db/migrations/0024_version_por_asiento.sql", import.meta.url), "utf8");
const sql22 = readFileSync(new URL("../db/migrations/0022_uso_por_modelo.sql", import.meta.url), "utf8");

/** El texto de la RPC: desde su CREATE OR REPLACE hasta el `$$;` que la cierra. */
function cuerpoRpc(fuente: string): string {
  const ini = fuente.indexOf("create or replace function bvsala.ingest_usage_batch");
  expect(ini, "la RPC ingest_usage_batch tiene que estar").toBeGreaterThanOrEqual(0);
  const fin = fuente.indexOf("\n$$;", ini);
  expect(fin, "la RPC tiene que cerrarse con $$;").toBeGreaterThan(ini);
  return fuente.slice(ini, fin);
}

/**
 * Quita el bloque del upsert de seat_activity: sus comentarios inmediatamente
 * anteriores, el `insert into bvsala.seat_activity` y todo hasta la primera
 * línea en blanco. Lo demás del cuerpo tiene que ser IDÉNTICO entre 0022 y 0024.
 */
function sinUpsertDeSeat(cuerpo: string): string {
  const lineas = cuerpo.split("\n");
  const ini = lineas.findIndex((l) => l.includes("insert into bvsala.seat_activity"));
  expect(ini, "el upsert de seat_activity tiene que estar en la RPC").toBeGreaterThan(0);
  let desde = ini;
  while (desde > 0 && lineas[desde - 1]!.trim().startsWith("--")) desde--;
  let hasta = ini;
  while (hasta < lineas.length && lineas[hasta]!.trim() !== "") hasta++;
  return [...lineas.slice(0, desde), ...lineas.slice(hasta)].join("\n");
}

describe("0024 — reproduce 0022 entero y cambia solo el upsert de seat_activity", () => {
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

  it("el cuerpo de la RPC es idéntico al de 0022 línea a línea fuera del upsert de seat_activity", () => {
    const propio = sinUpsertDeSeat(cuerpoRpc(sql));
    const base = sinUpsertDeSeat(cuerpoRpc(sql22));
    // Si esto falla, alguien tocó (o perdió) algo de 0022 al copiar: revisar
    // el cuerpo contra 0022, no el diff (doctrina de 0015:70-79).
    expect(propio).toBe(base);
  });

  it("el upsert de seat_activity está UNA vez y solo dentro de la RPC", () => {
    const veces = sql.split("insert into bvsala.seat_activity").length - 1;
    expect(veces).toBe(1);
    expect(cuerpoRpc(sql)).toContain("insert into bvsala.seat_activity");
  });
});

describe("0024 — lo propio: guard, semver_key, cinco columnas y el upsert nuevo", () => {
  it("aborta si falta la base 0021/0022 antes de tocar nada", () => {
    expect(sql).toContain("0024: base 0022 ausente");
    expect(sql).toContain("to_regclass('bvsala.usage_daily_by_model') is null");
    expect(sql).toContain("column_name = 'shadow_requests'");
    expect(sql).toContain("p.prosrc like '%usage_daily_by_model%'");
    // El guard va ANTES de cualquier cambio de esquema.
    expect(sql.indexOf("0024: base 0022 ausente")).toBeLessThan(sql.indexOf("create or replace function bvsala.semver_key"));
    expect(sql.indexOf("0024: base 0022 ausente")).toBeLessThan(sql.indexOf("alter table bvsala.seat_activity"));
  });

  it("define semver_key inmutable, estricta y que devuelve NULL en vez de lanzar", () => {
    const ini = sql.indexOf("create or replace function bvsala.semver_key");
    expect(ini).toBeGreaterThanOrEqual(0);
    const fn = sql.slice(ini, sql.indexOf("$$;", ini));
    expect(fn).toContain("returns int[]");
    expect(fn).toContain("immutable");
    expect(fn).toContain("strict");
    expect(fn).toContain("else null");
    expect(fn).not.toContain("raise");
  });

  it("el patrón de semver_key acepta gateway/sdk + semver y rechaza el resto (incluidas cabeceras repetidas)", () => {
    const m = /when v ~ '([^']+)'/.exec(sql);
    expect(m, "el patrón tiene que estar en la función").not.toBeNull();
    const patron = new RegExp(m![1]!);
    for (const ok of ["gateway/0.4.16", "sdk/0.4.16", "gateway/0.10.0", "sdk/1.2.3-beta.1", "gateway/9999.9999.9999"]) {
      expect(patron.test(ok), ok).toBe(true);
    }
    for (const mal of [
      "0.4.16",                          // sin superficie
      "cli/0.4.16",                      // superficie desconocida
      "gateway/0.4",                     // sin parche
      "gateway/0.4.16, gateway/0.4.16",  // cabecera repetida: «a, b»
      "gateway/0.4.16 ",                 // espacio
      "gateway/00000.4.16",              // más de 4 dígitos
      "gateway/0.4.16-",                 // sufijo vacío
      "",
    ]) {
      expect(patron.test(mal), mal).toBe(false);
    }
  });

  it("añade exactamente las cinco columnas, con default y SIN restricciones nuevas", () => {
    for (const col of [
      "add column if not exists client_version_min     text",
      "add column if not exists client_version_max     text",
      "add column if not exists requests_sin_version   bigint        not null default 0",
      "add column if not exists measured_baseline_cost numeric(14,6) not null default 0",
      "add column if not exists measured_actual_cost   numeric(14,6) not null default 0",
    ]) {
      expect(sql, col).toContain(col);
    }
    expect(sql.split("add column if not exists").length - 1).toBe(5);
    // Un CHECK que fallase revertiría el lote entero (0011): ninguno.
    expect(sql.toLowerCase()).not.toMatch(/\bcheck\s*\(/);
    expect(sql).not.toContain("add constraint");
  });

  it("el upsert sella min/max por orden semver, cuenta los sin versión y acumula el dinero medido", () => {
    const rpc = cuerpoRpc(sql);
    expect(rpc).toContain("nullif(r->>'clientVersion','')");
    expect(rpc).toContain("case when nullif(r->>'clientVersion','') is null then 1 else 0 end");
    expect(rpc).toContain("bvsala.semver_key(excluded.client_version_min) < bvsala.semver_key(bvsala.seat_activity.client_version_min)");
    expect(rpc).toContain("bvsala.semver_key(excluded.client_version_max) > bvsala.semver_key(bvsala.seat_activity.client_version_max)");
    // Un registro sin versión nunca pisa el min/max guardado.
    expect(rpc).toContain("when excluded.client_version_min is null then bvsala.seat_activity.client_version_min");
    expect(rpc).toContain("when excluded.client_version_max is null then bvsala.seat_activity.client_version_max");
    expect(rpc).toContain("requests_sin_version   = bvsala.seat_activity.requests_sin_version + excluded.requests_sin_version");
    expect(rpc).toContain("measured_baseline_cost = bvsala.seat_activity.measured_baseline_cost + excluded.measured_baseline_cost");
    expect(rpc).toContain("measured_actual_cost   = bvsala.seat_activity.measured_actual_cost + excluded.measured_actual_cost");
    // El dinero medido del asiento es el MISMO fold que usage_daily: medido × coste.
    expect(rpc.split("medido * coalesce((r->>'baselineCost')::numeric, 0)").length - 1).toBe(2);
    expect(rpc.split("medido * coalesce((r->>'actualCost')::numeric, 0)").length - 1).toBe(2);
    // `medido` se calcula ANTES del upsert de seat_activity (viene así de 0022).
    expect(rpc.indexOf("medido := case when r->>'basis' = 'measured' then 1 else 0 end"))
      .toBeLessThan(rpc.indexOf("insert into bvsala.seat_activity"));
    // Lo heredado del upsert sigue: requests +1 y last_seen_at.
    expect(rpc).toContain("requests = bvsala.seat_activity.requests + 1");
    expect(rpc).toContain("last_seen_at = now(),");
  });

  it("nunca DROP, nunca toca usage_daily, y el grant va después de la RPC", () => {
    expect(sql.toLowerCase()).not.toContain("drop function");
    expect(sql.toLowerCase()).not.toContain("drop table");
    expect(sql).not.toContain("alter table bvsala.usage_daily");
    expect(sql.indexOf("grant execute on function bvsala.ingest_usage_batch(uuid, jsonb) to service_role"))
      .toBeGreaterThan(sql.indexOf("create or replace function bvsala.ingest_usage_batch"));
  });
});
