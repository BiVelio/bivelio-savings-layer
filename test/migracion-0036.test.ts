import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  ESTADOS_DE_INTENTO,
  MOTIVOS_DE_INCERTIDUMBRE,
  MOTIVOS_DE_NO_ENVIO,
  TRANSICIONES,
  idDeEventoDePresupuesto,
} from "../src/metering/presupuesto.js";
import { sha256 } from "../src/util/hash.js";

/**
 * 0036 — el presupuesto por intento (D07). ESCRITA, SIN APLICAR: el repositorio
 * no tiene un parser de SQL ni una base de pruebas, así que aquí se comprueba
 * lo que se puede sin ejecutarla — la forma léxica, el orden, los privilegios —
 * y, sobre todo, que la base y el SDK dicen LO MISMO: los estados, las
 * transiciones, las pruebas de no-envío y el id de los eventos de la outbox.
 */
const sql = readFileSync(new URL("../db/migrations/0036_presupuesto_intentos.sql", import.meta.url), "utf8");
const codigo = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n");
const sinCadenas = codigo.replace(/'(?:[^']|'')*'/g, "''");

const lista = (m: RegExpMatchArray | null) => [...m![1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort();

describe("0036 — forma y orden", () => {
  it("es la ÚNICA 0036 y la siguiente a la 0035", () => {
    const migs = readdirSync(new URL("../db/migrations/", import.meta.url)).filter((f) => /^\d{4}_.*\.sql$/.test(f));
    expect(migs.filter((f) => f.startsWith("0036_"))).toEqual(["0036_presupuesto_intentos.sql"]);
    expect(migs.filter((f) => f.startsWith("0035_"))).toEqual(["0035_ajustes_asientos_sin_borrado.sql"]);
  });

  it("empieza por la guarda de 0035, antes de crear nada", () => {
    const guard = codigo.indexOf("raise exception '0036: base 0035 ausente");
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(codigo.indexOf("create table"));
    expect(codigo).toContain("has_table_privilege('service_role', 'bvsala.ajustes_asientos', 'delete')");
  });

  it("léxicamente sana: paréntesis equilibrados, cuerpos $fn$ cerrados, todo en bvsala", () => {
    let nivel = 0;
    for (const c of sinCadenas) {
      if (c === "(") nivel += 1;
      if (c === ")") nivel -= 1;
      expect(nivel).toBeGreaterThanOrEqual(0);
    }
    expect(nivel).toBe(0);
    expect((codigo.match(/\$fn\$/g) ?? []).length % 2).toBe(0);
    expect((codigo.match(/\$\$/g) ?? []).length).toBe(2);
    for (const m of codigo.matchAll(/create (?:table if not exists|or replace function|index if not exists \S+\s+on|trigger \S+\s+before update on) (\S+?)[\s(]/g)) {
      expect(m[1]!.startsWith("bvsala.")).toBe(true);
    }
    expect(codigo).not.toMatch(/\bpublic\./);
  });

  it("no toca el ingest ni el uso diario (regla 1 del runbook)", () => {
    expect(codigo).not.toMatch(/ingest_usage_batch|usage_daily|usage_ingest_seen/);
  });
});

describe("0036 — el dinero, en enteros", () => {
  it("todos los importes son bigint en micro-USD; la única columna numeric es el exacto en atto (entero)", () => {
    for (const m of codigo.matchAll(/^\s+(\w+_micro_usd)\s+(\w+)/gm)) expect(m[2]).toBe("bigint");
    expect([...codigo.matchAll(/numeric\(([^)]*)\)/g)].map((m) => m[1])).toEqual(["40, 0"]);
    expect(codigo).not.toMatch(/\b(real|double precision|float\d?)\b/);
    for (const m of codigo.matchAll(/moneda\s+text not null default 'USD' check \(moneda = 'USD'\)/g)) expect(m).toBeTruthy();
    expect((codigo.match(/check \(moneda = 'USD'\)/g) ?? []).length).toBe(3);
  });

  it("la admisión es un UPDATE condicional con los cuatro cubos y ≤ (no <)", () => {
    expect(codigo).toMatch(
      /update bvsala\.presupuestos_proyecto\s+set reservado_micro_usd = reservado_micro_usd \+ p_importe[^;]*gastado_micro_usd \+ estimado_micro_usd \+ reservado_micro_usd \+ incierto_micro_usd \+ p_importe <= tope_micro_usd;/,
    );
    // Y la fila se bloquea antes de leer el intento.
    const reservar = codigo.slice(codigo.indexOf("function bvsala.presupuesto_reservar("));
    expect(reservar.indexOf("for update")).toBeLessThan(reservar.indexOf("from bvsala.presupuesto_intentos"));
  });

  it("un incierto retiene al menos lo reservado; un abierto, exactamente lo reservado; uno cerrado, nada", () => {
    expect(codigo).toContain("estado <> 'uncertain' or (exposicion_micro_usd >= reservado_micro_usd and motivo_incierto is not null)");
    expect(codigo).toContain("estado not in ('reserved', 'dispatched') or exposicion_micro_usd = reservado_micro_usd");
    expect(codigo).toContain("estado not in ('settled', 'released', 'estimated') or (exposicion_micro_usd = 0 and cerrado_en is not null)");
    expect(codigo).toContain("reservado_micro_usd     bigint not null check (reservado_micro_usd > 0)");
  });

  it("UNIQUE por recibo y por intento; el id del intento es el de D02", () => {
    expect(codigo).toContain("constraint presupuesto_intentos_recibo_unico unique (org_id, receipt_event_id)");
    expect(codigo).toContain("constraint presupuesto_recibos_un_recibo_por_intento unique (org_id, project_id, attempt_id)");
    expect(codigo).toContain("primary key (org_id, receipt_event_id)");
    expect(codigo).toContain("check (attempt_id = logical_call_id || ':a' || ordinal::text)");
    expect(codigo).toContain("constraint presupuesto_outbox_orden_unico unique (org_id, project_id, logical_call_id, seq)");
  });
});

describe("0036 — la base y el SDK dicen lo mismo", () => {
  it("los estados del CHECK son ESTADOS_DE_INTENTO (en intentos y en la outbox)", () => {
    const checks = [...codigo.matchAll(/estado\s+text not null check \(estado in \(([\s\S]*?)\)\)/g)];
    expect(checks).toHaveLength(2);
    for (const m of checks) expect(lista(m)).toEqual([...ESTADOS_DE_INTENTO].sort());
  });

  it("las transiciones del trigger son TRANSICIONES", () => {
    const trigger = codigo.slice(codigo.indexOf("function bvsala.presupuesto_intentos_transicion()"));
    const enSql: Record<string, string[]> = {};
    for (const m of trigger.matchAll(/old\.estado = '([a-z]+)'\s+and new\.estado in \(([^)]*)\)/g)) {
      enSql[m[1]!] = [...m[2]!.matchAll(/'([a-z]+)'/g)].map((x) => x[1]!).sort();
    }
    const enTs = Object.fromEntries(
      Object.entries(TRANSICIONES)
        .filter(([, v]) => v.length > 0)
        .map(([k, v]) => [k, [...v].sort()]),
    );
    expect(enSql).toEqual(enTs);
  });

  it("las pruebas de no-envío y los motivos de incertidumbre coinciden (y un timeout local no es prueba)", () => {
    expect(lista(codigo.match(/prueba_no_envio\s+text check \(prueba_no_envio in \(([^)]*)\)\)/))).toEqual([...MOTIVOS_DE_NO_ENVIO].sort());
    expect(lista(codigo.match(/p_prueba not in \(([^)]*)\)/))).toEqual([...MOTIVOS_DE_NO_ENVIO].sort());
    expect(lista(codigo.match(/motivo_incierto\s+text check \(motivo_incierto in \(([\s\S]*?)\)\)/))).toEqual([...MOTIVOS_DE_INCERTIDUMBRE].sort());
    expect(MOTIVOS_DE_NO_ENVIO as readonly string[]).not.toContain("timeout_local");
  });

  it("el id de un evento de la outbox calculado en SQL es el del SDK", () => {
    const m = codigo.match(/'bud_' \|\| left\(encode\(sha256\(convert_to\(\s*([\s\S]*?),\s*'UTF8'\)\), 'hex'\), 32\)/);
    expect(m).not.toBeNull();
    // Se evalúa la concatenación de la RPC con valores de ejemplo.
    const valores: Record<string, string> = { "i.project_id": "proj-d07", "i.attempt_id": "lc_1:a0", "i.estado": "settled", "v_seq::text": "3" };
    const cadena = m![1]!
      .split("||")
      .map((t) => t.trim())
      .map((t) => (t.startsWith("'") ? t.slice(1, -1) : valores[t]!))
      .join("");
    expect(`bud_${sha256(cadena).slice(0, 32)}`).toBe(idDeEventoDePresupuesto("proj-d07", "lc_1:a0", "settled", 3));
  });
});

