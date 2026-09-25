/**
 * EL SUELO QUE SOSTIENE EL PAQUETE DE NPM, cuando el artefacto publicado se
 * midió con una pieza que npm no trae.
 * ---------------------------------------------------------------------------
 * Run: pnpm -s exec tsx benchmarks/titular-como-se-instala.ts [--json]
 *
 * EL CASO QUE LO MOTIVA. El artefacto del 2026-09-12 (≥ 23,2 % frente a B0,
 * ≥ 22,9 % frente a B1) se midió con `benchmarks/compresor.ts` inyectado en la
 * capa. El paquete de npm solo trae `noopCompressor`, así que el escenario
 * «Forwarded support thread (compression)» ahorró allí un 15,1 % que quien
 * instala el SDK no puede ahorrar. Y ese escenario es CARO (≈ 3.860 tokens de
 * entrada): con el estimador estratificado pesa mucho en el agregado.
 *
 * LO QUE NO VALE, y por qué. Sacar el escenario del agregado —tratarlo como «no
 * aplica», igual que los de Anthropic/Gemini— SUBE los suelos a 27,2 % / 26,4 %:
 * el escenario ahorraba menos que la media, y quitarlo deja solo los buenos. Es
 * la cifra halagüeña por la puerta de atrás. El tráfico existe (un cliente pega
 * hilos reenviados); lo que no existe en npm es la palanca.
 *
 * LO QUE HACE ESTE MÓDULO. Sin red, con los ensayos publicados: a cada ensayo
 * del brazo B de un escenario cuya palanca npm no trae se le DEVUELVEN los
 * tokens de entrada que el compresor quitó (la diferencia media de entrada
 * A − B que el propio artefacto midió, al precio de entrada del modelo), y se
 * recalcula el MISMO estimador estratificado con la MISMA semilla. La salida del
 * brazo B se queda como se midió.
 *
 * ES UNA RECONSTRUCCIÓN, NO UNA MEDICIÓN, y por eso no se publica en ningún
 * artefacto ni en la web. Sirve para una sola cosa: comprobar que lo que la web
 * PROMETE cabe también en lo que el paquete entrega, mientras no haya una tirada
 * `BVSALA_AB_SIN_COMPRESOR=1`. Que la salida se quede como se midió es el
 * supuesto pesimista de los dos que dejan los datos: en esa tirada el brazo B
 * escribió 490 tokens frente a 261 del A, y con la entrada entera de vuelta ese
 * escenario sale en −18,6 %. Suponer «la capa no hace nada ahí» (B = A) daría
 * un suelo de 17,7 %, más cómodo y sin nada que lo respalde. Ante la duda, el
 * lado seguro. Cuando llegue la tirada real, `sdk.asShipped: true` apaga la
 * reconstrucción y mandan los suelos medidos.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { bootstrapRatioCIEstratificado, type CI } from "./stats.js";

/**
 * Palancas cuyo ahorro en el banco depende de una pieza que el paquete de npm
 * NO trae. `compression` exige un `compressor` inyectado y npm solo lleva
 * `noopCompressor`. Si algún día el paquete trae uno, sale de esta lista en el
 * mismo cambio que lo añade.
 */
export const PALANCAS_QUE_NPM_NO_TRAE: readonly string[] = ["compression"];

/** El subconjunto del artefacto que hace falta. */
export interface ArtefactoParaSuelo {
  model?: string;
  sdk?: { asShipped?: unknown };
  config?: { seed?: number };
  pricing?: {
    table?: Record<string, { inputPer1k: number }>;
    fallback?: { inputPer1k: number };
  };
  aggregate?: { savings?: Partial<CI> };
  aggregateB1?: { savings?: Partial<CI> };
  levers?: { exercised?: { palanca: string; escenario: string | null }[] };
  scenarios?: { name: string; measured?: { inputTokenDeltaMean?: number } }[];
}

