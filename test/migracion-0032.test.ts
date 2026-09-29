import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";


/**
 * 0032 — la licencia Medir. Aditiva: un valor más en el CHECK del plan, un
 * índice único parcial y una tabla de altas solo para el service role.
 */
const sql = readFileSync(new URL("../db/migrations/0032_licencia_medir.sql", import.meta.url), "utf8");
const codigo = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0032 — la licencia Medir", () => {
  it("empieza por la guarda de la base", () => {
    expect(codigo.indexOf("raise exception '0032: base ausente")).toBeLessThan(codigo.indexOf("alter table"));
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

  it("no toca la RPC de uso ni ninguna fila existente", () => {
    expect(codigo).not.toMatch(/ingest_usage_batch/);
    expect(codigo).not.toMatch(/\b(update|delete from)\s+bvsala\./);
  });
});
