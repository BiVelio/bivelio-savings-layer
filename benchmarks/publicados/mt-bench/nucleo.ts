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
import { usoNativoDeGemini } from "../../gemini-nativo.js";
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
  // Desde gpt-5.6 OpenAI desglosa la ESCRITURA de caché (`cache_write_tokens`,
  // dentro de `prompt_tokens`) y la cobra a 1,25×. El arnés la ignoraba hasta la
  // gama alta: la 0.4.31 sí la lee, y su coste declarado salió por encima del medido.
  const escrita = num(det.cache_write_tokens);
  return {
    entrada: num(u.prompt_tokens) - cacheada - escrita,
    cacheLeida: cacheada,
    cacheEscrita: escrita,
    salida: num(u.completion_tokens),
    razonamiento: num(detSalida.reasoning_tokens),
  };
}

/**
 * Chat Completions del endpoint compatible de Gemini (`…/v1beta/openai`):
 * `completion_tokens` NO incluye el razonamiento («thoughts»), que Google
 * factura a precio de salida; solo aparece en `total_tokens`. Medido en vivo
 * el 2026-09-29: gemini-3.8-flash, 13 de entrada + 3 de salida y
 * `total_tokens` 193. La salida facturada es, pues, `total − prompt`, y el
 * razonamiento, `total − prompt − completion`. Sin `total_tokens` no se sabe
 * lo que se piensa: error, nunca un 0.
 */
export function usoDeGoogle(cuerpo: unknown): UsoMedido {
  // La API NATIVA (`generateContent`) trae `usageMetadata`, no `usage`: el
  // pensamiento viene aparte (`thoughtsTokenCount`) y se factura como salida.
  if (cuerpo && typeof cuerpo === "object" && "usageMetadata" in cuerpo) return usoDeGeminiNativo(cuerpo);
  const u = (cuerpo as { usage?: Record<string, unknown> } | null)?.usage;
  if (!u || typeof u.prompt_tokens !== "number" || typeof u.completion_tokens !== "number" || typeof u.total_tokens !== "number") {
    throw new SinUsage("respuesta de Gemini sin usage completo (prompt/completion/total): no se inventa un 0");
  }
  const det = (u.prompt_tokens_details ?? {}) as Record<string, unknown>;
  const cacheada = num(det.cached_tokens);
  const prompt = num(u.prompt_tokens);
  const salida = Math.max(num(u.completion_tokens), num(u.total_tokens) - prompt);
  return {
    entrada: prompt - cacheada,
    cacheLeida: cacheada,
    cacheEscrita: 0,
    salida,
    razonamiento: salida - num(u.completion_tokens),
  };
}

/**
 * `generateContent` (la API nativa de Gemini, la que usa `GoogleProvider`):
 * `promptTokenCount` incluye lo leído de la caché implícita
 * (`cachedContentTokenCount`), y la salida facturada es visible + pensamiento
 * («Output price (including thinking tokens)»). El lector es el del banco
 * (benchmarks/gemini-nativo.ts), no el del adaptador. Sin contadores: error.
 */
export function usoDeGeminiNativo(cuerpo: unknown): UsoMedido {
  const u = usoNativoDeGemini(cuerpo);
  if (!u) throw new SinUsage("respuesta nativa de Gemini sin usageMetadata completo: no se inventa un 0");
  return { entrada: u.entrada - u.cacheLeida, cacheLeida: u.cacheLeida, cacheEscrita: 0, salida: u.salida, razonamiento: u.pensamiento };
}

/** El lector de usage de cada familia (el MISMO para los dos brazos). */
export function usoDeFamilia(familia: Familia, cuerpo: unknown): UsoMedido {
  return familia === "anthropic" ? usoDeAnthropic(cuerpo) : familia === "google" ? usoDeGoogle(cuerpo) : usoDeOpenAI(cuerpo);
}

/** Prima de escritura de caché: 1,25× en Anthropic (5 min); OpenAI no la cobra en estos modelos; Gemini tampoco (caché implícita). */
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

export type Familia = "anthropic" | "openai" | "google";

