/**
 * Banco del ESFUERZO · el ARNÉS (todo el I/O: red, disco, reloj).
 * ---------------------------------------------------------------------------
 * Verifica la palanca D (gateway/esfuerzo.ts) contra la verja de calidad del
 * anillo 1: éxito de TAREA con verificador programático, salida a precio de
 * lista como objetivo, factura total y lectura de caché como guardas. El
 * núcleo (nucleo.ts) es puro; el proveedor simulado (simulado.ts), también.
 *
 * EN SECO POR DEFECTO. Sin `--en-vivo` no hay red, no se lee ninguna clave y no
 * se gasta nada: contesta el proveedor simulado y el artefacto sale marcado
 * `simulated: true`, que el criterio trata como «no enciende nada».
 *
 * Uso:
 *   pnpm esfuerzo                          en seco: el corpus entero contra el simulador
 *   pnpm esfuerzo --humo                   en seco: 2 tareas × 1 rep
 *   pnpm esfuerzo --en-vivo [--humo]       LA TIRADA REAL (la lanza el dueño): exige
 *                                          BVSALA_DEMO_ANTHROPIC_API_KEY y BVSALA_ESFUERZO_BUDGET_USD
 *   pnpm esfuerzo --decidir=<artefacto>    recalcula el criterio sobre una tirada hecha, sin red
 *
 * ENV:  BVSALA_ESFUERZO_MODEL (claude-opus-5), BVSALA_ESFUERZO_NIVELES (los que
 *       rebajan el defecto del modelo), BVSALA_ESFUERZO_BRAZOS (los cuatro),
 *       BVSALA_ESFUERZO_REPS (4), BVSALA_ESFUERZO_TAREAS (ids por comas),
 *       BVSALA_ESFUERZO_MARGEN (0.05), BVSALA_ESFUERZO_BUDGET_USD (obligatorio
 *       en vivo), BVSALA_ESFUERZO_OUT_DIR (benchmarks/out),
 *       BVSALA_DEMO_ANTHROPIC_API_KEY (+ _BASE_URL, con o sin /v1).
 * Log humano por STDERR; por stdout solo la ruta del artefacto.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

import { defectoDeEsfuerzo, type Esfuerzo } from "../../gateway/esfuerzo.js";
import { tareasDelAnillo1, type Tarea } from "../anillo1/tareas.js";
import {
  BRAZOS,
  MAX_TOKENS_ESFUERZO,
  UMBRALES_POR_DEFECTO,
  costeEsperado,
  decidir,
  diagnosticoDeColocacion,
  ejecucionVacia,
  ejecutarTareaEsfuerzo,
  nivelesQueRebajan,
  ordenDeEjecucion,
  paresNecesarios,
  prevuelo,
  type Brazo,
  type Decision,
  type EjecucionEsfuerzo,
  type Pedir,
  type Plan,
  type RespuestaMessages,
  type Umbrales,
} from "./nucleo.js";
import { FACTORES_SUPUESTOS, FRACCION_THINKING_SUPUESTA, proveedorSimulado, type OpcionesSimulador } from "./simulado.js";

export const MODELO_POR_DEFECTO = "claude-opus-5";
export const REPS_POR_DEFECTO = 4;
/** Las del circuito corto, por id: un log y un código con tests (como el banco de salida). */
export const TAREAS_DE_HUMO = ["log-aguja-500", "codigo-off-by-one"];

/** Las fuentes del criterio, en el artefacto: quien lo lea puede comprobarlas. */
export const FUENTES = [
  { what: "effort levels, defaults, per-message effort (beta)", url: "https://platform.claude.com/docs/en/build-with-claude/effort", checked: "2026-09-27" },
  { what: "thinking billed as output; output_tokens_details.thinking_tokens; effort changes invalidate the cache", url: "https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost", checked: "2026-09-27" },
  { what: "placement of mid-conversation system messages and prompt caching", url: "https://platform.claude.com/docs/en/build-with-claude/mid-conversation-system-messages", checked: "2026-09-27" },
];

