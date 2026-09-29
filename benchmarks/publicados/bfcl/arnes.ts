/**
 * BFCL A/B — Berkeley Function Calling Leaderboard, con y sin la capa.
 * ---------------------------------------------------------------------------
 * Uso:
 *   pnpm bench:bfcl --preparar                  # solo descarga y verifica el dataset
 *   pnpm bench:bfcl --mock                      # arnés entero sin red (proveedor simulado)
 *   pnpm bench:bfcl --n=25 --multi=4 --repes=5  # LIVE (claves en .env.bench)
 *
 * Opciones: --modelos=a,b  --n=<por categoría AST>  --multi=<entradas multi-turn>
 *   --repes=<repeticiones AST deliberadas>  --tope=<$ por modelo, A+B>  --semilla=<n>
 *   --salida=<dir>  --nombre=<base de <nombre>.json/.md, por defecto bfcl-0431>
 *   --comparar=<artefacto de una tirada anterior (la 0.4.30) para la sección de comparación>
 *   --concurrencia=<por proveedor, ≤4>
 *
 * TOPE DURO POR FAMILIA (en código, `TOPE_MAXIMO`): 0,80 $ por modelo OpenAI y
 * 1,25 $ por modelo Anthropic, A+B, entre TODAS las tiradas de la batería; los
 * modelos de gama alta (`MODELOS_GAMA_ALTA`, Gemini incluido) tienen 1,25 $ cada
 * uno (`techoDe`). `--tope` solo puede bajarlo. Gemini se habla por el endpoint
 * compatible con OpenAI de Google (BVSALA_SONDA_BASE_URL, host oficial). Antes de gastar en Anthropic se prueba la clave con
 * `GET /v1/models` (gratis): un 401 deja el modelo «no medible: clave inválida».
 *
 * DOCTRINA (la de benchmarks/README.md, sección A/B):
 *   · los dos brazos se miden con el `usage` real del proveedor y la MISMA
 *     aritmética de precio (cable.ts); el informe de la capa se publica aparte,
 *     como lo que la capa DICE, nunca como la medición;
 *   · la exactitud se juzga con el comprobador AST de BFCL portado (ast.ts), el
 *     mismo en los dos brazos;
 *   · la capa no debe cambiar ninguna llamada de herramienta: se comprueba
 *     llamada a llamada contra la respuesta cruda que ella misma recibió, y el
 *     cuerpo que mandó contra el del brazo A;
 *   · presupuesto duro por modelo, comprobado ANTES de cada llamada;
 *   · subconjunto estratificado por categoría con semilla fija, recorrido en
 *     turno rotatorio para que una tirada cortada por presupuesto siga
 *     estratificada.
 */
import { appendFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SavingsLayer, SavingsResult } from "../../../src/index.js";
import { precioYPrima } from "../../coste.js";
import { muestreoPareadoPara } from "../../scenarios.js";
import { mulberry32 } from "../../stats.js";
import { comprobarEntrada, parsearJson, salidaDeLlamadas, type ValorJ } from "./ast.js";
import {
  cuerpoBrazoA,
  diferenciasDelCable,
  leerRespuesta,
  llamadasIguales,
  llamarBrazoA,
  llamarBrazoB,
  normalizarBase,
  type Endpoint,
  type LlamadaHerramienta,
  type Muestreo,
  type Turno,
} from "./brazos.js";
import {
  crearCable,
  peorCasoDeLlamada,
  Presupuesto,
  PresupuestoAgotado,
  Semaforo,
  sinSecretos,
  unidadEnCurso,
  type Familia,
  type LlamadaDelCable,
} from "./cable.js";
import {
  CATEGORIAS_AST,
  COMMIT_BFCL,
  LICENCIA_BFCL,
  REPO_BFCL,
  cargarCategoria,
  cargarMultiTurno,
  prepararDataset,
  DIR_CACHE,
  type CategoriaAst,
  type EntradaAst,
  type EntradaMultiTurno,
} from "./datos.js";
import { herramientaDe, type HerramientaNeutral } from "./esquema.js";
import { escribirInforme, resumir, type ResumenDeModelo } from "./informe.js";
import { cargarSdk, instalarVerjaDeHosts, VERSION_PAQUETE, type ProcedenciaDelBrazoB, type SdkCargado } from "./procedencia.js";
import { claveSimulada, fetchSimulado, respuestaDeReferencia, type RespuestaSimulada } from "./simulador.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "..", "..", "..");

export const MODELOS_POR_DEFECTO = [
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-sonnet-5",
  "openai/gpt-4o-mini",
  "openai/gpt-5.4-mini",
] as const;

/** El techo autorizado por el dueño para ESTA batería, por modelo y A+B. `--tope` solo lo baja. */
export const TOPE_MAXIMO: Record<Familia, number> = { openai: 0.8, anthropic: 1.25 };

/**
 * La batería de GAMA ALTA (2026-09-29): el dueño autorizó 1,25 $ por modelo, A+B,
 * para cada uno de estos, sea cual sea su proveedor. Un modelo de esta lista usa
 * este techo en vez del de su familia; `--tope` sigue pudiendo bajarlo, nunca subirlo.
 */
export const MODELOS_GAMA_ALTA = [
  "anthropic/claude-opus-5-5",
  "anthropic/claude-sonnet-5-5",
  "openai/gpt-5.5",
  "openai/gpt-5.6-sol",
  "google/gemini-3.8-flash",
  "google/gemini-3.1-pro-preview",
] as const;
export const TOPE_GAMA_ALTA = 1.25;

/** El techo de un modelo: el de gama alta si está en esa lista; si no, el de su familia. */
export function techoDe(modelo: string): number {
  return (MODELOS_GAMA_ALTA as readonly string[]).includes(modelo) ? TOPE_GAMA_ALTA : TOPE_MAXIMO[familiaDe(modelo)];
}

/**
 * Precios OFICIALES citados para modelos SIN fila en el catálogo del SDK. El
 * catálogo NO se toca (es del producto, no del banco); el banco solo mide con
 * un precio que pueda citar con URL y fecha. Sin entrada aquí ni fila en el
 * catálogo, el modelo no se mide.
 */
export const PRECIOS_CITADOS: Record<string, { precio: { inputPer1k: number; outputPer1k: number; cachedInputPer1k: number }; prima: number; fuente: string }> = {
  // https://platform.claude.com/docs/en/about-claude/pricing, consultada el 2026-09-29:
  // «Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok»
  // (entrada, escritura 5 min = 1,25×, escritura 1 h = 2×, lectura = 0,1×, salida).
  "claude-sonnet-5-5": {
    precio: { inputPer1k: 0.002, outputPer1k: 0.01, cachedInputPer1k: 0.0002 },
    prima: 1.25,
    fuente: "https://platform.claude.com/docs/en/about-claude/pricing (consultada 2026-09-29): Claude Sonnet 5.5 $2 / $2.50 (5m write) / $4 (1h write) / $0.20 (cache hit) / $10 per MTok",
  },
};

