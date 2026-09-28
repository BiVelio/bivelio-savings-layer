/**
 * MT-Bench A/B — el núcleo PURO de la batería (sin red, sin disco, sin claves).
 * ---------------------------------------------------------------------------
 * Todo lo que decide una cifra vive aquí para que `test/mt-bench-publicado.test.ts`
 * lo pueda fijar sin gastar un céntimo: qué ficheros del dataset se aceptan
 * (commit + sha256), en qué orden se recorren las preguntas (subconjunto
 * estratificado con semilla), cuánto cuesta una llamada a partir del `usage`
 * del proveedor, cuánto se puede gastar como mucho (el tope duro) y cómo se lee
 * un veredicto del juez de pares con las posiciones intercambiadas.
 *
 * La red, la capa y los informes están en `mt-bench.ts`.
 */
import { mulberry32 } from "../../stats.js";

// ── El dataset, fijado ──────────────────────────────────────────────────────

/**
 * FastChat (lm-sys), `fastchat/llm_judge/data`. Licencia del repositorio:
 * Apache-2.0 (https://github.com/lm-sys/FastChat/blob/main/LICENSE). Aunque la
 * licencia permitiría redistribuirlo, el repo NO lo versiona: se descarga en
 * tiempo de ejecución y se acepta solo si su sha256 coincide con el de aquí.
 * Un fichero distinto en ese commit sería otro benchmark, y se aborta.
 */
export const DATASET = {
  repo: "lm-sys/FastChat",
  commit: "587d5cfa1609a43d192cedb8441cac3c17db105d",
  commitDate: "2025-06-02T15:22:03Z",
  license: "Apache-2.0",
  licenseUrl: "https://github.com/lm-sys/FastChat/blob/587d5cfa1609a43d192cedb8441cac3c17db105d/LICENSE",
  ficheros: {
    preguntas: {
      path: "fastchat/llm_judge/data/mt_bench/question.jsonl",
      sha256: "119565adbab82227089cefdb44c8d7e2cf04dc0a0ec233634c82e7d4e2a944f7",
    },
    referencias: {
      path: "fastchat/llm_judge/data/mt_bench/reference_answer/gpt-4.jsonl",
      sha256: "f957a5bc977badb66885ec970e6cd08527845780313f0995764260e5777b9b3f",
    },
    promptsDelJuez: {
      path: "fastchat/llm_judge/data/judge_prompts.jsonl",
      sha256: "fd283293406d024f44c174b094ef48031d0687a4682fd3a56b29b138f80281b6",
    },
  },
} as const;

export type NombreDeFichero = keyof typeof DATASET.ficheros;

export function urlDeFichero(nombre: NombreDeFichero): string {
  return `https://raw.githubusercontent.com/${DATASET.repo}/${DATASET.commit}/${DATASET.ficheros[nombre].path}`;
}

/** Las 8 categorías de MT-Bench, en el orden en que FastChat las lista. */
export const CATEGORIAS = [
  "writing",
  "roleplay",
  "reasoning",
  "math",
  "coding",
  "extraction",
  "stem",
  "humanities",
] as const;
export type Categoria = (typeof CATEGORIAS)[number];

/** `NEED_REF_CATS` de fastchat/llm_judge/common.py: el juez ve la respuesta de referencia. */
export const CATEGORIAS_CON_REFERENCIA: readonly Categoria[] = ["math", "reasoning", "coding"];

/**
 * `temperature_config` de fastchat/llm_judge/common.py. Los DOS brazos usan la
 * misma temperatura por categoría (misma tarea, mismo muestreo).
 */
export const TEMPERATURA_FASTCHAT: Record<Categoria, number> = {
  writing: 0.7,
  roleplay: 0.7,
  extraction: 0.0,
  math: 0.0,
  coding: 0.0,
  reasoning: 0.0,
  stem: 0.1,
  humanities: 0.1,
};

