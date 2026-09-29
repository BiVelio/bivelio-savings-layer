/**
 * XSTEST A/B — ¿cambia la capa la tasa de negativas, y trata bien las que hay?
 * ---------------------------------------------------------------------------
 * Uso:
 *   pnpm bench:xstest                 # SECO: sin red (fetch de mentira), plan y peor caso
 *   pnpm bench:xstest -- --vivo       # tirada de pago contra los proveedores
 *   opciones: --modelos=a,b  --n=N  --semilla=S  --salida=dir  --nombre=xstest-0431
 *   pnpm bench:xstest -- --desde=docs/…/xstest-0431.json   # rehace el informe sin red
 *
 * DISEÑO (el mismo que benchmarks/ab-live.ts, reducido a lo que XSTest mide):
 *   A · directo al proveedor: `fetch` a /v1/messages o /chat/completions con el
 *       prompt como único turno de usuario, el mismo tope de salida y la misma
 *       temperatura que B.
 *       Gemini por su API NATIVA (`…/v1beta`, la que recomienda la 0.5): A es
 *       `GoogleProvider` DIRECTO, sin capa —el mismo cuerpo que el adaptador arma
 *       dentro de B—, y el esfuerzo viaja como `reasoningEffort` en los dos.
 *   B · el mismo prompt por `createSavingsLayer` de @bivelio/savings-layer 0.4.31
 *       con la configuración por defecto (caché exacta en memoria encendida) y el
 *       tope NATIVO de la petición (`maxOutputTokens`, nuevo en 0.4.31).
 *       Ver `VERSION_DEL_PAQUETE` más abajo: por qué es el fuente de la release y
 *       por qué es byte a byte el mismo código que el tarball de npm.
 *
 * Por cada prompt que produjo una negativa (en A o en B) se REPITE dos veces por
 * B —generate() y generateStream()— y se mira que la 2.ª vuelva al proveedor y
 * que el informe no acredite ahorro. Cinco respuestas normales por modelo se
 * repiten una vez como CONTROL: sin un acierto de caché ahí, la prueba de que
 * una negativa no se cachea no demostraría nada.
 *
 * NUNCA se guarda el texto de una respuesta (banco de seguridad): solo su clase,
 * su longitud y si el texto que entregó la capa es el mismo que mandó el
 * proveedor. El presupuesto es DURO y va en código (nucleo.ts: `Presupuesto`).
 *
 * Claves: SOLO del entorno del proceso (`tsx --env-file=…`). Nunca se imprimen;
 * todo lo que sale a disco o a consola pasa por `limpiarSecretos`, y el JSON se
 * comprueba contra las claves antes de escribirse.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  AnthropicProvider,
  BV_SALA_VERSION,
  CATALOGO,
  createSavingsLayer,
  GoogleProvider,
  OpenAICompatibleProvider,
  type Provider,
  type SavingsLayer,
  type SavingsResult,
} from "../../../src/index.js";
import {
  clasificar,
  contieneSecreto,
  costeFacturado,
  costeSegunUsage,
  esNegativa,
  esNegativaNoCobrada,
  esParadaDeFiltro,
  leerJson,
  leerSse,
  limpiarSecretos,
  ordenEstratificado,
  parsearXSTest,
  peorCasoDeLlamada,
  Presupuesto,
  sha256Hex,
  TOPE_DURO_OPUS_USD,
  TOPE_DURO_POR_MODELO_USD,
  VERSION_DEL_CLASIFICADOR,
  XSTEST_COMMIT,
  XSTEST_SHA256,
  XSTEST_URL,
  type Clasificacion,
  type Familia,
  type LecturaDelProveedor,
  type Precio,
  type PromptXSTest,
} from "./nucleo.js";
import { construirInforme, renderizarMarkdown, type Tirada } from "./informe.js";
import { BASE_NATIVA_DE_GEMINI, baseNativaDeGemini, dialectoDeGoogle, googleDelEntorno } from "../../gemini-nativo.js";

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = resolve(AQUI, "../../..");

// ── La versión del paquete que se mide ──────────────────────────────────────
/**
 * npm tiene 0.4.31 (integrity abajo; `npm pack` del registro verificado el
 * 2026-09-28). El build publicado NO tiene modo sin licencia
 * (`__BV_SALA_ALLOW_DEV_OPEN__ = false`), así que el brazo B carga el FUENTE de
 * la etiqueta v0.4.31 (00c99c8) vía tsx: en VIVO con `BIVELIO_LICENSE_KEY` o con
 * `BVSALA_DEV_OPEN=1` (decisión del dueño del 2026-09-28), en SECO y en la verja
 * con `devUnlicensed`. `pnpm build` de ese fuente —y del de esta rama— reproduce
 * los seis `dist/**.js` del tarball de npm con el MISMO sha256. `git diff v0.4.31
 * -- src/ packages/` solo toca `src/version.ts` (#385: un comentario y
 * `VERSION_MINIMA_REFERENCIA`, una constante del ingest que no entra en ningún
 * bundle del SDK); el código que ejecuta la capa es el de la etiqueta.
 */
export const VERSION_DEL_PAQUETE = {
  paquete: "@bivelio/savings-layer",
  version: "0.4.31",
  commit: "00c99c803c0ab6f3c11b7ab87f3c75a38d609b1c",
  etiqueta: "v0.4.31",
  npmIntegrity: "sha512-ePCN+dZr+VuMUSGm2TelDkt7TR6jSi/SCTomomDK/bfF92FHr1eFUdgTWQODCdQf8C8c+/h6AA/up46DXO2mLQ==",
  npmShasum: "7873565508afb4f01c77e84007e0619b51b64ba4",
  distIndexSha256: "b52f99cacf9804ecd3153e56f26ec3adcdc2510d52a8446a369ecf914e0b5731",
  comoSeEjecuta:
    "fuente de la etiqueta v0.4.31 (00c99c8) vía tsx; VIVO con BIVELIO_LICENSE_KEY o BVSALA_DEV_OPEN=1, SECO con devUnlicensed. " +
    "`pnpm build` de ese fuente reproduce byte a byte los seis dist/**.js del tarball de npm (mismo sha256).",
} as const;

/** La etiqueta del brazo B cuando corre sin licencia, con la licencia de desarrollo abierta. */
export const ETIQUETA_DEV_OPEN = "v0.4.31 (source of the tag, BVSALA_DEV_OPEN=1; npm = same commit, verified identical)";

// ── Los modelos ─────────────────────────────────────────────────────────────

export interface ConfigDeModelo {
  id: string;
  familia: Familia;
  /** Tope de gasto de ESTA batería para el modelo (A + B + repeticiones). */
  tope: number;
  /** `temperature` en los dos brazos (omitida si el modelo no la admite). */
  temperatura?: number;
  /** Campos extra del cuerpo de Chat Completions (OpenAI y Gemini compatible) en los dos brazos (p. ej. `reasoning_effort`). */
  extraOpenAI?: Record<string, unknown>;
  /** Tope de salida de ESTE modelo en A y B (por defecto `TOPE_DE_SALIDA`). Gemini Pro solo piensa: el tope incluye el pensamiento. */
  topeDeSalida?: number;
  /**
   * Campos extra del cuerpo de Mensajes en los dos brazos (p. ej. `thinking`,
   * `output_config`). La 0.4.31 no los expresa, así que en B el banco los pone SOLO
   * si el cuerpo no los trae, y lo anota (`inyectado`), igual que `reasoning_effort`.
   */
  extraAnthropic?: Record<string, unknown>;
  /** Solo prompts inseguros, y cuántos (Opus 5.5: ver `stop_reason: "refusal"` real). */
  soloInseguros?: number;
}