/** El proveedor (a quién se paga y con qué clave), distinto del dialecto del cable (`Familia`). */
export type Proveedor = "anthropic" | "openai" | "google";
export function proveedorDe(modelo: string): Proveedor {
  if (modelo.startsWith("google/") || /^gemini/.test(modelo)) return "google";
  return familiaDe(modelo);
}

/** Los únicos hosts a los que la tirada puede hablar: los API oficiales de cada proveedor. */
export const HOSTS_OFICIALES: Record<Proveedor, string> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
  google: "generativelanguage.googleapis.com",
};

/** Nombre de fichero por defecto: «bfcl-0431» para la 0.4.31. */
export const NOMBRE_POR_DEFECTO = `bfcl-${VERSION_PAQUETE.replace(/\./g, "")}`;

// ── Tipos del artefacto ───────────────────────────────────────────────────

export interface ResumenDelInforme {
  cache: string;
  basis: string;
  actual: number;
  baselineEstimate: number;
  netSavings: number;
  actualLlm: number;
  avoidedLlm: number;
  providerCachedInput: number;
  eliminatedInput: number;
  compressedInput: number;
  qualityStatus?: string;
  trazas: string[];
}

export interface ResultadoBrazo {
  ok: boolean;
  error?: string;
  llamadas: LlamadaHerramienta[];
  texto: string;
  coste: number;
  llamadasAlProveedor: number;
  entrada: number;
  lecturaCache: number;
  escrituraCache: number;
  salida: number;
}

export interface RegistroAst {
  id: string;
  categoria: CategoriaAst;
  primero: "A" | "B";
  A: ResultadoBrazo & { correcto: boolean; motivo?: string };
  B: ResultadoBrazo & {
    correcto: boolean;
    motivo?: string;
    informe?: ResumenDelInforme;
    /** La capa devolvió exactamente las llamadas de la respuesta cruda que recibió. */
    fiel: boolean | null;
    diferenciasDelCable: string[];
    marcasDeCache: number;
  };
  /** Mismas llamadas (nombre+argumentos canónicos) en A y en B. */
  mismasLlamadas: boolean;
}

export interface RegistroRepeticion {
  id: string;
  costeA: number;
  costeB: number;
  cacheB: string;
  llamadasAlProveedorB: number;
  avoidedLlmB: number;
  basisB: string;
}

export interface VarianteMultiTurno {
  variante: "V1-base" | "V2-isError" | "V3-args" | "V4-repite-V1" | "V5-repite-V2";
  costeA: number;
  costeB: number;
  cacheB: string;
  llamadasAlProveedorB: number;
  textoB: string;
  llamadasB: number;
  textoA: string;
  basisB: string;
  /** Trazas de la capa (política, caché, herramientas) de la llamada B: dicen POR QUÉ acertó o no. */
  trazasB?: string[];
  error?: string;
  /** Error del brazo A en esta variante (HTTP del proveedor). */
  errorA?: string;
  /** En qué difiere el cuerpo que mandó B del de A en esta variante (p. ej. un `extra_content` perdido). */
  diferenciasDelCableB?: string[];
}

export interface RegistroMultiTurno {
  id: string;
  clases: string[];
  herramientas: number;
  paso0: {
    A: { llamadas: LlamadaHerramienta[]; coste: number; herramientasEnCable: number; error?: string };
    B: { llamadas: LlamadaHerramienta[]; coste: number; herramientasEnCable: number; error?: string; diferenciasDelCable: string[] };
    referenciaTurno1: string[];
  };
  variantes: VarianteMultiTurno[];
  /** Violaciones del aislamiento de caché (lo que arregló #368). Vacío = sano. */
  violaciones: string[];
  omitido?: string;
}

export interface TiradaDeModelo {
  modelo: string;
  familia: Familia;
  muestreo: Muestreo;
  precio: { inputPer1k: number; outputPer1k: number; cachedInputPer1k?: number; primaEscritura: number; claveCatalogo?: string; fuente?: string };
  proveedor?: Proveedor;
  /** La mayor salida (tokens, pensamiento incluido) de UNA llamada: el peor caso reservado supone 4096. */
  salidaMaximaPorLlamada?: number;
  tope: number;
  gastado: number;
  gastoPorBrazo: { A: number; B: number };
  llamadasPorBrazo: { A: number; B: number };
  abortadoPorPresupuesto: boolean;
  ast: RegistroAst[];
  repeticiones: RegistroRepeticion[];
  multiTurno: RegistroMultiTurno[];
  avisosDeLaCapa: string[];
  errores: string[];
}

export interface Artefacto {
  bateria: "BFCL";
  fecha: string;
  modo: "LIVE" | "MOCK";
  dataset: { repo: string; commit: string; licencia: string; categorias: string[]; tamanoPorCategoria: Record<string, number> };
  paquete: ProcedenciaDelBrazoB;
  config: { n: number; multi: number; repes: number; tope: number; semilla: number; concurrencia: number; gastoPrevioDescontado: Record<string, number> };
  modelos: TiradaDeModelo[];
  resumen?: ResumenDeModelo[];
  /** Modelos que no se midieron sin gastar nada (p. ej. la prueba gratuita de la clave dio 401). */
  noMedibles?: { modelo: string; motivo: string }[];
  /** La tirada anterior (otra versión del paquete) con la que se compara, tal como se publicó. */
  comparacion?: { fichero: string; version: string; tag: string; commitDelTag: string; fecha: string; config: Artefacto["config"]; resumen: ResumenDeModelo[]; multiTurno: Record<string, { id: string; herramientasEnCable: { A: number; B: number } }[]> };
  /** Notas del operador con evidencia (lo que el arnés no puede redactar solo); se publican tal cual. */
  notas?: string[];
  /** Tiradas unidas con --fusionar. */
  partes?: { fecha: string; config: Artefacto["config"]; modelos: string[] }[];
}

// ── Utilidades ────────────────────────────────────────────────────────────

function arg(nombre: string): string | undefined {
  const p = process.argv.find((a) => a === `--${nombre}` || a.startsWith(`--${nombre}=`));
  if (!p) return undefined;
  return p.includes("=") ? p.slice(p.indexOf("=") + 1) : "1";
}

function barajar<T>(xs: T[], semilla: number): T[] {
  const r = mulberry32(semilla);
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Muestra estratificada: n por categoría, semilla fija, en turno rotatorio. */
export function muestraEstratificada(porCategoria: Map<CategoriaAst, EntradaAst[]>, n: number, semilla: number): EntradaAst[] {
  const listas = [...porCategoria.entries()].map(([cat, xs]) => barajar(xs, semilla ^ hash32(cat)).slice(0, n));
  const out: EntradaAst[] = [];
  for (let i = 0; i < n; i++) for (const l of listas) if (l[i]) out.push(l[i]!);
  return out;
}

/** El DIALECTO del cable: Gemini se habla por su endpoint compatible con OpenAI. */
export function familiaDe(modelo: string): Familia {
  if (modelo.startsWith("anthropic/") || /^claude/.test(modelo)) return "anthropic";
  return "openai";
}

function canonica(ls: LlamadaHerramienta[]): string {
  const norm = (a: string) => {
    try {
      return JSON.stringify(ordenar(JSON.parse(a)));
    } catch {
      return a;
    }
  };
  return JSON.stringify(ls.map((l) => [l.name, norm(l.arguments)]).sort());
}
function ordenar(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(ordenar);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, ordenar(x)]));
  return v;
}