export interface Pregunta {
  id: number;
  categoria: Categoria;
  turnos: [string, string];
}

export interface Referencia {
  id: number;
  turnos: [string, string];
}

export interface PromptDelJuez {
  name: string;
  type: string;
  system_prompt: string;
  prompt_template: string;
  output_format: string;
}

function lineas(texto: string): unknown[] {
  return texto
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as unknown);
}

export function parsearPreguntas(texto: string): Pregunta[] {
  return lineas(texto).map((o) => {
    const q = o as { question_id: number; category: string; turns: string[] };
    if (!(CATEGORIAS as readonly string[]).includes(q.category)) {
      throw new Error(`MT-Bench: categoría desconocida «${q.category}» en la pregunta ${q.question_id}`);
    }
    if (!Array.isArray(q.turns) || q.turns.length !== 2) {
      throw new Error(`MT-Bench: la pregunta ${q.question_id} no tiene exactamente 2 turnos`);
    }
    return { id: q.question_id, categoria: q.category as Categoria, turnos: [q.turns[0]!, q.turns[1]!] };
  });
}

export function parsearReferencias(texto: string): Map<number, Referencia> {
  const m = new Map<number, Referencia>();
  for (const o of lineas(texto)) {
    const r = o as { question_id: number; choices: { turns: string[] }[] };
    const t = r.choices?.[0]?.turns;
    if (!t || t.length < 2) continue;
    m.set(r.question_id, { id: r.question_id, turnos: [t[0]!, t[1]!] });
  }
  return m;
}

export function parsearPromptsDelJuez(texto: string): Map<string, PromptDelJuez> {
  const m = new Map<string, PromptDelJuez>();
  for (const o of lineas(texto)) {
    const p = o as PromptDelJuez;
    m.set(p.name, p);
  }
  return m;
}

// ── El subconjunto estratificado ────────────────────────────────────────────

export const SEMILLA_DE_MUESTRA = 20260928;

/**
 * El ORDEN en que se recorren las preguntas: barajadas con semilla dentro de su
 * categoría y luego intercaladas por rondas (una de cada categoría por ronda).
 * Cualquier PREFIJO de este orden es un subconjunto estratificado: ninguna
 * categoría lleva más de una pregunta de ventaja a otra. Así, si el presupuesto
 * corta a mitad, lo que queda medido sigue equilibrado por categoría, y el corte
 * es reproducible (misma semilla → mismas preguntas).
 */
export function ordenEstratificado(preguntas: Pregunta[], semilla = SEMILLA_DE_MUESTRA): Pregunta[] {
  const rng = mulberry32(semilla);
  const porCategoria = CATEGORIAS.map((c) => {
    const grupo = preguntas.filter((p) => p.categoria === c).sort((a, b) => a.id - b.id);
    for (let i = grupo.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [grupo[i], grupo[j]] = [grupo[j]!, grupo[i]!];
    }
    return grupo;
  });
  const salida: Pregunta[] = [];
  const max = Math.max(0, ...porCategoria.map((g) => g.length));
  for (let ronda = 0; ronda < max; ronda++) {
    for (const g of porCategoria) if (g[ronda]) salida.push(g[ronda]!);
  }
  return salida;
}

// ── Coste a partir del usage del proveedor ──────────────────────────────────

export interface Precio {
  inputPer1k: number;
  outputPer1k: number;
  cachedInputPer1k?: number;
}

/**
 * El usage de una llamada, repartido por lo que se factura distinto. Sale SIEMPRE
 * del cuerpo de la respuesta del proveedor, con el mismo lector para los dos
 * brazos: nunca del informe de la capa.
 */
export interface UsoMedido {
  /** Entrada sin caché (ni leída ni escrita). */
  entrada: number;
  /** Entrada leída de la caché de prefijo del proveedor. */
  cacheLeida: number;
  /** Entrada escrita en la caché (Anthropic la cobra con prima). */
  cacheEscrita: number;
  /** Salida facturada (incluye razonamiento en OpenAI). */
  salida: number;
  /** Tokens de razonamiento (ya dentro de `salida`), cuando el proveedor los desglosa. */
  razonamiento: number;
}

