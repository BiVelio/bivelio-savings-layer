import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * 0032 — EL AHORRO NATIVO de la caché del proveedor, en su carril propio y FUERA
 * de la comisión. La misma lección que 0025, 0029 y 0031: la RPC se sustituye
 * SIEMPRE cuerpo entero, así que una 0032 copiada de otra versión borraría en
 * silencio un carril. Aquí se deshace, texto a texto, cada añadido de 0032 y lo
 * que queda tiene que ser la RPC de 0031 sin una coma de diferencia.
 *
 * Y lo que importa para el dinero: ninguna expresión del carril nativo entra en
 * baseline_cost, actual_cost ni measured_*. Del proveedor: se enseña, jamás se cobra.
 */
const sql = readFileSync(new URL("../db/migrations/0032_ahorro_nativo_del_proveedor.sql", import.meta.url), "utf8");
const sql31 = readFileSync(new URL("../db/migrations/0031_referencia_por_asiento.sql", import.meta.url), "utf8");

function cuerpoRpc(fuente: string): string {
  const ini = fuente.indexOf("create or replace function bvsala.ingest_usage_batch");
  expect(ini, "la RPC ingest_usage_batch tiene que estar").toBeGreaterThanOrEqual(0);
  const fin = fuente.indexOf("\n$$;", ini);
  expect(fin, "la RPC tiene que cerrarse con $$;").toBeGreaterThan(ini);
  return fuente.slice(ini, fin);
}

/** Un bloque de la RPC: desde la línea del marcador hasta la primera línea en blanco. */
function bloque(cuerpo: string, marcador: string): string {
  const ini = cuerpo.indexOf(`\n    ${marcador}\n`);
  expect(ini, `el bloque «${marcador}» tiene que estar en la RPC`).toBeGreaterThan(0);
  return cuerpo.slice(ini + 1, cuerpo.indexOf("\n\n", ini + 1));
}

const LECTURA = "coalesce((r->>'nativeCacheReadSavings')::numeric, 0)";
const PRIMA = "coalesce((r->>'nativeCacheWritePremium')::numeric, 0)";

/** Cada añadido de 0032 a la RPC, y lo que había en 0031 en su lugar. */
const DESHACER: [string, string][] = [
  [
    "    -- 0032 · + el AHORRO NATIVO de la caché del proveedor en sus tres columnas propias al\n" +
      "    -- final (native_*). Jamás en baseline_cost/actual_cost ni en measured_*: la caché es\n" +
      "    -- del proveedor y no es comisionable.\n",
    "",
  ],
  [
    "      reference_requests, reference_baseline_cost, reference_actual_cost,\n" +
      "      native_cache_read_savings, native_cache_write_premium, native_requests\n",
    "      reference_requests, reference_baseline_cost, reference_actual_cost\n",
  ],
  [
    "      case when r->>'basis' = 'reference' then coalesce((r->>'actualCost')::numeric, 0) else 0 end,\n" +
      `      ${LECTURA},\n` +
      `      ${PRIMA},\n` +
      `      case when ${LECTURA} > 0\n` +
      `             or ${PRIMA} > 0 then 1 else 0 end\n`,
    "      case when r->>'basis' = 'reference' then coalesce((r->>'actualCost')::numeric, 0) else 0 end\n",
  ],
  [
    "      native_cache_read_savings = bvsala.usage_daily.native_cache_read_savings + excluded.native_cache_read_savings,\n" +
      "      native_cache_write_premium = bvsala.usage_daily.native_cache_write_premium + excluded.native_cache_write_premium,\n" +
      "      native_requests = bvsala.usage_daily.native_requests + excluded.native_requests,\n",
    "",
  ],
  [
    "    -- 0032 · + el ahorro nativo de la caché del proveedor, POR MODELO (y por tanto por proveedor).\n",
    "",
  ],
  [
    "      eliminated_input_tokens, eliminated_floor_cost, reference_requests, reference_baseline_cost,\n" +
      "      native_cache_read_savings, native_cache_write_premium, updated_at\n",
    "      eliminated_input_tokens, eliminated_floor_cost, reference_requests, reference_baseline_cost, updated_at\n",
  ],
  [
    "      case when r->>'basis' = 'reference' then coalesce((r->>'baselineCost')::numeric, 0) else 0 end,\n" +
      `      ${LECTURA},\n` +
      `      ${PRIMA},\n` +
      "      now()\n",
    "      case when r->>'basis' = 'reference' then coalesce((r->>'baselineCost')::numeric, 0) else 0 end,\n" +
      "      now()\n",
  ],
  [
    "      native_cache_read_savings = bvsala.usage_daily_by_model.native_cache_read_savings + excluded.native_cache_read_savings,\n" +
      "      native_cache_write_premium = bvsala.usage_daily_by_model.native_cache_write_premium + excluded.native_cache_write_premium,\n",
    "",
  ],
];