export interface ModeloDeLaBateria {
  /** El id que se pide (y que manda el brazo A al API). */
  id: string;
  familia: Familia;
  /**
   * Tope de salida por llamada, IGUAL en los dos brazos. Desde la 0.4.31 (#381)
   * es el tope NATIVO de la capa: el brazo B lo pasa como
   * `SavingsRequest.maxOutputTokens`, y la capa lo manda como `max_tokens` a
   * Anthropic y como `max_completion_tokens` al API oficial de OpenAI. El brazo
   * A manda ese mismo campo con el mismo valor. El transporte del banco ya NO
   * inyecta nada: si una petición sale sin tope, no sale (ver
   * `topeDelCuerpo`), y el diff del cable compara también ese campo.
   */
  maxSalida: number;
  /** false → no se manda `temperature` en ningún brazo (modelos de razonamiento que la rechazan). */
  temperatura: boolean;
  /**
   * Solo para un modelo SIN fila en el catálogo del paquete: su precio de lista
   * OFICIAL, citado (URL + fecha de consulta). No toca el catálogo: la capa lo
   * recibe como `defaultCostModel` y el banco lo usa para medir. Sin fila y sin
   * esto, el modelo es «no medible».
   */
  precioOficial?: { precio: Precio; fuente: string; consultado: string; cita: string };
}

/**
 * FastChat genera con `max_tokens=1024`. gpt-5.4-mini razona y el razonamiento
 * cuenta dentro de `max_completion_tokens`: con 1024 muchas respuestas saldrían
 * vacías, así que lleva 4096 en ambos brazos. El techo se declara en el informe.
 *
 * claude-sonnet-5: omitir `thinking` = pensamiento ADAPTATIVO (va dentro de
 * `max_tokens`), y el API rechaza `temperature` (400). Así que, como
 * gpt-5.4-mini, lleva 4096 y no se manda temperatura en ningún brazo.
 * claude-haiku-4-5 no piensa si no se le pide: 1024 y la temperatura de FastChat.
 */
export const MODELOS_POR_DEFECTO: ModeloDeLaBateria[] = [
  { id: "claude-haiku-4-5", familia: "anthropic", maxSalida: 1024, temperatura: true },
  { id: "claude-sonnet-5", familia: "anthropic", maxSalida: 4096, temperatura: false },
  { id: "gpt-4o-mini", familia: "openai", maxSalida: 1024, temperatura: true },
  { id: "gpt-5.4-mini", familia: "openai", maxSalida: 4096, temperatura: false },
];

/**
 * La tirada «gama alta» (2026-09-29): los modelos de mayor gama de cada
 * proveedor que el dueño pidió («lanza MT-Bench gama alta»), con el mismo
 * arnés. Elegidos contra los listados en vivo del 2026-09-29 (GET /v1/models
 * de Anthropic y OpenAI, GET /v1beta/models de Google) y el catálogo:
 *   · gpt-5.6: `gpt-5.6-sol`, la de mayor gama sin «pro» con fila ($4/$20;
 *     -terra $2/$12, -luna $0.20/$1.20).
 *   · Gemini: `gemini-3.8-flash` (la Flash vigente más nueva con fila) y
 *     `gemini-3.1-pro-preview` (la única Pro 3.x servida, con fila).
 *   · `claude-sonnet-5-5` no tiene fila: se mide con su precio OFICIAL citado.
 * Topes de salida: 1024 (FastChat) en Anthropic, que no piensa si no se le
 * pide; 4096 en gpt-5.x y Gemini 3.x, cuyo razonamiento cuenta dentro del tope.
 * Temperatura: Opus 5.5 y Sonnet 5.5 rechazan `temperature` con 400
 * («`temperature` is deprecated for this model», humo LIVE del 2026-09-29):
 * no se manda en ningún brazo, como en gpt-5.x. Gemini sí la acepta y lleva la
 * de FastChat por categoría en los dos.
 * Esfuerzo de razonamiento: el POR DEFECTO del proveedor en los dos brazos (la
 * 0.4.31 no tiene campo para fijarlo, así que el brazo A tampoco lo manda).
 */
