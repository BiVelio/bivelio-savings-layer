/**
 * Anillo 1 · el arnés: ejecuta el corpus de tareas por PARES contra la API
 * real de Anthropic y decide con ÉXITO DE TAREA, no con parecido de texto.
 *
 *   brazo A — sin context_management (la línea base de cualquier integración);
 *   brazo B — NUESTROS diales (gateway/diales.ts) + su cabecera beta: lo mismo
 *             que la palanca S4a inyecta en vivo.
 *
 * Reglas heredadas del banco A/B (y sus porqués):
 *   · SAL DE FRÍO por (tarea, brazo, rep) como primer byte del system: dos
 *     ejecuciones jamás comparten prefijo de caché, ni entre brazos ni entre
 *     reps — el coste de cada brazo es el suyo de verdad.
 *   · PAREADO: la rep r de A y de B corren la misma tarea con el mismo mundo;
 *     el bootstrap remuestrea PARES.
 *   · El coste sale de `costeMedido` (el del medidor de producción, primas de
 *     caché incluidas), del usage oficial del proveedor. Nada se estima.
 *   · Presupuesto duro: BVSALA_ANILLO1_BUDGET_USD (por defecto 40 $) aborta
 *     la tirada si el gasto acumulado lo supera.
 *
 * La PUERTA del plan (§2.5): B no pierde éxito de tarea fuera del CI del 95 %,
 * y sus re-lecturas no se disparan (la tasa base del corpus real es 144 %).
 *
 * Uso:  pnpm anillo1            (corpus entero, reps de BVSALA_ANILLO1_REPS)
 *       pnpm anillo1 --humo     (2 tareas × 1 rep: valida el circuito)
 * ENV:  BVSALA_DEMO_ANTHROPIC_API_KEY (+ _BASE_URL opcional),
 *       BVSALA_ANILLO1_MODEL (claude-sonnet-4-5), BVSALA_ANILLO1_REPS (3),
 *       BVSALA_ANILLO1_TAREAS (lista de ids separada por comas).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { costeMedido } from "../../gateway/medidor.js";
import { BETA_CONTEXT_MANAGEMENT, configDeDiales } from "../../gateway/diales.js";
import {
  ejecutarHerramienta,
  esquemaDeHerramientas,
  tareasDelAnillo1,
  type EstadoDeTarea,
  type Tarea,
} from "./tareas.js";

type Brazo = "A" | "B";

export interface PeticionConstruida {
  cuerpo: Record<string, unknown>;
  cabeceras: Record<string, string>;
}

/**
 * La petición de un turno, PURA — exportada para que las verjas comprueben sin
 * red que B lleva exactamente lo que la palanca inyecta y A no lleva nada.
 */
export function construirPeticion(opts: {
  tarea: Tarea;
  brazo: Brazo;
  sal: string;
  modelo: string;
  mensajes: unknown[];
  apiKey: string;
}): PeticionConstruida {
  const cuerpo: Record<string, unknown> = {
    model: opts.modelo,
    max_tokens: 2048,
    // La sal es el PRIMER byte del prompt: la divergencia de caché empieza en 0.
    system: `[medicion-fria ${opts.sal}]\n${opts.tarea.sistema}`,
    tools: esquemaDeHerramientas(opts.tarea),
    messages: opts.mensajes,
  };
  const cabeceras: Record<string, string> = {
    "content-type": "application/json",
    "x-api-key": opts.apiKey,
    "anthropic-version": "2023-06-01",
  };
  if (opts.brazo === "B") {
    cuerpo.context_management = configDeDiales();
    cabeceras["anthropic-beta"] = BETA_CONTEXT_MANAGEMENT;
  }
  return { cuerpo, cabeceras };
}