export class SinUsage extends Error {}

function num(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? x : 0;
}

/** Messages API: `input_tokens` NO incluye lo leído/escrito en caché. */
export function usoDeAnthropic(cuerpo: unknown): UsoMedido {
  const u = (cuerpo as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || typeof u.input_tokens !== "number" || typeof u.output_tokens !== "number") {
    throw new SinUsage("respuesta de Anthropic sin usage: no se inventa un 0");
  }
  return {
    entrada: num(u.input_tokens),
    cacheLeida: num(u.cache_read_input_tokens),
    cacheEscrita: num(u.cache_creation_input_tokens),
    salida: num(u.output_tokens),
    razonamiento: 0,
  };
}

/** Chat Completions: `prompt_tokens` SÍ incluye `cached_tokens`. */
export function usoDeOpenAI(cuerpo: unknown): UsoMedido {
  const u = (cuerpo as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || typeof u.prompt_tokens !== "number" || typeof u.completion_tokens !== "number") {
    throw new SinUsage("respuesta de OpenAI sin usage: no se inventa un 0");
  }
  const det = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const detSalida = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  const cacheada = num(det.cached_tokens);
  return {
    entrada: num(u.prompt_tokens) - cacheada,
    cacheLeida: cacheada,
    cacheEscrita: 0,
    salida: num(u.completion_tokens),
    razonamiento: num(detSalida.reasoning_tokens),
  };
}

/** Prima de escritura de caché: 1,25× en Anthropic (5 min); OpenAI no la cobra en estos modelos. */
export function primaDeEscritura(familia: Familia): number {
  return familia === "anthropic" ? 1.25 : 1;
}

export function costeDeUso(precio: Precio, prima: number, u: UsoMedido): number {
  const leida = precio.cachedInputPer1k ?? precio.inputPer1k;
  return (
    (u.entrada / 1000) * precio.inputPer1k +
    (u.cacheLeida / 1000) * leida +
    (u.cacheEscrita / 1000) * precio.inputPer1k * prima +
    (u.salida / 1000) * precio.outputPer1k
  );
}

export function sumarUsos(us: UsoMedido[]): UsoMedido {
  const t: UsoMedido = { entrada: 0, cacheLeida: 0, cacheEscrita: 0, salida: 0, razonamiento: 0 };
  for (const u of us) {
    t.entrada += u.entrada;
    t.cacheLeida += u.cacheLeida;
    t.cacheEscrita += u.cacheEscrita;
    t.salida += u.salida;
    t.razonamiento += u.razonamiento;
  }
  return t;
}

// ── Los modelos ─────────────────────────────────────────────────────────────

export type Familia = "anthropic" | "openai";

export interface ModeloDeLaBateria {
  /** El id que se pide (y que manda el brazo A al API). */
  id: string;
  familia: Familia;
  /**
   * Tope de salida por llamada, IGUAL en los dos brazos. En Anthropic es
   * `max_tokens` (obligatorio en ese API; a la capa se le pasa como
   * `defaultMaxOutputTokens` de su adaptador). En OpenAI la capa 0.4.30 no
   * tiene forma de fijar un tope de salida en una petición de texto libre (solo
   * con un contrato `response`), así que el TRANSPORTE del banco añade
   * `max_completion_tokens` a las dos ramas por igual: es el techo de gasto, no
   * una palanca, y el diff del cable lo excluye y lo declara.
   */
  maxSalida: number;
  /** false → no se manda `temperature` en ningún brazo (modelos de razonamiento que la rechazan). */
  temperatura: boolean;
}

/**
 * FastChat genera con `max_tokens=1024`. gpt-5.4-mini razona y el razonamiento
 * cuenta dentro de `max_completion_tokens`: con 1024 muchas respuestas saldrían
 * vacías, así que lleva 4096 en ambos brazos. El techo se declara en el informe.
 */