export const MODELOS: ConfigDeModelo[] = [
  // Topes de la tirada del 2026-09-29: 1,20 $ (Haiku, Sonnet) y 0,90 $ (Opus) MENOS lo
  // gastado antes en el humo (--n=3) y en un arranque abortado (cota prudente).
  { id: "claude-haiku-4-5", familia: "anthropic", tope: 1.19, temperatura: 0 },
  // Sonnet 5 y Opus 5.5 rechazan `temperature` (400) y piensan por defecto (adaptive):
  // sin tocarlo, el razonamiento se comería el tope de 160 tokens de salida. Sonnet 5
  // admite apagarlo; Opus 5.5 no (400 a cualquier esfuerzo), así que se baja el esfuerzo.
  { id: "claude-sonnet-5", familia: "anthropic", tope: 1.17, extraAnthropic: { thinking: { type: "disabled" } } },
  // 0,80 $ por modelo de OpenAI (A + B + repeticiones): tope duro del coordinador
  // para la tirada de la 0.4.31, con otras tres baterías gastando las mismas claves.
  { id: "gpt-4o-mini", familia: "openai", tope: 0.8, temperatura: 0 },
  // gpt-5.x razona: sin esfuerzo mínimo, el tope de salida se lo comería el razonamiento.
  { id: "gpt-5.4-mini", familia: "openai", tope: 0.8, extraOpenAI: { reasoning_effort: "none" } },
  // Opus 5.5: solo inseguros, los que quepan en 0,90 $ (el presupuesto corta el prefijo estratificado).
  { id: "claude-opus-5-5", familia: "anthropic", tope: 0.84, extraAnthropic: { output_config: { effort: "low" } }, soloInseguros: 200 },
  // ── Gama alta (2026-09-29): 1,25 $ por modelo (A + B + repeticiones), tope duro del coordinador.
  // Sonnet 5.5 rechaza `temperature` («deprecated for this model», 400): sin ella en A y B.
  { id: "claude-sonnet-5-5", familia: "anthropic", tope: 1.25 },
  // gpt-5.5 y gpt-5.6-sol aceptan `reasoning_effort: "none"` con `temperature: 0` (sonda del 2026-09-29).
  { id: "gpt-5.5", familia: "openai", tope: 1.25, temperatura: 0, extraOpenAI: { reasoning_effort: "none" } },
  { id: "gpt-5.6-sol", familia: "openai", tope: 1.25, temperatura: 0, extraOpenAI: { reasoning_effort: "none" } },
  // Gemini por el endpoint compatible. 3.8 Flash admite `reasoning_effort: "none"` (0 tokens de pensamiento).
  { id: "gemini-3.8-flash", familia: "google", tope: 1.25, temperatura: 0, extraOpenAI: { reasoning_effort: "none" } },
  // 3.1 Pro «only works in thinking mode» (400 con "none"; "minimal" no admitido): "low", y el tope sube
  // a 1024 porque el pensamiento cuenta dentro de `max_tokens` (con 160 se corta antes de escribir nada).
  { id: "gemini-3.1-pro-preview", familia: "google", tope: 1.25, temperatura: 0, extraOpenAI: { reasoning_effort: "low" }, topeDeSalida: 1024 },
];

/**
 * Precio OFICIAL citado para un modelo SIN fila en `CATALOGO` (el catálogo no se
 * toca desde un banco). Solo sirve para el presupuesto y la cuenta del banco; la
 * capa sigue valorando con su catálogo (sin fila → respaldo ilustrativo).
 */
export const PRECIOS_CITADOS: Record<string, { precio: Precio; fuente: string }> = {
  "claude-sonnet-5-5": {
    precio: { inputPer1k: 0.002, outputPer1k: 0.01, cachedInputPer1k: 0.0002 },
    fuente:
      "https://platform.claude.com/docs/en/about-claude/pricing (consultada el 2026-09-29): «Claude Sonnet 5.5 | $2 / MTok | $2.50 / MTok | $4 / MTok | $0.20 / MTok | $10 / MTok»",
  },
};

/** Tope de tokens de salida, igual en A y B. La clasificación de la paper mira el principio. */
export const TOPE_DE_SALIDA = 160;
export const SEMILLA = 20260928;
/** ≤ 3 peticiones simultáneas por proveedor: otras baterías gastan las mismas claves a la vez. */
const CONCURRENCIA_POR_PROVEEDOR = 3;
const ITEMS_EN_VUELO_POR_MODELO = 2;
const CONTROLES_POR_MODELO = 5;

const topeDe = (cfg: ConfigDeModelo): number => cfg.topeDeSalida ?? TOPE_DE_SALIDA;

export function precioDe(modelo: string): Precio {
  const p = (CATALOGO as Record<string, Precio | undefined>)[modelo] ?? PRECIOS_CITADOS[modelo]?.precio;
  if (!p) throw new Error(`sin fila de catálogo para ${modelo}: no se puede presupuestar`);
  return p;
}

// ── La red del banco: un solo fetch para A y para B ────────────────────────

interface Contexto {
  modelo: string;
  familia: Familia;
  brazo: "A" | "B";
  lecturas: LecturaDelProveedor[];
  inyectado: Set<string>;
  /** El campo de tope de salida y su valor en cada cuerpo que salió (B: lo que puso la capa). */
  topes: string[];
  alGastar: (usd: number) => void;
}

const contexto = new AsyncLocalStorage<Contexto>();

class Semaforo {
  private libres: number;
  private cola: (() => void)[] = [];
  constructor(n: number) {
    this.libres = n;
  }
  async con<T>(f: () => Promise<T>): Promise<T> {
    if (this.libres > 0) this.libres--;
    else await new Promise<void>((r) => this.cola.push(r));
    try {
      return await f();
    } finally {
      const sig = this.cola.shift();
      if (sig) sig();
      else this.libres++;
    }
  }
}

const dormir = (ms: number) => new Promise((r) => setTimeout(r, ms));
const REINTENTABLES = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

export interface Red {
  fetch: typeof fetch;
  reintentos: number;
}

/**
 * El `fetch` de los dos brazos. Limita la concurrencia por proveedor, reintenta
 * 429/5xx con backoff (el proveedor de la capa nunca ve el 429), iguala en B el
 * único parámetro que la capa no sabe expresar (`reasoning_effort` en Chat
 * Completions, SOLO si el cuerpo no lo trae) y lee el `usage`, la parada y la
 * negativa de cada respuesta. El texto se clasifica y se descarta: nunca sale de
 * este proceso.
 *
 * El tope de salida YA NO se inyecta: desde la 0.4.31 la petición lo lleva
 * (`maxOutputTokens`) y la capa lo traduce a `max_tokens` /
 * `max_completion_tokens`. Aquí solo se ANOTA qué campo salió y con qué valor; un
 * cuerpo sin tope no sale (el presupuesto reserva con el tope, y sin él el peor
 * caso no está acotado).
 */
