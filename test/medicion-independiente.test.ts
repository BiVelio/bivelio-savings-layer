import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, it, expect, afterAll } from "vitest";

import { bootstrapRatioCI, bootstrapRatioCIEstratificado, mulberry32 } from "../benchmarks/stats.js";

/**
 * EL KIT DE MEDICIÓN INDEPENDIENTE (recomendación n.º 3 del informe de
 * competencia): que un tercero pueda comprobarnos sin fiarse de nosotros.
 *
 * La verja (a) es PERMANENTE: lo que esté publicado en la web tiene que poder
 * recalcularse con el script público desde sus propios ensayos. Si alguien
 * publica un JSON que no se sigue de su CSV, esto se pone rojo.
 */

const raiz = new URL("../", import.meta.url).pathname;
const SCRIPT = join(raiz, "apps/web/public/measure/reproduce.mjs");
const DATOS = join(raiz, "apps/web/public/data");
const temporales: string[] = [];
afterAll(() => {
  for (const d of temporales) rmSync(d, { recursive: true, force: true });
});

function reproducir(...args: string[]): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", timeout: 60_000 });
  return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

interface Informe {
  ok: boolean;
  checks: { name: string; status: string }[];
  warnings: string[];
  redRows: { scenario: string; against: string; status: string }[];
}

// El script se importa con un especificador VARIABLE para que TypeScript no
// intente resolver un .mjs sin tipos: es JavaScript público, sin dependencias.
const rutaDelScript = SCRIPT;
const kit = (await import(rutaDelScript)) as {
  mulberry32: (s: number) => () => number;
  bootstrapEstratificado: typeof bootstrapRatioCIEstratificado;
  bootstrapRatio: typeof bootstrapRatioCI;
  parseCsv: (t: string) => string[][];
  verify: (a: unknown, t: unknown) => Informe;
  readTrials: (csv: string) => unknown;
};

describe("(a) lo publicado se recalcula con el script público, bit a bit", () => {
  const r = reproducir("--json", "--artifact", join(DATOS, "ab-live.json"), "--trials", join(DATOS, "ab-live-trials.csv"));
  const informe = JSON.parse(r.stdout) as Informe;

  it("sale 0 y todo cuadra", () => {
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(informe.ok).toBe(true);
    expect(informe.checks.every((c) => c.status === "match")).toBe(true);
  });

  it("recalcula el agregado frente a B0 y frente a B1, y cada fila", () => {
    const nombres = informe.checks.map((c) => c.name);
    expect(nombres).toContain("aggregate (B vs B0)");
    expect(nombres).toContain("aggregateB1 (B vs B1)");
    expect(nombres.some((n) => /^scenario rows/.test(n))).toBe(true);
    expect(nombres).toContain("trials");
  });

  it("y avisa de lo que el artefacto de hoy no declara (sin sello asShipped, sin B2)", () => {
    const publicado = JSON.parse(readFileSync(join(DATOS, "ab-live.json"), "utf8")) as { sdk?: { asShipped?: boolean }; aggregateB2?: unknown };
    if (publicado.sdk?.asShipped !== true) {
      expect(informe.warnings.join(" ")).toMatch(/sdk\.asShipped is not true/);
    }
    if (!publicado.aggregateB2) {
      expect(informe.warnings.join(" ")).toMatch(/no aggregateB2/);
    }
  });
});

describe("(b) el bootstrap del script es el del banco, línea a línea", () => {
  it("el mismo generador", () => {
    const a = mulberry32(1234567);
    const b = kit.mulberry32(1234567);
    for (let i = 0; i < 1000; i++) expect(b()).toBe(a());
  });

  it("50 conjuntos sintéticos: estratificado y agrupado, idénticos", () => {
    const rng = mulberry32(42);
    for (let k = 0; k < 50; k++) {
      const estratos = Array.from({ length: 1 + Math.floor(rng() * 12) }, () => {
        const n = Math.floor(rng() * 6); // incluye estratos vacíos y de una muestra
        const costA = Array.from({ length: n }, () => rng() * 0.01);
        const costB = costA.map((a) => a * (0.3 + rng()));
        return { costA, costB };
      });
      const opts = { seed: 1 + Math.floor(rng() * 1e6), resamples: 2000 };
      expect(kit.bootstrapEstratificado(estratos, opts)).toEqual(bootstrapRatioCIEstratificado(estratos, opts));
      const a = estratos.flatMap((e) => e.costA);
      const b = estratos.flatMap((e) => e.costB);
      expect(kit.bootstrapRatio(a, b, opts)).toEqual(bootstrapRatioCI(a, b, opts));
    }
  });

  it("el CSV se lee como RFC 4180: comillas, comillas dobladas, comas y saltos dentro", () => {
    expect(kit.parseCsv('a,b\n"x, y","di ""hola""\nadiós"\r\n1,2\n')).toEqual([
      ["a", "b"],
      ["x, y", 'di "hola"\nadiós'],
      ["1", "2"],
    ]);
  });
});