export interface OpcionesDeTirada {
  seco: boolean;
  humo: boolean;
  modelo: string;
  brazos: Brazo[];
  niveles: Esfuerzo[];
  reps: number;
  /** Ids del anillo 1; vacío = todas (o las de humo). */
  tareas: string[];
  presupuestoUsd?: number;
  umbrales: Umbrales;
  outDir: string;
  log: (l: string) => void;
  /** Solo en vivo. */
  apiKey?: string;
  url?: string;
  /** Solo en seco. */
  simulador?: OpcionesSimulador;
  /** Inyectable para las verjas: el transporte en vivo. */
  pedirEnVivo?: Pedir;
}

export interface Artefacto {
  version: 1;
  bench: "effort";
  date: string;
  run: string;
  simulated: boolean;
  /** En seco: lo que el simulador supone. Nada de esto es evidencia. */
  simulatorAssumptions?: { outputFactorByLevel: Record<Esfuerzo, number>; thinkingShare: number; trailingDialGoverns: boolean };
  model: string;
  modelDefaultEffort: Esfuerzo | undefined;
  arms: Brazo[];
  levels: Esfuerzo[];
  reps: number;
  smoke: boolean;
  tasks: string[];
  conditions: { maxTokens: number; cache: string; thinking: string; history: string };
  aborted: boolean;
  costUsd: number;
  budgetUsd: number | null;
  runs: EjecucionEsfuerzo[];
  decision: Decision;
  /** Una decisión por brazo, para comparar colocaciones; `decision` es la del brazo de la palanca. */
  decisionByArm: Decision[];
  placement: string[];
  sources: typeof FUENTES;
}

function tareasElegidas(o: Pick<OpcionesDeTirada, "humo" | "tareas">): Tarea[] {
  const todas = tareasDelAnillo1();
  const ids = o.tareas.length ? o.tareas : o.humo ? TAREAS_DE_HUMO : todas.map((t) => t.id);
  const porId = new Map(todas.map((t) => [t.id, t]));
  const faltan = ids.filter((id) => !porId.has(id));
  if (faltan.length) throw new Error(`unknown ring-1 tasks: ${faltan.join(", ")}`);
  return ids.map((id) => porId.get(id)!);
}

/** El transporte real: POST con reintentos ante 429/5xx, como el banco de salida. Nunca imprime cabeceras. */
export function pedirConFetch(url: string, log: (l: string) => void): Pedir {
  return async (p) => {
    for (let intento = 0; ; intento++) {
      const res = await fetch(url, { method: "POST", headers: p.cabeceras, body: p.texto });
      if (res.ok) return (await res.json()) as RespuestaMessages;
      const texto = await res.text();
      if ([429, 500, 502, 503, 529].includes(res.status) && intento < 3) {
        const espera = 2000 * 2 ** intento;
        log(`    retry ${intento + 1} after HTTP ${res.status} (${espera} ms)`);
        await new Promise((r) => setTimeout(r, espera));
        continue;
      }
      throw new Error(`HTTP ${res.status}: ${texto.slice(0, 300)}`);
    }
  };
}

/** Los comandos que el dueño corre, en el orden en que tiene sentido correrlos. */
export function comandosDelDueno(modelo: string, techoHumoUsd: number | null): string[] {
  const techo = techoHumoUsd === null ? "<ceiling printed by the dry run>" : String(Math.max(1, Math.ceil(techoHumoUsd)));
  return [
    `# 1. The placement probe (does the dial appended at the end govern the current response?):`,
    `BVSALA_ESFUERZO_MODEL=${modelo} BVSALA_ESFUERZO_NIVELES=low BVSALA_ESFUERZO_BUDGET_USD=${techo} pnpm esfuerzo --en-vivo --humo`,
    `# 2. The full run (${REPS_POR_DEFECTO} reps = 60 pairs per arm and level; a 5-point margin needs ${paresNecesarios(0.05)} that control solves):`,
    `BVSALA_ESFUERZO_MODEL=${modelo} BVSALA_ESFUERZO_BUDGET_USD=<ceiling the run prints> pnpm esfuerzo --en-vivo`,
    `# 3. Recompute the criterion on the artifact (no network, no cost), e.g. with a 10-point margin:`,
    `BVSALA_ESFUERZO_MARGEN=0.10 pnpm esfuerzo --decidir=benchmarks/out/<effort artifact>.json`,
  ];
}

