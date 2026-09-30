import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 0034 — el cobro de los asientos usados de más. Aditiva: una tabla nueva
 * (el candado de «una vez por (org, período)»), su trigger de inmutabilidad y
 * nada más. Va DESPUÉS de 0033 (la licencia Medir) y la exige aplicada.
 */
const sql = readFileSync(new URL("../db/migrations/0034_cobro_asientos.sql", import.meta.url), "utf8");
const codigo = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0034 — ajustes_asientos", () => {
  it("empieza por la guarda de la base", () => {
    const guard = codigo.indexOf("raise exception '0034: base ausente");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(codigo.indexOf("create table"));
    expect(codigo).toContain("to_regprocedure('bvsala.billable_seats(uuid, date)') is null");
  });

  it("exige 0033 aplicada (su tabla Y su índice) antes de tocar nada", () => {
    const guard = codigo.indexOf("raise exception '0034: base 0033 ausente");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(codigo.indexOf("create table"));
    expect(codigo).toContain("to_regclass('bvsala.medir_altas') is null");
    expect(codigo).toContain("to_regclass('bvsala.licenses_una_medir_viva_por_org') is null");
  });

  it("es la ÚNICA 0034 y la siguiente a la 0033", () => {
    const migs = readdirSync(new URL("../db/migrations/", import.meta.url)).filter((f) => /^\d{4}_.*\.sql$/.test(f));
    expect(migs.filter((f) => f.startsWith("0034_"))).toEqual(["0034_cobro_asientos.sql"]);
    expect(migs.filter((f) => f.startsWith("0033_"))).toEqual(["0033_licencia_medir.sql"]);
  });

  it("una fila por (org, período): la PK es el candado", () => {
    expect(codigo).toMatch(/primary key \(org_id, periodo\)/);
    expect(codigo).toContain("periodo                 text not null check (periodo ~ '^\\d{4}-\\d{2}$')");
    expect(codigo).toContain("stripe_invoice_item_id  text unique");
  });

  it("el CHECK de estados es el de siempre (el test del código, cobro-asientos.test.ts, lo ata a ESTADOS_DE_AJUSTE)", () => {
    const m = codigo.match(/estado\s+text not null check \(estado in \(([\s\S]*?)\)\)/);
    expect(m).not.toBeNull();
    const enSql = [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();
    expect(enSql).toEqual(
      ["cobrado", "fallido", "omitido_bajo_minimo", "omitido_no_activa", "omitido_sin_precio", "pendiente", "revision_humana", "seco"],
    );
  });

  it("las cifras cuadran por construcción y un cobrado lleva su item", () => {
    expect(codigo).toContain("check (exceso = greatest(usados - pagados, 0))");
    expect(codigo).toContain("check (estado <> 'cobrado' or stripe_invoice_item_id is not null)");
    expect(codigo).toContain("importe_eur             numeric(12,2) not null check (importe_eur >= 0)");
  });

  it("inmutable: cobrado terminal, cifras fijadas fuera de seco, no se vuelve a seco", () => {
    expect(codigo).toMatch(/before update on bvsala\.ajustes_asientos\s+for each row execute function bvsala\.ajustes_asientos_inmutable\(\)/);
    expect(codigo).toContain("if old.estado = 'cobrado' then");
    expect(codigo).toContain("if new.estado = 'seco' and old.estado <> 'seco' then");
    for (const col of ["plan", "periodo_pago", "usados", "pagados", "exceso", "importe_eur"]) {
      expect(codigo).toContain(`new.${col} is distinct from old.${col}`);
    }
    expect(codigo).toContain("set search_path = bvsala, pg_temp");
  });

  it("solo el service role, y sin DELETE", () => {
    expect(codigo).toContain("alter table bvsala.ajustes_asientos enable row level security;");
    expect(codigo).toContain("revoke all on bvsala.ajustes_asientos from anon, authenticated;");
    expect(codigo).toContain("grant select, insert, update on bvsala.ajustes_asientos to service_role;");
    expect(codigo).not.toMatch(/create policy \w+ on bvsala\.ajustes_asientos/);
    expect(codigo).not.toMatch(/grant[^;]*delete[^;]*ajustes_asientos/i);
  });

  it("no toca la RPC de uso ni ninguna fila existente", () => {
    expect(codigo).not.toMatch(/ingest_usage_batch/);
    expect(codigo).not.toMatch(/(alter table|update|insert into|delete from)\s+bvsala\.(usage_daily|subscriptions|cargos|extractos)/);
    expect(codigo).not.toMatch(/\bdrop table\b/i);
  });
});

describe("0034 — el runbook", () => {
  const runbook = readFileSync(new URL("../docs/RUNBOOK-MIGRACIONES-PROD.md", import.meta.url), "utf8");
  it("tiene su anexo, su fila en el diagnóstico y dice 0034 ANTES de la web", () => {
    expect(runbook).toContain("## Anexo — 0034");
    expect(runbook).toContain("('0034 cobro de asientos'");
    expect(runbook).toMatch(/0034\*\* ANTES de desplegar la web/);
  });
});
