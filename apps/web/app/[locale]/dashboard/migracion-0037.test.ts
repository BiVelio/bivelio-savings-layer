import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const leer = (nombre: string) => readFileSync(new URL(`../../../../../db/migrations/${nombre}`, import.meta.url), "utf8");
const rpc = (sql: string) => {
  const inicio = sql.indexOf("create or replace function bvsala.ingest_usage_batch");
  const fin = sql.indexOf("grant execute on function bvsala.ingest_usage_batch", inicio);
  return sql.slice(inicio, fin);
};

describe("0037 — sombra por modelo sin regresar la RPC vigente", () => {
  const actual = leer("0037_sombra_por_modelo.sql");

  it("copia íntegra la RPC de 0032 y añade solo el fold sombra", () => {
    const conFold = rpc(actual);
    const inicio = conFold.indexOf("\n\n      -- 0037 · el MISMO registro sombra");
    const fin = conFold.indexOf("      n := n + 1;", inicio);
    expect(inicio).toBeGreaterThan(0);
    expect(fin).toBeGreaterThan(inicio);
    const sinFold = `${conFold.slice(0, inicio)}\n${conFold.slice(fin)}`;
    expect(sinFold).toBe(rpc(leer("0032_ahorro_nativo_del_proveedor.sql")));
  });

  it("acumula por org/día/modelo tras la deduplicación y conserva las guardas", () => {
    expect(actual.indexOf("on conflict (org_id, request_id) do nothing")).toBeLessThan(
      actual.indexOf("insert into bvsala.usage_daily_shadow_by_model"),
    );
    expect(actual).toContain("on conflict (org_id, day, model) do update set");
    expect(actual).toContain("coalesce(nullif(r->>'model', ''), 'unknown')");
    for (const guarda of [
      "batch too large",
      "record without requestId",
      "seat_activity.reference_baseline_cost",
      "nativeCacheReadSavings",
      "eliminatedInputFloorCost",
      "reference_hits",
      "clientVersion",
      "base 0036 ausente",
    ]) {
      expect(actual).toContain(guarda);
    }
  });

  it("RLS de miembro, sin escritura directa y sin contenido de prompts", () => {
    expect(actual).toContain("alter table bvsala.usage_daily_shadow_by_model enable row level security");
    expect(actual).toContain("revoke all on bvsala.usage_daily_shadow_by_model from anon, authenticated, service_role");
    expect(actual).toContain("grant select on bvsala.usage_daily_shadow_by_model to authenticated, service_role");
    expect(actual).toContain("for select using (bvsala.is_org_member(org_id))");
    expect(actual).toContain("grant execute on function bvsala.ingest_usage_batch(uuid, jsonb) to service_role");
    expect(actual).not.toMatch(/prompt|completion|tool_result/i);
  });
});
