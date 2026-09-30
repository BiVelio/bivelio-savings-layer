import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * 0035 — ajustes_asientos no se borra ni se trunca. 0034 concedía solo
 * select/insert/update, pero los privilegios por defecto de Supabase dan TODO a
 * service_role en las tablas nuevas: en producción quedaba DELETE concedido.
 */
const sql = readFileSync(new URL("../db/migrations/0035_ajustes_asientos_sin_borrado.sql", import.meta.url), "utf8");
const codigo = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");

describe("0035 — ajustes_asientos sin borrado", () => {
  it("exige 0034 aplicada antes de tocar nada", () => {
    const guard = codigo.indexOf("raise exception '0035: base 0034 ausente");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(codigo.indexOf("revoke"));
  });

  it("quita DELETE y TRUNCATE al service role, y nada más", () => {
    expect(codigo).toMatch(/revoke delete, truncate on bvsala\.ajustes_asientos from service_role;/);
    expect(codigo).not.toMatch(/\bgrant\b/i);
    expect(codigo).not.toMatch(/\b(drop|alter table|create)\b/i);
  });

  it("no pone trigger de borrado: el ON DELETE CASCADE desde organizations tiene que seguir funcionando", () => {
    expect(codigo).not.toMatch(/before delete/i);
  });
});