/** Un artefacto sintético coherente con su CSV, construido con el bootstrap del banco. */
function sintetico(): { art: Record<string, unknown>; csv: string } {
  const seed = 99;
  const esc = [
    { name: "verde", filas: [[0.01, 0.009, 0.0085, 0.005], [0.011, 0.01, 0.0095, 0.006], [0.012, 0.011, 0.01, 0.0055]] },
    { name: "roja, con coma", filas: [[0.01, 0.01, 0.01, 0.0105], [0.01, 0.01, 0.01, 0.0098], [0.01, 0.01, 0.01, 0.0104]] },
    { name: "pérdida", filas: [[0.01, 0.01, 0.01, 0.02], [0.01, 0.01, 0.01, 0.021], [0.01, 0.01, 0.01, 0.019]] },
  ];
  const col = (i: number) => esc.map((e) => e.filas.map((f) => f[i]!));
  const estr = (a: number, b: number) => col(a).map((ca, k) => ({ costA: ca, costB: col(b)[k]! }));
  const aggregate = { savings: bootstrapRatioCIEstratificado(estr(0, 3), { seed }), strata: 3 };
  const aggregateB1 = { savings: bootstrapRatioCIEstratificado(estr(1, 3), { seed }) };
  const aggregateB2 = { savings: bootstrapRatioCIEstratificado(estr(2, 3), { seed }) };
  const aggregateNativeVsB0 = { savings: bootstrapRatioCIEstratificado(estr(0, 2), { seed }) };
  const scenarios = esc.map((e) => ({
    name: e.name,
    measured: { savings: bootstrapRatioCI(e.filas.map((f) => f[0]!), e.filas.map((f) => f[3]!), { seed }) },
    measuredB1: { savings: bootstrapRatioCI(e.filas.map((f) => f[1]!), e.filas.map((f) => f[3]!), { seed }) },
    measuredB2: { savings: bootstrapRatioCI(e.filas.map((f) => f[2]!), e.filas.map((f) => f[3]!), { seed }) },
  }));
  const lows = [aggregate.savings.lower, aggregateB1.savings.lower, aggregateB2.savings.lower];
  const art = {
    mode: "LIVE",
    trials: 9,
    sdk: { version: "0.0.0", asShipped: true },
    config: { seed, resamples: 10000 },
    aggregate,
    aggregateB1,
    aggregateB2,
    aggregateNativeVsB0,
    scenarios,
    scenariosNotApplicable: [{ name: "fuera", motivo: "no aplica" }],
    scenarioSet: { size: 4, names: ["verde", "roja, con coma", "pérdida", "fuera"] },
    floors: { vsB0: lows[0], vsB1: lows[1], vsB2: lows[2], min: Math.min(...lows), minAgainst: "B2" },
    transport: { endpointHost: "api.example.com" },
    pricing: { listPriceKnown: true, cacheWrites: { premium: 1, metered: true } },
  };
  const csv =
    "scenario,kind,rep,costA,costA1,costA2,costB,savedFraction,savedFractionB1,savedFractionB2\n" +
    esc
      .flatMap((e) => e.filas.map((f, i) => `${e.name.includes(",") ? `"${e.name}"` : e.name},ran,${i},${f[0]},${f[1]},${f[2]},${f[3]},,,`))
      .join("\n") +
    "\n";
  return { art, csv };
}

function escribir(art: unknown, csv: string): { a: string; t: string } {
  const dir = mkdtempSync(join(tmpdir(), "bv-medicion-"));
  temporales.push(dir);
  const a = join(dir, "ab-live.json");
  const t = join(dir, "ab-live-trials.csv");
  writeFileSync(a, JSON.stringify(art));
  writeFileSync(t, csv);
  return { a, t };
}

