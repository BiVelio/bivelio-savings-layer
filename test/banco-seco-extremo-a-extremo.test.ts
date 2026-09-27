import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, afterAll } from "vitest";

import { decidePublish, type ArtifactShape } from "../benchmarks/publish-guard.js";

/**
 * EL BANCO ENTERO, EN SECO: `benchmarks/ab-live.ts` de verdad, contra el
 * proveedor simulado, en un directorio temporal.
 *
 * Comprueba que el artefacto trae lo que la recomendación n.º 3 del informe de
 * competencia pide (B2, sus suelos, el sello del SDK tal como se instala, el
 * conjunto de escenarios) y que `reproduce.mjs` —el script PÚBLICO del kit de
 * medición independiente— recalcula lo que el banco escribe, bit a bit.
 *
 * EL ENTORNO SE CONSTRUYE A MANO, sin heredar NINGUNA `BVSALA_*` del shell: una
 * verja en seco no puede convertirse en una tirada de pago porque alguien tenga
 * un endpoint exportado. Cada spawn afirma además `mode: MOCK` o que abortó
 * antes de la primera llamada.
 */

const raiz = new URL("../", import.meta.url).pathname;
const tsx = join(raiz, "node_modules", ".bin", "tsx");
const temporales: string[] = [];

afterAll(() => {
  for (const d of temporales) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* da igual */
    }
  }
});

/** El entorno mínimo, y NADA heredado salvo PATH y HOME. */
function entorno(extra: Record<string, string>): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", BVSALA_DEV_OPEN: "1", ...extra };
}

function banco(extra: Record<string, string>): { code: number; salida: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "bv-banco-seco-"));
  temporales.push(dir);
  const r = spawnSync(tsx, [join(raiz, "benchmarks", "ab-live.ts")], {
    cwd: raiz,
    encoding: "utf8",
    env: entorno({ BVSALA_AB_OUT_DIR: dir, BVSALA_AB_REPS: "2", BVSALA_AB_MAX_REPS: "2", ...extra }),
    timeout: 120_000,
  });
  return { code: r.status ?? 1, salida: `${r.stdout ?? ""}${r.stderr ?? ""}`, dir };
}

interface CI {
  point: number;
  lower: number;
  upper: number;
}