function resumenDelInforme(r: SavingsResult): ResumenDelInforme {
  const rep = r.report;
  return {
    cache: rep.cache.result,
    basis: String(rep.cost.basis),
    actual: rep.cost.actual,
    baselineEstimate: rep.cost.baselineEstimate,
    netSavings: rep.cost.netSavings,
    actualLlm: rep.calls.actualLlm,
    avoidedLlm: rep.calls.avoidedLlm,
    providerCachedInput: rep.tokens.providerCachedInput ?? 0,
    eliminatedInput: rep.tokens.eliminatedInput,
    compressedInput: rep.tokens.compressedInput,
    ...(rep.qualityStatus ? { qualityStatus: String(rep.qualityStatus) } : {}),
    trazas: rep.traces
      .filter((t) => /tool|cache|resolver|route|serial|compres|elision|policy/i.test(t.stage))
      .map((t) => sinSecretos(`${t.stage}:${t.outcome}${t.detail ? ` ${JSON.stringify(t.detail).slice(0, 200)}` : ""}`)),
  };
}

function sumaDelCable(reg: LlamadaDelCable[], brazo: "A" | "B") {
  const xs = reg.filter((c) => c.brazo === brazo);
  return {
    coste: xs.reduce((s, c) => s + c.coste, 0),
    llamadasAlProveedor: xs.length,
    entrada: xs.reduce((s, c) => s + (c.uso?.entrada ?? 0), 0),
    lecturaCache: xs.reduce((s, c) => s + (c.uso?.lecturaCache ?? 0), 0),
    escrituraCache: xs.reduce((s, c) => s + (c.uso?.escrituraCache ?? 0), 0),
    salida: xs.reduce((s, c) => s + (c.uso?.salida ?? 0), 0),
  };
}

// ── La tirada de un modelo ────────────────────────────────────────────────

interface Contexto {
  modelo: string;
  familia: Familia;
  ep: Endpoint;
  cable: typeof fetch;
  capa: SavingsLayer;
  muestreo: Muestreo;
  presupuesto: Presupuesto;
  diario: string;
  precio: CostModelDelBanco;
}
type CostModelDelBanco = { inputPer1k: number; outputPer1k: number; cachedInputPer1k?: number };

/** La mayor salida de una llamada de este modelo en el diario del cable de ESTA tirada. */
function maximaSalida(diario: string, modelo: string): number {
  let max = 0;
  try {
    for (const l of readFileSync(diario, "utf8").split("\n")) {
      if (!l.trim()) continue;
      const c = JSON.parse(l) as { modelo: string; uso?: { salida?: number } | null };
      if (c.modelo === modelo) max = Math.max(max, c.uso?.salida ?? 0);
    }
  } catch {
    /* sin diario (nada corrió) */
  }
  return max;
}

function volcar(ctx: Contexto, reg: LlamadaDelCable[]): void {
  for (const c of reg) appendFileSync(ctx.diario, `${JSON.stringify({ modelo: ctx.modelo, ...c })}\n`);
}

async function correrA(ctx: Contexto, unidad: string, turnos: Turno[], hs: HerramientaNeutral[], reg: LlamadaDelCable[]) {
  const cuerpo = cuerpoBrazoA(ctx.familia, ctx.modelo, turnos, hs, ctx.muestreo);
  const r = await unidadEnCurso.run({ unidad, brazo: "A", registro: reg }, () => llamarBrazoA(ctx.ep, ctx.cable, cuerpo));
  const leida = leerRespuesta(ctx.familia, r.ok ? r.cuerpo : null);
  return {
    cuerpo,
    ok: r.ok,
    ...(r.ok ? {} : { error: sinSecretos(`HTTP ${r.status}: ${JSON.stringify(r.cuerpo).slice(0, 300)}`) }),
    ...leida,
  };
}

async function correrB(ctx: Contexto, unidad: string, turnos: Turno[], hs: HerramientaNeutral[], reg: LlamadaDelCable[]) {
  try {
    const r = await unidadEnCurso.run({ unidad, brazo: "B", registro: reg }, () => llamarBrazoB(ctx.capa, ctx.modelo, turnos, hs, ctx.muestreo));
    return { ok: true as const, r };
  } catch (e) {
    if (e instanceof PresupuestoAgotado) throw e;
    const err = e as Error;
    if (err.cause instanceof PresupuestoAgotado) throw err.cause;
    if (/presupuesto de .* agotado/.test(err.message)) throw new PresupuestoAgotado(ctx.modelo, ctx.presupuesto.gastado, ctx.presupuesto.tope);
    return { ok: false as const, error: sinSecretos(`${err.name}: ${err.message}`).slice(0, 400) };
  }
}

function veredicto(e: EntradaAst, llamadas: LlamadaHerramienta[]): { correcto: boolean; motivo?: string } {
  if (llamadas.length === 0) return { correcto: false, motivo: "sin llamada de herramienta" };
  const salida = salidaDeLlamadas(llamadas);
  if ("error" in salida) return { correcto: false, motivo: salida.error };
  const posible = parsearJson(JSON.stringify(e.respuesta)) as unknown as Record<string, Record<string, ValorJ[]>>[];
  const v = comprobarEntrada(e.categoria, e.funciones, salida, posible);
  return v.valido ? { correcto: true } : { correcto: false, motivo: v.error ?? "inválida" };
}