describe("0032 — reproduce 0031 entero y solo añade el carril nativo", () => {
  it("deshechos los añadidos de 0032, la RPC es la de 0031 línea a línea", () => {
    let deshecho = cuerpoRpc(sql);
    for (const [de, a] of DESHACER) {
      expect(deshecho.split(de).length - 1, de).toBe(1);
      deshecho = deshecho.replace(de, a);
    }
    expect(deshecho.split("\n")).toEqual(cuerpoRpc(sql31).split("\n"));
  });

  it("conserva las piezas de 0022, 0024, 0025, 0029 y 0031", () => {
    const rpc = cuerpoRpc(sql);
    for (const pieza of [
      "batch too large",
      "record without requestId",
      "bvsala.usage_ingest_seen",
      "r->>'basis' = 'shadow'",
      "clientVersion",
      "eliminatedInputFloorCost",
      "insert into bvsala.reference_hits (",
      "reference_baseline_cost = bvsala.seat_activity.reference_baseline_cost + excluded.reference_baseline_cost",
      "active_seats",
      "security definer",
    ]) {
      expect(rpc, pieza).toContain(pieza);
    }
  });

  it("no borra nada: ni funciones, ni tablas, ni columnas", () => {
    const bajo = sql.toLowerCase();
    expect(bajo).not.toContain("drop function");
    expect(bajo).not.toContain("drop table");
    expect(bajo).not.toContain("drop column");
    expect(sql).toContain("grant execute on function bvsala.ingest_usage_batch(uuid, jsonb) to service_role;");
  });
});

describe("0032 — ⛔ el ahorro nativo JAMÁS entra en el dinero comisionable", () => {
  const rpc = cuerpoRpc(sql);
  const usage = bloque(rpc, "insert into bvsala.usage_daily (");

  it("ninguna acumulación de baseline_cost, actual_cost o measured_* menciona el carril nativo", () => {
    for (const linea of rpc.split("\n")) {
      if (/^\s*(measured_[a-z_]+|baseline_cost|actual_cost)\s*=/.test(linea)) {
        expect(linea, linea).not.toMatch(/native/i);
      }
    }
    expect(rpc).not.toMatch(/medido \* [^\n]*native/i);
  });

  it("los valores de baseline_cost, actual_cost y measured_* de usage_daily son los de 0031, sin un carácter más", () => {
    const usage31 = bloque(cuerpoRpc(sql31), "insert into bvsala.usage_daily (");
    const valores = (b: string) => b.slice(b.indexOf(") values ("), b.indexOf("\n    )\n"));
    const v32 = valores(usage).split("\n");
    const v31 = valores(usage31).split("\n");
    // Los primeros valores (todo lo de 0031) son idénticos; lo nativo va DETRÁS.
    expect(v32.slice(0, v31.length - 1)).toEqual(v31.slice(0, -1));
  });

  it("los dos campos del cable se leen solo aquí, y solo a sus columnas propias", () => {
    expect(rpc.split("'nativeCacheReadSavings'").length - 1).toBe(3); // valor y contador en usage_daily, valor en by_model
    expect(usage).toContain("native_cache_read_savings = bvsala.usage_daily.native_cache_read_savings + excluded.native_cache_read_savings");
  });
});

describe("0032 — lo propio: guard 0031, columnas, CHECK ≥ 0, numeric(20,10)", () => {
  it("aborta si falta la base 0031 ANTES de tocar nada", () => {
    const guard = sql.indexOf("0032: base 0031 ausente");
    expect(guard).toBeGreaterThan(0);
    expect(guard).toBeLessThan(sql.indexOf("alter table"));
    expect(guard).toBeLessThan(sql.indexOf("create or replace function"));
  });

  it("columnas aditivas con default, dinero en numeric(20,10)", () => {
    expect(sql).toContain("add column if not exists native_cache_read_savings  numeric(20,10) not null default 0");
    expect(sql).toContain("add column if not exists native_cache_write_premium numeric(20,10) not null default 0");
    expect(sql).toContain("add column if not exists native_requests            bigint         not null default 0");
  });

  it("el único CHECK es de no negatividad", () => {
    const checks = [...sql.matchAll(/add constraint (\w+) check/g)].map((m) => m[1]);
    expect(checks).toEqual(["usage_daily_native_no_negatives"]);
  });
});