export const MODELOS_GAMA_ALTA: ModeloDeLaBateria[] = [
  { id: "claude-opus-5-5", familia: "anthropic", maxSalida: 1024, temperatura: false },
  {
    id: "claude-sonnet-5-5",
    familia: "anthropic",
    maxSalida: 1024,
    temperatura: false,
    precioOficial: {
      precio: { inputPer1k: 0.002, outputPer1k: 0.01, cachedInputPer1k: 0.0002 },
      fuente: "https://platform.claude.com/docs/en/about-claude/pricing",
      consultado: "2026-09-29",
      cita: "Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok",
    },
  },
  { id: "gpt-5.5", familia: "openai", maxSalida: 4096, temperatura: false },
  { id: "gpt-5.6-sol", familia: "openai", maxSalida: 4096, temperatura: false },
  { id: "gemini-3.8-flash", familia: "google", maxSalida: 4096, temperatura: true },
  { id: "gemini-3.1-pro-preview", familia: "google", maxSalida: 4096, temperatura: true },
];

/** Tope duro de la tirada gama alta: 1,25 $ por modelo (A+B), cualquiera que sea su familia. */
export const TOPE_GAMA_ALTA_POR_MODELO_USD = 1.25;

/**
 * TODOS los modelos que la batería sabe medir: los de siempre y los de gama
 * alta. El banco semanal lanza `--modelos=<id>` sin `--gama-alta`, así que un
 * id se resuelve en la unión (benchmarks/banco-semanal/soporte.ts pregunta aquí).
 */
export const MODELOS_MEDIBLES: readonly ModeloDeLaBateria[] = [...MODELOS_POR_DEFECTO, ...MODELOS_GAMA_ALTA];

/** El modelo de la batería con ese id (primero en la lista de siempre, luego en la de gama alta), o undefined. */
export function modeloDeMtBench(id: string): ModeloDeLaBateria | undefined {
  return MODELOS_POR_DEFECTO.find((m) => m.id === id) ?? MODELOS_GAMA_ALTA.find((m) => m.id === id);
}

/** ¿Es de la lista de gama alta? Entonces lleva SU tope y SU prima por modelo, se corra o no con `--gama-alta`. */
export function esDeGamaAlta(m: Pick<ModeloDeLaBateria, "id">): boolean {
  return MODELOS_GAMA_ALTA.some((x) => x.id === m.id);
}

/** Id con prefijo de proveedor, como lo espera la capa (precio, claves de caché, informe). */
export function idCualificado(m: ModeloDeLaBateria): string {
  return `${m.familia}/${m.id}`;
}

// ── El presupuesto duro ─────────────────────────────────────────────────────

/**
 * Topes duros de esta tirada (0.4.31): 0,80 $ por modelo de OpenAI y 1,25 $ por
 * modelo de Anthropic (A+B juntos), y 0,50 $ de juez EN TOTAL para la batería.
 */
export const TOPE_POR_FAMILIA_USD: Readonly<Record<Familia, number>> = { openai: 0.8, anthropic: 1.25, google: 0.8 };
export const TOPE_DEL_JUEZ_USD = 0.5;

export function topePorModelo(m: Pick<ModeloDeLaBateria, "familia">): number {
  return TOPE_POR_FAMILIA_USD[m.familia];
}

/**
 * La parte del juez que le toca a un modelo: lo que QUEDA del tope total
 * repartido a partes iguales entre los modelos que faltan por juzgar (este
 * incluido). Lo que un modelo no gaste pasa a los siguientes; la suma nunca
 * supera el total.
 */
export function parteDelJuez(totalUsd: number, gastadoUsd: number, modelosPendientes: number): number {
  if (modelosPendientes <= 0) return 0;
  return Math.max(0, totalUsd - gastadoUsd) / modelosPendientes;
}

/**
 * El tope de salida que lleva un cuerpo de petición (`max_tokens` o
 * `max_completion_tokens`), o null si no lleva ninguno. Una petición de
 * generación sin tope no tiene peor caso acotado, así que el transporte no la
 * envía: el tope lo pone quien llama (la capa o el brazo A), nunca el banco.
 */