/** Imprime una decisión, clase a clase. */
export function describirDecision(d: Decision, log: (l: string) => void): void {
  log(`\n── DECISION · arm ${d.brazo}${d.simulado ? " · SIMULATED (never switches anything on)" : ""} ──`);
  for (const t of d.todas) {
    const c = t.celda;
    const ic = (x: { media: number; inferior: number; superior: number }) =>
      `${x.media.toFixed(1)} % [${x.inferior.toFixed(1)}, ${x.superior.toFixed(1)}]`;
    log(
      `  ${t.nivel}: output $ ${ic(c.salidaUsd.reduccionPct)} · total $ ${ic(c.totalUsd.reduccionPct)} · ` +
        `success ${c.exito.brazo}/${c.exito.total} vs ${c.exito.control}/${c.exito.total} (losses ${c.exito.perdidas} of ${c.exito.control}, bound ${(c.exito.cotaDePerdidas * 100).toFixed(1)} %) · ` +
        `cache read ${(c.lecturaDeCache.control * 100).toFixed(1)} → ${(c.lecturaDeCache.brazo * 100).toFixed(1)} %` +
        (c.thinking ? ` · thinking ${c.thinking.control} → ${c.thinking.brazo} tok` : ""),
    );
    for (const m of t.dictamen.motivos) log(`      ✗ ${m}`);
    for (const n of t.dictamen.notas) log(`      · ${n}`);
  }
  for (const k of d.porClase) {
    log(`  class ${k.clase}: ${k.nivel ? `ON at ${k.nivel} (output floor ${k.sueloSalidaPct?.toFixed(1)} %)` : "OFF"}`);
  }
  log(
    d.global.nivel
      ? `  GATEWAY (one level for every class): BVSALA_GATEWAY_EFFORT=${d.global.nivel} (output floor ${d.global.sueloSalidaPct?.toFixed(1)} %)`
      : `  GATEWAY (one level for every class): OFF`,
  );
}

