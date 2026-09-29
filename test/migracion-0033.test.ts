import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";


/**
 * 0033 — la licencia Medir. Aditiva: un valor más en el CHECK del plan, un
 * índice único parcial y una tabla de altas solo para el service role. Va
 * DESPUÉS de 0032 (el ahorro nativo) y la exige aplicada, como 0032 exige 0031.
 */
const sql = readFileSync(new URL("../db/migrations/0033_licencia_medir.sql", import.meta.url), "utf8");
const codigo = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0033 — la licencia Medir", () => {
  it("empieza por la guarda de la base", () => {
    expect(codigo.indexOf("raise exception '0033: base ausente")).toBeLessThan(codigo.indexOf("alter table"));
  });

  it("exige 0032 aplicada (su columna Y su versión de la RPC) antes de tocar nada", () => {
    const guard = codigo.indexOf("raise exception '0033: base 0032 ausente");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(codigo.indexOf("alter table"));
    expect(codigo).toContain("column_name='native_cache_read_savings'");
    expect(codigo).toContain("p.prosrc like '%nativeCacheReadSavings%'");
  });

  it("es la ÚNICA 0033 y la siguiente a la 0032 más alta del repo", () => {
    const migs = readdirSync(new URL("../db/migrations/", import.meta.url)).filter((f) => /^\d{4}_.*\.sql$/.test(f));
    expect(migs.filter((f) => f.startsWith("0033_"))).toEqual(["0033_licencia_medir.sql"]);
    // Ninguna migración de este PR con otro número (la 0032 es la del ahorro nativo, #412).
    expect(migs.filter((f) => /licencia_medir/.test(f))).toEqual(["0033_licencia_medir.sql"]);
  });

  it("admite `measure` sin perder ningún plan anterior", () => {
    expect(codigo).toContain("drop constraint if exists licenses_plan_check");
    expect(codigo).toMatch(/check \(plan in \('free', 'measure', 'pro', 'team', 'enterprise'\)\)/);
  });

  it("una Medir viva por organización", () => {
    expect(codigo).toMatch(
      /create unique index if not exists licenses_una_medir_viva_por_org\s+on bvsala\.licenses \(org_id\)\s+where plan = 'measure' and revoked = false;/,
    );
  });

  it("las altas: una por cuenta (PK usuario), una por organización (única), solo service role", () => {
    expect(codigo).toContain("user_id       uuid primary key references auth.users(id)");
    expect(codigo).toContain("org_id        uuid not null unique references bvsala.organizations(id)");
    expect(codigo).toContain("alter table bvsala.medir_altas enable row level security;");
    expect(codigo).toContain("revoke all on bvsala.medir_altas from anon, authenticated;");
    expect(codigo).not.toMatch(/create policy \w+ on bvsala\.medir_altas/);
    // Guarda el dominio del correo, nunca la dirección.
    expect(codigo).toContain("email_dominio text");
    expect(codigo).not.toMatch(/\bemail\s+text/);
  });

  it("no toca la RPC de uso ni ninguna fila existente: no puede regresar la versión de 0032", () => {
    // `ingest_usage_batch` solo aparece en el guard (lectura de pg_proc), jamás definida.
    expect(codigo).not.toMatch(/create\s+(or\s+replace\s+)?function/i);
    expect(codigo).not.toMatch(/(alter table|update|insert into|delete from)\s+bvsala\.usage_daily/);
    expect(codigo).not.toMatch(/\b(update|delete from)\s+bvsala\./);
  });
});