export function topeDelCuerpo(cuerpo: Record<string, unknown>): number | null {
  // La API nativa de Gemini lo lleva dentro de `generationConfig`.
  const gc = cuerpo["generationConfig"];
  const nativo = gc && typeof gc === "object" ? (gc as Record<string, unknown>)["maxOutputTokens"] : undefined;
  for (const v of [cuerpo["max_tokens"], cuerpo["max_completion_tokens"], nativo]) {
    if (typeof v === "number" && Number.isInteger(v) && v > 0) return v;
  }
  return null;
}

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

/** El juicio de un turno, tal como lo guarda el arnés. */
export interface JuicioDeTurno {
  turno: 1 | 2;
  prompt: string;
  partida1: Ganador | "idéntica";
  partida2: Ganador | "idéntica";
  ganador: "A" | "B" | "empate" | "error";
  inconsistente: boolean;
  identicas: boolean;
  /** Una de sus partidas no cupo en el tope del juez: el turno queda sin juzgar (no es un error de lectura). */
  sinPresupuesto?: boolean;
  /** Partidas que salieron de verdad hacia el juez (0-2). */
  partidas?: number;
}

/**
 * Los turnos que CUENTAN para la tasa de victoria: los que tienen ganador. Un
 * turno sin presupuesto (una partida no cupo en el tope del juez) o con una
 * partida ilegible NO es un empate: no se juzgó, y meterlo como ½ empujaría la
 * tasa hacia 0,5 — que es exactamente el 0,500 [0,500, 0,500] que dio el banco
 * semanal del 2026-09-29 con el juez cortado en la primera pregunta.
 */
export function turnosValidos<T extends Pick<JuicioDeTurno, "ganador">>(js: readonly T[]): (T & { ganador: "A" | "B" | "empate" })[] {
  return js.filter((j): j is T & { ganador: "A" | "B" | "empate" } => j.ganador !== "error");
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

/**
 * Campos que el banco añade por igual a los dos brazos y que no son de la capa.
 * Con la 0.4.31 está VACÍO: el tope de salida lo pone la capa (brazo B) y el
 * brazo A por su cuenta, y si no coinciden el diff del cable lo enseña.
 */
export const CAMPOS_DEL_BANCO: readonly string[] = [];

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

/**
 * El cuerpo del brazo A con el texto de SUS respuestas anteriores cambiado por
 * las del brazo B, en orden. En el turno 2 cada brazo lleva en `messages` su
 * propia respuesta al turno 1, que por muestreo casi nunca coincide: sin esto
 * el diff del cable diría «messages» en todos los turnos 2 aunque la capa no
 * hubiera tocado nada. Con esto, lo que queda es lo que la capa cambió.
 */
export function conRespuestasDe(cuerpo: unknown, respuestas: readonly string[]): unknown {
  if (!cuerpo || typeof cuerpo !== "object") return cuerpo;
  const nat = cuerpo as { contents?: unknown };
  if (Array.isArray(nat.contents)) {
    // La API nativa de Gemini: los turnos del asistente son `role: "model"` con partes de texto.
    let j = 0;
    const contents = nat.contents.map((c) => {
      const t = c as { role?: unknown };
      if (t && t.role === "model" && j < respuestas.length) return { ...(c as object), parts: [{ text: respuestas[j++] }] };
      return c;
    });
    return { ...(cuerpo as object), contents };
  }
  const c = cuerpo as { messages?: unknown };
  if (!Array.isArray(c.messages)) return cuerpo;
  let k = 0;
  const messages = c.messages.map((m) => {
    const msg = m as { role?: unknown };
    if (msg && msg.role === "assistant" && k < respuestas.length) return { ...(m as object), content: respuestas[k++] };
    return m;
  });
  return { ...(cuerpo as object), messages };
}

function sinMarcasDeCache(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sinMarcasDeCache);
  if (v && typeof v === "object") {
    const o: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) if (k !== "cache_control") o[k] = sinMarcasDeCache(x);
    return o;
  }
  return v;
}