describe("una tirada MOCK sin ninguna variable: el SDK tal como se instala, con B2", () => {
  const r = banco({});
  const art = JSON.parse(readFileSync(join(r.dir, "ab-live.json"), "utf8")) as Record<string, unknown> & {
    mode: string;
    sdk: { asShipped: boolean };
    arms: Record<string, string>;
    aggregate: { savings: CI };
    aggregateB1: { savings: CI };
    aggregateB2: { savings: CI };
    aggregateNativeVsB0: { savings: CI };
    floors: { vsB0: number; vsB1: number; vsB2: number; min: number; minAgainst: string };
    native: { simulated: boolean; decisions: { feature: string; source: { url: string; checked: string } }[] };
    scenarios: { name: string; armA2?: unknown; measuredB2?: unknown; cacheWrites: unknown; sampling: unknown }[];
    scenariosNotApplicable: unknown[];
    scenarioSet: { size: number; names: string[] };
    pricing: { listPriceKnown: boolean; cacheWrites: { premium: number; metered: boolean | null } };
    config: { resamples: number; b2: boolean; b2Effort: string; reasoningHeadroomTokens: number };
    cost: { spentUsd: number; ceilingUsd: number };
  };
  const csv = readFileSync(join(r.dir, "ab-live-trials.csv"), "utf8");

  it("sale bien, en MOCK", () => {
    expect(r.code, r.salida).toBe(0);
    expect(r.salida).toContain("[mode: MOCK]");
    expect(art.mode).toBe("MOCK");
  });

  it("asShipped es el defecto: sin ninguna variable, el artefacto mide lo que instala el cliente", () => {
    expect(art.sdk.asShipped).toBe(true);
  });

  it("trae el brazo B2, su agregado, lo que ahorra el proveedor solo y los tres suelos", () => {
    expect(Object.keys(art.arms)).toEqual(["A", "A1", "A2", "B"]);
    expect(typeof art.aggregateB2.savings.lower).toBe("number");
    expect(typeof art.aggregateNativeVsB0.savings.point).toBe("number");
    const { vsB0, vsB1, vsB2, min } = art.floors;
    expect(vsB0).toBe(art.aggregate.savings.lower);
    expect(vsB1).toBe(art.aggregateB1.savings.lower);
    expect(vsB2).toBe(art.aggregateB2.savings.lower);
    expect(min).toBe(Math.min(vsB0, vsB1, vsB2));
    expect(["B0", "B1", "B2"]).toContain(art.floors.minAgainst);
    for (const s of art.scenarios) {
      expect(s.armA2, s.name).toBeDefined();
      expect(s.measuredB2, s.name).toBeDefined();
      expect(s.cacheWrites, s.name).toBeDefined();
      expect(s.sampling, s.name).toBeDefined();
    }
  });

  it("B2 en MOCK dice que es simulado, y cada decisión lleva su fuente", () => {
    expect(art.native.simulated).toBe(true);
    expect(art.native.decisions.length).toBeGreaterThan(0);
    for (const d of art.native.decisions) {
      expect(d.source.url).toMatch(/^https:\/\//);
      expect(d.source.checked).toBe("2026-09-27");
    }
  });

  it("ninguna fila se cae: scenarioSet = medidos + no aplicables", () => {
    expect(art.scenarioSet.size).toBe(art.scenarios.length + art.scenariosNotApplicable.length);
    expect(art.scenarioSet.names).toHaveLength(art.scenarioSet.size);
  });

  it("el precio sale del catálogo y la escritura de caché lleva su prima; el coste real se cuenta", () => {
    expect(art.pricing.listPriceKnown).toBe(true);
    expect(art.pricing.cacheWrites.premium).toBeGreaterThanOrEqual(1);
    // `metered` solo mira las llamadas a modelos con prima: `null` si no hubo ninguna.
    expect([true, false, null]).toContain(art.pricing.cacheWrites.metered);
    expect(art.config).toMatchObject({ resamples: 10_000, b2: true, b2Effort: "low", reasoningHeadroomTokens: 0 });
    expect(art.cost.spentUsd).toBeGreaterThan(0);
    expect(art.cost.spentUsd).toBeLessThanOrEqual(art.cost.ceilingUsd);
  });

  it("el CSV de ensayos lleva la columna de B2", () => {
    const cabecera = csv.split("\n")[0]!.split(",");
    expect(cabecera).toEqual(
      expect.arrayContaining(["scenario", "costA", "costA1", "costA2", "costB", "savedFractionB2"]),
    );
  });

  it("la verja de publicación lo aceptaría con --allow-mock, con el único aviso de que es MOCK", () => {
    const d = decidePublish(null, art as ArtifactShape, { allowMock: true });
    expect(d.blockers).toEqual([]);
    expect(d.ok).toBe(true);
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toMatch(/MOCK/);
  });

  it("reproduce.mjs (el script PÚBLICO) recalcula lo que el banco escribe, bit a bit", () => {
    const rep = spawnSync(
      process.execPath,
      [join(raiz, "apps/web/public/measure/reproduce.mjs"), "--json", "--artifact", join(r.dir, "ab-live.json"), "--trials", join(r.dir, "ab-live-trials.csv")],
      { encoding: "utf8" },
    );
    expect(rep.status, rep.stdout + rep.stderr).toBe(0);
    const informe = JSON.parse(rep.stdout) as { ok: boolean; checks: { name: string; status: string }[] };
    expect(informe.ok).toBe(true);
    const nombres = informe.checks.map((c) => c.name);
    for (const esperado of ["aggregate (B vs B0)", "aggregateB1 (B vs B1)", "aggregateB2 (B vs B2)", "aggregateNativeVsB0 (B2 vs B0)"]) {
      expect(nombres).toContain(esperado);
    }
    expect(informe.checks.every((c) => c.status === "match")).toBe(true);
  });
});

describe("lo que la tirada se niega a hacer, antes de la primera llamada", () => {
  it("BVSALA_AB_SIN_COMPRESOR con un valor que no es 1: obsoleta, aborta con la instrucción nueva", () => {
    const r = banco({ BVSALA_AB_SIN_COMPRESOR: "0" });
    expect(r.code).not.toBe(0);
    expect(r.salida).toMatch(/BVSALA_AB_SIN_COMPRESOR=0 está obsoleta/);
    expect(r.salida).toMatch(/BVSALA_AB_CON_COMPRESOR=1/);
  });

  it("BVSALA_AB_SIN_COMPRESOR=1 solo avisa: ya es lo que hace `pnpm ab`", () => {
    const r = banco({ BVSALA_AB_SIN_COMPRESOR: "1" });
    expect(r.code, r.salida).toBe(0);
    expect(r.salida).toMatch(/está obsoleta/);
  });

  it("con el compresor del banco pedido, el sello dice asShipped: false (investigación, no publicable)", () => {
    const r = banco({ BVSALA_AB_CON_COMPRESOR: "1" });
    expect(r.code, r.salida).toBe(0);
    const art = JSON.parse(readFileSync(join(r.dir, "ab-live.json"), "utf8")) as ArtifactShape;
    expect(art.sdk?.asShipped).toBe(false);
    expect(decidePublish(null, art, { allowMock: true }).ok).toBe(false);
  });

  it("preset y DEMO_MODEL a la vez: no adivina", () => {
    const r = banco({ BVSALA_AB_PRESET: "2026", BVSALA_DEMO_MODEL: "openai/gpt-4o-mini" });
    expect(r.code).not.toBe(0);
    expect(r.salida).toMatch(/both set/);
  });

  it("LIVE sin presupuesto: el prevuelo para la tirada y no llama a nadie", () => {
    // Un host .invalid (RFC 2606): aunque algo se escapara, no resolvería.
    const r = banco({ BVSALA_AB_PRESET: "2026", BVSALA_DEMO_OPENAI_BASE_URL: "https://api.openai.invalid/v1" });
    expect(r.code).not.toBe(0);
    expect(r.salida).toMatch(/La tirada NO empieza \(no se ha llamado a ningún proveedor\)/);
    expect(r.salida).toMatch(/BVSALA_AB_BUDGET_USD is mandatory in LIVE/);
    expect(r.salida).not.toMatch(/Coste estimado de la tirada/);
  });

  it("un esfuerzo de B2 que no existe, tampoco empieza (ni en MOCK)", () => {
    const r = banco({ BVSALA_AB_B2_EFFORT: "altisimo" });
    expect(r.code).not.toBe(0);
    expect(r.salida).toMatch(/BVSALA_AB_B2_EFFORT=altisimo is not one of/);
  });
});

describe("guardas de texto del banco", () => {
  const fuente = readFileSync(join(raiz, "benchmarks", "ab-live.ts"), "utf8");

  it("`asShipped` depende SOLO de BVSALA_AB_CON_COMPRESOR", () => {
    expect(fuente).toContain('const CON_COMPRESOR = process.env.BVSALA_AB_CON_COMPRESOR === "1";');
    expect(fuente).toContain("const SDK_TAL_COMO_SE_INSTALA = !CON_COMPRESOR;");
    expect(fuente.match(/SDK_TAL_COMO_SE_INSTALA =/g)).toHaveLength(1);
  });

  it("el muestreador adaptativo para con el intervalo MÁS ANCHO de las comparaciones activas", () => {
    const ciHalf = fuente.slice(fuente.indexOf("const ciHalf = ()"), fuente.indexOf("while (mode === \"LIVE\" && paired.length < MAX_REPS"));
    expect(ciHalf).toMatch(/Math\.max\(h, semiancho\(paired\.map\(\(p\) => p\.costA1/);
    expect(ciHalf).toMatch(/Math\.max\(h, semiancho\(paired\.map\(\(p\) => p\.costA2/);
  });
});