export const MODELOS_POR_DEFECTO: ModeloDeLaBateria[] = [
  { id: "claude-haiku-4-5", familia: "anthropic", maxSalida: 1024, temperatura: true },
  { id: "claude-sonnet-5", familia: "anthropic", maxSalida: 1024, temperatura: true },
  { id: "gpt-4o-mini", familia: "openai", maxSalida: 1024, temperatura: true },
  { id: "gpt-5.4-mini", familia: "openai", maxSalida: 4096, temperatura: false },
];

/** Id con prefijo de proveedor, como lo espera la capa (precio, claves de caché, informe). */
export function idCualificado(m: ModeloDeLaBateria): string {
  return `${m.familia}/${m.id}`;
}

// ── El presupuesto duro ─────────────────────────────────────────────────────

/** 5 $ por modelo entre 4 baterías → 1,25 $ por modelo (A+B) aquí; 1 $ para el juez. */
export const TOPE_POR_MODELO_USD = 1.25;
export const TOPE_DEL_JUEZ_USD = 1.0;

export class PresupuestoAgotado extends Error {
  constructor(
    readonly tope: string,
    mensaje: string,
  ) {
    super(mensaje);
  }
}

/**
 * Un tope que NO se puede cruzar. Cada llamada reserva antes de salir su coste
 * en el PEOR caso (entrada acotada por lo que se manda, salida al tope
 * declarado, toda la entrada a precio de escritura de caché) y, al volver,
 * cambia la reserva por el coste real medido. Si la reserva no cabe, la llamada
 * no se envía. Con concurrencia, las reservas en vuelo cuentan como gastadas.
 */
export class Tope {
  gastado = 0;
  private reservado = 0;
  /** Llamadas cuyo coste real superó su reserva (no debería pasar: es una anomalía). */
  excesos = 0;

  constructor(
    readonly nombre: string,
    readonly limiteUsd: number,
    /** Se llama con cada gasto real, en cuanto se conoce (para persistirlo aunque el proceso muera después). */
    private readonly alGastar?: (usd: number) => void,
  ) {}

  cabe(usd: number): boolean {
    return this.gastado + this.reservado + usd <= this.limiteUsd + 1e-12;
  }

  reservar(usd: number): number {
    if (!this.cabe(usd)) {
      throw new PresupuestoAgotado(
        this.nombre,
        `tope «${this.nombre}»: ${fmtUsd(this.gastado)} gastados + ${fmtUsd(this.reservado)} en vuelo + ` +
          `${fmtUsd(usd)} de esta llamada superarían ${fmtUsd(this.limiteUsd)}`,
      );
    }
    this.reservado += usd;
    return usd;
  }

  /** Cierra una reserva con el coste real (0 si la llamada no se cobró). */
  cerrar(reserva: number, real: number): void {
    this.reservado = Math.max(0, this.reservado - reserva);
    this.gastado += real;
    if (real > reserva + 1e-12) this.excesos++;
    if (real > 0) this.alGastar?.(real);
  }

  get enVuelo(): number {
    return this.reservado;
  }
}

/** Cota superior de tokens de un texto: ~4 caracteres por token en inglés; se usa 2 para ir sobrado. */
export function cotaDeTokens(texto: string): number {
  return Math.ceil(texto.length / 2) + 16;
}

/**
 * Peor coste de UNA llamada: entrada acotada por los caracteres enviados (más un
 * margen para lo que añada la capa), toda ella a precio de escritura de caché, y
 * la salida al tope declarado.
 */
export function peorCosteDeLlamada(
  precio: Precio,
  prima: number,
  caracteresDeEntrada: number,
  maxSalida: number,
  margenDeEntrada = 512,
): number {
  const entrada = Math.ceil(caracteresDeEntrada / 2) + 16 + margenDeEntrada;
  return (entrada / 1000) * precio.inputPer1k * Math.max(1, prima) + (maxSalida / 1000) * precio.outputPer1k;
}