async function unidadAst(ctx: Contexto, e: EntradaAst, indice: number): Promise<RegistroAst> {
  const hs = e.funciones.map((f) => herramientaDe(f));
  const turnos: Turno[] = e.pregunta.map((q) => ({ role: "user", content: q.content }));
  const reg: LlamadaDelCable[] = [];
  const primero: "A" | "B" = indice % 2 === 0 ? "A" : "B";
  let a!: Awaited<ReturnType<typeof correrA>>;
  let b!: Awaited<ReturnType<typeof correrB>>;
  if (primero === "A") {
    a = await correrA(ctx, e.id, turnos, hs, reg);
    b = await correrB(ctx, e.id, turnos, hs, reg);
  } else {
    b = await correrB(ctx, e.id, turnos, hs, reg);
    a = await correrA(ctx, e.id, turnos, hs, reg);
  }
  volcar(ctx, reg);
  const sa = sumaDelCable(reg, "A");
  const sb = sumaDelCable(reg, "B");
  const llamadasB = b.ok ? (b.r.toolCalls ?? []) : [];
  const ultimaB = [...reg].reverse().find((c) => c.brazo === "B" && c.status === 200);
  const crudaB = ultimaB ? leerRespuesta(ctx.familia, ultimaB.respuesta) : null;
  const primeraB = reg.find((c) => c.brazo === "B");
  const dif = primeraB?.peticion ? diferenciasDelCable(a.cuerpo, primeraB.peticion) : { diferencias: ["B made no provider call"], marcasDeCacheEnB: 0 };
  return {
    id: e.id,
    categoria: e.categoria,
    primero,
    A: { ok: a.ok, ...(a.error ? { error: a.error } : {}), llamadas: a.llamadas, texto: a.texto, ...sa, ...veredicto(e, a.llamadas) },
    B: {
      ok: b.ok,
      ...(b.ok ? {} : { error: b.error }),
      llamadas: llamadasB,
      texto: b.ok ? b.r.text : "",
      ...sb,
      ...veredicto(e, llamadasB),
      ...(b.ok ? { informe: resumenDelInforme(b.r) } : {}),
      fiel: b.ok && crudaB ? llamadasIguales(llamadasB, crudaB.llamadas) : null,
      diferenciasDelCable: dif.diferencias,
      marcasDeCache: dif.marcasDeCacheEnB,
    },
    mismasLlamadas: canonica(a.llamadas) === canonica(llamadasB),
  };
}

async function unidadRepeticion(ctx: Contexto, e: EntradaAst): Promise<RegistroRepeticion> {
  const hs = e.funciones.map((f) => herramientaDe(f));
  const turnos: Turno[] = e.pregunta.map((q) => ({ role: "user", content: q.content }));
  const reg: LlamadaDelCable[] = [];
  const unidad = `${e.id}#repeticion`;
  await correrA(ctx, unidad, turnos, hs, reg);
  const b = await correrB(ctx, unidad, turnos, hs, reg);
  volcar(ctx, reg);
  return {
    id: e.id,
    costeA: sumaDelCable(reg, "A").coste,
    costeB: sumaDelCable(reg, "B").coste,
    cacheB: b.ok ? b.r.report.cache.result : `error: ${b.error}`,
    llamadasAlProveedorB: sumaDelCable(reg, "B").llamadasAlProveedor,
    avoidedLlmB: b.ok ? b.r.report.calls.avoidedLlm : 0,
    basisB: b.ok ? String(b.r.report.cost.basis) : "error",
  };
}

/** Cambia UN argumento de la primera llamada (la variante V3); sin argumentos que cambiar, añade uno. null = no hay llamada o sus argumentos no son JSON. */
export function conArgumentoCambiado(ls: LlamadaHerramienta[]): LlamadaHerramienta[] | null {
  const [primera, ...resto] = ls;
  if (!primera) return null;
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(primera.arguments || "{}") as Record<string, unknown>;
  } catch {
    return null;
  }
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === "string") return [{ ...primera, arguments: JSON.stringify({ ...args, [k]: `${v}_alt` }) }, ...resto];
    if (typeof v === "number") return [{ ...primera, arguments: JSON.stringify({ ...args, [k]: v + 1 }) }, ...resto];
  }
  // Sin nada que cambiar (p. ej. `{}`): se añade un argumento. Para la clave de caché es «argumentos distintos».
  return [{ ...primera, arguments: JSON.stringify({ ...args, bfcl_variant: "alt" }) }, ...resto];
}

function idsNuevos(ls: LlamadaHerramienta[], familia: Familia, sufijo: string): LlamadaHerramienta[] {
  return ls.map((l, i) => ({ ...l, id: familia === "anthropic" ? `toolu_bfcl_${sufijo}_${i}` : `call_bfcl_${sufijo}_${i}` }));
}

/** El resultado sintético de una herramienta (el banco no ejecuta las clases de BFCL). */
function resultadoSintetico(l: LlamadaHerramienta): string {
  return JSON.stringify({ status: "ok", function: l.name, result: "done" });
}

/**
 * Reserva el peor caso de UN paso (una llamada por brazo, más media de margen para
 * una llamada extra de la capa), calculado del cuerpo REAL del brazo A. Sin sitio
 * → `PresupuestoAgotado`, antes de gastar nada en ese paso.
 */
function peorPaso(ctx: Contexto, turnos: Turno[], hs: HerramientaNeutral[]): number {
  return 2.5 * peorCasoDeLlamada(JSON.stringify(cuerpoBrazoA(ctx.familia, ctx.modelo, turnos, hs, ctx.muestreo)), ctx.precio);
}
async function conReserva<T>(ctx: Contexto, monto: number, f: () => Promise<T>): Promise<T> {
  if (!ctx.presupuesto.reservar(monto)) throw new PresupuestoAgotado(ctx.modelo, ctx.presupuesto.gastado, ctx.presupuesto.tope);
  try {
    return await f();
  } finally {
    ctx.presupuesto.liberar(monto);
  }
}

