import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * 0031 — LO MEDIDO POR REFERENCIA, TAMBIÉN POR ASIENTO. La misma lección que
 * 0025 y 0029: la RPC se sustituye SIEMPRE cuerpo entero (CREATE OR REPLACE),
 * así que una 0031 copiada de 0025 en vez de 0029 borraría el carril de
 * referencia de usage_daily y reference_hits SIN NINGÚN ERROR. Por eso este
 * test exige las piezas de 0022, 0024, 0025 y 0029, y compara el cuerpo LÍNEA A
 * LÍNEA contra 0029 fuera del ÚNICO bloque que 0031 cambia (seat_activity).
 */
const sql = readFileSync(new URL("../db/migrations/0031_referencia_por_asiento.sql", import.meta.url), "utf8");
const sql29 = readFileSync(new URL("../db/migrations/0029_medido_por_referencia.sql", import.meta.url), "utf8");

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

const BLOQUE_ASIENTO = "insert into bvsala.seat_activity (org_id, seat_id, day, requests, is_ci, last_seen_at,";
const BLOQUE_USAGE = "insert into bvsala.usage_daily (";
const BLOQUE_MODELO = "insert into bvsala.usage_daily_by_model (";

/** Las tres expresiones del carril, tal cual las escribe 0029 en usage_daily. */
const EXPRESIONES_REFERENCIA = [
  "case when r->>'basis' = 'reference' then 1 else 0 end",
  "case when r->>'basis' = 'reference' then coalesce((r->>'baselineCost')::numeric, 0) else 0 end",
  "case when r->>'basis' = 'reference' then coalesce((r->>'actualCost')::numeric, 0) else 0 end",
] as const;

describe("0031 — reproduce 0029 entero (y por tanto 0025, 0024 y 0022) y cambia solo el bloque de seat_activity", () => {
  it("el cuerpo de la RPC es idéntico al de 0029 línea a línea fuera del bloque de seat_activity", () => {
    const limpiar = (c: string) => sinBloque(c, BLOQUE_ASIENTO);
    // Si esto falla, alguien tocó (o perdió) algo de 0029 al copiar: revisar el
    // cuerpo contra 0029, no el diff (doctrina de 0015:70-79).
    expect(limpiar(cuerpoRpc(sql)).split("\n")).toEqual(limpiar(cuerpoRpc(sql29)).split("\n"));
  });

  it("conserva las piezas de 0022, 0024, 0025 y 0029, una a una", () => {
    const rpc = cuerpoRpc(sql);
    for (const pieza of [
      // 0022
      "batch too large",
      "record without requestId",
      "bvsala.usage_ingest_seen",
      "r->>'basis' = 'shadow'",
      "on conflict (org_id, day, session_id, agent_id) do update",
      "active_seats",
      "security definer",
      // 0024
      "bvsala.semver_key(excluded.client_version_min) < bvsala.semver_key(bvsala.seat_activity.client_version_min)",
      "requests_sin_version   = bvsala.seat_activity.requests_sin_version + excluded.requests_sin_version",
      "measured_baseline_cost = bvsala.seat_activity.measured_baseline_cost + excluded.measured_baseline_cost",
      // 0025
      "eliminated_floor_cost = bvsala.usage_daily.eliminated_floor_cost + excluded.eliminated_floor_cost",
      "eliminated_floor_cost = bvsala.usage_daily_by_model.eliminated_floor_cost + excluded.eliminated_floor_cost,",
      // 0029
      "insert into bvsala.reference_hits (",
      "reference_baseline_cost = bvsala.usage_daily.reference_baseline_cost + excluded.reference_baseline_cost,",
      "reference_baseline_cost = bvsala.usage_daily_by_model.reference_baseline_cost + excluded.reference_baseline_cost,",
      BLOQUE_MODELO,
      BLOQUE_USAGE,
    ]) {
      expect(rpc, pieza).toContain(pieza);
    }
  });

  it("no redefine semver_key ni borra funciones", () => {
    expect(sql).not.toContain("create or replace function bvsala.semver_key");
    expect(sql.toLowerCase()).not.toContain("drop function");
    expect(sql.toLowerCase()).not.toContain("drop table");
  });
});