describe("(c) las filas rojas se listan, no se esconden", () => {
  it("«red» con el punto bajo cero y «proven loss» con todo el intervalo bajo cero, frente a cada brazo", () => {
    const { art, csv } = sintetico();
    const f = escribir(art, csv);
    const r = reproducir("--json", "--artifact", f.a, "--trials", f.t);
    expect(r.code, r.stdout).toBe(0);
    const informe = JSON.parse(r.stdout) as Informe;
    expect(informe.redRows.filter((x) => x.scenario === "pérdida").map((x) => `${x.against}:${x.status}`)).toEqual([
      "B0:proven loss",
      "B1:proven loss",
      "B2:proven loss",
    ]);
    expect(informe.redRows.some((x) => x.scenario === "roja, con coma")).toBe(true);
    expect(informe.redRows.some((x) => x.scenario === "verde")).toBe(false);
  });
});

describe("(d) códigos de salida: 0 cuadra, 1 no cuadra, 2 no se puede leer", () => {
  it("0 con un artefacto coherente", () => {
    const { art, csv } = sintetico();
    const f = escribir(art, csv);
    expect(reproducir("--artifact", f.a, "--trials", f.t).code).toBe(0);
  });

  it("1 si el JSON dice otra cosa que su CSV (un suelo retocado, una fila quitada, un recuento que no cuadra)", () => {
    const { art, csv } = sintetico();
    const retocado = { ...art, aggregateB2: { savings: { ...(art["aggregateB2"] as { savings: object }).savings, lower: 0.5 } } };
    const f1 = escribir(retocado, csv);
    const r1 = reproducir("--json", "--artifact", f1.a, "--trials", f1.t);
    expect(r1.code).toBe(1);
    expect((JSON.parse(r1.stdout) as Informe).checks.find((c) => c.name.startsWith("aggregateB2"))?.status).toBe("mismatch");

    const sinFila = { ...art, scenarioSet: { size: 5, names: ["verde", "roja, con coma", "pérdida", "fuera", "escondida"] } };
    const f2 = escribir(sinFila, csv);
    expect(reproducir("--artifact", f2.a, "--trials", f2.t).code).toBe(1);

    const f3 = escribir({ ...art, trials: 10 }, csv);
    expect(reproducir("--artifact", f3.a, "--trials", f3.t).code).toBe(1);

    const f4 = escribir({ ...art, floors: { ...(art["floors"] as object), min: 0.9 } }, csv);
    expect(reproducir("--artifact", f4.a, "--trials", f4.t).code).toBe(1);
  });

  it("2 si no se puede leer: fichero ausente, JSON roto o una columna que falta", () => {
    const { art, csv } = sintetico();
    const f = escribir(art, csv);
    expect(reproducir("--artifact", join(tmpdir(), "no-existe-bv.json"), "--trials", f.t).code).toBe(2);
    const roto = escribir("{no es json", csv);
    writeFileSync(roto.a, "{no es json");
    expect(reproducir("--artifact", roto.a, "--trials", roto.t).code).toBe(2);
    const sinColumna = escribir(art, csv.replace("costB", "costX"));
    const r = reproducir("--json", "--artifact", sinColumna.a, "--trials", sinColumna.t);
    expect(r.code).toBe(2);
    expect(r.stdout).toMatch(/missing column costB/);
    expect(reproducir("--no-existe").code).toBe(2);
  });
});

describe("(e) y (f) el documento del kit", () => {
  const doc = readFileSync(join(raiz, "docs/MEDICION-INDEPENDIENTE.md"), "utf8");
  const publico = readFileSync(join(raiz, "apps/web/public/measure/independent-measurement.md"), "utf8");

  it("la copia que sirve la web es idéntica, byte a byte", () => {
    expect(publico).toBe(doc);
  });

  it("no escribe NINGUNA cifra: cada número se nombra por su campo del artefacto", () => {
    expect(doc).not.toMatch(/\d+(?:[.,]\d+)?\s*%/);
    expect(doc).not.toMatch(/[$€]\s*\d/);
    expect(doc).not.toMatch(/\d+\s*(?:USD|EUR)\b/);
  });

  it("es público: en inglés", () => {
    expect(doc).not.toMatch(/[áéíóúñ¿¡]/);
  });

  it("nombra los campos que el script comprueba", () => {
    for (const campo of ["floors.min", "aggregateB2", "aggregateNativeVsB0", "scenarioSet", "sdk.asShipped", "native.decisions", "pricing.cacheWrites"]) {
      expect(doc).toContain(campo);
    }
  });
});
