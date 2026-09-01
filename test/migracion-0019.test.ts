import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

/**
 * La lección de 0011: ningún test tocaba los .sql y un CHECK rompió producción.
 * La RPC se sustituye SIEMPRE cuerpo entero (CREATE OR REPLACE), así que 0019
 * tiene que reproducir el de 0015 COMPLETO — este test comprueba que ninguna
 * pieza heredada se cayó al copiar, y que la adición de sesiones está y no toca
 * usage_daily.
 */
const sql = readFileSync(new URL("../db/migrations/0019_atribucion_por_sesion.sql", import.meta.url), "utf8");

describe("0019 — reproduce 0015 entero y añade solo usage_sessions", () => {
  it("conserva las piezas heredadas de 0015, una a una", () => {
    for (const pieza of [
      "batch too large",                     // tope de lote
      "record without requestId",            // requestId obligatorio
      "bvsala.usage_ingest_seen",            // idempotencia
      "bvsala.seat_activity",                // asientos
      "measured_actual_cost = bvsala.usage_daily.measured_actual_cost + excluded.measured_actual_cost", // acumulación measured
      "baseline_input_tokens = bvsala.usage_daily.baseline_input_tokens + excluded.baseline_input_tokens", // tokens de 0015
      "active_seats",                        // recuento del día
      "grant execute on function bvsala.ingest_usage_batch(uuid, jsonb) to service_role", // ACL (nunca DROP+CREATE)
      "security definer",
    ]) {
      expect(sql, pieza).toContain(pieza);
    }
  });

  it("añade la tabla de sesiones con su clave por subagente, RLS y acumulación aditiva", () => {
    expect(sql).toContain("create table if not exists bvsala.usage_sessions");
    expect(sql).toContain("primary key (org_id, day, session_id, agent_id)");
    expect(sql).toContain("alter table bvsala.usage_sessions enable row level security");
    expect(sql).toContain("bvsala.is_org_member(org_id)");
    expect(sql).toContain("r->>'sessionId'");
    expect(sql).toContain("on conflict (org_id, day, session_id, agent_id) do update");
  });

  it("NO toca los CHECK ni las columnas de usage_daily (la trampa de 0011)", () => {
    expect(sql).not.toContain("alter table bvsala.usage_daily");
    expect(sql).not.toContain("add constraint");
  });
});