interface UsoAnthropic {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

interface RespuestaMessages {
  content?: { type: string; id?: string; name?: string; input?: Record<string, unknown>; text?: string }[];
  stop_reason?: string;
  usage?: UsoAnthropic;
  context_management?: { applied_edits?: { type?: string; cleared_input_tokens?: number; cleared_tool_uses?: number }[] };
  error?: { type?: string; message?: string };
}

export interface Ejecucion {
  tarea: string;
  clase: Tarea["clase"];
  brazo: Brazo;
  rep: number;
  exito: boolean;
  entregado: boolean;
  turnos: number;
  llamadas: number;
  relecturas: number;
  costeUsd: number;
  tokens: { entrada: number; salida: number; cacheLeida: number; cacheEscrita: number };
  borradosAplicados: number;
  tokensBorrados: number;
}

async function pedirConReintentos(
  url: string,
  peticion: PeticionConstruida,
  log: (l: string) => void,
): Promise<RespuestaMessages> {
  for (let intento = 0; ; intento++) {
    const res = await fetch(url, {
      method: "POST",
      headers: peticion.cabeceras,
      body: JSON.stringify(peticion.cuerpo),
    });
    if (res.ok) return (await res.json()) as RespuestaMessages;
    const texto = await res.text();
    if ([429, 500, 502, 503, 529].includes(res.status) && intento < 3) {
      const espera = 2000 * 2 ** intento;
      log(`    reintento ${intento + 1} tras HTTP ${res.status} (${espera} ms)`);
      await new Promise((r) => setTimeout(r, espera));
      continue;
    }
    throw new Error(`HTTP ${res.status}: ${texto.slice(0, 300)}`);
  }
}

async function ejecutarTarea(opts: {
  tarea: Tarea;
  brazo: Brazo;
  rep: number;
  sal: string;
  modelo: string;
  apiKey: string;
  url: string;
  log: (l: string) => void;
}): Promise<Ejecucion> {
  const { tarea, brazo, rep } = opts;
  const estado: EstadoDeTarea = tarea.construir();
  const mensajes: unknown[] = [{ role: "user", content: tarea.enunciado }];
  const vistas = new Set<string>();

  const ejec: Ejecucion = {
    tarea: tarea.id,
    clase: tarea.clase,
    brazo,
    rep,
    exito: false,
    entregado: false,
    turnos: 0,
    llamadas: 0,
    relecturas: 0,
    costeUsd: 0,
    tokens: { entrada: 0, salida: 0, cacheLeida: 0, cacheEscrita: 0 },
    borradosAplicados: 0,
    tokensBorrados: 0,
  };
  let respuestaFinal = "";

  while (ejec.turnos < tarea.turnosMax) {
    ejec.turnos++;
    const peticion = construirPeticion({ tarea, brazo, sal: opts.sal, modelo: opts.modelo, mensajes, apiKey: opts.apiKey });
    const res = await pedirConReintentos(opts.url, peticion, opts.log);
    if (res.error) throw new Error(`API: ${res.error.type}: ${res.error.message}`);

    if (res.usage) {
      const medido = costeMedido(opts.modelo, res.usage);
      if (medido) {
        ejec.costeUsd += medido.costeUsd;
        ejec.tokens.entrada += medido.tokens.entrada;
        ejec.tokens.salida += medido.tokens.salida;
        ejec.tokens.cacheLeida += medido.tokens.cacheLeida;
        ejec.tokens.cacheEscrita += medido.tokens.cacheEscrita;
      }
    }
    for (const edit of res.context_management?.applied_edits ?? []) {
      ejec.borradosAplicados++;
      ejec.tokensBorrados += edit.cleared_input_tokens ?? 0;
    }

    const contenido = res.content ?? [];
    mensajes.push({ role: "assistant", content: contenido });

    if (res.stop_reason !== "tool_use") break; // texto final sin entregar: cuenta como no entregado

    const resultados: unknown[] = [];
    let entregado = false;
    for (const bloque of contenido) {
      if (bloque.type !== "tool_use" || bloque.id === undefined || bloque.name === undefined) continue;
      ejec.llamadas++;
      const firma = `${bloque.name}:${JSON.stringify(bloque.input ?? {})}`;
      if (vistas.has(firma)) ejec.relecturas++;
      vistas.add(firma);
      const r = ejecutarHerramienta(tarea, estado, { nombre: bloque.name, entrada: bloque.input ?? {} });
      resultados.push({
        type: "tool_result",
        tool_use_id: bloque.id,
        content: r.contenido,
        ...(r.esError ? { is_error: true } : {}),
      });
      if (r.entrega !== undefined) {
        respuestaFinal = r.entrega;
        entregado = true;
      }
    }
    if (resultados.length === 0) break;
    mensajes.push({ role: "user", content: resultados });
    if (entregado) {
      ejec.entregado = true;
      break;
    }
  }

  ejec.exito = ejec.entregado && tarea.verificar(estado, respuestaFinal);
  // Las tareas de estado (escribir/migrar/arreglar) pueden estar bien aunque la
  // entrega textual sea pobre: el verificador mira el workspace igualmente.
  if (!ejec.exito && ejec.entregado === false) ejec.exito = false;
  return ejec;
}

// ── Estadística: bootstrap sobre PARES (tarea, rep) ──

export function bootstrapDiferencia(
  pares: { a: number; b: number }[],
  reps = 10_000,
  semilla = 20260904,
): { media: number; inferior: number; superior: number } {
  const n = pares.length;
  const diffs = pares.map((p) => p.b - p.a);
  const media = diffs.reduce((x, y) => x + y, 0) / n;
  let estado = semilla >>> 0;
  const azar = () => {
    estado |= 0;
    estado = (estado + 0x6d2b79f5) | 0;
    let t = Math.imul(estado ^ (estado >>> 15), 1 | estado);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const medias: number[] = [];
  for (let i = 0; i < reps; i++) {
    let suma = 0;
    for (let j = 0; j < n; j++) suma += diffs[Math.floor(azar() * n)]!;
    medias.push(suma / n);
  }
  medias.sort((x, y) => x - y);
  return { media, inferior: medias[Math.floor(reps * 0.025)]!, superior: medias[Math.floor(reps * 0.975)]! };
}

// ── main ──

async function main(): Promise<void> {
  const apiKey = process.env.BVSALA_DEMO_ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("Falta BVSALA_DEMO_ANTHROPIC_API_KEY (en .env.bench).");
    process.exit(1);
  }
  const base = (process.env.BVSALA_DEMO_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com").replace(/\/v1\/?$/, "");
  const url = `${base}/v1/messages`;
  const modelo = process.env.BVSALA_ANILLO1_MODEL ?? "claude-sonnet-4-5";
  const humo = process.argv.includes("--humo") || process.env.BVSALA_ANILLO1_HUMO === "1";
  const reps = humo ? 1 : Number(process.env.BVSALA_ANILLO1_REPS ?? 3);
  const presupuesto = Number(process.env.BVSALA_ANILLO1_BUDGET_USD ?? 40);
  const filtro = process.env.BVSALA_ANILLO1_TAREAS?.split(",").map((s) => s.trim());

  let tareas = tareasDelAnillo1();
  if (filtro?.length) tareas = tareas.filter((t) => filtro.includes(t.id));
  if (humo && !filtro?.length) tareas = [tareas[0]!, tareas[4]!]; // un log y un código con tests

  const tirada = randomUUID().slice(0, 8);
  const log = (l: string) => console.log(l);
  log(`anillo 1 · tirada ${tirada} · modelo ${modelo} · ${tareas.length} tareas × 2 brazos × ${reps} reps · presupuesto ${presupuesto} $`);

  const ejecuciones: Ejecucion[] = [];
  let gastado = 0;
  let abortada = false;

  bucle: for (const tarea of tareas) {
    for (let rep = 0; rep < reps; rep++) {
      for (const brazo of ["A", "B"] as const) {
        const sal = `${tirada}-${tarea.id}-${brazo}-${rep}`;
        try {
          const e = await ejecutarTarea({ tarea, brazo, rep, sal, modelo, apiKey, url, log });
          ejecuciones.push(e);
          gastado += e.costeUsd;
          log(
            `  ${tarea.id} ${brazo}${rep} → ${e.exito ? "✓" : "✗"} turnos=${e.turnos} llamadas=${e.llamadas} relecturas=${e.relecturas}` +
              ` coste=$${e.costeUsd.toFixed(4)}${brazo === "B" ? ` borrados=${e.borradosAplicados} (${e.tokensBorrados} tok)` : ""}`,
          );
        } catch (err) {
          log(`  ${tarea.id} ${brazo}${rep} → ERROR ${String(err).slice(0, 200)}`);
          ejecuciones.push({
            tarea: tarea.id,
            clase: tarea.clase,
            brazo,
            rep,
            exito: false,
            entregado: false,
            turnos: 0,
            llamadas: 0,
            relecturas: 0,
            costeUsd: 0,
            tokens: { entrada: 0, salida: 0, cacheLeida: 0, cacheEscrita: 0 },
            borradosAplicados: 0,
            tokensBorrados: 0,
          });
        }
        if (gastado > presupuesto) {
          log(`\n⛔ presupuesto superado ($${gastado.toFixed(2)} > $${presupuesto}) — tirada abortada aquí`);
          abortada = true;
          break bucle;
        }
      }
    }
  }

  // ── Veredicto ──
  const porBrazo = (b: Brazo) => ejecuciones.filter((e) => e.brazo === b);
  const pares: { a: number; b: number }[] = [];
  const paresCoste: { a: number; b: number }[] = [];
  for (const t of tareas) {
    for (let rep = 0; rep < reps; rep++) {
      const a = ejecuciones.find((e) => e.tarea === t.id && e.brazo === "A" && e.rep === rep);
      const b = ejecuciones.find((e) => e.tarea === t.id && e.brazo === "B" && e.rep === rep);
      if (a && b) {
        pares.push({ a: a.exito ? 1 : 0, b: b.exito ? 1 : 0 });
        if (a.costeUsd > 0 && b.costeUsd > 0) paresCoste.push({ a: a.costeUsd, b: b.costeUsd });
      }
    }
  }

  const exitosA = porBrazo("A").filter((e) => e.exito).length;
  const exitosB = porBrazo("B").filter((e) => e.exito).length;
  const relecturasDe = (b: Brazo) => {
    const xs = porBrazo(b);
    const llamadas = xs.reduce((s, e) => s + e.llamadas, 0);
    return llamadas === 0 ? 0 : xs.reduce((s, e) => s + e.relecturas, 0) / llamadas;
  };
  const costeDe = (b: Brazo) => porBrazo(b).reduce((s, e) => s + e.costeUsd, 0);
  const borrados = porBrazo("B").reduce((s, e) => s + e.borradosAplicados, 0);
  const tokensBorrados = porBrazo("B").reduce((s, e) => s + e.tokensBorrados, 0);

  const ciExito = pares.length > 1 ? bootstrapDiferencia(pares) : null;
  const puertaExito = ciExito === null ? false : ciExito.superior >= 0; // B no pierde fuera del CI
  const puertaRelecturas = relecturasDe("B") <= Math.max(relecturasDe("A") * 1.5, relecturasDe("A") + 0.05);

  log("\n── VEREDICTO ──");
  log(`éxito A: ${exitosA}/${porBrazo("A").length} · éxito B: ${exitosB}/${porBrazo("B").length}`);
  if (ciExito) {
    log(
      `diferencia de éxito (B−A): media ${(ciExito.media * 100).toFixed(1)} pt · CI95 [${(ciExito.inferior * 100).toFixed(1)}, ${(ciExito.superior * 100).toFixed(1)}] pt`,
    );
  }
  log(`coste: A $${costeDe("A").toFixed(2)} · B $${costeDe("B").toFixed(2)} (${((1 - costeDe("B") / Math.max(costeDe("A"), 1e-9)) * 100).toFixed(1)} % menos)`);
  log(`relecturas/llamada: A ${(relecturasDe("A") * 100).toFixed(1)} % · B ${(relecturasDe("B") * 100).toFixed(1)} %`);
  log(`borrados del proveedor en B: ${borrados} (${tokensBorrados.toLocaleString()} tokens limpiados)`);
  log(`puerta de éxito: ${puertaExito ? "PASA" : "NO PASA"} · puerta de relecturas: ${puertaRelecturas ? "PASA" : "NO PASA"}${abortada ? " · TIRADA ABORTADA POR PRESUPUESTO" : ""}`);

  const artefacto = {
    version: 1,
    fecha: new Date().toISOString(),
    tirada,
    modelo,
    reps,
    humo,
    abortada,
    tareas: tareas.map((t) => t.id),
    ejecuciones,
    agregado: {
      exitosA,
      exitosB,
      totalPorBrazo: porBrazo("A").length,
      ciExitoBMenosA: ciExito,
      costeA: costeDe("A"),
      costeB: costeDe("B"),
      relecturasA: relecturasDe("A"),
      relecturasB: relecturasDe("B"),
      borradosAplicadosB: borrados,
      tokensBorradosB: tokensBorrados,
      puertaExito,
      puertaRelecturas,
    },
  };
  const dir = join(process.cwd(), "benchmarks", "out");
  mkdirSync(dir, { recursive: true });
  const salida = join(dir, `anillo1-${new Date().toISOString().slice(0, 10)}-${tirada}.json`);
  writeFileSync(salida, JSON.stringify(artefacto, null, 2) + "\n");
  log(`\nartefacto: ${salida}`);
}

const esEjecucionDirecta = process.argv[1]?.includes("arnes");
if (esEjecucionDirecta) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