/**
 * Claves de primer nivel en las que difieren dos cuerpos normalizados. Una clave
 * que solo difiere en marcas `cache_control` sale como `clave:cache_control`.
 */
export function diferenciasDeCuerpo(a: unknown, b: unknown): string[] {
  const na = normalizarCuerpo(a) as Record<string, unknown>;
  const nb = normalizarCuerpo(b) as Record<string, unknown>;
  const claves = new Set([...Object.keys(na ?? {}), ...Object.keys(nb ?? {})]);
  const d: string[] = [];
  for (const k of [...claves].sort()) {
    if (JSON.stringify(na?.[k]) === JSON.stringify(nb?.[k])) continue;
    // Si lo ÚNICO que cambia son marcas `cache_control`, se dice cuál es el cambio.
    const sa = normalizarCuerpo(sinMarcasDeCache(na?.[k]));
    const sb = normalizarCuerpo(sinMarcasDeCache(nb?.[k]));
    d.push(JSON.stringify(sa) === JSON.stringify(sb) ? `${k}:cache_control` : k);
  }
  return d;
}

// ── La clase del ahorro ─────────────────────────────────────────────────────

export type ClaseDelAhorro = "ahorro" | "sobrecoste" | "indistinguible de 0" | "muestra insuficiente" | "sin datos";

/** Por debajo de esto un bootstrap no da un intervalo que signifique nada. */
export const MINIMO_DE_PREGUNTAS_PARA_CLASE = 10;

/**
 * Lo que se puede afirmar del ahorro medido con su IC95: «ahorro» solo si el
 * extremo inferior es > 0, «sobrecoste» solo si el superior es < 0; si el
 * intervalo contiene el 0, no se distingue de no hacer nada. Con menos de
 * `MINIMO_DE_PREGUNTAS_PARA_CLASE` preguntas pareadas no se clasifica.
 */
export function claseDelAhorro(ci: { lower: number; upper: number } | null, n: number): ClaseDelAhorro {
  if (!ci || n === 0) return "sin datos";
  if (n < MINIMO_DE_PREGUNTAS_PARA_CLASE) return "muestra insuficiente";
  if (ci.lower > 0) return "ahorro";
  if (ci.upper < 0) return "sobrecoste";
  return "indistinguible de 0";
}

/**
 * Campos que la capa puede añadir al cable SIN cambiar lo que se factura por sí
 * mismos: `prompt_cache_key` solo agrupa peticiones para la caché de prefijo de
 * OpenAI; si no hay aciertos de caché, no mueve un token.
 */
export const CAMPOS_SIN_EFECTO_DIRECTO_EN_COSTE: readonly string[] = ["prompt_cache_key"];

export interface Atribucion {
  atribuible: boolean | null;
  motivo: string;
}

/**
 * ¿Se le puede atribuir a la capa una diferencia de coste medida? NO, si el
 * cable de B solo difiere del de A en campos sin efecto directo en coste, B no
 * leyó de caché más que A y la capa no declara ahorro: entonces las dos
 * peticiones eran la misma y la diferencia es muestreo de la SALIDA (longitud
 * de la respuesta), por significativo que salga el IC.
 */
