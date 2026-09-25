import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { parseUsageRecords as parseWeb, UsageValidationError } from "../apps/web/lib/metering/usage.js";
import { parseUsageRecord as parseProtocolo } from "../packages/protocol/src/index.js";

/**
 * «TU PROPIO BANCO» ES UN INSTRUMENTO, JAMÁS UNA BASE DE COMISIÓN.
 *
 * Los jueces del roadmap refutaron el carril «verified» como base: N·d_low
 * extrapola a peticiones que nadie midió, no ve colas negativas raras y
 * sobrecobra por construcción el 2,5 % de los periodos. Así que los pares viven
 * en un canal propio, y esta verja impide la regresión en las dos direcciones:
 *
 *   · ningún fichero que factura, cierra o pinta el extracto puede leer las
 *     tablas de la verificación ni su módulo;
 *   · el ingest de USO rechaza `basis: "verification"`: un par jamás puede caer
 *     en la función que acumula dinero medido.
 */
const RAIZ = fileURLToPath(new URL("../", import.meta.url));

function ficheros(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) ficheros(p, acc);
    else if (/\.(ts|tsx|sql)$/.test(e)) acc.push(p);
  }
  return acc;
}

const LO_QUE_FACTURA = [
  "apps/web/lib/billing",
  "apps/web/lib/stripe",
  "apps/web/app/api/billing",
  "apps/web/app/api/stripe",
  "apps/web/app/api/cron/cierre-extractos",
  "apps/web/app/api/cron/facturar-extractos",
  "apps/web/app/api/cron/dunning",
  "apps/web/app/[locale]/dashboard/extracto",
  "apps/web/lib/metering/usage.ts",
  "apps/web/app/api/metering/usage",
];

/** Lo que, en SQL, es dinero facturable: si una migración lo nombra, no puede nombrar además la verificación. */
const SQL_QUE_FACTURA = ["ingest_usage_batch", "usage_daily", "extractos", "measured_", "reference_", "comision", "commission"];

describe("⛔ la facturación no lee la verificación", () => {
  const todos = LO_QUE_FACTURA.flatMap((r) => {
    const p = join(RAIZ, r);
    return statSync(p).isFile() ? [p] : ficheros(p);
  });

  it("hay ficheros que vigilar", () => {
    expect(todos.length).toBeGreaterThan(10);
  });

  it("ninguno menciona las tablas, la función ni el módulo de la verificación", () => {
    const malos = todos.filter((f) => /verification_|ingest_verification_batch|lib\/verificacion/.test(readFileSync(f, "utf8")));
    expect(malos.map((f) => f.replace(RAIZ, ""))).toEqual([]);
  });

  it("ninguna migración anterior a la 0030 menciona `verification_`", () => {
    const dir = join(RAIZ, "db/migrations");
    const anteriores = readdirSync(dir).filter((f) => /^\d{4}_/.test(f) && Number(f.slice(0, 4)) < 30);
    expect(anteriores.length).toBeGreaterThan(20);
    const malas = anteriores.filter((f) => readFileSync(join(dir, f), "utf8").includes("verification_"));
    expect(malas).toEqual([]);
  });

  it("ninguna migración de la 0030 en adelante junta `verification_` con el dinero facturable", () => {
    // El SQL futuro que llevara pares a un extracto, a `usage_daily` o a la
    // comisión tendría que nombrar las dos cosas en el mismo fichero. Si algún día
    // se quiere de verdad, es otra especificación y el sí del dueño: se cambia
    // este test a la vista, no se cuela. (Comentarios fuera: 0030 explica en
    // prosa qué NO toca.)
    const dir = join(RAIZ, "db/migrations");
    const desde30 = readdirSync(dir).filter((f) => /^\d{4}_/.test(f) && Number(f.slice(0, 4)) >= 30);
    expect(desde30).toContain("0030_banco_propio.sql");
    const malas = desde30.filter((f) => {
      const codigo = readFileSync(join(dir, f), "utf8")
        .split("\n")
        .map((l) => l.replace(/--.*$/, ""))
        .join("\n");
      return codigo.includes("verification_") && SQL_QUE_FACTURA.some((x) => codigo.includes(x));
    });
    expect(malas).toEqual([]);
  });
});

describe("⛔ el ingest de uso rechaza basis «verification»", () => {
  const registro = {
    orgId: "self",
    requestId: "req-1",
    model: "openai/gpt-4o-mini",
    at: Date.now(),
    avoidedLlm: 0,
    actualLlm: 1,
    baselineInputTokens: 10,
    actualInputTokens: 10,
    eliminatedInputTokens: 0,
    compressedInputTokens: 0,
    baselineOutputTokens: 5,
    actualOutputTokens: 5,
    providerCachedInputTokens: 0,
    cacheResult: "miss",
    baselineCost: 0.01,
    actualCost: 0.01,
    netSavings: 0,
    basis: "verification",
  };
  const ORG = "99999999-9999-4999-8999-999999999999";

  it("la web (parseUsageRecords)", () => {
    expect(() => parseWeb([registro], ORG)).toThrow(UsageValidationError);
    expect(() => parseWeb([registro], ORG)).toThrow(/basis/);
  });

  it("el protocolo (parseUsageRecord)", () => {
    expect(() => parseProtocolo(registro, ORG)).toThrow(/basis/);
  });

  it("y el mismo registro con basis «measured» sí entra (el test no pasa por accidente)", () => {
    expect(parseWeb([{ ...registro, basis: "measured" }], ORG)).toHaveLength(1);
    expect(parseProtocolo({ ...registro, basis: "measured" }, ORG).basis).toBe("measured");
  });
});
