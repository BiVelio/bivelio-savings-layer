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
 * del brazo B de un escenario cuya palanca npm no trae se le DEVUELVEN, al
 * precio de entrada del modelo, los tokens que el compresor QUITÓ, y se
 * recalcula el MISMO estimador estratificado con la MISMA semilla. La salida
 * del brazo B se queda como se midió.
 *
 * CUÁNTOS TOKENS SE DEVUELVEN — y por qué no es la diferencia A − B. El
 * artefacto trae dos cifras: `measured.inputTokenDeltaMean` (1.654, la entrada
 * media de A menos la de B) y `attribution.compressedInputTokens` (2.005, lo que
 * el informe de la capa dice que quitó el compresor). La primera es NETA: ya
 * descuenta ≈ 351 tokens por ensayo de entrada propia del brazo B —las
 * reparaciones del contrato de salida, que una instalación de npm seguiría
 * pagando—, así que devolver 1.654 deja al paquete mejor de lo que está. Se
 * devuelve el MAYOR de los dos. Con 1.654 el menor de los suelos salía en
 * 12,57 %; con 2.005 sale en 10,37 %.
 *
 * Y 2.005 no es una cota inferior que haya que multiplicar por las llamadas
 * extra del brazo B: esas llamadas son la reparación de la etapa 11 del
 * pipeline (src/pipeline/pipeline.ts, «Stage 11»), que manda SOLO la respuesta
 * inválida y los errores, nunca el hilo de origen. No llevan nada que el
 * compresor hubiera quitado. La sal de frío va en un mensaje `system` aparte y
 * el hilo es una constante, así que lo quitado en la primera repetición (donde
 * se anota `attribution`) es lo quitado en todas.
 *
 * ES UNA RECONSTRUCCIÓN, NO UNA MEDICIÓN, y por eso su cifra no se publica en
 * ningún artefacto ni en la web. Sirve para una sola cosa: comprobar que lo que
 * la web PROMETE cabe también en lo que el paquete entrega, mientras no haya una
 * tirada `BVSALA_AB_SIN_COMPRESOR=1`. Que la salida y las reparaciones del brazo
 * B se queden como se midieron es el supuesto conservador que dejan los datos
 * (en esa tirada B escribió 490 tokens frente a 261 del A): suponer «la capa no
 * hace nada ahí» (B = A) daría un suelo más alto y sin nada que lo respalde. No
 * es una cota: sin compresor el modelo ve otra entrada y podría reparar más o
 * menos veces. Lo decide la tirada real; cuando llegue, `sdk.asShipped: true`
 * apaga la reconstrucción y mandan los suelos medidos.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { bootstrapRatioCIEstratificado, type CI } from "./stats.js";

/**
 * Palancas cuyo ahorro en el banco depende de una pieza que el paquete de npm
 * NO trae. `compression` exige un `compressor` inyectado y npm solo lleva
 * `noopCompressor`. Si algún día el paquete trae uno, sale de esta lista en el
 * mismo cambio que lo añade. La web lleva un espejo de esta lista
 * (apps/web/lib/bench/sdk-instalado.ts) y un test exige que digan lo mismo.
 */
export const PALANCAS_QUE_NPM_NO_TRAE: readonly string[] = ["compression"];

/** El estado de palanca que el banco anota por escenario. */
interface PalancaDeEscenario {
  palanca: string;
  ejercitada?: boolean;
}

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
  levers?: { exercised?: { palanca: string; escenario?: string | null }[] };
  scenarios?: {
    name: string;
    reps?: number;
    palanca?: PalancaDeEscenario | null;
    measured?: { inputTokenDeltaMean?: number };
    attribution?: { compressedInputTokens?: number };
  }[];
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
  /**
   * `true` SOLO si el artefacto declara haber medido el SDK tal como se instala
   * (`sdk.asShipped: true`). Un artefacto sin sello nunca lo es, aunque no haya
   * nada que reconstruir: no se sabe qué llevaba.
   */
  medidoTalCual: boolean;
  /** `true` = no se devolvió nada: mandan los suelos del artefacto tal cual. */
  sinReconstruir: boolean;
  /** Por qué este resultado es el que es, en una línea (para la consola y luz-verde). */
  motivo: string;
  /** Los escenarios a los que se devolvió la entrada que quitó una pieza que npm no trae. */
  reconstruidos: {
    escenario: string;
    palanca: string;
    tokensDeEntradaDevueltos: number;
    /** De dónde salen: la atribución del informe de la capa o la diferencia A − B. */
    fuente: "attribution.compressedInputTokens" | "measured.inputTokenDeltaMean";
    usdPorEnsayo: number;
  }[];
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
 * Los escenarios cuyo ahorro salió de una palanca que npm no trae. Se leen de
 * `scenarios[].palanca` (una entrada por escenario) y, para artefactos que solo
 * la declaran ahí, también de `levers.exercised` (una entrada por PALANCA: si la
 * misma palanca se ejercitara en dos escenarios, esa lista solo nombraría uno).
 */
export function escenariosConPiezaQueNpmNoTrae(art: ArtefactoParaSuelo): { escenario: string; palanca: string }[] {
  const vistos = new Map<string, string>();
  for (const s of art.scenarios ?? []) {
    const p = s.palanca;
    if (p && PALANCAS_QUE_NPM_NO_TRAE.includes(p.palanca) && p.ejercitada === true) vistos.set(s.name, p.palanca);
  }
  for (const p of art.levers?.exercised ?? []) {
    if (p.escenario && PALANCAS_QUE_NPM_NO_TRAE.includes(p.palanca) && !vistos.has(p.escenario)) {
      vistos.set(p.escenario, p.palanca);
    }
  }
  return [...vistos].map(([escenario, palanca]) => ({ escenario, palanca }));
}