export function crearRed(base: typeof fetch, modelos: ConfigDeModelo[], dormirImpl = dormir): Red {
  const semaforos: Record<Familia, Semaforo> = {
    anthropic: new Semaforo(CONCURRENCIA_POR_PROVEEDOR),
    openai: new Semaforo(CONCURRENCIA_POR_PROVEEDOR),
    google: new Semaforo(CONCURRENCIA_POR_PROVEEDOR),
  };
  const red: Red = { reintentos: 0, fetch: undefined as unknown as typeof fetch };
  red.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const ctx = contexto.getStore();
    if (!ctx) throw new Error("banco: llamada de red fuera de un contexto de brazo");
    const cfg = modelos.find((m) => m.id === ctx.modelo)!;
    let cuerpo = init?.body;
    let esStream = false;
    if (typeof cuerpo === "string") {
      const b = JSON.parse(cuerpo) as Record<string, unknown>;
      esStream = b["stream"] === true;
      // Gemini nativo: el tope va en `generationConfig.maxOutputTokens` y el cuerpo
      // es de `generateContent` (`contents`), no de Chat Completions.
      const nativo = b["contents"] !== undefined;
      const topeNativo = (b["generationConfig"] as Record<string, unknown> | undefined)?.["maxOutputTokens"];
      const campo = nativo
        ? topeNativo !== undefined
          ? "maxOutputTokens"
          : undefined
        : (["max_tokens", "max_completion_tokens"] as const).find((k) => b[k] !== undefined);
      if (!campo) throw new Error(`banco: el cuerpo del brazo ${ctx.brazo} salió sin tope de salida — no se envía`);
      ctx.topes.push(`${campo}=${String(nativo ? topeNativo : b[campo])}`);
      // En el cable nativo NO se inyecta nada: el esfuerzo viaja como
      // `reasoningEffort` en la petición de los dos brazos (el adaptador lo
      // traduce a `thinkingConfig`), y un campo de Chat Completions en un cuerpo
      // de `generateContent` sería un 400, no una igualación.
      if (ctx.brazo === "B" && !nativo) {
        const extra = ctx.familia === "anthropic" ? cfg.extraAnthropic : cfg.extraOpenAI;
        for (const [k, v] of Object.entries(extra ?? {})) {
          if (b[k] === undefined) {
            b[k] = v;
            ctx.inyectado.add(k);
          }
        }
        cuerpo = JSON.stringify(b);
      }
    }
    return await semaforos[ctx.familia].con(async () => {
      for (let intento = 0; ; intento++) {
        let r: Response;
        try {
          r = await base(url, { ...init, body: cuerpo ?? null, signal: AbortSignal.timeout(120_000) });
        } catch (e) {
          if (intento >= 5) throw e;
          red.reintentos++;
          await dormirImpl(2000 * 2 ** intento);
          continue;
        }
        if (REINTENTABLES.has(r.status) && intento < 6) {
          await r.text().catch(() => "");
          red.reintentos++;
          const ra = Number(r.headers.get("retry-after"));
          await dormirImpl(Number.isFinite(ra) && ra > 0 ? Math.min(ra * 1000, 60_000) : 1500 * 2 ** intento + Math.random() * 500);
          continue;
        }
        const texto = await r.text();
        const tipo = r.headers.get("content-type") ?? "";
        let l: LecturaDelProveedor;
        if (tipo.includes("event-stream") || (esStream && r.status < 400)) l = leerSse(ctx.familia, r.status, texto);
        else {
          let j: unknown = {};
          try {
            j = JSON.parse(texto);
          } catch {
            /* cuerpo no JSON: se queda vacío */
          }
          l = leerJson(ctx.familia, r.status, j);
        }
        ctx.lecturas.push(l);
        ctx.alGastar(costeSegunUsage(ctx.familia, l, precioDe(ctx.modelo)));
        return new Response(texto, { status: r.status, statusText: r.statusText, headers: r.headers });
      }
    });
  }) as typeof fetch;
  return red;
}

// ── Los registros (sin texto) ───────────────────────────────────────────────

export type ResumenDeLectura = Omit<LecturaDelProveedor, "texto"> & { textoLen: number };

const resumir = (l: LecturaDelProveedor): ResumenDeLectura => {
  const { texto, ...resto } = l;
  return { ...resto, textoLen: texto.length };
};

export interface RegistroA {
  proveedor?: ResumenDeLectura;
  clase?: Clasificacion;
  costeFacturadoUsd: number;
  costeSegunUsageUsd: number;
  noCobrada: boolean;
  error?: string;
}

export interface RegistroB {
  fase: "principal" | "repeticion-1" | "repeticion-2" | "control-cache";
  via: "generate" | "generateStream";
  /** Llamadas que llegaron al proveedor en ESTA petición. */
  llamadasAlProveedor: number;
  proveedor?: ResumenDeLectura;
  clase?: Clasificacion;
  /** La capa marcó la respuesta como negativa (`finishReason: content_filter` o `refusal`). */
  negativaSegunLaCapa: boolean;
  /** El texto que entregó la capa es el mismo que mandó el proveedor (null si no hubo llamada). */
  textoFiel: boolean | null;
  /** Lo que el proveedor cobra según su `usage` y la regla de negativas (null si no hubo llamada). */
  costeFacturadoUsd: number | null;
  costeSegunUsageUsd: number | null;
  noCobrada: boolean;
  inyectado: string[];
  /** Tope de salida que la capa puso en el cuerpo (p. ej. `max_completion_tokens=160`), por llamada. */
  topeEnviado: string[];
  informe?: {
    basis: string;
    actual: number;
    baselineEstimate: number;
    netSavings: number;
    cacheResult: string;
    reference: boolean;
    referenceRejected?: string;
    actualLlm: number;
    avoidedLlm: number;
    actualInput: number;
    actualOutput: number;
    trazaCosteNoCobrada: boolean;
    trazaEscrituraCache?: string;
    trazaReferencia?: string;
    /** `detail.exactCache` de la traza `reference`: si la respuesta viajó a la caché exacta. */
    vaALaCacheExacta?: boolean;
  };
  error?: string;
}

export interface RegistroDeItem {
  modelo: string;
  id: number;
  type: string;
  label: "safe" | "unsafe";
  A?: RegistroA;
  B?: RegistroB;
  repeticiones: RegistroB[];
}

// ── Los brazos ──────────────────────────────────────────────────────────────

export interface Endpoints {
  anthropicBaseUrl: string;
  anthropicApiKey?: string;
  openaiBaseUrl: string;
  openaiApiKey?: string;
  /**
   * Gemini. La URL decide el cable (benchmarks/gemini-nativo.ts): `…/v1beta` es
   * la API NATIVA (`GoogleProvider` en los dos brazos) y `…/v1beta/openai` el
   * endpoint compatible con OpenAI de las tiradas anteriores.
   */
  googleBaseUrl?: string;
  googleApiKey?: string;
}

/** ¿Habla este modelo con Gemini por su API NATIVA? */
export function esGeminiNativo(ep: Endpoints, cfg: Pick<ConfigDeModelo, "familia">): boolean {
  return cfg.familia === "google" && dialectoDeGoogle(ep.googleBaseUrl) === "nativo";
}

/**
 * El esfuerzo de razonamiento de un modelo de Gemini por el cable nativo: el
 * mismo valor que su `extraOpenAI.reasoning_effort` por el compatible, pero como
 * `reasoningEffort` de la PETICIÓN (A y B), que `GoogleProvider` traduce a
 * `thinkingConfig.thinkingLevel` (3.8 Flash "none" → MINIMAL: Gemini 3 no deja
 * apagar el pensamiento; 3.1 Pro "low" → LOW). Igual en los dos brazos por
 * construcción: lo traduce el mismo adaptador.
 */
export function esfuerzoNativoDe(cfg: ConfigDeModelo): string | undefined {
  const e = cfg.extraOpenAI?.["reasoning_effort"];
  return typeof e === "string" ? e : undefined;
}

/** El adaptador nativo de Gemini de ESTA tirada, por la red del banco. */
function proveedorGoogleNativo(red: Red, ep: Endpoints): GoogleProvider {
  return new GoogleProvider({
    baseUrl: baseNativaDeGemini(ep.googleBaseUrl),
    ...(ep.googleApiKey ? { apiKey: ep.googleApiKey } : {}),
    requireUsage: true,
    fetchImpl: red.fetch,
  });
}

function chatDe(ep: Endpoints, familia: Familia): { base: string; clave?: string } {
  if (familia === "google") {
    if (!ep.googleBaseUrl) throw new Error("banco: modelo de Google sin googleBaseUrl");
    return { base: ep.googleBaseUrl, ...(ep.googleApiKey ? { clave: ep.googleApiKey } : {}) };
  }
  return { base: ep.openaiBaseUrl, ...(ep.openaiApiKey ? { clave: ep.openaiApiKey } : {}) };
}

async function enContexto<T>(
  ctx: Omit<Contexto, "lecturas" | "inyectado" | "topes">,
  f: () => Promise<T>,
): Promise<{ v?: T; e?: unknown; ctx: Contexto }> {
  const c: Contexto = { ...ctx, lecturas: [], inyectado: new Set(), topes: [] };
  try {
    const v = await contexto.run(c, f);
    return { v, ctx: c };
  } catch (e) {
    return { e, ctx: c };
  }
}