describe("0036 — privilegios: leer sí, escribir solo por RPC", () => {
  it("ninguna tabla concede INSERT, UPDATE, DELETE ni TRUNCATE a nadie", () => {
    for (const m of codigo.matchAll(/grant ([a-z, ]+) on bvsala\.(\w+)/g)) {
      expect(m[1]!.trim()).toBe("select");
    }
    expect(codigo).not.toMatch(/grant all on/);
  });

  it("RLS activa en las cinco tablas; los miembros solo leen el presupuesto", () => {
    const tablas = [...codigo.matchAll(/create table if not exists (bvsala\.\w+)/g)].map((m) => m[1]!);
    expect(tablas).toHaveLength(5);
    for (const t of tablas) expect(codigo).toContain(`alter table ${t}`);
    for (const t of tablas) expect(codigo).toMatch(new RegExp(`alter table ${t.replace(".", "\\.")}\\s+enable row level security;`));
    expect(codigo).toContain("for select using (bvsala.is_org_member(org_id));");
    expect([...codigo.matchAll(/grant select on (bvsala\.\w+) to ([^;]+);/g)].filter((m) => m[2]!.includes("authenticated")).map((m) => m[1])).toEqual([
      "bvsala.presupuestos_proyecto",
    ]);
  });

  it("toda función se revoca de PUBLIC y solo el service role ejecuta las RPC (nunca anon ni authenticated)", () => {
    const funciones = [...codigo.matchAll(/create or replace function (bvsala\.\w+)\(/g)].map((m) => m[1]!);
    expect(funciones.length).toBeGreaterThanOrEqual(13);
    for (const f of funciones) {
      expect(codigo).toMatch(new RegExp(`revoke all on function ${f.replace(".", "\\.")}\\([^)]*\\) from public, anon, authenticated`));
    }
    for (const m of codigo.matchAll(/grant execute on function [^;]+ to ([^;]+);/g)) expect(m[1]).toBe("service_role");
    expect(codigo).not.toMatch(/grant execute on function bvsala\.presupuesto_emitir/);
    for (const f of funciones.filter((f) => !f.endsWith("_transicion") && !f.endsWith("_inmutable"))) {
      const cuerpo = codigo.slice(codigo.indexOf(`function ${f}(`));
      expect(cuerpo.slice(0, cuerpo.indexOf("as $fn$"))).toMatch(/security definer\s+set search_path = bvsala, pg_temp/);
    }
  });

  it("liberar exige el estado reservado; estimar, un importe positivo; liquidar, el coste derivado del exacto", () => {
    expect(codigo).toContain("if not found or v_int.estado <> 'reserved' then");
    expect(codigo).toContain("if p_importe is null or p_importe <= 0 then\n    raise exception 'presupuesto_estimar");
    expect(codigo).toContain("p_coste <> floor((p_exact_atto + 500000000000) / 1000000000000)");
  });
});