/**
 * Peor coste de una pregunta entera (2 turnos × 2 brazos). El turno 2 lleva el
 * turno 1 y su respuesta, acotada por el tope de salida (≈ 4 caracteres por
 * token como máximo razonable → se cuentan 6 para ir sobrado).
 */
export function peorCosteDePregunta(precio: Precio, prima: number, p: Pregunta, maxSalida: number): number {
  const t1 = p.turnos[0].length;
  const t2 = t1 + maxSalida * 6 + p.turnos[1].length;
  return 2 * (peorCosteDeLlamada(precio, prima, t1, maxSalida) + peorCosteDeLlamada(precio, prima, t2, maxSalida));
}

// ── El juez de pares ────────────────────────────────────────────────────────

export type Ganador = "A" | "B" | "empate" | "error";

/**
 * Lectura del veredicto exactamente como `play_a_match_pair` de FastChat:
 * «[[A]]» gana A, si no «[[B]]» gana B, si no «[[C]]» empate; otra cosa, error.
 */
export function leerVeredicto(texto: string): Ganador {
  if (texto.includes("[[A]]")) return "A";
  if (texto.includes("[[B]]")) return "B";
  if (texto.includes("[[C]]")) return "empate";
  return "error";
}

/**
 * Las dos partidas con las posiciones intercambiadas, traducidas a BRAZOS:
 *   partida 1: Assistant A = brazo A (directo), Assistant B = brazo B (capa)
 *   partida 2: Assistant A = brazo B (capa),    Assistant B = brazo A (directo)
 * Si coinciden, ese brazo gana; si discrepan, empate («inconsistente», como
 * FastChat). Un error en cualquiera deja el turno fuera del recuento.
 */
export function combinarPartidas(
  partida1: Ganador,
  partida2: Ganador,
): { ganador: "A" | "B" | "empate" | "error"; inconsistente: boolean } {
  if (partida1 === "error" || partida2 === "error") return { ganador: "error", inconsistente: false };
  const g1 = partida1;
  const g2 = partida2 === "A" ? "B" : partida2 === "B" ? "A" : "empate";
  if (g1 === g2) return { ganador: g1, inconsistente: false };
  return { ganador: "empate", inconsistente: true };
}

/** Puntuación del brazo B (la capa) frente al A en un turno: 1 gana, 0,5 empate, 0 pierde. */
export function puntuacionDeB(g: "A" | "B" | "empate"): number {
  return g === "B" ? 1 : g === "A" ? 0 : 0.5;
}

function rellenar(plantilla: string, valores: Record<string, string>): string {
  return plantilla.replace(/\{(\w+)\}/g, (m, k: string) => (k in valores ? valores[k]! : m));
}

export interface ConversacionDeDosTurnos {
  preguntas: [string, string];
  respuestas: [string, string];
}

/**
 * El mensaje de usuario del juez para un turno, con el prompt de FastChat que
 * toca: `pair-v2` / `pair-v2-multi-turn`, o sus variantes `pair-math-v1*` con la
 * respuesta de referencia en math/reasoning/coding. `primero` va como
 * «Assistant A».
 */