/**
 * CSV y artefacto tienen que describir los MISMOS estratos y en el MISMO orden:
 * es el orden en que `ab-live.ts` los pasó al bootstrap, y con la misma semilla
 * es lo que reproduce su intervalo. Dos escenarios con el mismo nombre se
 * fundirían en un estrato; uno que falte en el CSV desplazaría el generador.
 * Mejor un error que diga cuál que un suelo que no cuadra sin explicación.
 */
function estratosEnOrden(art: ArtefactoParaSuelo, ensayos: Ensayo[]): Map<string, Ensayo[]> {
  const estratos = new Map<string, Ensayo[]>();
  for (const e of ensayos) {
    const lista = estratos.get(e.scenario) ?? [];
    lista.push(e);
    estratos.set(e.scenario, lista);
  }
  const escenarios = art.scenarios;
  if (!escenarios) return estratos;
  const nombres = escenarios.map((s) => s.name);
  const repetidos = nombres.filter((n, i) => nombres.indexOf(n) !== i);
  if (repetidos.length) {
    throw new Error(`el artefacto trae escenarios con el mismo nombre (${[...new Set(repetidos)].join(", ")}): el CSV los fundiría en un estrato`);
  }
  const sinArtefacto = [...estratos.keys()].filter((n) => !nombres.includes(n));
  if (sinArtefacto.length) {
    throw new Error(`el CSV trae ensayos de escenarios que el artefacto no declara: ${sinArtefacto.join(", ")}`);
  }
  const sinEnsayos = escenarios.filter((s) => (s.reps ?? 0) > 0 && !estratos.has(s.name)).map((s) => s.name);
  if (sinEnsayos.length) {
    throw new Error(`el artefacto declara repeticiones de escenarios que el CSV no trae: ${sinEnsayos.join(", ")}`);
  }
  const orden = nombres.filter((n) => estratos.has(n));
  if (orden.join("\u0000") !== [...estratos.keys()].join("\u0000")) {
    throw new Error("el CSV no trae los escenarios en el orden del artefacto: el bootstrap no reproduciría su intervalo");
  }
  return estratos;
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
  const medidoTalCual = art.sdk?.asShipped === true;
  const afectados = escenariosConPiezaQueNpmNoTrae(art);

  if (reconstruir && (medidoTalCual || afectados.length === 0)) {
    const b0 = art.aggregate?.savings;
    const b1 = art.aggregateB1?.savings;
    if (!b0 || typeof b0.lower !== "number") throw new Error("el artefacto no trae el suelo frente a B0");
    const ci = (s: Partial<CI>): CI => ({ point: s.point ?? s.lower!, lower: s.lower!, upper: s.upper ?? s.lower! });
    const conB1 = b1 && typeof b1.lower === "number" ? ci(b1) : null;
    return {
      medidoTalCual,
      sinReconstruir: true,
      motivo: medidoTalCual
        ? "el artefacto midió el SDK tal como se instala desde npm (sdk.asShipped: true)"
        : "el artefacto no declara qué SDK midió, pero no ejercitó ninguna palanca que npm no trae",
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
    for (const p of afectados) {
      const esc = (art.scenarios ?? []).find((s) => s.name === p.escenario);
      const neto = Math.max(0, esc?.measured?.inputTokenDeltaMean ?? 0);
      const quitado = Math.max(0, esc?.attribution?.compressedInputTokens ?? 0);
      // El MAYOR: la diferencia A − B ya descuenta la entrada propia del brazo B.
      const tokens = Math.max(neto, quitado);
      const usd = (tokens / 1000) * pIn;
      extraPorEscenario.set(p.escenario, usd);
      reconstruidos.push({
        escenario: p.escenario,
        palanca: p.palanca,
        tokensDeEntradaDevueltos: tokens,
        fuente: quitado >= neto ? "attribution.compressedInputTokens" : "measured.inputTokenDeltaMean",
        usdPorEnsayo: usd,
      });
    }
  }

  const estratos = estratosEnOrden(art, ensayos);
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
  return {
    medidoTalCual,
    sinReconstruir: !reconstruir,
    motivo: reconstruir
      ? "RECONSTRUCCIÓN, no medición: el artefacto se midió con una pieza que npm no trae"
      : "recalculado desde el CSV sin tocar nada",
    reconstruidos,
    b0,
    b1,
    menor: Math.min(b0.lower, b1?.lower ?? b0.lower),
  };
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
    console.log(`  ${r.motivo}`);
    for (const x of r.reconstruidos) {
      console.log(
        `  · ${x.escenario} (${x.palanca}): +${x.tokensDeEntradaDevueltos.toFixed(0)} tokens de entrada devueltos al brazo B (${x.fuente})`,
      );
    }
    console.log(`  frente a B0: punto ${pct(r.b0.point)}  suelo ${pct(r.b0.lower)}`);
    if (r.b1) console.log(`  frente a B1: punto ${pct(r.b1.point)}  suelo ${pct(r.b1.lower)}`);
    console.log(`  el menor de los suelos: ${pct(r.menor)} — lo prometido tiene que caber aquí\n`);
  }
}
