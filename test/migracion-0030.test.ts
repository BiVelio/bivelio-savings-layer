import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * 0030 — TU PROPIO BANCO. Aditiva e independiente: tablas propias, función de
 * ingest propia y función de resumen propia. A diferencia de 0025/0029 NO
 * sustituye la RPC de uso —ése es el punto—, así que aquí no hay comparación
 * línea a línea: hay la prueba de que no la nombra.
 */
const sql = readFileSync(new URL("../db/migrations/0030_banco_propio.sql", import.meta.url), "utf8");
/** El SQL sin comentarios de línea: lo que de verdad ejecuta la base. */
const codigo = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

function bloque(desde: string, hasta: string): string {
  const i = codigo.indexOf(desde);
  expect(i, desde).toBeGreaterThanOrEqual(0);
  const j = codigo.indexOf(hasta, i + desde.length);
  expect(j, hasta).toBeGreaterThan(i);
  return codigo.slice(i, j);
}

const TABLAS = ["verification_samples", "verification_daily", "verification_batches_seen"];

describe("0030 — tu propio banco", () => {
  it("empieza por la guarda de la base", () => {
    expect(codigo).toMatch(/to_regclass\('bvsala\.organizations'\) is null/);
    expect(codigo).toMatch(/to_regprocedure\('bvsala\.is_org_member\(uuid\)'\) is null/);
    expect(codigo.indexOf("raise exception '0030: base ausente")).toBeLessThan(codigo.indexOf("create table"));
  });

  it("las tres tablas, idempotentes, con su clave primaria y RLS", () => {
    expect(codigo).toContain("create table if not exists bvsala.verification_samples (");
    expect(codigo).toContain("primary key (org_id, request_id)");
    expect(codigo).toContain("create table if not exists bvsala.verification_daily (");
    expect(codigo).toContain("primary key (org_id, day, category)");
    expect(codigo).toContain("create table if not exists bvsala.verification_batches_seen (");
    expect(codigo).toContain("primary key (org_id, batch_id)");
    for (const t of TABLAS) {
      expect(codigo, t).toContain(`alter table bvsala.${t} enable row level security;`);
      expect(codigo, t).toMatch(new RegExp(`grant all\\s+on bvsala\\.${t} to service_role;`));
    }
  });

  it("lectura solo para miembros; la idempotencia, solo para el servicio", () => {
    for (const t of ["verification_samples", "verification_daily"]) {
      expect(codigo).toContain(`drop policy if exists ${t}_read on bvsala.${t};`);
      expect(codigo).toContain(`create policy ${t}_read on bvsala.${t} for select using (bvsala.is_org_member(org_id));`);
      expect(codigo).toContain(`grant select on bvsala.${t} to authenticated;`);
    }
    expect(codigo).not.toMatch(/create policy \w+ on bvsala\.verification_batches_seen/);
    expect(codigo).not.toMatch(/grant select on bvsala\.verification_batches_seen/);
  });

  it("el único CHECK de cada tabla es de ≥ 0", () => {
    const checks = [...codigo.matchAll(/add constraint (\w+) check \(([\s\S]*?)\);/g)];
    expect(checks.map((m) => m[1])).toEqual(["verification_samples_no_negatives", "verification_daily_no_negatives"]);
    for (const m of checks) {
      const condiciones = m[2]!.split(/\band\b/).map((c) => c.replace(/\s+/g, " ").trim());
      for (const c of condiciones) expect(c, c).toMatch(/>= 0\)*$/);
    }
  });

  it("la función de ingest: definer, search_path, topes, idempotencia por lote y por petición, revoke/grant", () => {
    const f = bloque("create or replace function bvsala.ingest_verification_batch", "\nend $$;");
    expect(f).toContain("security definer set search_path = bvsala");
    expect(f).toContain("jsonb_array_length(p_samples) > 500 or jsonb_array_length(p_counts) > 200");
    expect(f).toContain("insert into bvsala.verification_batches_seen (org_id, batch_id) values (p_org, p_batch_id)");
    expect(f).toContain("if not found then return 0; end if;");
    expect(f).toMatch(/on conflict \(org_id, request_id\) do nothing;/);
    expect(f).toMatch(/set requests = bvsala\.verification_daily\.requests \+ excluded\.requests;/);
    expect(codigo).toContain("revoke all on function bvsala.ingest_verification_batch(uuid, text, jsonb, jsonb) from public, anon, authenticated;");
    expect(codigo).toContain("grant execute on function bvsala.ingest_verification_batch(uuid, text, jsonb, jsonb) to service_role;");
  });

  it("la función de resumen corre con la RLS de quien consulta", () => {
    const f = bloque("create or replace function bvsala.verification_summary", "\n$$;");
    expect(f).toContain("security invoker");
    expect(f).not.toContain("security definer");
    expect(codigo).toContain("grant execute on function bvsala.verification_summary(uuid, date, date) to authenticated, service_role;");
  });

  it("⛔ no nombra nada de la facturación ni borra funciones", () => {
    for (const prohibido of ["ingest_usage_batch", "usage_daily", "extractos", "measured_", "reference_", "drop function"]) {
      expect(sql, prohibido).not.toContain(prohibido);
    }
  });

  it("cada columna que escribe la función existe en el create table", () => {
    const tabla = bloque("create table if not exists bvsala.verification_samples (", "primary key");
    const columnas = new Set([...tabla.matchAll(/^\s{2}([a-z_0-9]+)\s+(?:uuid|text|date|timestamptz|numeric|bigint)/gm)].map((m) => m[1]!));
    const f = bloque("insert into bvsala.verification_samples (", ")\n    values");
    const escritas = f
      .replace("insert into bvsala.verification_samples (", "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean);
    expect(escritas.length).toBe(23);
    for (const c of escritas) expect(columnas, c).toContain(c);
  });
});