/** Una fila de `ab-live-trials.csv`. */
export interface Ensayo {
  scenario: string;
  costA: number;
  costA1: number | null;
  costB: number;
}

/** Parte una línea CSV respetando las comillas que escribe `report.ts`. */
function camposCsv(linea: string): string[] {
  const campos: string[] = [];
  let actual = "";
  let entreComillas = false;
  for (let i = 0; i < linea.length; i++) {
    const c = linea[i]!;
    if (entreComillas) {
      if (c === '"' && linea[i + 1] === '"') { actual += '"'; i++; }
      else if (c === '"') entreComillas = false;
      else actual += c;
    } else if (c === '"') entreComillas = true;
    else if (c === ",") { campos.push(actual); actual = ""; }
    else actual += c;
  }
  campos.push(actual);
  return campos;
}

/** Lee `ab-live-trials.csv` (las columnas que escribe `ab-live.ts`). */
export function leerEnsayos(csv: string): Ensayo[] {
  const lineas = csv.split("\n").filter((l) => l.trim().length > 0);
  const cabecera = camposCsv(lineas[0] ?? "");
  const col = (k: string): number => {
    const i = cabecera.indexOf(k);
    if (i < 0) throw new Error(`el CSV de ensayos no trae la columna ${k}`);
    return i;
  };
  const [iS, iA, iA1, iB] = [col("scenario"), col("costA"), col("costA1"), col("costB")];
  return lineas.slice(1).map((l) => {
    const c = camposCsv(l);
    const a1 = c[iA1] ?? "";
    return { scenario: c[iS]!, costA: Number(c[iA]), costA1: a1 === "" ? null : Number(a1), costB: Number(c[iB]) };
  });
}

export interface SueloComoSeInstala {
  /** `true` = el artefacto ya midió lo que se instala: sus suelos, sin reconstruir nada. */
  medidoTalCual: boolean;
  /** Los escenarios a los que se devolvió la entrada que quitó una pieza que npm no trae. */
  reconstruidos: { escenario: string; palanca: string; tokensDeEntradaDevueltos: number; usdPorEnsayo: number }[];
  b0: CI;
  b1: CI | null;
  /** El menor de los dos suelos, en fracción. Es el que tiene que sostener la promesa. */
  menor: number;
}