async function unidadMultiTurno(ctx: Contexto, e: EntradaMultiTurno): Promise<RegistroMultiTurno> {
  const hs = e.funciones.map((f) => herramientaDe(f));
  const usuario: Turno = { role: "user", content: e.turnos[0]?.map((q) => q.content).join("\n") ?? "" };
  const reg0: LlamadaDelCable[] = [];
  const [a0, b0] = await conReserva(ctx, peorPaso(ctx, [usuario], hs), async () => {
    const a = await correrA(ctx, `${e.id}#paso0`, [usuario], hs, reg0);
    const b = await correrB(ctx, `${e.id}#paso0`, [usuario], hs, reg0);
    return [a, b] as const;
  });
  volcar(ctx, reg0);
  const primeraB = reg0.find((c) => c.brazo === "B");
  const herramientasEn = (p: Record<string, unknown> | null | undefined) => ((p?.["tools"] as unknown[]) ?? []).length;
  const registro: RegistroMultiTurno = {
    id: e.id,
    clases: e.clases,
    herramientas: hs.length,
    paso0: {
      A: { llamadas: a0.llamadas, coste: sumaDelCable(reg0, "A").coste, herramientasEnCable: herramientasEn(a0.cuerpo), ...(a0.error ? { error: a0.error } : {}) },
      B: {
        llamadas: b0.ok ? (b0.r.toolCalls ?? []) : [],
        coste: sumaDelCable(reg0, "B").coste,
        herramientasEnCable: herramientasEn(primeraB?.peticion),
        ...(b0.ok ? {} : { error: b0.error }),
        diferenciasDelCable: primeraB?.peticion ? diferenciasDelCable(a0.cuerpo, primeraB.peticion).diferencias : ["B made no provider call"],
      },
      referenciaTurno1: e.referencia[0] ?? [],
    },
    variantes: [],
    violaciones: [],
  };
  // Las variantes parten de UNA misma llamada para los dos brazos: la de A (o la de B si A no llamó).
  const base = a0.llamadas.length ? a0.llamadas : b0.ok ? (b0.r.toolCalls ?? []) : [];
  if (!base.length) {
    registro.omitido = "ningún brazo llamó a una herramienta en el paso 0: no hay turno de herramienta que variar";
    return registro;
  }
  const cambiadas = conArgumentoCambiado(base);
  const turnosDe = (llamadas: LlamadaHerramienta[], sufijo: string, isError: boolean): Turno[] => {
    const ls = idsNuevos(llamadas, ctx.familia, sufijo);
    return [
      usuario,
      { role: "assistant", content: "", llamadas: ls },
      ...ls.map((l): Turno => ({ role: "tool", id: l.id!, name: l.name, content: resultadoSintetico(l), ...(isError ? { isError: true } : {}) })),
    ];
  };
  const plan: [VarianteMultiTurno["variante"], Turno[]][] = [
    ["V1-base", turnosDe(base, "v1", false)],
    ["V2-isError", turnosDe(base, "v2", true)],
    ...(cambiadas ? [["V3-args", turnosDe(cambiadas, "v3", false)] as [VarianteMultiTurno["variante"], Turno[]]] : []),
    ["V4-repite-V1", turnosDe(base, "v4", false)],
    ["V5-repite-V2", turnosDe(base, "v5", true)],
  ];
  for (const [variante, turnos] of plan) {
    const reg: LlamadaDelCable[] = [];
    const unidad = `${e.id}#${variante}`;
    // Orden alterno: el prefijo caliente que deja el primero (caché automática de OpenAI) no favorece siempre al mismo brazo.
    const bPrimero = registro.variantes.length % 2 === 1;
    let a!: Awaited<ReturnType<typeof correrA>>;
    let bb!: Awaited<ReturnType<typeof correrB>>;
    try {
      await conReserva(ctx, peorPaso(ctx, turnos, hs), async () => {
        const b = bPrimero ? await correrB(ctx, unidad, turnos, hs, reg) : null;
        a = await correrA(ctx, unidad, turnos, hs, reg);
        bb = b ?? (await correrB(ctx, unidad, turnos, hs, reg));
      });
    } catch (err) {
      volcar(ctx, reg);
      if (err instanceof PresupuestoAgotado) {
        registro.omitido = `presupuesto agotado antes de ${variante} (${registro.variantes.length} variantes hechas)`;
        registro.violaciones = violacionesDeCache(registro.variantes);
        throw Object.assign(err, { parcial: registro });
      }
      throw err;
    }
    volcar(ctx, reg);
    const primeraBv = reg.find((c) => c.brazo === "B");
    registro.variantes.push({
      variante,
      costeA: sumaDelCable(reg, "A").coste,
      costeB: sumaDelCable(reg, "B").coste,
      cacheB: bb.ok ? bb.r.report.cache.result : "error",
      llamadasAlProveedorB: sumaDelCable(reg, "B").llamadasAlProveedor,
      textoB: bb.ok ? bb.r.text : "",
      llamadasB: bb.ok ? (bb.r.toolCalls?.length ?? 0) : 0,
      textoA: a.texto,
      basisB: bb.ok ? String(bb.r.report.cost.basis) : "error",
      ...(bb.ok ? { trazasB: resumenDelInforme(bb.r).trazas } : { error: bb.error }),
      ...(a.ok ? {} : { errorA: a.error }),
      diferenciasDelCableB: primeraBv?.peticion ? diferenciasDelCable(a.cuerpo, primeraBv.peticion).diferencias : ["B made no provider call"],
    });
  }
  registro.violaciones = violacionesDeCache(registro.variantes);
  return registro;
}

/**
 * Las reglas del aislamiento (#368): una respuesta cacheada nunca cruza un
 * `isError` distinto ni unos argumentos distintos. Una repetición exacta SÍ
 * puede servirse de caché, pero entonces con el texto de SU original.
 */
export function violacionesDeCache(vs: VarianteMultiTurno[]): string[] {
  const v = (n: VarianteMultiTurno["variante"]) => vs.find((x) => x.variante === n);
  const out: string[] = [];
  const golpe = (x: VarianteMultiTurno | undefined) => !!x && x.cacheB !== "miss" && x.cacheB !== "error";
  const v1 = v("V1-base");
  const v2 = v("V2-isError");
  const v3 = v("V3-args");
  const v4 = v("V4-repite-V1");
  const v5 = v("V5-repite-V2");
  if (golpe(v2)) out.push(`V2 (isError:true) served from cache (${v2!.cacheB}) after V1 with the same content and isError:false`);
  if (golpe(v3)) out.push(`V3 (different arguments) served from cache (${v3!.cacheB})`);
  if (golpe(v4) && v1 && v4!.textoB !== v1.textoB) out.push(`V4 (repeat of V1) served from cache with a text different from V1's`);
  if (golpe(v5) && v2 && v5!.textoB !== v2.textoB) out.push(`V5 (repeat of V2) served from cache with a text different from V2's`);
  if (golpe(v5) && v1 && v2 && v1.textoB !== v2.textoB && v5!.textoB === v1.textoB) out.push(`V5 (isError:true) got V1's (isError:false) answer`);
  return out;
}

