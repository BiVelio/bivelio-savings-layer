import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, afterAll } from "vitest";

/**
 * EL CSV Y EL JSON QUE SE PUBLICAN TIENEN QUE SER DE LA MISMA TIRADA.
 *
 * Los dos se sirven a la vez en la landing y el README invita a recalcular el
 * intervalo con el CSV, así que una desincronía no es un detalle interno: es que
 * la PRUEBA contradice al TITULAR en la misma página que la publica. Pasó — la
 * auditoría encontró un CSV que recomputaba 27,1 % junto a un JSON que titulaba
 * ≥24,1 % — porque `pnpm ab:publish` copiaba el CSV incondicionalmente, sin mirar
 * de qué corrida venía.
 *
 * El lazo es `trials`, el recuento de ensayos que `pnpm ab` sella en el
 * artefacto. Este test ejercita el publicador de verdad, con ficheros reales.
 */

const raiz = new URL("../", import.meta.url).pathname;
const temporales: string[] = [];

/**
 * Copia el repo mínimo necesario para correr `pnpm ab:publish` aislado. Con
 * `sufijo` (p. ej. `--openai-gpt-6-luna`) escribe los ficheros de UN modelo de
 * una tirada multi-modelo, que es lo que lee `--model`.
 */
function bancoDePruebas(artefacto: unknown, csv: string, sufijo = ""): string {
  const dir = mkdtempSync(join(tmpdir(), "bv-publish-"));
  temporales.push(dir);
  mkdirSync(join(dir, "benchmarks", "out"), { recursive: true });
  mkdirSync(join(dir, "apps", "web", "public", "data"), { recursive: true });
  for (const f of ["publish.ts", "publish-guard.ts"]) {
    cpSync(join(raiz, "benchmarks", f), join(dir, "benchmarks", f));
  }
  writeFileSync(join(dir, "benchmarks", "out", `ab-live${sufijo}.json`), JSON.stringify(artefacto, null, 2));
  writeFileSync(join(dir, "benchmarks", "out", `ab-live-trials${sufijo}.csv`), csv);
  return dir;
}

/** `spawnSync` y no `execFileSync` porque hacen falta LOS DOS flujos: el
 *  publicador manda sus AVISOS por stderr y sus confirmaciones por stdout, y
 *  este test comprueba ambos. */