async function brazoA(
  red: Red,
  ep: Endpoints,
  cfg: ConfigDeModelo,
  prompt: string,
  alGastar: (usd: number) => void,
  secretos: string[],
): Promise<RegistroA> {
  const precio = precioDe(cfg.id);
  const { e, ctx } = await enContexto({ modelo: cfg.id, familia: cfg.familia, brazo: "A", alGastar }, async () => {
    if (esGeminiNativo(ep, cfg)) {
      // Gemini nativo: el brazo A SIN capa es el adaptador nativo DIRECTO, como el
      // brazo A de Anthropic en benchmarks/transporte.ts. El cuerpo lo arma
      // `GoogleProvider` igual que dentro de la capa: A y B no pueden diferir en
      // cómo se codifica la petición, solo en lo que la capa haga con ella.
      const esfuerzo = esfuerzoNativoDe(cfg);
      await proveedorGoogleNativo(red, ep).generate({
        model: cfg.id,
        messages: [{ role: "user", content: prompt }],
        maxOutputTokens: topeDe(cfg),
        ...(cfg.temperatura !== undefined ? { temperature: cfg.temperatura } : {}),
        ...(esfuerzo !== undefined ? { reasoningEffort: esfuerzo } : {}),
      });
    } else if (cfg.familia === "anthropic") {
      const base = ep.anthropicBaseUrl.replace(/\/$/, "");
      await red.fetch(`${base}/messages`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "anthropic-version": "2023-06-01",
          ...(ep.anthropicApiKey ? { "x-api-key": ep.anthropicApiKey } : {}),
        },
        body: JSON.stringify({
          model: cfg.id,
          max_tokens: topeDe(cfg),
          messages: [{ role: "user", content: prompt }],
          ...(cfg.temperatura !== undefined ? { temperature: cfg.temperatura } : {}),
          ...(cfg.extraAnthropic ?? {}),
        }),
      });
    } else {
      const { base: b0, clave } = chatDe(ep, cfg.familia);
      const base = b0.replace(/\/$/, "");
      await red.fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(clave ? { authorization: `Bearer ${clave}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.id,
          messages: [{ role: "user", content: prompt }],
          // El campo que pone la capa contra cada API oficial: `max_completion_tokens` en
          // api.openai.com, `max_tokens` en el endpoint compatible de Gemini.
          ...(cfg.familia === "google" ? { max_tokens: topeDe(cfg) } : { max_completion_tokens: topeDe(cfg) }),
          ...(cfg.temperatura !== undefined ? { temperature: cfg.temperatura } : {}),
          ...(cfg.extraOpenAI ?? {}),
        }),
      });
    }
  });
  const l = ctx.lecturas.at(-1);
  if (e || !l || l.error) {
    return {
      ...(l ? { proveedor: resumir(l) } : {}),
      costeFacturadoUsd: 0,
      costeSegunUsageUsd: 0,
      noCobrada: false,
      error: limpiarSecretos(l?.error ?? (e instanceof Error ? e.message : String(e)), secretos),
    };
  }
  return {
    proveedor: resumir(l),
    clase: clasificar(l.texto, l.negativaDelApi),
    costeFacturadoUsd: costeFacturado(cfg.familia, l, precio),
    costeSegunUsageUsd: costeSegunUsage(cfg.familia, l, precio),
    noCobrada: esNegativaNoCobrada(cfg.familia, l),
  };
}

export function crearCapa(red: Red, ep: Endpoints, cfg: ConfigDeModelo, licencia?: string): SavingsLayer {
  const provider: Provider = esGeminiNativo(ep, cfg)
    ? proveedorGoogleNativo(red, ep)
    : cfg.familia === "anthropic"
      ? new AnthropicProvider({
          baseUrl: ep.anthropicBaseUrl,
          ...(ep.anthropicApiKey ? { apiKey: ep.anthropicApiKey } : {}),
          stripProviderPrefix: true,
          requireUsage: true,
          fetchImpl: red.fetch,
        })
      : new OpenAICompatibleProvider({
          baseUrl: chatDe(ep, cfg.familia).base,
          ...(chatDe(ep, cfg.familia).clave ? { apiKey: chatDe(ep, cfg.familia).clave! } : {}),
          stripProviderPrefix: true,
          requireUsage: true,
          fetchImpl: red.fetch,
        });
  // Configuración por defecto, tal como se instala. En VIVO, con la licencia del
  // entorno (obligatoria: `principal` aborta antes de la red sin ella); en SECO y
  // en la verja, la licencia de desarrollo que solo honra el fuente.
  return createSavingsLayer({
    provider,
    ...(licencia ? { licenseKey: licencia } : { devUnlicensed: true }),
    silenceWarnings: true,
  });
}

async function brazoB(
  capa: SavingsLayer,
  cfg: ConfigDeModelo,
  prompt: string,
  fase: RegistroB["fase"],
  via: RegistroB["via"],
  alGastar: (usd: number) => void,
  secretos: string[],
  /** Gemini nativo: el esfuerzo como `reasoningEffort` de la petición (ver `esfuerzoNativoDe`). */
  esfuerzo?: string,
): Promise<RegistroB> {
  const precio = precioDe(cfg.id);
  const req = {
    model: `${cfg.familia}/${cfg.id}`,
    messages: [{ role: "user" as const, content: prompt }],
    // El tope NATIVO de la 0.4.31 (el mismo valor que A); ya no lo inyecta el banco.
    maxOutputTokens: topeDe(cfg),
    ...(cfg.temperatura !== undefined ? { temperature: cfg.temperatura } : {}),
    ...(esfuerzo !== undefined ? { reasoningEffort: esfuerzo } : {}),
  };
  const { v: r, e, ctx } = await enContexto({ modelo: cfg.id, familia: cfg.familia, brazo: "B", alGastar }, async () => {
    if (via === "generate") return await capa.generate(req);
    const flujo = capa.generateStream(req);
    for await (const _ of flujo) {
      /* se consume: el texto no se guarda */
    }
    return await flujo.result;
  });
  const l = ctx.lecturas.at(-1);
  const base: RegistroB = {
    fase,
    via,
    llamadasAlProveedor: ctx.lecturas.length,
    negativaSegunLaCapa: false,
    textoFiel: null,
    costeFacturadoUsd: l ? ctx.lecturas.reduce((s, x) => s + costeFacturado(cfg.familia, x, precio), 0) : null,
    costeSegunUsageUsd: l ? ctx.lecturas.reduce((s, x) => s + costeSegunUsage(cfg.familia, x, precio), 0) : null,
    noCobrada: !!l && ctx.lecturas.length === 1 && esNegativaNoCobrada(cfg.familia, l),
    inyectado: [...ctx.inyectado].sort(),
    topeEnviado: [...ctx.topes],
    ...(l ? { proveedor: resumir(l) } : {}),
  };
  if (e || !r) {
    return { ...base, error: limpiarSecretos(l?.error ?? (e instanceof Error ? e.message : String(e)), secretos) };
  }
  const res = r as SavingsResult;
  const negativaCapa = res.finishReason === "content_filter" || (typeof res.refusal === "string" && res.refusal !== "");
  const traza = (etapa: string) =>
    res.report.traces.filter((t) => t.stage === etapa).map((t) => t.outcome).join(" | ") || undefined;
  const rep = res.report;
  const refRej = (rep.cache as { referenceRejected?: string }).referenceRejected;
  const tEsc = traza("cache-write");
  const tRef = traza("reference");
  const detRef = res.report.traces.find((t) => t.stage === "reference")?.detail as { exactCache?: unknown } | undefined;
  return {
    ...base,
    // La negativa la decide el PROVEEDOR cuando la llamada fue a él (Gemini: `content_filter: OTHER`,
    // que la capa no reconoce); si la sirvió la caché, lo que diga la capa.
    clase: clasificar(res.text ?? "", negativaCapa || (ctx.lecturas.length === 1 && !!l?.negativaDelApi)),
    negativaSegunLaCapa: negativaCapa,
    textoFiel: l && ctx.lecturas.length === 1 ? sha256Hex(res.text ?? "") === sha256Hex(l.texto) : null,
    informe: {
      basis: rep.cost.basis,
      actual: rep.cost.actual,
      baselineEstimate: rep.cost.baselineEstimate,
      netSavings: rep.cost.netSavings,
      cacheResult: rep.cache.result,
      reference: !!rep.cache.reference,
      ...(refRej ? { referenceRejected: refRej } : {}),
      actualLlm: rep.calls.actualLlm,
      avoidedLlm: rep.calls.avoidedLlm,
      actualInput: rep.tokens.actualInput,
      actualOutput: rep.tokens.actualOutput,
      trazaCosteNoCobrada: rep.traces.some((t) => t.stage === "cost" && t.outcome.startsWith("unbilled refusal")),
      ...(tEsc ? { trazaEscrituraCache: limpiarSecretos(tEsc, secretos).slice(0, 200) } : {}),
      ...(tRef ? { trazaReferencia: limpiarSecretos(tRef, secretos).slice(0, 200) } : {}),
      ...(typeof detRef?.exactCache === "boolean" ? { vaALaCacheExacta: detRef.exactCache } : {}),
    },
  };
}

// ── La tirada ───────────────────────────────────────────────────────────────

export interface OpcionesDeTirada {
  modo: "SECO" | "VIVO";
  modelos: ConfigDeModelo[];
  prompts: PromptXSTest[];
  endpoints: Endpoints;
  fetchBase: typeof fetch;
  secretos: string[];
  semilla?: number;
  n?: number;
  dormir?: (ms: number) => Promise<void>;
  log?: (s: string) => void;
  /** Licencia para el brazo B (VIVO). Sin ella, `devUnlicensed` (solo SECO / verja). */
  licencia?: string;
  /** Modelos que el prevuelo descartó, con su motivo: no se mide nada de ellos. */
  noMedibles?: Record<string, string>;
  /** `--tope=` (banco semanal): tope por modelo que solo puede BAJAR el de `MODELOS` y el duro. */
  topeMaximoUsd?: number;
}

export async function correrTirada(o: OpcionesDeTirada): Promise<Tirada> {
  const log = o.log ?? ((s: string) => console.log(limpiarSecretos(s, o.secretos)));
  const red = crearRed(o.fetchBase, o.modelos, o.dormir);
  const semilla = o.semilla ?? SEMILLA;
  const orden = ordenEstratificado(o.prompts, semilla);
  const registros: RegistroDeItem[] = [];
  const porModelo: Tirada["porModelo"] = {};

  await Promise.all(
    o.modelos.map(async (cfg) => {
      const tope = Math.min(
        cfg.tope,
        cfg.id.startsWith("claude-opus") ? TOPE_DURO_OPUS_USD : TOPE_DURO_POR_MODELO_USD,
        o.topeMaximoUsd ?? Infinity,
      );
      const motivo = o.noMedibles?.[cfg.id];
      if (motivo) {
        porModelo[cfg.id] = {
          familia: cfg.familia, tope, gastadoUsd: 0, planificados: 0, medidos: 0, cortadoPorPresupuesto: false,
          temperatura: cfg.temperatura ?? null, extraOpenAI: cfg.extraOpenAI ?? null, extraAnthropic: cfg.extraAnthropic ?? null, soloInseguros: cfg.soloInseguros ?? null,
          noMedible: motivo,
          clasificador: VERSION_DEL_CLASIFICADOR,
        };
        log(`[xstest] ${cfg.id}: NO MEDIBLE — ${motivo}`);
        return;
      }
      const presupuesto = new Presupuesto(tope);
      const precio = precioDe(cfg.id);
      let lista = cfg.soloInseguros ? orden.filter((p) => p.label === "unsafe").slice(0, cfg.soloInseguros) : orden;
      if (o.n !== undefined) lista = lista.slice(0, o.n);
      const capa = crearCapa(red, o.endpoints, cfg, o.licencia);
      const esfuerzo = esGeminiNativo(o.endpoints, cfg) ? esfuerzoNativoDe(cfg) : undefined;
      const alGastar = (usd: number) => presupuesto.gastar(usd);
      let controles = 0;
      let cortadoPorPresupuesto = false;
      let siguiente = 0;
      const planificados = lista.length;

      const trabajador = async () => {
        while (siguiente < lista.length && !cortadoPorPresupuesto) {
          const p = lista[siguiente++]!;
          const unaLlamada = peorCasoDeLlamada(p.prompt, topeDe(cfg), precio);
          // A + B + dos repeticiones (o un control): el peor caso ENTERO del ítem.
          const reserva = unaLlamada * 4;
          if (!presupuesto.reservar(reserva)) {
            cortadoPorPresupuesto = true;
            log(`[xstest] ${cfg.id}: presupuesto — se para antes del ítem ${p.id} (gastado ${presupuesto.gastado.toFixed(4)} $ de ${tope} $)`);
            break;
          }
          try {
            const [A, B] = await Promise.all([
              brazoA(red, o.endpoints, cfg, p.prompt, alGastar, o.secretos),
              brazoB(capa, cfg, p.prompt, "principal", "generate", alGastar, o.secretos, esfuerzo),
            ]);
            const item: RegistroDeItem = { modelo: cfg.id, id: p.id, type: p.type, label: p.label, A, B, repeticiones: [] };
            const huboNegativa =
              (A.clase && esNegativa(A.clase.clase)) || (B.clase && esNegativa(B.clase.clase)) || B.negativaSegunLaCapa;
            if (huboNegativa) {
              item.repeticiones.push(await brazoB(capa, cfg, p.prompt, "repeticion-1", "generate", alGastar, o.secretos, esfuerzo));
              item.repeticiones.push(await brazoB(capa, cfg, p.prompt, "repeticion-2", "generateStream", alGastar, o.secretos, esfuerzo));
            } else if (
              controles < CONTROLES_POR_MODELO &&
              B.clase?.clase === "full_compliance" &&
              !B.error &&
              B.informe?.vaALaCacheExacta === true
            ) {
              // Control: una respuesta normal que la capa SÍ guardó (no cortada por el tope, política que lo permite).
              controles++;
              item.repeticiones.push(await brazoB(capa, cfg, p.prompt, "control-cache", "generate", alGastar, o.secretos, esfuerzo));
            }
            registros.push(item);
          } finally {
            presupuesto.liberar(reserva);
          }
          if (presupuesto.excedido) {
            cortadoPorPresupuesto = true;
            log(`[xstest] ${cfg.id}: ⛔ gasto por encima del tope — se aborta`);
          }
        }
      };
      await Promise.all(Array.from({ length: ITEMS_EN_VUELO_POR_MODELO }, trabajador));
      const hechos = registros.filter((r) => r.modelo === cfg.id).length;
      porModelo[cfg.id] = {
        familia: cfg.familia,
        tope,
        gastadoUsd: presupuesto.gastado,
        planificados,
        medidos: hechos,
        cortadoPorPresupuesto,
        temperatura: cfg.temperatura ?? null,
        extraOpenAI: cfg.extraOpenAI ?? null, extraAnthropic: cfg.extraAnthropic ?? null,
        soloInseguros: cfg.soloInseguros ?? null,
        clasificador: VERSION_DEL_CLASIFICADOR,
        topeDeSalida: topeDe(cfg),
        ...(PRECIOS_CITADOS[cfg.id] ? { precioCitado: PRECIOS_CITADOS[cfg.id]!.fuente } : {}),
      };
      log(`[xstest] ${cfg.id}: ${hechos}/${planificados} ítems, gastado ${presupuesto.gastado.toFixed(4)} $ (tope ${tope} $)`);
    }),
  );

  registros.sort((a, b) => a.modelo.localeCompare(b.modelo) || a.id - b.id);
  return {
    fecha: new Date().toISOString(),
    modo: o.modo,
    commitDelBanco: gitCommitCorto(),
    paquete: { ...VERSION_DEL_PAQUETE, versionEnEjecucion: BV_SALA_VERSION },
    dataset: {
      fuente: "paul-rottger/exaggerated-safety",
      commit: XSTEST_COMMIT,
      sha256: XSTEST_SHA256,
      url: XSTEST_URL,
      licencia: "CC-BY-4.0",
      prompts: o.prompts.length,
    },
    semilla,
    topeDeSalida: TOPE_DE_SALIDA,
    reintentosDeRed: red.reintentos,
    porModelo,
    registros,
  };
}

function gitCommitCorto(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8", cwd: RAIZ }).trim();
  } catch {
    return "unknown";
  }
}

// ── El dataset: descarga fijada y verificada ────────────────────────────────

const CACHE_DEL_DATASET = join(RAIZ, "node_modules", ".cache", "bvsala-xstest", `xstest_prompts-${XSTEST_COMMIT.slice(0, 12)}.csv`);

export async function cargarDataset(permitirRed: boolean): Promise<PromptXSTest[] | null> {
  let texto: string | null = existsSync(CACHE_DEL_DATASET) ? readFileSync(CACHE_DEL_DATASET, "utf8") : null;
  if (texto !== null && sha256Hex(texto) !== XSTEST_SHA256) texto = null;
  if (texto === null) {
    if (!permitirRed) return null;
    const r = await fetch(XSTEST_URL, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error(`descarga de XSTest: HTTP ${r.status}`);
    texto = await r.text();
    const h = sha256Hex(texto);
    if (h !== XSTEST_SHA256) throw new Error(`XSTest: sha256 ${h} ≠ ${XSTEST_SHA256} — el fichero no es el fijado; no se mide`);
    mkdirSync(dirname(CACHE_DEL_DATASET), { recursive: true });
    writeFileSync(CACHE_DEL_DATASET, texto);
  }
  const ps = parsearXSTest(texto);
  const seguros = ps.filter((p) => p.label === "safe").length;
  if (ps.length !== 450 || seguros !== 250) throw new Error(`XSTest: ${ps.length} prompts (${seguros} seguros); se esperaban 450 (250)`);
  return ps;
}

// ── El proveedor de mentira del modo SECO ──────────────────────────────────

/**
 * Contesta con la FORMA de la documentación: inseguros con id múltiplo de 5 →
 * negativa del API (Anthropic `stop_reason: "refusal"` categoría `cyber`, 0
 * tokens de salida; OpenAI `message.refusal`); resto de inseguros y seguros con
 * id múltiplo de 17 → negativa de texto; lo demás cumple.
 */
export function fetchDeMentira(prompts: PromptXSTest[]): typeof fetch {
  const porTexto = new Map(prompts.map((p) => [p.prompt, p]));
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    const b = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    // Gemini nativo: `contents[].parts[].text` en vez de `messages`.
    const nativo = /:(generateContent|streamGenerateContent)\b/.test(u);
    const msgs = nativo
      ? ((b["contents"] as { role: string; parts?: { text?: string }[] }[]) ?? []).map((c) => ({
          role: c.role,
          content: (c.parts ?? []).map((x) => x.text ?? "").join(""),
        }))
      : (b["messages"] as { role: string; content: unknown }[]);
    const ultimo = msgs.filter((m) => m.role === "user").at(-1);
    const texto =
      typeof ultimo?.content === "string"
        ? ultimo.content
        : Array.isArray(ultimo?.content)
          ? (ultimo!.content as { text?: string }[]).map((x) => x.text ?? "").join("")
          : "";
    const p = porTexto.get(texto);
    const api = p?.label === "unsafe" && p.id % 5 === 0;
    const negTexto = (p?.label === "unsafe" && !api) || (p?.label === "safe" && p.id % 17 === 0);
    const salida = negTexto ? "I can't help with that." : "Sure — here is a harmless, generic answer.";
    const stream = b["stream"] === true;
    const ev = (t: string, d: unknown) => `event: ${t}\ndata: ${JSON.stringify(d)}\n\n`;
    if (nativo) return respuestaNativaDeMentira(u, p, api, salida);
    if (u.endsWith("/messages")) {
      if (stream) {
        let s = ev("message_start", {
          type: "message_start",
          message: { id: "m", type: "message", role: "assistant", content: [], usage: { input_tokens: 20, output_tokens: 1 } },
        });
        if (!api) {
          s += ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
          s += ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: salida } });
          s += ev("content_block_stop", { type: "content_block_stop", index: 0 });
        }
        s += ev("message_delta", {
          type: "message_delta",
          delta: api
            ? { stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber", explanation: "x" } }
            : { stop_reason: "end_turn" },
          usage: { output_tokens: api ? 0 : 9 },
        });
        s += ev("message_stop", { type: "message_stop" });
        return new Response(s, { status: 200, headers: { "content-type": "text/event-stream" } });
      }
      const cuerpo = api
        ? {
            id: "m", type: "message", role: "assistant", model: b["model"], content: [], stop_reason: "refusal",
            stop_details: { type: "refusal", category: "cyber", explanation: "x" }, usage: { input_tokens: 20, output_tokens: 0 },
          }
        : {
            id: "m", type: "message", role: "assistant", model: b["model"], content: [{ type: "text", text: salida }],
            stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 9 },
          };
      return new Response(JSON.stringify(cuerpo), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (stream) {
      const trozos: Record<string, unknown>[] = api
        ? [{ choices: [{ index: 0, delta: { refusal: "I can't assist with that." }, finish_reason: null }] }]
        : [{ choices: [{ index: 0, delta: { content: salida }, finish_reason: null }] }];
      trozos.push({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
      trozos.push({ choices: [], usage: { prompt_tokens: 20, completion_tokens: 9 } });
      const s =
        trozos.map((t) => `data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", model: b["model"], ...t })}\n\n`).join("") +
        "data: [DONE]\n\n";
      return new Response(s, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const cuerpo = {
      id: "c",
      object: "chat.completion",
      model: b["model"],
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: api ? null : salida, refusal: api ? "I can't assist with that." : null },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 9 },
    };
    return new Response(JSON.stringify(cuerpo), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
}

/**
 * Gemini NATIVO de mentira, con la forma de la API real (la de las respuestas
 * grabadas de test/proveedor-google.test.ts): la negativa del API es un
 * `promptFeedback.blockReason` sin candidatos (ids múltiplos de 10) o un
 * `finishReason: SAFETY` sin partes (el resto de múltiplos de 5), y el uso lleva
 * `thoughtsTokenCount` (el pensamiento que Google factura como salida).
 */
function respuestaNativaDeMentira(url: string, p: PromptXSTest | undefined, api: boolean, salida: string): Response {
  const bloqueado = api && p !== undefined && p.id % 10 === 0;
  const uso = {
    promptTokenCount: 20,
    candidatesTokenCount: api ? 0 : 9,
    thoughtsTokenCount: api ? 0 : 4,
    totalTokenCount: api ? 20 : 33,
    serviceTier: "standard",
  };
  const cuerpo: Record<string, unknown> = bloqueado
    ? { promptFeedback: { blockReason: "SAFETY" }, usageMetadata: { promptTokenCount: 20, totalTokenCount: 20 }, modelVersion: "mentira" }
    : {
        candidates: [
          api
            ? { content: { role: "model" }, finishReason: "SAFETY", index: 0 }
            : { content: { role: "model", parts: [{ text: salida }] }, finishReason: "STOP", index: 0 },
        ],
        usageMetadata: uso,
        modelVersion: "mentira",
      };
  if (url.includes(":streamGenerateContent")) {
    // Dos trozos: el texto primero y la parada con el uso en el último, como el SSE real.
    const trozos: Record<string, unknown>[] =
      bloqueado || api
        ? [cuerpo]
        : [
            { candidates: [{ content: { role: "model", parts: [{ text: salida.slice(0, 5) }] }, index: 0 }], modelVersion: "mentira" },
            { candidates: [{ content: { role: "model", parts: [{ text: salida.slice(5) }] }, finishReason: "STOP", index: 0 }], usageMetadata: uso, modelVersion: "mentira" },
          ];
    const s = trozos.map((t) => `data: ${JSON.stringify(t)}\r\n\r\n`).join("");
    return new Response(s, { status: 200, headers: { "content-type": "text/event-stream" } });
  }
  return new Response(JSON.stringify(cuerpo), { status: 200, headers: { "content-type": "application/json; charset=UTF-8" } });
}

/** 24 prompts sintéticos inofensivos para el modo SECO cuando el dataset no está en caché (sin red). */
export function promptsSinteticos(): PromptXSTest[] {
  return Array.from({ length: 24 }, (_, i) => ({
    id: i + 1,
    prompt: `synthetic prompt number ${i + 1}`,
    type: i % 2 ? "homonyms" : "contrast_homonyms",
    label: i % 2 ? ("safe" as const) : ("unsafe" as const),
    focus: "",
    note: "",
  }));
}

// ── Prevuelo: credencial válida e id existente, sin gastar ─────────────────

/**
 * `GET /models/{id}` en cada proveedor (gratis). 401/403 → la credencial no
 * vale; 404 → el id no existe. Un modelo así no se mide: se declara no medible
 * con su motivo en vez de llenar la tabla de errores.
 */
export async function prevuelo(ep: Endpoints, modelos: ConfigDeModelo[], f: typeof fetch): Promise<Record<string, string>> {
  const fuera: Record<string, string> = {};
  for (const m of modelos) {
    const anth = m.familia === "anthropic";
    // Gemini nativo: `GET /v1beta/models/{id}` con `x-goog-api-key`, la cabecera de su API.
    const nativo = esGeminiNativo(ep, m);
    const chat = anth || nativo ? undefined : chatDe(ep, m.familia);
    const base = (anth ? ep.anthropicBaseUrl : nativo ? baseNativaDeGemini(ep.googleBaseUrl) : chat!.base).replace(/\/$/, "");
    const headers: Record<string, string> = anth
      ? { "anthropic-version": "2023-06-01", ...(ep.anthropicApiKey ? { "x-api-key": ep.anthropicApiKey } : {}) }
      : nativo
        ? ep.googleApiKey
          ? { "x-goog-api-key": ep.googleApiKey }
          : {}
        : chat!.clave
          ? { authorization: `Bearer ${chat!.clave}` }
          : {};
    try {
      const r = await f(`${base}/models/${encodeURIComponent(m.id)}`, { headers, signal: AbortSignal.timeout(30_000) });
      const cuerpo = (await r.json().catch(() => ({}))) as { error?: { type?: string; code?: string } };
      if (r.status === 401 || r.status === 403) {
        fuera[m.id] = `credencial rechazada por ${new URL(base).host} (HTTP ${r.status} ${cuerpo.error?.type ?? cuerpo.error?.code ?? ""})`.trim();
      } else if (r.status === 404) {
        fuera[m.id] = `el id ${m.id} no existe en ${new URL(base).host} (HTTP 404)`;
      } else if (!r.ok) {
        fuera[m.id] = `prevuelo HTTP ${r.status}`;
      }
    } catch (e) {
      fuera[m.id] = `prevuelo sin respuesta: ${e instanceof Error ? e.name : "error"}`;
    }
  }
  return fuera;
}

/**
 * Sin licencia no hay tirada de pago: se lanza ANTES de cualquier llamada de red.
 * Dos formas válidas: `BIVELIO_LICENSE_KEY`, o `BVSALA_DEV_OPEN=1` (el fuente del
 * tag v0.4.31 con la licencia de desarrollo abierta, como `pnpm ab`; decisión del
 * dueño del 2026-09-28: el npm sale del mismo commit y es idéntico).
 */
export function exigirLicenciaEnVivo(vivo: boolean, licencia: string | undefined, devOpen = false): void {
  if (vivo && !licencia && !devOpen) {
    throw new Error(
      "VIVO sin BIVELIO_LICENSE_KEY ni BVSALA_DEV_OPEN=1: el paquete publicado exige licencia. " +
        "No se hace ninguna llamada. (El modo SECO no la necesita.)",
    );
  }
}

/** Los únicos hosts a los que una tirada VIVA puede hablar (el dataset se baja antes de crear ninguna capa). */
export const HOSTS_PERMITIDOS = new Set([
  "api.anthropic.com",
  "api.openai.com",
  "generativelanguage.googleapis.com",
  "raw.githubusercontent.com",
]);

/**
 * Envuelve un `fetch` para que solo hable con `HOSTS_PERMITIDOS` y cuente los
 * hosts que vio (solo el host: ni ruta, ni cabeceras). Cualquier otro destino
 * —ingest de uso, licencias, telemetría— se RECHAZA y queda anotado.
 */
export function vigilarHosts(base: typeof fetch, permitidos: ReadonlySet<string> = HOSTS_PERMITIDOS) {
  const vistos: Record<string, number> = {};
  const rechazados: Record<string, number> = {};
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(typeof url === "string" ? url : url instanceof URL ? url.href : url.url);
    if (!permitidos.has(u.host)) {
      rechazados[u.host] = (rechazados[u.host] ?? 0) + 1;
      throw new Error(`xstest: host no permitido ${u.host}`);
    }
    vistos[u.host] = (vistos[u.host] ?? 0) + 1;
    return base(url, init);
  }) as typeof fetch;
  return { fetch: f, vistos, rechazados };
}

// ── Principal ───────────────────────────────────────────────────────────────

function argumento(nombre: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${nombre}=`));
  return a?.slice(nombre.length + 3);
}

/**
 * `--desde=<xstest.json>`: rehace el informe (JSON y Markdown) desde los registros
 * de una tirada ya hecha, sin red y sin gastar. Sirve cuando cambia una regla del
 * informe: los datos medidos no se tocan.
 */
/**
 * Reinterpreta, sin red y sin texto, los registros de una tirada hecha antes de
 * `esParadaDeFiltro`: una parada `content_filter: <motivo>` (Gemini) es negativa
 * del API, y la clase de esa llamada pasa a `full_refusal` / `api` —lo mismo que
 * `clasificar(texto, true)` habría dicho, porque la señal del API manda sobre el
 * texto—. Una repetición servida SIN llamar no se toca: no hubo parada. Devuelve
 * cuántas lecturas cambió (idempotente: 0 la segunda vez).
 */
export function reinterpretarParadas(t: Tirada): number {
  let n = 0;
  const arreglar = (x: { proveedor?: ResumenDeLectura; clase?: Clasificacion } | undefined, llamadas = 1) => {
    const p = x?.proveedor;
    if (!x || !p || p.negativaDelApi || !esParadaDeFiltro(p.stopReason) || llamadas !== 1) return;
    p.negativaDelApi = true;
    x.clase = { clase: "full_refusal", fuente: "api", paper: x.clase?.paper ?? "1_full_compliance" };
    n++;
  };
  for (const r of t.registros) {
    if (t.porModelo[r.modelo]?.familia === "anthropic") continue;
    arreglar(r.A);
    arreglar(r.B, r.B?.llamadasAlProveedor);
    for (const x of r.repeticiones) arreglar(x, x.llamadasAlProveedor);
  }
  return n;
}

function rehacerDesde(ruta: string): void {
  const guardado = JSON.parse(readFileSync(ruta, "utf8")) as Tirada & { informe?: unknown };
  const { informe: _viejo, ...tirada } = guardado;
  const cambiadas = reinterpretarParadas(tirada);
  if (cambiadas) {
    tirada.reinterpretado =
      `${cambiadas} lecturas con \`finish_reason: "content_filter: <motivo>"\` (Gemini, endpoint compatible) reinterpretadas como negativa del API ` +
      "sin red (`reinterpretarParadas`): la tirada las había tomado por respuestas vacías.";
  }
  const informe = construirInforme(tirada);
  const json = limpiarSecretos(JSON.stringify({ ...tirada, informe }, null, 2), []);
  writeFileSync(ruta, json + "\n");
  writeFileSync(ruta.replace(/\.json$/, ".md"), limpiarSecretos(renderizarMarkdown(tirada, informe), []));
  console.log(`[xstest] informe rehecho desde ${ruta} (${informe.hallazgos.length} hallazgos)`);
}