async function correrModelo(
  modelo: string,
  entradas: { ast: EntradaAst[]; repes: EntradaAst[]; multi: EntradaMultiTurno[] },
  op: { mock: boolean; cargado: SdkCargado; tope: number; semaforos: Record<Proveedor, Semaforo>; respuestas: Map<string, RespuestaSimulada>; concurrencia: number; diario: string },
): Promise<TiradaDeModelo> {
  const familia = familiaDe(modelo);
  const proveedor = proveedorDe(modelo);
  const catalogo = precioYPrima(modelo);
  const citado = PRECIOS_CITADOS[modelo.slice(modelo.lastIndexOf("/") + 1)];
  if (!catalogo.conocido && !citado) throw new Error(`${modelo}: sin fila propia en el catálogo ni precio oficial citado; no se mide`);
  const pp = catalogo.conocido ? catalogo : { precio: citado!.precio, prima: citado!.prima, conocido: true, fuente: citado!.fuente };
  const presupuesto = new Presupuesto(modelo, op.tope);
  const env = process.env;
  const ep: Endpoint = op.mock
    ? { familia, baseUrl: familia === "anthropic" ? "https://mock.invalid/v1" : `https://mock-${proveedor}.invalid/v1`, apiKey: "mock" }
    : proveedor === "anthropic"
      ? { familia, baseUrl: normalizarBase(env["BVSALA_DEMO_ANTHROPIC_BASE_URL"] ?? ""), apiKey: env["BVSALA_DEMO_ANTHROPIC_API_KEY"] ?? "" }
      : proveedor === "google"
        ? { familia, baseUrl: normalizarBase(env["BVSALA_SONDA_BASE_URL"] ?? ""), apiKey: env["BVSALA_SONDA_API_KEY"] ?? "" }
        : { familia, baseUrl: normalizarBase(env["BVSALA_DEMO_BASE_URL"] ?? ""), apiKey: env["BVSALA_DEMO_API_KEY"] ?? "" };
  if (!op.mock && !ep.apiKey) throw new Error(`${modelo}: falta la clave de ${proveedor} en el entorno (se comprueba por existencia)`);
  if (!op.mock && new URL(ep.baseUrl).host !== HOSTS_OFICIALES[proveedor]) throw new Error(`${modelo}: el endpoint no es el API oficial de ${proveedor}`);
  const cable = crearCable({
    familia,
    presupuesto,
    precio: pp.precio,
    prima: pp.prima,
    semaforo: op.semaforos[proveedor],
    ...(op.mock ? { base: fetchSimulado(op.respuestas), pausasMs: [1] } : {}),
  });
  const { sdk } = op.cargado;
  const provider =
    familia === "anthropic"
      ? new sdk.AnthropicProvider({ apiKey: ep.apiKey, baseUrl: ep.baseUrl, fetchImpl: cable, ...(op.mock ? { stripProviderPrefix: true } : {}) })
      : new sdk.OpenAICompatibleProvider({
          apiKey: ep.apiKey,
          baseUrl: ep.baseUrl,
          fetchImpl: cable,
          // Gemini por su endpoint compatible: el id va sin `google/` (el adaptador solo lo quita solo en api.openai.com).
          ...(op.mock || proveedor === "google" ? { stripProviderPrefix: true } : {}),
        });
  // Configuración por defecto: SOLO el proveedor. Sin licenseServerUrl, sin serviceAccountKey, sin
  // exportadores: nada de metering ni telemetría (y la verja de hosts lo comprueba).
  const capa = sdk.createSavingsLayer({ provider, devUnlicensed: true });
  const muestreo = muestreoPareadoPara(modelo) as Muestreo;
  const ctx: Contexto = { modelo, familia, ep, cable, capa, muestreo, presupuesto, diario: op.diario, precio: pp.precio };
  const tirada: TiradaDeModelo = {
    modelo,
    familia,
    proveedor,
    muestreo,
    precio: {
      ...pp.precio,
      primaEscritura: pp.prima,
      ...("clave" in pp && pp.clave ? { claveCatalogo: pp.clave } : {}),
      ...("fuente" in pp ? { fuente: pp.fuente } : {}),
    },
    tope: op.tope,
    gastado: 0,
    gastoPorBrazo: { A: 0, B: 0 },
    llamadasPorBrazo: { A: 0, B: 0 },
    abortadoPorPresupuesto: false,
    ast: [],
    repeticiones: [],
    multiTurno: [],
    avisosDeLaCapa: [],
    errores: [],
  };
  // Peor caso de una unidad AST: el cuerpo REAL del brazo A, dos brazos y media llamada de margen.
  const peorAst = (e: EntradaAst) =>
    peorPaso(ctx, e.pregunta.map((q) => ({ role: "user", content: q.content })), e.funciones.map((f) => herramientaDe(f)));

  const trabajar = async <T>(xs: T[], reserva: (x: T) => number, f: (x: T, i: number) => Promise<void>) => {
    let i = 0;
    const hilo = async () => {
      for (;;) {
        if (presupuesto.agotado) return;
        const k = i++;
        if (k >= xs.length) return;
        const monto = reserva(xs[k]!);
        // Si no cabe porque OTRAS unidades retienen su reserva, se espera a que acaben;
        // solo se para cuando ni con todo liberado cabe.
        let r = presupuesto.intentarReservar(monto);
        while (r === "esperar") {
          await new Promise((ok) => setTimeout(ok, 250));
          r = presupuesto.intentarReservar(monto);
        }
        if (r === "no") return;
        try {
          await f(xs[k]!, k);
        } catch (e) {
          if (e instanceof PresupuestoAgotado) {
            presupuesto.agotado = true;
            return;
          }
          tirada.errores.push(sinSecretos(`${(e as Error).name}: ${(e as Error).message}`).slice(0, 400));
        } finally {
          presupuesto.liberar(monto);
        }
      }
    };
    await Promise.all(Array.from({ length: op.concurrencia }, hilo));
  };

  // 1) Multi-turn primero (es lo que comprueba #368 y la parte más cara por entrada), en serie.
  // La reserva va POR PASO (paso 0 y cada variante), no por entrada: una entrada entera
  // (12 llamadas a 4096 de salida) no cabe en 1,25 $ en los modelos caros aunque su gasto real sí.
  for (const e of entradas.multi) {
    if (presupuesto.agotado) break;
    try {
      tirada.multiTurno.push(await unidadMultiTurno(ctx, e));
    } catch (err) {
      if (err instanceof PresupuestoAgotado) {
        const parcial = (err as PresupuestoAgotado & { parcial?: RegistroMultiTurno }).parcial;
        if (parcial) tirada.multiTurno.push(parcial);
        presupuesto.agotado = true;
        break;
      }
      tirada.errores.push(sinSecretos(`${(err as Error).name}: ${(err as Error).message}`).slice(0, 400));
    }
  }
  // 2) AST, en dos tramos: hasta la última entrada que se repite, luego las repeticiones (3) y
  // después el resto. Así un recorte por presupuesto cae en la COLA del AST (que sigue
  // estratificada: turno rotatorio) y no se come las repeticiones, que necesitan que la capa
  // haya visto antes su entrada.
  const ultima = Math.max(-1, ...entradas.repes.map((r) => entradas.ast.findIndex((e) => e.id === r.id)));
  await trabajar(entradas.ast.slice(0, ultima + 1), peorAst, async (e, k) => {
    tirada.ast.push(await unidadAst(ctx, e, k));
  });
  // 3) Repeticiones deliberadas de AST (la capa ya vio esas preguntas).
  await trabajar(entradas.repes, peorAst, async (e) => {
    tirada.repeticiones.push(await unidadRepeticion(ctx, e));
  });
  // 2b) El resto del AST.
  await trabajar(entradas.ast.slice(ultima + 1), peorAst, async (e, k) => {
    tirada.ast.push(await unidadAst(ctx, e, ultima + 1 + k));
  });

  tirada.gastado = presupuesto.gastado;
  tirada.gastoPorBrazo = { ...presupuesto.porBrazo };
  tirada.llamadasPorBrazo = { ...presupuesto.llamadas };
  tirada.abortadoPorPresupuesto = presupuesto.agotado;
  tirada.salidaMaximaPorLlamada = maximaSalida(op.diario, modelo);
  const orden = new Map(entradas.ast.map((e, i) => [e.id, i]));
  tirada.ast.sort((x, y) => (orden.get(x.id) ?? 0) - (orden.get(y.id) ?? 0));
  return tirada;
}

// ── Principal ─────────────────────────────────────────────────────────────

/**
 * GET /v1/models con la clave de Anthropic: no factura. Devuelve el motivo para no
 * medir (401 → «clave inválida») o null si la clave responde. La clave solo viaja en
 * la cabecera; en el motivo solo va el estado HTTP.
 */