export function atribucionDelAhorro(e: {
  clase: ClaseDelAhorro;
  diferenciasDelCable: Record<string, number>;
  lecturasDeCacheA: number;
  lecturasDeCacheB: number;
  ahorroDeclaradoUsd: number;
  /**
   * Tokens que B ESCRIBIÓ en la caché del proveedor. Una marca `cache_control`
   * (diff `clave:cache_control`) solo mueve dinero si el proveedor escribió
   * (prima) o leyó (descuento); por debajo del mínimo de tramo del modelo el
   * proveedor la ignora y la petición se factura igual que sin ella. Si no se
   * pasa, la marca cuenta como cambio con efecto (lo conservador).
   */
  tokensEscritosEnCacheB?: number;
}): Atribucion {
  if (e.clase === "sin datos" || e.clase === "muestra insuficiente") return { atribuible: null, motivo: "sin muestra suficiente" };
  const marcaInerte = e.tokensEscritosEnCacheB === 0 && e.lecturasDeCacheB === 0;
  const conEfecto = Object.keys(e.diferenciasDelCable).filter(
    (k) => !CAMPOS_SIN_EFECTO_DIRECTO_EN_COSTE.includes(k) && !(marcaInerte && k.endsWith(":cache_control")),
  );
  const cacheExtra = e.lecturasDeCacheB > e.lecturasDeCacheA;
  if (conEfecto.length === 0 && !cacheExtra && Math.abs(e.ahorroDeclaradoUsd) < 1e-9) {
    const soloEstos = Object.keys(e.diferenciasDelCable);
    return {
      atribuible: false,
      motivo:
        `el cable de B solo difiere de A en ${soloEstos.length ? soloEstos.map((k) => `\`${k}\``).join(", ") : "nada"}, ` +
        (marcaInerte && soloEstos.some((k) => k.endsWith(":cache_control"))
          ? "las marcas `cache_control` de B no escribieron ni leyeron un token (tramo por debajo del mínimo del modelo: el proveedor las ignora), "
          : "") +
        `B no leyó de caché más que A (${e.lecturasDeCacheB} frente a ${e.lecturasDeCacheA} llamadas) y la capa declara 0 $ de ahorro: ` +
        "la diferencia de coste es muestreo de la salida, no la capa",
    };
  }
  const razones = [
    ...(conEfecto.length ? [`el cable difiere en ${conEfecto.map((k) => `\`${k}\``).join(", ")}`] : []),
    ...(cacheExtra ? [`B leyó de caché en ${e.lecturasDeCacheB} llamadas frente a ${e.lecturasDeCacheA} de A`] : []),
    ...(Math.abs(e.ahorroDeclaradoUsd) >= 1e-9 ? [`la capa declara ${e.ahorroDeclaradoUsd > 0 ? "ahorro" : "sobrecoste"} (${e.ahorroDeclaradoUsd.toFixed(6)} $)`] : []),
  ];
  return { atribuible: true, motivo: `posible efecto de la capa: ${razones.join("; ")}` };
}

// ── La guarda de hosts ──────────────────────────────────────────────────────

/**
 * Los ÚNICOS hosts a los que puede salir el proceso en una tirada: los dos
 * proveedores, la pasarela del juez y el dataset. Nada de medición, licencias
 * ni telemetría: el brazo B corre desde el fuente con la licencia de
 * desarrollo abierta y su tráfico no debe tocar el plano de control.
 */
export const HOSTS_PERMITIDOS = [
  "api.anthropic.com",
  "api.openai.com",
  // Gemini: su API nativa (`/v1beta/models/…:generateContent`) o su endpoint compatible (`/v1beta/openai`).
  "generativelanguage.googleapis.com",
  "ai-gateway.vercel.sh",
  "raw.githubusercontent.com",
] as const;

export function hostDe(url: string): string {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "(url no parseable)";
  }
}

export function hostPermitido(url: string): boolean {
  const u = (() => {
    try {
      return new URL(url);
    } catch {
      return null;
    }
  })();
  return !!u && u.protocol === "https:" && (HOSTS_PERMITIDOS as readonly string[]).includes(u.host.toLowerCase());
}

// ── La verificación del fuente ──────────────────────────────────────────────

/**
 * Compara dos listados `ruta → hash de blob de git`: el de la etiqueta y el
 * del árbol que se va a cargar. Devuelve las rutas que difieren, sobran o
 * faltan: vacío ⇔ `git diff <etiqueta> -- <rutas>` vacío.
 */
export function diferenciasDeArbol(etiqueta: Map<string, string>, arbol: Map<string, string>): string[] {
  const d: string[] = [];
  for (const [ruta, h] of etiqueta) if (arbol.get(ruta) !== h) d.push(arbol.has(ruta) ? `M ${ruta}` : `D ${ruta}`);
  for (const ruta of arbol.keys()) if (!etiqueta.has(ruta)) d.push(`A ${ruta}`);
  return d.sort();
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