export function promptDelJuez(
  prompts: Map<string, PromptDelJuez>,
  turno: 1 | 2,
  primero: ConversacionDeDosTurnos,
  segundo: ConversacionDeDosTurnos,
  referencia: Referencia | undefined,
): { nombre: string; system: string; user: string } {
  const conRef = referencia !== undefined;
  const nombre = conRef
    ? turno === 1
      ? "pair-math-v1"
      : "pair-math-v1-multi-turn"
    : turno === 1
      ? "pair-v2"
      : "pair-v2-multi-turn";
  const p = prompts.get(nombre);
  if (!p) throw new Error(`MT-Bench: falta el prompt del juez «${nombre}»`);
  const valores: Record<string, string> =
    turno === 1
      ? {
          question: primero.preguntas[0],
          answer_a: primero.respuestas[0],
          answer_b: segundo.respuestas[0],
          ...(conRef ? { ref_answer_1: referencia!.turnos[0] } : {}),
        }
      : {
          question_1: primero.preguntas[0],
          question_2: primero.preguntas[1],
          answer_a_1: primero.respuestas[0],
          answer_a_2: primero.respuestas[1],
          answer_b_1: segundo.respuestas[0],
          answer_b_2: segundo.respuestas[1],
          ...(conRef ? { ref_answer_1: referencia!.turnos[0], ref_answer_2: referencia!.turnos[1] } : {}),
        };
  return { nombre, system: p.system_prompt, user: rellenar(p.prompt_template, valores) };
}

// ── El cable: qué cambió la capa ─────────────────────────────────────────────

/** Campos que el banco añade por igual a los dos brazos y que no son de la capa. */
export const CAMPOS_DEL_BANCO = ["max_completion_tokens"] as const;

/**
 * Forma normal de un cuerpo de petición para compararlo con el otro brazo:
 * claves ordenadas, `content` de solo-texto sin marcas reducido a su string, y
 * sin los campos que pone el banco. Una marca `cache_control` NO se normaliza:
 * es precisamente algo que la capa añade y cuesta (o ahorra) dinero.
 */
export function normalizarCuerpo(cuerpo: unknown): unknown {
  const quitar = new Set<string>(CAMPOS_DEL_BANCO);
  const rec = (v: unknown, clave: string | null): unknown => {
    if (Array.isArray(v)) {
      if (
        clave === "content" &&
        v.every(
          (b) =>
            b && typeof b === "object" && (b as { type?: unknown }).type === "text" && Object.keys(b).length === 2,
        )
      ) {
        return v.map((b) => (b as { text: string }).text).join("");
      }
      return v.map((x) => rec(x, null));
    }
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      const salida: Record<string, unknown> = {};
      for (const k of Object.keys(o).sort()) {
        if (clave === null && quitar.has(k)) continue;
        salida[k] = rec(o[k], k);
      }
      return salida;
    }
    return v;
  };
  return rec(cuerpo, null);
}

/** Claves de primer nivel en las que difieren dos cuerpos normalizados. */
export function diferenciasDeCuerpo(a: unknown, b: unknown): string[] {
  const na = normalizarCuerpo(a) as Record<string, unknown>;
  const nb = normalizarCuerpo(b) as Record<string, unknown>;
  const claves = new Set([...Object.keys(na ?? {}), ...Object.keys(nb ?? {})]);
  const d: string[] = [];
  for (const k of [...claves].sort()) {
    if (JSON.stringify(na?.[k]) !== JSON.stringify(nb?.[k])) d.push(k);
  }
  return d;
}

// ── Utilidades de informe ───────────────────────────────────────────────────

export function fmtUsd(x: number): string {
  return `$${x.toFixed(4)}`;
}

export function percentil(xs: number[], p: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil(p * s.length) - 1));
  return s[idx]!;
}

/**
 * Tapa cualquier valor de credencial que se cuele en un texto (mensaje de error,
 * cuerpo de respuesta) antes de guardarlo o imprimirlo, y cualquier cabecera de
 * autenticación con su valor.
 */
export function redactar(texto: string, secretos: (string | undefined)[]): string {
  let t = texto;
  for (const s of secretos) if (s && s.length >= 8) t = t.split(s).join("[redactado]");
  return t
    .replace(/(authorization|x-api-key)(["']?)\s*[:=]\s*(["']?)(bearer\s+)?[^\s"',}]+/gi, "$1$2: $3[redactado]")
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|sk-ant-[A-Za-z0-9_-]{8,}|bvk_[A-Za-z0-9_-]{8,})/g, "[redactado]");
}