async function probarClaveAnthropic(): Promise<string | null> {
  const apiKey = process.env["BVSALA_DEMO_ANTHROPIC_API_KEY"] ?? "";
  if (!apiKey) return "not measurable: no Anthropic key in the environment (checked by existence)";
  const base = normalizarBase(process.env["BVSALA_DEMO_ANTHROPIC_BASE_URL"] ?? "https://api.anthropic.com");
  try {
    const r = await fetch(`${base}/models`, { headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } });
    if (r.status === 401 || r.status === 403) return `not measurable: invalid key (free check GET /v1/models → HTTP ${r.status})`;
    if (!r.ok) return `not measurable: free key check GET /v1/models → HTTP ${r.status}`;
    return null;
  } catch (e) {
    return sinSecretos(`not measurable: free key check failed (${(e as Error).message})`).slice(0, 200);
  }
}

/** Lo que se publica de la tirada anterior para compararla: su resumen y el recorte del multi-turno. */
function comparacionCon(fichero: string, raiz: string): Artefacto["comparacion"] {
  const p = JSON.parse(readFileSync(fichero, "utf8")) as Artefacto;
  const medidos = p.modelos.filter((t) => t.ast.some((r) => r.A.ok) || t.multiTurno.some((m) => !m.paso0.A.error));
  return {
    fichero: fichero.startsWith(raiz) ? fichero.slice(raiz.length + 1) : fichero,
    version: p.paquete.version,
    tag: p.paquete.tag,
    commitDelTag: p.paquete.commitDelTag,
    fecha: p.fecha,
    config: p.config,
    resumen: medidos.map(resumir),
    multiTurno: Object.fromEntries(
      medidos.map((t) => [t.modelo, t.multiTurno.map((m) => ({ id: m.id, herramientasEnCable: { A: m.paso0.A.herramientasEnCable, B: m.paso0.B.herramientasEnCable } }))]),
    ),
  };
}