describe("0031 — el bloque de seat_activity: el carril, con las MISMAS expresiones que usage_daily", () => {
  const rpc = cuerpoRpc(sql);
  const asiento = bloque(rpc, BLOQUE_ASIENTO);
  const usage = bloque(rpc, BLOQUE_USAGE);

  it("la primera línea del bloque es la de 0029, idéntica (es el marcador de la comparación)", () => {
    expect(cuerpoRpc(sql29)).toContain(`\n    ${BLOQUE_ASIENTO}\n`);
    expect(rpc).toContain(`    -- 0031 · `);
  });

  it("las tres columnas nuevas al final del insert", () => {
    expect(asiento).toContain(
      "measured_baseline_cost, measured_actual_cost,\n" +
        "                                      reference_requests, reference_baseline_cost, reference_actual_cost)\n",
    );
  });

  it("cuadre textual: las tres expresiones de referencia son las MISMAS del bloque de usage_daily", () => {
    for (const expr of EXPRESIONES_REFERENCIA) {
      expect(usage, `usage_daily: ${expr}`).toContain(expr);
      expect(asiento, `seat_activity: ${expr}`).toContain(expr);
    }
    // Y en el mismo orden: requests, baseline, actual.
    const pos = EXPRESIONES_REFERENCIA.map((e) => asiento.indexOf(e));
    expect([...pos].sort((a, b) => a - b)).toEqual(pos);
  });

  it("las dos líneas `medido * …` del asiento siguen iguales y la referencia JAMÁS se multiplica por `medido`", () => {
    expect(asiento).toContain(
      "              medido * coalesce((r->>'baselineCost')::numeric, 0),\n" +
        "              medido * coalesce((r->>'actualCost')::numeric, 0),\n",
    );
    expect(asiento).not.toMatch(/medido \* [^\n]*reference/);
    expect(rpc).not.toMatch(/measured_[a-z_]+ = [^\n]*reference/);
    expect(rpc).toContain("medido := case when r->>'basis' = 'measured' then 1 else 0 end;");
  });

  it("las tres acumulaciones al final del conflict, y measured_* intactas", () => {
    expect(asiento).toContain(
      "        measured_actual_cost   = bvsala.seat_activity.measured_actual_cost + excluded.measured_actual_cost,\n" +
        "        reference_requests      = bvsala.seat_activity.reference_requests + excluded.reference_requests,\n" +
        "        reference_baseline_cost = bvsala.seat_activity.reference_baseline_cost + excluded.reference_baseline_cost,\n" +
        "        reference_actual_cost   = bvsala.seat_activity.reference_actual_cost + excluded.reference_actual_cost;",
    );
  });
});

describe("0031 — lo propio: guard 0029, columnas sin CHECK, dinero en numeric(20,10), grant", () => {
  it("aborta si falta la base 0029 ANTES de tocar nada", () => {
    const guard = sql.indexOf("0031: base 0029 ausente");
    expect(guard).toBeGreaterThan(0);
    for (const cambio of ["alter table", "create or replace function"]) {
      expect(sql.indexOf(cambio), cambio).toBeGreaterThan(guard);
    }
    const bloqueGuard = sql.slice(sql.indexOf("do $$"), sql.indexOf("end $$;"));
    expect(bloqueGuard).toContain("to_regclass('bvsala.reference_hits') is null");
    expect(bloqueGuard).toContain("column_name='reference_baseline_cost'");
    expect(bloqueGuard).toContain("p.prosrc like '%reference_hits%'");
    expect(bloqueGuard).toContain("p.prosrc like '%eliminatedInputFloorCost%'");
    expect(bloqueGuard).toContain("p.prosrc like '%clientVersion%'");
  });

  it("el diagnóstico de cabecera exige la columna y la RPC final (0024, 0025, 0029 y 0031 a la vez)", () => {
    const diag = sql.slice(0, sql.indexOf("do $$"));
    expect(diag).toContain("table_name='seat_activity' and column_name='reference_baseline_cost') as columna_0031");
    for (const pieza of ["%reference_hits%", "%seat_activity.reference_baseline_cost%", "%eliminatedInputFloorCost%", "%clientVersion%"]) {
      expect(diag, pieza).toContain(`p.prosrc like '${pieza}'`);
    }
    // Y el patrón de la RPC final casa de verdad con el cuerpo nuevo (y no con el de 0029).
    expect(cuerpoRpc(sql)).toContain("seat_activity.reference_baseline_cost");
    expect(cuerpoRpc(sql29)).not.toContain("seat_activity.reference_baseline_cost");
  });

  it("exactamente 3 columnas nuevas, en seat_activity, con el dinero en numeric(20,10)", () => {
    expect(sql.split("add column if not exists").length - 1).toBe(3);
    const alter = sql.indexOf("alter table bvsala.seat_activity\n");
    expect(alter).toBeGreaterThan(0);
    const cuerpo = sql.slice(alter, sql.indexOf(";", alter));
    expect(cuerpo).toMatch(/add column if not exists reference_requests\s+bigint\s+not null default 0/);
    // Una mutación a (14,6) tiene que poner esto en rojo: la escala es la de 0029.
    expect(cuerpo).toMatch(/add column if not exists reference_baseline_cost numeric\(20,10\) not null default 0/);
    expect(cuerpo).toMatch(/add column if not exists reference_actual_cost\s+numeric\(20,10\) not null default 0/);
    expect(sql).not.toMatch(/reference_(baseline|actual)_cost\s+numeric\(14,6\)/);
  });

  it("ningún CHECK sobre seat_activity (un CHECK que salte revierte el lote entero: 0011)", () => {
    expect(sql).not.toContain("add constraint");
  });

  it("el grant va DESPUÉS del `$$;` de la RPC", () => {
    const cierre = sql.indexOf("\n$$;", sql.indexOf("create or replace function bvsala.ingest_usage_batch"));
    expect(cierre).toBeGreaterThan(0);
    expect(sql.lastIndexOf("grant execute on function bvsala.ingest_usage_batch(uuid, jsonb) to service_role;")).toBeGreaterThan(cierre);
  });
});