function publicar(dir: string, ...args: string[]): { code: number; salida: string } {
  const r = spawnSync("npx", ["tsx", join(dir, "benchmarks", "publish.ts"), ...args], {
    cwd: dir, encoding: "utf8",
  });
  return { code: r.status ?? 1, salida: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Un artefacto LIVE que pasa el guardarraíl de publicación (con B2 y sus suelos, desde el 2026-09-27). */
function artefactoLive(trials: number | null, model = "gpt-4o-mini") {
  return {
    mode: "LIVE",
    model,
    modelStable: true,
    ...(trials === null ? {} : { trials }),
    generatedAt: "2026-08-29T10:00:00.000Z",
    commit: "abc1234",
    // El SDK tal como se instala: sin este sello la verja no publica.
    sdk: { version: "0.4.23", asShipped: true },
    reconciliation: { reconciled: true, residual: 0 },
    aggregate: { savings: { lower: 0.2, point: 0.3, upper: 0.4 }, proven: true, qualityPassRate: 1 },
    aggregateB2: { savings: { lower: 0.1, point: 0.2, upper: 0.3 } },
    floors: { vsB0: 0.2, vsB1: null, vsB2: 0.1, min: 0.1, minAgainst: "B2" },
    transport: { kind: "openai-compatible", endpointHost: "api.openai.com" },
    pricing: { listPriceKnown: true, cacheWrites: { premium: 1, metered: true } },
    // El guardarraíl exige escenarios: un artefacto sin ellos no se publica,
    // y con razón (un titular sin nada detrás). Y que estén TODOS.
    scenarios: [{ name: "resumen", kind: "exact", savings: { lower: 0.2, point: 0.3, upper: 0.4 } }],
    scenarioSet: { size: 1, names: ["resumen"] },
  };
}

const cabecera = "scenario,kind,rep,costA,costB,savedFraction\n";
const filas = (n: number) =>
  cabecera + Array.from({ length: n }, (_, i) => `esc,exact,${i},0.01,0.005,0.5`).join("\n") + "\n";

afterAll(() => {
  for (const d of temporales) { try { rmSync(d, { recursive: true, force: true }); } catch { /* da igual */ } }
});

describe("el publicador ata el CSV al JSON", () => {
  it("RECHAZA un CSV de otra tirada, y dice por qué", () => {
    const dir = bancoDePruebas(artefactoLive(12), filas(7));
    const r = publicar(dir);
    expect(r.code).not.toBe(0);
    expect(r.salida).toContain("el CSV no es de esta tirada");
    expect(r.salida).toMatch(/12 ensayos/);
    expect(r.salida).toMatch(/7 filas/);
    // Y NO ha escrito nada: un rechazo que deja el destino a medias sería peor
    // que no comprobar, porque dejaría publicado el JSON sin su CSV.
    expect(existsSync(join(dir, "apps", "web", "public", "data", "ab-live.json"))).toBe(false);
  });

  it("publica cuando cuadran", () => {
    const dir = bancoDePruebas(artefactoLive(7), filas(7));
    const r = publicar(dir);
    expect(r.code).toBe(0);
    expect(r.salida).toContain("cuadran");
    const csv = readFileSync(join(dir, "apps", "web", "public", "data", "ab-live-trials.csv"), "utf8");
    expect(csv.split("\n").filter((l) => l.trim()).length - 1).toBe(7);
  });

  it("un artefacto ANTERIOR al sello se publica igual, pero avisando", () => {
    // No se bloquea: impediría republicar lo que ya está publicado.
    const dir = bancoDePruebas(artefactoLive(null), filas(3));
    const r = publicar(dir);
    expect(r.code).toBe(0);
    expect(r.salida).toContain("no declara `trials`");
  });
});

describe("`--model` publica UN modelo de una tirada multi-modelo, sin pagar otra", () => {
  it("lee ab-live--<babosa>.json y SU CSV, y los publica como el titular", () => {
    const dir = bancoDePruebas(artefactoLive(4, "openai/gpt-6-luna"), filas(4), "--openai-gpt-6-luna");
    const r = publicar(dir, "--model", "openai/gpt-6-luna");
    expect(r.code).toBe(0);
    expect(r.salida).toContain("cuadran");
    const publicado = JSON.parse(readFileSync(join(dir, "apps", "web", "public", "data", "ab-live.json"), "utf8"));
    expect(publicado.model).toBe("openai/gpt-6-luna");
    const csv = readFileSync(join(dir, "apps", "web", "public", "data", "ab-live-trials.csv"), "utf8");
    expect(csv.split("\n").filter((l) => l.trim()).length - 1).toBe(4);
    // `--model=<id>` es lo mismo.
    expect(publicar(dir, "--model=openai/gpt-6-luna", "--dry-run").code).toBe(0);
  });

  it("RECHAZA el fichero si su `model` no es el pedido: el nombre del fichero no manda", () => {
    const dir = bancoDePruebas(artefactoLive(4, "openai/gpt-4o-mini"), filas(4), "--openai-gpt-6-luna");
    const r = publicar(dir, "--model", "openai/gpt-6-luna");
    expect(r.code).not.toBe(0);
    expect(r.salida).toMatch(/declara model = openai\/gpt-4o-mini y se pidió --model openai\/gpt-6-luna/);
    expect(existsSync(join(dir, "apps", "web", "public", "data", "ab-live.json"))).toBe(false);
  });

  it("sin ab-live.json, señala los artefactos por modelo que sí hay", () => {
    const dir = bancoDePruebas(artefactoLive(4, "openai/gpt-6-luna"), filas(4), "--openai-gpt-6-luna");
    const r = publicar(dir);
    expect(r.code).not.toBe(0);
    expect(r.salida).toMatch(/ab-live--openai-gpt-6-luna\.json/);
    expect(r.salida).toMatch(/--model <id>/);
    expect(publicar(dir, "--model").code).not.toBe(0);
    // `--model --dry-run` no pide un modelo llamado «--dry-run».
    const r2 = publicar(dir, "--model", "--dry-run");
    expect(r2.code).not.toBe(0);
    expect(r2.salida).toMatch(/--model necesita el id del modelo/);
  });
});