/** La tirada entera. Devuelve el artefacto y la ruta donde quedó escrito. */
export async function correr(o: OpcionesDeTirada): Promise<{ ruta: string; artefacto: Artefacto }> {
  const tareas = tareasElegidas(o);
  const reps = o.humo ? 1 : o.reps;
  const errores = prevuelo({ modelo: o.modelo, brazos: o.brazos, niveles: o.niveles, reps, tareas: tareas.map((t) => t.id) });
  if (!o.seco) {
    if (!o.apiKey && !o.pedirEnVivo) errores.push("LIVE needs BVSALA_DEMO_ANTHROPIC_API_KEY (in .env.bench)");
    if (!(o.presupuestoUsd !== undefined && o.presupuestoUsd > 0)) errores.push("LIVE needs BVSALA_ESFUERZO_BUDGET_USD: the run aborts when spend passes it");
  }
  if (errores.length) throw new Error(`preflight refused the run:\n  - ${errores.join("\n  - ")}`);

  const plan: Plan = {
    modelo: o.modelo,
    brazos: o.brazos,
    niveles: o.niveles,
    reps,
    tareas: tareas.map((t) => t.id),
    ejecuciones: 0,
  };
  const orden = ordenDeEjecucion(plan);
  plan.ejecuciones = orden.length;
  const coste = costeEsperado(plan, Object.fromEntries(tareas.map((t) => [t.id, t.turnosMax])));
  const tirada = randomUUID().slice(0, 8);
  const log = o.log;
  log(
    `effort bench · ${o.seco ? "DRY (simulated provider, no network, no spend)" : "LIVE"} · run ${tirada} · ${o.modelo} (default ${defectoDeEsfuerzo(o.modelo)})` +
      `\n  ${tareas.length} tasks × ${reps} reps · arms ${o.brazos.join(", ")} · levels ${o.niveles.join(", ")} → ${plan.ejecuciones} runs` +
      (coste
        ? `\n  hard output ceiling $${coste.techoSalidaUsd.toFixed(2)} · input reference (measured mean, full price) $${coste.referenciaEntradaUsd.toFixed(2)}` +
          (o.seco ? "" : ` · budget $${o.presupuestoUsd}`)
        : ""),
  );

  const pedir: Pedir = o.seco
    ? proveedorSimulado(o.simulador ?? { dialFinalRige: true })
    : (o.pedirEnVivo ?? pedirConFetch(o.url ?? "https://api.anthropic.com/v1/messages", log));
  const porId = new Map(tareas.map((t) => [t.id, t]));
  const ejecuciones: EjecucionEsfuerzo[] = [];
  let gastado = 0;
  let abortada = false;
  for (const e of orden) {
    const tarea = porId.get(e.tarea)!;
    const sal = `${tirada}-${e.tarea}-${e.brazo}-${e.nivel ?? "default"}-${e.rep}`;
    try {
      const r = await ejecutarTareaEsfuerzo({
        tarea,
        brazo: e.brazo,
        nivel: e.nivel,
        rep: e.rep,
        sal,
        modelo: o.modelo,
        apiKey: o.seco ? "simulated" : (o.apiKey ?? ""),
        pedir,
      });
      ejecuciones.push(r);
      gastado += r.costeTotalUsd;
      log(
        `  ${e.tarea} ${e.brazo}${e.nivel ? `@${e.nivel}` : ""}#${e.rep} → ${r.exito ? "✓" : "✗"} turns=${r.turnos} out=${r.tokens.salida} tok` +
          ` ($${r.costeSalidaUsd.toFixed(4)}) total=$${r.costeTotalUsd.toFixed(4)} cacheRead=${r.tokens.cacheLeida}`,
      );
    } catch (err) {
      // Se conserva marcada: sale de la puerta de calidad (un 400 no es un fracaso del esfuerzo).
      log(`  ${e.tarea} ${e.brazo}${e.nivel ? `@${e.nivel}` : ""}#${e.rep} → ERROR ${String(err).slice(0, 200)}`);
      ejecuciones.push({ ...ejecucionVacia(tarea, e.brazo, e.nivel, e.rep), error: String(err).slice(0, 160) });
    }
    if (!o.seco && o.presupuestoUsd !== undefined && gastado > o.presupuestoUsd) {
      log(`\n⛔ budget passed ($${gastado.toFixed(2)} > $${o.presupuestoUsd}): run aborted here`);
      abortada = true;
      break;
    }
  }

  const tratamiento = o.brazos.filter((b) => b !== "control");
  const decisiones = tratamiento.map((brazo) =>
    decidir(ejecuciones, { brazo, umbrales: o.umbrales, simulado: o.seco, modelo: o.modelo }),
  );
  const principal =
    decisiones.find((d) => d.brazo === "dial-final") ??
    decidir(ejecuciones, { brazo: "dial-final", umbrales: o.umbrales, simulado: o.seco, modelo: o.modelo });
  const colocacion = diagnosticoDeColocacion(ejecuciones);
  for (const d of decisiones) describirDecision(d, log);
  for (const n of colocacion) log(`  ⚠ ${n}`);
  if (abortada) log("\nRUN ABORTED BY BUDGET: the decision covers only what ran");

  const artefacto: Artefacto = {
    version: 1,
    bench: "effort",
    date: new Date().toISOString(),
    run: tirada,
    simulated: o.seco,
    ...(o.seco
      ? {
          simulatorAssumptions: {
            outputFactorByLevel: { ...FACTORES_SUPUESTOS, ...(o.simulador?.factores ?? {}) },
            thinkingShare: FRACCION_THINKING_SUPUESTA,
            trailingDialGoverns: o.simulador?.dialFinalRige ?? true,
          },
        }
      : {}),
    model: o.modelo,
    modelDefaultEffort: defectoDeEsfuerzo(o.modelo),
    arms: o.brazos,
    levels: o.niveles,
    reps,
    smoke: o.humo,
    tasks: tareas.map((t) => t.id),
    conditions: {
      maxTokens: MAX_TOKENS_ESFUERZO,
      cache: "automatic caching (top-level cache_control), one salt per run: turns of a run read each other, runs never share a prefix",
      thinking: "the model's default (adaptive); billed as output",
      history: "the client's: it never carries the dial, which each arm applies per request as the gateway does",
    },
    aborted: abortada,
    costUsd: gastado,
    budgetUsd: o.presupuestoUsd ?? null,
    runs: ejecuciones,
    decision: principal,
    decisionByArm: decisiones,
    placement: colocacion,
    sources: FUENTES,
  };
  mkdirSync(o.outDir, { recursive: true });
  const ruta = join(o.outDir, `effort-${new Date().toISOString().slice(0, 10)}-${tirada}${o.seco ? "-dry" : ""}.json`);
  writeFileSync(ruta, JSON.stringify(artefacto, null, 2) + "\n");
  log(`\n${o.seco ? "simulated " : ""}spend: $${gastado.toFixed(2)}\nartifact: ${ruta}`);
  if (o.seco) {
    log("\nThis was a DRY run: it proves the plumbing, not the model. The owner's commands:");
    // El techo de la sonda de colocación (paso 1): las tareas de humo, 1 rep, solo `low`.
    const planHumo: Plan = { ...plan, tareas: TAREAS_DE_HUMO, reps: 1, niveles: ["low"], ejecuciones: 0 };
    planHumo.ejecuciones = ordenDeEjecucion(planHumo).length;
    const humo = costeEsperado(planHumo, Object.fromEntries(tareasDelAnillo1().map((t) => [t.id, t.turnosMax])));
    for (const c of comandosDelDueno(o.modelo, humo ? humo.techoSalidaUsd + humo.referenciaEntradaUsd : null)) log(`  ${c}`);
  }
  return { ruta, artefacto };
}