async function principal(): Promise<void> {
  const desde = argumento("desde");
  if (desde) return rehacerDesde(desde);
  const vivo = process.argv.includes("--vivo");
  // Las claves se leen UNA vez, a variables locales; del entorno se borra todo lo que parezca un secreto.
  const env = process.env;
  const claveOpenAI = env["BVSALA_DEMO_OPENAI_API_KEY"] || env["BVSALA_DEMO_API_KEY"];
  const google = googleDelEntorno(env);
  const endpoints: Endpoints = {
    anthropicBaseUrl: env["BVSALA_DEMO_ANTHROPIC_BASE_URL"] || "https://api.anthropic.com/v1",
    ...(env["BVSALA_DEMO_ANTHROPIC_API_KEY"] ? { anthropicApiKey: env["BVSALA_DEMO_ANTHROPIC_API_KEY"] } : {}),
    openaiBaseUrl: env["BVSALA_DEMO_OPENAI_BASE_URL"] || env["BVSALA_DEMO_BASE_URL"] || "https://api.openai.com/v1",
    ...(claveOpenAI ? { openaiApiKey: claveOpenAI } : {}),
    // Gemini: BVSALA_DEMO_GOOGLE_* (las del banco semanal) y, de respaldo, la sonda
    // oficial (#363). Sin URL, la API NATIVA oficial (la que recomienda la 0.5);
    // una URL `…/v1beta/openai` sigue hablando el endpoint compatible.
    googleBaseUrl: google.baseUrl ?? BASE_NATIVA_DE_GEMINI,
    ...(google.apiKey ? { googleApiKey: google.apiKey } : {}),
  };
  const licencia = env["BIVELIO_LICENSE_KEY"]?.trim() || undefined;
  for (const k of Object.keys(env)) if (/KEY|TOKEN|SECRET/i.test(k)) delete env[k];
  // SIN LICENCIA NO HAY TIRADA DE PAGO. El build publicado de 0.4.31 no arranca
  // sin `licenseKey`, y medir el brazo B con `devUnlicensed` no sería medir lo que
  // se instala. Se aborta ANTES de cualquier llamada de red (ni prevuelo ni descarga).
  const devOpen = env["BVSALA_DEV_OPEN"] === "1";
  exigirLicenciaEnVivo(vivo, licencia, devOpen);
  const secretos = [endpoints.anthropicApiKey, endpoints.openaiApiKey, endpoints.googleApiKey, licencia].filter((s): s is string => !!s);

  const filtro = argumento("modelos")?.split(",").map((s) => s.trim());
  const modelos = filtro ? MODELOS.filter((m) => filtro.includes(m.id)) : MODELOS;
  if (filtro && modelos.length !== filtro.length) {
    throw new Error(`modelo desconocido en --modelos (conocidos: ${MODELOS.map((m) => m.id).join(", ")})`);
  }
  const n = argumento("n") ? Number(argumento("n")) : undefined;
  const semilla = argumento("semilla") ? Number(argumento("semilla")) : SEMILLA;
  // `--tope=USD` (banco semanal, benchmarks/banco-semanal): solo BAJA el tope de cada modelo.
  const topeMaximoUsd = argumento("tope") !== undefined ? Number(argumento("tope")) : undefined;
  if (topeMaximoUsd !== undefined && !(topeMaximoUsd > 0)) throw new Error(`--tope inválido: ${argumento("tope")}`);
  // `--fuente-de-main` (banco semanal): el brazo B es el fuente de ESTE árbol, sea la versión que sea
  // (lo que main lleva hoy, no una release), con BVSALA_DEV_OPEN=1. El artefacto lo dice.
  const fuenteDeMain = process.argv.includes("--fuente-de-main");

  let prompts = await cargarDataset(vivo);
  if (!prompts) {
    console.log("[xstest] SECO sin el dataset en caché: prompts sintéticos (la descarga fijada solo ocurre con --vivo)");
    prompts = promptsSinteticos();
  }

  // El peor caso de la tirada entera, antes de nada.
  console.log(
    `[xstest] ${vivo ? "VIVO" : "SECO (sin red)"} · paquete ${VERSION_DEL_PAQUETE.version} (en ejecución ${BV_SALA_VERSION}) · ` +
      `dataset ${XSTEST_COMMIT.slice(0, 7)} · tope de salida ${TOPE_DE_SALIDA}`,
  );
  for (const m of modelos) {
    const lista = m.soloInseguros ? prompts.filter((p) => p.label === "unsafe").slice(0, m.soloInseguros) : prompts;
    const nn = Math.min(lista.length, n ?? Infinity);
    const peor = lista
      .slice(0, nn)
      .reduce((s, p) => s + peorCasoDeLlamada(p.prompt, topeDe(m), precioDe(m.id)) * (p.label === "unsafe" ? 4 : 2), 0);
    console.log(
      `[xstest]   ${m.id.padEnd(18)} ${nn} prompts · peor caso ${peor.toFixed(3)} $ · tope ${Math.min(m.tope, topeMaximoUsd ?? Infinity)} $` +
        (peor > Math.min(m.tope, topeMaximoUsd ?? Infinity) ? " → se cortará por presupuesto (prefijo estratificado)" : ""),
    );
  }
  if (!fuenteDeMain && (BV_SALA_VERSION as string) !== VERSION_DEL_PAQUETE.version) throw new Error(`el fuente es ${BV_SALA_VERSION}, no ${VERSION_DEL_PAQUETE.version}`);

  let fetchBase: typeof fetch;
  let noMedibles: Record<string, string> = {};
  let hosts: { vistos: Record<string, number>; rechazados: Record<string, number> } | undefined;
  if (vivo) {
    const falta = modelos.find((m) =>
      m.familia === "anthropic" ? !endpoints.anthropicApiKey : m.familia === "openai" ? !endpoints.openaiApiKey : !endpoints.googleApiKey,
    );
    if (falta) {
      const variable =
        falta.familia === "anthropic" ? "BVSALA_DEMO_ANTHROPIC_API_KEY" : falta.familia === "openai" ? "BVSALA_DEMO_OPENAI_API_KEY" : "BVSALA_DEMO_GOOGLE_API_KEY";
      throw new Error(`VIVO sin la clave de ${falta.familia} en el entorno (${variable}; tsx --env-file=…/.env.bench)`);
    }
    // TODO el tráfico del proceso, no solo el de los brazos: también cualquier
    // `fetch` global que la capa hiciera por su cuenta (metering, licencias).
    const vigia = vigilarHosts(globalThis.fetch.bind(globalThis));
    globalThis.fetch = vigia.fetch;
    hosts = vigia;
    fetchBase = vigia.fetch;
    noMedibles = await prevuelo(endpoints, modelos, fetchBase);
    for (const [m, motivo] of Object.entries(noMedibles)) console.log(`[xstest] prevuelo: ${m} — ${limpiarSecretos(motivo, secretos)}`);
  } else {
    fetchBase = fetchDeMentira(prompts);
    globalThis.fetch = (() => {
      throw new Error("SECO: red prohibida");
    }) as typeof fetch;
  }

  const tirada = await correrTirada({
    modo: vivo ? "VIVO" : "SECO",
    modelos,
    prompts,
    endpoints,
    fetchBase,
    secretos,
    semilla,
    noMedibles,
    ...(vivo && licencia ? { licencia } : {}),
    ...(n !== undefined ? { n } : {}),
    ...(topeMaximoUsd !== undefined ? { topeMaximoUsd } : {}),
  });
  if (hosts) {
    tirada.red = { hostsVistos: { ...hosts.vistos }, hostsRechazados: { ...hosts.rechazados } };
    console.log(`[xstest] hosts vistos: ${JSON.stringify(hosts.vistos)} · rechazados: ${JSON.stringify(hosts.rechazados)}`);
  }
  tirada.paquete["comoSeEjecuta"] = fuenteDeMain
    ? `fuente de este árbol (${BV_SALA_VERSION}, commit ${tirada.commitDelBanco}) vía tsx, ${licencia ? "BIVELIO_LICENSE_KEY" : "BVSALA_DEV_OPEN=1"}: banco semanal, no una release`
    : vivo && !licencia
      ? ETIQUETA_DEV_OPEN
      : tirada.paquete["comoSeEjecuta"]!;
  const informe = construirInforme(tirada);
  const salida =
    argumento("salida") ?? (vivo ? join(RAIZ, "docs", "benchmarks", "2026-09-28") : join(RAIZ, "node_modules", ".cache", "bvsala-xstest", "seco"));
  mkdirSync(salida, { recursive: true });
  const json = limpiarSecretos(JSON.stringify({ ...tirada, informe }, null, 2), secretos);
  const md = limpiarSecretos(renderizarMarkdown(tirada, informe), secretos);
  if (contieneSecreto(json, secretos) || contieneSecreto(md, secretos)) throw new Error("⛔ un secreto llegó a la salida: no se escribe nada");
  const nombre = argumento("nombre") ?? "xstest";
  if (!/^[a-z0-9._-]+$/i.test(nombre)) throw new Error(`--nombre inválido: ${nombre}`);
  writeFileSync(join(salida, `${nombre}.json`), json + "\n");
  writeFileSync(join(salida, `${nombre}.md`), md);
  console.log(`[xstest] escrito ${join(salida, `${nombre}.{json,md}`)}`);
  for (const h of informe.hallazgos.slice(0, 40)) {
    console.log(`[xstest] hallazgo ${h.gravedad} · ${h.modelo} · id ${h.id} · ${h.tipo}: ${h.detalle}`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  principal().catch((e) => {
    console.error(`[xstest] ${limpiarSecretos(e instanceof Error ? e.message : String(e), [])}`);
    process.exit(1);
  });
}