async function principal(): Promise<void> {
  const mock = arg("mock") !== undefined;
  const fusionar = arg("fusionar");
  if (fusionar) {
    // Une artefactos de tiradas de la MISMA batería (mismo dataset y paquete), p. ej. una por proveedor.
    const partes = fusionar.split(",").map((r) => JSON.parse(readFileSync(resolve(RAIZ, r), "utf8")) as Artefacto);
    const base = partes[0]!;
    for (const p of partes) {
      if (p.dataset.commit !== base.dataset.commit || p.paquete.commitDelTag !== base.paquete.commitDelTag || p.modo !== base.modo) {
        throw new Error("--fusionar: artifacts from different datasets, packages or modes");
      }
    }
    const modelos = partes.flatMap((p) => p.modelos);
    const unido: Artefacto = {
      ...base,
      noMedibles: partes.flatMap((p) => p.noMedibles ?? []),
      paquete: {
        ...base.paquete,
        hostsVistos: [...new Set(partes.flatMap((p) => p.paquete.hostsVistos))].sort(),
        hostsRechazados: [...new Set(partes.flatMap((p) => p.paquete.hostsRechazados))].sort(),
      },
      modelos,
      resumen: modelos.map(resumir),
      partes: partes.map((p) => ({ fecha: p.fecha, config: p.config, modelos: p.modelos.map((t) => t.modelo) })),
    };
    const dir = resolve(RAIZ, arg("salida") ?? "docs/benchmarks/2026-09-28");
    const nombreF = arg("nombre") ?? NOMBRE_POR_DEFECTO;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${nombreF}.json`), `${JSON.stringify(unido, null, 2)}\n`);
    writeFileSync(join(dir, `${nombreF}.md`), escribirInforme(unido));
    console.log(`→ ${join(dir, `${nombreF}.json`)} y .md (${partes.length} tiradas unidas)`);
    return;
  }
  const soloPreparar = arg("preparar") !== undefined;
  if (soloPreparar) {
    await prepararDataset({ descargar: true });
    console.log(`BFCL ${COMMIT_BFCL.slice(0, 12)}: dataset descargado y verificado en ${DIR_CACHE}`);
    return;
  }
  // ANTES de gastar: el fuente cargado es el del tag (si no, aborta).
  const cargado = await cargarSdk();
  const paquete = cargado.procedencia;
  const modelos = (arg("modelos") ?? MODELOS_POR_DEFECTO.join(",")).split(",").map((s) => s.trim()).filter(Boolean);
  const n = Number(arg("n") ?? 25);
  const multi = Number(arg("multi") ?? 4);
  const repes = Number(arg("repes") ?? 5);
  const tope = Number(arg("tope") ?? Math.max(...Object.values(TOPE_MAXIMO)));
  const topeDe = (m: string) => Math.min(tope, techoDe(m));
  // EL TOPE ES POR MODELO Y ENTRE TODAS LAS TIRADAS DE ESTA BATERÍA: cada llamada LIVE queda en una
  // bitácora del cable (.cache/cable-live-*.jsonl), y su coste se descuenta del tope antes de empezar.
  // Así un piloto, una tirada abortada o una repetición nunca suman más de lo autorizado.
  const previo = new Map<string, number>();
  mkdirSync(join(AQUI, ".cache"), { recursive: true });
  if (!mock) {
    for (const f of readdirSync(join(AQUI, ".cache")).filter((x) => /^cable-live-.*\.jsonl$/.test(x))) {
      for (const linea of readFileSync(join(AQUI, ".cache", f), "utf8").split("\n")) {
        if (!linea.trim()) continue;
        const c = JSON.parse(linea) as { modelo: string; coste: number };
        previo.set(c.modelo, (previo.get(c.modelo) ?? 0) + c.coste);
      }
    }
  }
  const semilla = Number(arg("semilla") ?? 20260928);
  const concurrencia = Math.min(4, Math.max(1, Number(arg("concurrencia") ?? 3)));
  const salida = resolve(RAIZ, arg("salida") ?? (mock ? join(AQUI, ".cache", "mock") : "docs/benchmarks/2026-09-28"));
  const nombre = arg("nombre") ?? NOMBRE_POR_DEFECTO;
  if (!(tope > 0)) throw new Error("--tope debe ser > 0 (y nunca sube del techo por familia, TOPE_MAXIMO)");

  const porCategoria = new Map<CategoriaAst, EntradaAst[]>();
  for (const c of CATEGORIAS_AST) porCategoria.set(c, await cargarCategoria(c, { descargar: !mock }));
  const ast = muestraEstratificada(porCategoria, n, semilla);
  const repesE = ast.filter((e) => e.categoria === "simple").slice(0, repes);
  const multiE = barajar(await cargarMultiTurno({ descargar: !mock }), semilla ^ hash32("multi_turn_base")).slice(0, multi);

  const respuestas = new Map<string, RespuestaSimulada>();
  if (mock) for (const e of ast) respuestas.set(claveSimulada(e.pregunta.map((q) => q.content).join(""), e.funciones.map((f) => herramientaDe(f).nombre)), respuestaDeReferencia(e.respuesta as never));

  // LA VERJA DE HOSTS, antes de crear ningún proveedor: solo los hosts de los proveedores.
  // Solo los hosts de los proveedores de los modelos pedidos; y solo si son los API oficiales.
  const variableDeBase: Record<Proveedor, string> = { anthropic: "BVSALA_DEMO_ANTHROPIC_BASE_URL", openai: "BVSALA_DEMO_BASE_URL", google: "BVSALA_SONDA_BASE_URL" };
  const hostsPermitidos = mock
    ? []
    : [...new Set(modelos.map((m) => new URL(normalizarBase(process.env[variableDeBase[proveedorDe(m)]] ?? "")).host))];
  for (const h of hostsPermitidos) {
    if (!Object.values(HOSTS_OFICIALES).includes(h)) throw new Error(`endpoint ${h} is not a provider's own API host: the run only talks to ${Object.values(HOSTS_OFICIALES).join(", ")}`);
  }
  const verja = instalarVerjaDeHosts(hostsPermitidos);

  // LA PRUEBA GRATUITA DE LA CLAVE DE ANTHROPIC (GET /v1/models, no factura): un 401 = «no medible», sin gastar.
  const noMedibles: { modelo: string; motivo: string }[] = [];
  if (!mock && modelos.some((m) => familiaDe(m) === "anthropic")) {
    const motivo = await probarClaveAnthropic();
    if (motivo) {
      for (const m of modelos.filter((x) => familiaDe(x) === "anthropic")) noMedibles.push({ modelo: m, motivo });
      console.log(`  anthropic: ${motivo} — no se mide y no se gasta`);
    }
  }
  const aMedir = modelos.filter((m) => !noMedibles.some((x) => x.modelo === m));

  const avisos: string[] = [];
  const warnOriginal = console.warn;
  console.warn = (...xs: unknown[]) => {
    avisos.push(sinSecretos(xs.map(String).join(" ")).slice(0, 600));
  };
  const semaforos: Record<Proveedor, Semaforo> = { anthropic: new Semaforo(concurrencia), openai: new Semaforo(concurrencia), google: new Semaforo(concurrencia) };
  const diario = join(AQUI, ".cache", `cable-${mock ? "mock" : "live"}-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`);
  console.log(
    `BFCL A/B · ${mock ? "MOCK (proveedor simulado, sin red)" : "LIVE"} · dataset ${REPO_BFCL}@${COMMIT_BFCL.slice(0, 12)} (${LICENCIA_BFCL}) · ` +
      `${ast.length} AST (${n}/categoría) + ${repesE.length} repeticiones + ${multiE.length} multi-turn · tope ${aMedir.map((m) => `${m} ${topeDe(m)} $`).join(", ")}`,
  );
  // Los modelos de proveedores distintos corren en paralelo; los del mismo, en serie (comparten clave y semáforo).
  const porFamilia = new Map<Proveedor, string[]>();
  for (const m of aMedir) porFamilia.set(proveedorDe(m), [...(porFamilia.get(proveedorDe(m)) ?? []), m]);
  const tiradas: TiradaDeModelo[] = [];
  await Promise.all(
    [...porFamilia.values()].map(async (ms) => {
      for (const m of ms) {
        const inicio = avisos.length;
        let t: TiradaDeModelo;
        try {
          t = await correrModelo(m, { ast, repes: repesE, multi: multiE }, { mock, cargado, tope: Math.max(0, topeDe(m) - (previo.get(m) ?? 0)), semaforos, respuestas, concurrencia, diario });
        } catch (e) {
          noMedibles.push({ modelo: m, motivo: sinSecretos((e as Error).message).slice(0, 300) });
          console.log(`  ${m}: ${(e as Error).message}`);
          continue;
        }
        t.avisosDeLaCapa = [...new Set(avisos.slice(inicio))];
        tiradas.push(t);
        console.log(
          `  ${m}: ${t.ast.length} AST, ${t.multiTurno.length} multi-turn, gasto ${t.gastado.toFixed(4)} $ (A ${t.gastoPorBrazo.A.toFixed(4)} · B ${t.gastoPorBrazo.B.toFixed(4)})` +
            `${t.abortadoPorPresupuesto ? " · PARADO POR PRESUPUESTO" : ""}${t.errores.length ? ` · ${t.errores.length} errores` : ""}`,
        );
      }
    }),
  );
  console.warn = warnOriginal;
  verja.retirar();
  paquete.hostsVistos = [...verja.vistos].sort();
  paquete.hostsRechazados = [...verja.rechazados].sort();
  console.log(`  hosts contacted: ${paquete.hostsVistos.join(", ") || "(none)"} · refused: ${paquete.hostsRechazados.join(", ") || "(none)"}`);
  tiradas.sort((x, y) => modelos.indexOf(x.modelo) - modelos.indexOf(y.modelo));
  const artefacto: Artefacto = {
    bateria: "BFCL",
    fecha: new Date().toISOString(),
    modo: mock ? "MOCK" : "LIVE",
    dataset: {
      repo: REPO_BFCL,
      commit: COMMIT_BFCL,
      licencia: LICENCIA_BFCL,
      categorias: [...CATEGORIAS_AST, "multi_turn_base"],
      tamanoPorCategoria: Object.fromEntries([...porCategoria.entries()].map(([k, v]) => [k, v.length])),
    },
    paquete,
    config: { n, multi, repes, tope, semilla, concurrencia, gastoPrevioDescontado: Object.fromEntries(previo) },
    modelos: tiradas,
    ...(noMedibles.length ? { noMedibles } : {}),
  };
  artefacto.resumen = tiradas.map(resumir);
  const comparar = arg("comparar") ?? (mock ? undefined : "docs/benchmarks/2026-09-28/bfcl.json");
  if (comparar && comparar !== "no") artefacto.comparacion = comparacionCon(resolve(RAIZ, comparar), RAIZ);
  mkdirSync(salida, { recursive: true });
  const json = JSON.stringify(artefacto, null, 2);
  // Ninguna clave puede acabar en el artefacto: se compara contra los VALORES del entorno sin imprimirlos.
  const claves = ["BVSALA_DEMO_ANTHROPIC_API_KEY", "BVSALA_DEMO_API_KEY", "BVSALA_SONDA_API_KEY"].map((k) => process.env[k]).filter((v): v is string => !!v && v.length > 8);
  if (claves.some((k) => json.includes(k)) || /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/.test(json) || /\bAIza[0-9A-Za-z_-]{30,}/.test(json)) {
    throw new Error("the artifact contains a credential-shaped string: not written");
  }
  writeFileSync(join(salida, `${nombre}.json`), `${json}\n`);
  writeFileSync(join(salida, `${nombre}.md`), escribirInforme(artefacto));
  console.log(`→ ${join(salida, `${nombre}.json`)} y .md · cable (sin cabeceras) en ${diario}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  principal().catch((e: unknown) => {
    console.error(sinSecretos(e instanceof Error ? `${e.name}: ${e.message}` : String(e)));
    process.exit(1);
  });
}