function precioDeEntrada(art: ArtefactoParaSuelo): number {
  const modelo = art.model ?? "";
  const tabla = art.pricing?.table ?? {};
  const p = tabla[modelo.replace(/^[^/]+\//, "")] ?? tabla[modelo] ?? art.pricing?.fallback;
  if (!p || !Number.isFinite(p.inputPer1k)) {
    throw new Error(`el artefacto no trae precio de entrada para ${modelo || "(sin modelo)"}`);
  }
  return p.inputPer1k;
}

/**
 * El suelo del titular con lo que el paquete de npm entrega.
 *
 * `reconstruir: false` recalcula el estimador tal cual desde el CSV, sin tocar
 * nada: sirve para comprobar que CSV, artefacto y estimador cuadran al decimal
 * antes de fiarse de la reconstrucción.
 */
export function sueloComoSeInstala(
  art: ArtefactoParaSuelo,
  ensayos: Ensayo[],
  opts: { reconstruir?: boolean } = {},
): SueloComoSeInstala {
  const reconstruir = opts.reconstruir ?? true;
  const afectadas = (art.levers?.exercised ?? []).filter(
    (p) => PALANCAS_QUE_NPM_NO_TRAE.includes(p.palanca) && p.escenario,
  );

  if (reconstruir && (art.sdk?.asShipped === true || afectadas.length === 0)) {
    const b0 = art.aggregate?.savings;
    const b1 = art.aggregateB1?.savings;
    if (!b0 || typeof b0.lower !== "number") throw new Error("el artefacto no trae el suelo frente a B0");
    const ci = (s: Partial<CI>): CI => ({ point: s.point ?? s.lower!, lower: s.lower!, upper: s.upper ?? s.lower! });
    const conB1 = b1 && typeof b1.lower === "number" ? ci(b1) : null;
    return {
      medidoTalCual: true,
      reconstruidos: [],
      b0: ci(b0),
      b1: conB1,
      menor: Math.min(b0.lower, conB1?.lower ?? b0.lower),
    };
  }

  const pIn = precioDeEntrada(art);
  const reconstruidos: SueloComoSeInstala["reconstruidos"] = [];
  const extraPorEscenario = new Map<string, number>();
  if (reconstruir) {
    for (const p of afectadas) {
      const esc = (art.scenarios ?? []).find((s) => s.name === p.escenario);
      const tokens = Math.max(0, esc?.measured?.inputTokenDeltaMean ?? 0);
      const usd = (tokens / 1000) * pIn;
      extraPorEscenario.set(p.escenario!, usd);
      reconstruidos.push({ escenario: p.escenario!, palanca: p.palanca, tokensDeEntradaDevueltos: tokens, usdPorEnsayo: usd });
    }
  }

  // Los estratos en el orden en que aparecen: es el orden en que `ab-live.ts`
  // los pasó al bootstrap, y con la misma semilla reproduce su intervalo.
  const estratos = new Map<string, Ensayo[]>();
  for (const e of ensayos) {
    const lista = estratos.get(e.scenario) ?? [];
    lista.push(e);
    estratos.set(e.scenario, lista);
  }
  const seed = art.config?.seed ?? 1234567;
  const costeB = (e: Ensayo): number => e.costB + (extraPorEscenario.get(e.scenario) ?? 0);

  const b0 = bootstrapRatioCIEstratificado(
    [...estratos.values()].map((es) => ({ costA: es.map((e) => e.costA), costB: es.map(costeB) })),
    { seed },
  );
  const hayB1 = ensayos.some((e) => e.costA1 != null);
  const b1 = hayB1
    ? bootstrapRatioCIEstratificado(
        [...estratos.values()].map((es) => {
          const con = es.filter((e) => e.costA1 != null);
          return { costA: con.map((e) => e.costA1!), costB: con.map(costeB) };
        }),
        { seed },
      )
    : null;
  return { medidoTalCual: false, reconstruidos, b0, b1, menor: Math.min(b0.lower, b1?.lower ?? b0.lower) };
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const datos = new URL("../apps/web/public/data/", import.meta.url);
  const art = JSON.parse(readFileSync(new URL("ab-live.json", datos), "utf8")) as ArtefactoParaSuelo;
  const ensayos = leerEnsayos(readFileSync(new URL("ab-live-trials.csv", datos), "utf8"));
  const r = sueloComoSeInstala(art, ensayos);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(r));
  } else {
    const pct = (x: number) => `${(x * 100).toFixed(2)} %`;
    console.log(`\nsuelo del titular con lo que instala npm  (${art.model ?? "?"}, ${ensayos.length} ensayos)`);
    if (r.medidoTalCual) {
      console.log("  el artefacto ya midió el SDK tal como se instala: mandan sus suelos, sin reconstruir");
    } else {
      console.log("  RECONSTRUCCIÓN, no medición: el artefacto se midió con una pieza que npm no trae");
      for (const x of r.reconstruidos) {
        console.log(`  · ${x.escenario} (${x.palanca}): +${x.tokensDeEntradaDevueltos.toFixed(0)} tokens de entrada devueltos al brazo B`);
      }
    }
    console.log(`  frente a B0: punto ${pct(r.b0.point)}  suelo ${pct(r.b0.lower)}`);
    if (r.b1) console.log(`  frente a B1: punto ${pct(r.b1.point)}  suelo ${pct(r.b1.lower)}`);
    console.log(`  el menor de los suelos: ${pct(r.menor)} — lo prometido tiene que caber aquí\n`);
  }
}