/** `--decidir=<artefacto>`: el criterio otra vez, sobre lo ya medido. Puro salvo la lectura. */
export function redecidir(ruta: string, umbrales: Umbrales, log: (l: string) => void): Decision[] {
  const a = JSON.parse(readFileSync(ruta, "utf8")) as Artefacto;
  if (a.bench !== "effort") throw new Error(`${ruta} is not an effort-bench artifact`);
  const decisiones = a.arms
    .filter((b) => b !== "control")
    .map((brazo) => decidir(a.runs, { brazo, umbrales, simulado: a.simulated, modelo: a.model }));
  for (const d of decisiones) describirDecision(d, log);
  for (const n of diagnosticoDeColocacion(a.runs)) log(`  ⚠ ${n}`);
  return decisiones;
}

// ── main ──

function lista(v: string | undefined): string[] {
  return (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const log = (l: string) => console.error(l);
  const margen = Number(process.env.BVSALA_ESFUERZO_MARGEN ?? UMBRALES_POR_DEFECTO.margenCalidad);
  if (!(margen > 0 && margen < 1)) throw new Error(`BVSALA_ESFUERZO_MARGEN must be a fraction in (0, 1), got ${process.env.BVSALA_ESFUERZO_MARGEN}`);
  const umbrales: Umbrales = { ...UMBRALES_POR_DEFECTO, margenCalidad: margen };

  const decidirArg = process.argv.find((a) => a.startsWith("--decidir="));
  if (decidirArg) {
    redecidir(decidirArg.slice("--decidir=".length), umbrales, log);
    return;
  }

  const seco = !process.argv.includes("--en-vivo");
  const modelo = process.env.BVSALA_ESFUERZO_MODEL ?? MODELO_POR_DEFECTO;
  const niveles = lista(process.env.BVSALA_ESFUERZO_NIVELES);
  const brazos = lista(process.env.BVSALA_ESFUERZO_BRAZOS);
  const presupuesto = process.env.BVSALA_ESFUERZO_BUDGET_USD;
  // En seco NO se lee la clave: ni siquiera existe para esta tirada.
  const apiKey = seco ? undefined : process.env.BVSALA_DEMO_ANTHROPIC_API_KEY;
  const base = (process.env.BVSALA_DEMO_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/v1\/?$/, "");
  const { ruta } = await correr({
    seco,
    humo: process.argv.includes("--humo") || process.env.BVSALA_ESFUERZO_HUMO === "1",
    modelo,
    brazos: (brazos.length ? brazos : [...BRAZOS]) as Brazo[],
    niveles: (niveles.length ? niveles : nivelesQueRebajan(modelo)) as Esfuerzo[],
    reps: Number(process.env.BVSALA_ESFUERZO_REPS ?? REPS_POR_DEFECTO),
    tareas: lista(process.env.BVSALA_ESFUERZO_TAREAS),
    ...(presupuesto !== undefined ? { presupuestoUsd: Number(presupuesto) } : {}),
    umbrales,
    outDir: process.env.BVSALA_ESFUERZO_OUT_DIR ?? join(fileURLToPath(new URL("../../", import.meta.url)), "benchmarks", "out"),
    log,
    ...(apiKey ? { apiKey } : {}),
    url: `${base}/v1/messages`,
  });
  console.log(ruta);
}

// Guarda estrecha: este fichero se importa desde las verjas y nunca debe
// arrancar por coincidencia de nombre.
if (/esfuerzo[\\/]banco\.ts$/.test(process.argv[1] ?? "")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
