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

/** Copia el repo mínimo necesario para correr `pnpm ab:publish` aislado. */
function bancoDePruebas(artefacto: unknown, csv: string): string {
  const dir = mkdtempSync(join(tmpdir(), "bv-publish-"));
  temporales.push(dir);
  mkdirSync(join(dir, "benchmarks", "out"), { recursive: true });
  mkdirSync(join(dir, "apps", "web", "public", "data"), { recursive: true });
  for (const f of ["publish.ts", "publish-guard.ts"]) {
    cpSync(join(raiz, "benchmarks", f), join(dir, "benchmarks", f));
  }
  writeFileSync(join(dir, "benchmarks", "out", "ab-live.json"), JSON.stringify(artefacto, null, 2));
  writeFileSync(join(dir, "benchmarks", "out", "ab-live-trials.csv"), csv);
  return dir;
}

/** `spawnSync` y no `execFileSync` porque hacen falta LOS DOS flujos: el
 *  publicador manda sus AVISOS por stderr y sus confirmaciones por stdout, y
 *  este test comprueba ambos. */
function publicar(dir: string): { code: number; salida: string } {
  const r = spawnSync("npx", ["tsx", join(dir, "benchmarks", "publish.ts")], {
    cwd: dir, encoding: "utf8",
  });
  return { code: r.status ?? 1, salida: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

/** Un artefacto LIVE que pasa el guardarraíl de publicación. */
function artefactoLive(trials: number | null) {
  return {
    mode: "LIVE",
    model: "gpt-4o-mini",
    modelStable: true,
    ...(trials === null ? {} : { trials }),
    generatedAt: "2026-08-29T10:00:00.000Z",
    commit: "abc1234",
    // El SDK tal como se instala: sin este sello la verja no publica un LIVE.
    sdk: { version: "0.4.23", asShipped: true },
    reconciliation: { reconciled: true, residual: 0 },
    aggregate: { savings: { lower: 0.2, point: 0.3, upper: 0.4 }, proven: true, qualityPassRate: 1 },
    // El guardarraíl exige escenarios: un artefacto sin ellos no se publica,
    // y con razón (un titular sin nada detrás).
    scenarios: [{ name: "resumen", kind: "exact", savings: { lower: 0.2, point: 0.3, upper: 0.4 } }],
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
