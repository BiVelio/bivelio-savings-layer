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
  /** Campos extra del cuerpo de Chat Completions en los dos brazos (p. ej. `reasoning_effort`). */
  extraOpenAI?: Record<string, unknown>;
  /** Solo prompts inseguros, y cuántos (Opus 5.5: ver `stop_reason: "refusal"` real). */
  soloInseguros?: number;
}

export const MODELOS: ConfigDeModelo[] = [
  { id: "claude-haiku-4-5", familia: "anthropic", tope: 1.2, temperatura: 0 },
  { id: "claude-sonnet-5", familia: "anthropic", tope: 1.2, temperatura: 0 },
  // 0,80 $ por modelo de OpenAI (A + B + repeticiones): tope duro del coordinador
  // para la tirada de la 0.4.31, con otras tres baterías gastando las mismas claves.
  { id: "gpt-4o-mini", familia: "openai", tope: 0.8, temperatura: 0 },
  // gpt-5.x razona: sin esfuerzo mínimo, el tope de salida se lo comería el razonamiento.
  { id: "gpt-5.4-mini", familia: "openai", tope: 0.8, extraOpenAI: { reasoning_effort: "none" } },
  { id: "claude-opus-5-5", familia: "anthropic", tope: 0.9, temperatura: 0, soloInseguros: 20 },
];

/** Tope de tokens de salida, igual en A y B. La clasificación de la paper mira el principio. */
export const TOPE_DE_SALIDA = 160;
export const SEMILLA = 20260928;
const CONCURRENCIA_POR_PROVEEDOR = 4;
const ITEMS_EN_VUELO_POR_MODELO = 2;
const CONTROLES_POR_MODELO = 5;

function precioDe(modelo: string): Precio {
  const p = (CATALOGO as Record<string, Precio | undefined>)[modelo];
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
      const campo = (["max_tokens", "max_completion_tokens"] as const).find((k) => b[k] !== undefined);
      if (!campo) throw new Error(`banco: el cuerpo del brazo ${ctx.brazo} salió sin tope de salida — no se envía`);
      ctx.topes.push(`${campo}=${String(b[campo])}`);
      if (ctx.brazo === "B" && ctx.familia === "openai") {
        for (const [k, v] of Object.entries(cfg.extraOpenAI ?? {})) {
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
    if (cfg.familia === "anthropic") {
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
          max_tokens: TOPE_DE_SALIDA,
          messages: [{ role: "user", content: prompt }],
          ...(cfg.temperatura !== undefined ? { temperature: cfg.temperatura } : {}),
        }),
      });
    } else {
      const base = ep.openaiBaseUrl.replace(/\/$/, "");
      await red.fetch(`${base}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(ep.openaiApiKey ? { authorization: `Bearer ${ep.openaiApiKey}` } : {}),
        },
        body: JSON.stringify({
          model: cfg.id,
          messages: [{ role: "user", content: prompt }],
          max_completion_tokens: TOPE_DE_SALIDA,
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
  const provider: Provider =
    cfg.familia === "anthropic"
      ? new AnthropicProvider({
          baseUrl: ep.anthropicBaseUrl,
          ...(ep.anthropicApiKey ? { apiKey: ep.anthropicApiKey } : {}),
          stripProviderPrefix: true,
          requireUsage: true,
          fetchImpl: red.fetch,
        })
      : new OpenAICompatibleProvider({
          baseUrl: ep.openaiBaseUrl,
          ...(ep.openaiApiKey ? { apiKey: ep.openaiApiKey } : {}),
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
): Promise<RegistroB> {
  const precio = precioDe(cfg.id);
  const req = {
    model: `${cfg.familia}/${cfg.id}`,
    messages: [{ role: "user" as const, content: prompt }],
    // El tope NATIVO de la 0.4.31 (el mismo valor que A); ya no lo inyecta el banco.
    maxOutputTokens: TOPE_DE_SALIDA,
    ...(cfg.temperatura !== undefined ? { temperature: cfg.temperatura } : {}),
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
    clase: clasificar(res.text ?? "", negativaCapa),
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
      const tope = Math.min(cfg.tope, cfg.id.startsWith("claude-opus") ? TOPE_DURO_OPUS_USD : TOPE_DURO_POR_MODELO_USD);
      const motivo = o.noMedibles?.[cfg.id];
      if (motivo) {
        porModelo[cfg.id] = {
          familia: cfg.familia, tope, gastadoUsd: 0, planificados: 0, medidos: 0, cortadoPorPresupuesto: false,
          temperatura: cfg.temperatura ?? null, extraOpenAI: cfg.extraOpenAI ?? null, soloInseguros: cfg.soloInseguros ?? null,
          noMedible: motivo,
        };
        log(`[xstest] ${cfg.id}: NO MEDIBLE — ${motivo}`);
        return;
      }
      const presupuesto = new Presupuesto(tope);
      const precio = precioDe(cfg.id);
      let lista = cfg.soloInseguros ? orden.filter((p) => p.label === "unsafe").slice(0, cfg.soloInseguros) : orden;
      if (o.n !== undefined) lista = lista.slice(0, o.n);
      const capa = crearCapa(red, o.endpoints, cfg, o.licencia);
      const alGastar = (usd: number) => presupuesto.gastar(usd);
      let controles = 0;
      let cortadoPorPresupuesto = false;
      let siguiente = 0;
      const planificados = lista.length;

      const trabajador = async () => {
        while (siguiente < lista.length && !cortadoPorPresupuesto) {
          const p = lista[siguiente++]!;
          const unaLlamada = peorCasoDeLlamada(p.prompt, TOPE_DE_SALIDA, precio);
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
              brazoB(capa, cfg, p.prompt, "principal", "generate", alGastar, o.secretos),
            ]);
            const item: RegistroDeItem = { modelo: cfg.id, id: p.id, type: p.type, label: p.label, A, B, repeticiones: [] };
            const huboNegativa =
              (A.clase && esNegativa(A.clase.clase)) || (B.clase && esNegativa(B.clase.clase)) || B.negativaSegunLaCapa;
            if (huboNegativa) {
              item.repeticiones.push(await brazoB(capa, cfg, p.prompt, "repeticion-1", "generate", alGastar, o.secretos));
              item.repeticiones.push(await brazoB(capa, cfg, p.prompt, "repeticion-2", "generateStream", alGastar, o.secretos));
            } else if (
              controles < CONTROLES_POR_MODELO &&
              B.clase?.clase === "full_compliance" &&
              !B.error &&
              B.informe?.vaALaCacheExacta === true
            ) {
              // Control: una respuesta normal que la capa SÍ guardó (no cortada por el tope, política que lo permite).
              controles++;
              item.repeticiones.push(await brazoB(capa, cfg, p.prompt, "control-cache", "generate", alGastar, o.secretos));
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
        extraOpenAI: cfg.extraOpenAI ?? null,
        soloInseguros: cfg.soloInseguros ?? null,
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
    const msgs = b["messages"] as { role: string; content: unknown }[];
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
    const base = (anth ? ep.anthropicBaseUrl : ep.openaiBaseUrl).replace(/\/$/, "");
    const headers: Record<string, string> = anth
      ? { "anthropic-version": "2023-06-01", ...(ep.anthropicApiKey ? { "x-api-key": ep.anthropicApiKey } : {}) }
      : ep.openaiApiKey
        ? { authorization: `Bearer ${ep.openaiApiKey}` }
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
export const HOSTS_PERMITIDOS = new Set(["api.anthropic.com", "api.openai.com", "raw.githubusercontent.com"]);

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
function rehacerDesde(ruta: string): void {
  const guardado = JSON.parse(readFileSync(ruta, "utf8")) as Tirada & { informe?: unknown };
  const { informe: _viejo, ...tirada } = guardado;
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
  const endpoints: Endpoints = {
    anthropicBaseUrl: env["BVSALA_DEMO_ANTHROPIC_BASE_URL"] || "https://api.anthropic.com/v1",
    ...(env["BVSALA_DEMO_ANTHROPIC_API_KEY"] ? { anthropicApiKey: env["BVSALA_DEMO_ANTHROPIC_API_KEY"] } : {}),
    openaiBaseUrl: env["BVSALA_DEMO_OPENAI_BASE_URL"] || env["BVSALA_DEMO_BASE_URL"] || "https://api.openai.com/v1",
    ...(claveOpenAI ? { openaiApiKey: claveOpenAI } : {}),
  };
  const licencia = env["BIVELIO_LICENSE_KEY"]?.trim() || undefined;
  for (const k of Object.keys(env)) if (/KEY|TOKEN|SECRET/i.test(k)) delete env[k];
  // SIN LICENCIA NO HAY TIRADA DE PAGO. El build publicado de 0.4.31 no arranca
  // sin `licenseKey`, y medir el brazo B con `devUnlicensed` no sería medir lo que
  // se instala. Se aborta ANTES de cualquier llamada de red (ni prevuelo ni descarga).
  const devOpen = env["BVSALA_DEV_OPEN"] === "1";
  exigirLicenciaEnVivo(vivo, licencia, devOpen);
  const secretos = [endpoints.anthropicApiKey, endpoints.openaiApiKey, licencia].filter((s): s is string => !!s);

  const filtro = argumento("modelos")?.split(",").map((s) => s.trim());
  const modelos = filtro ? MODELOS.filter((m) => filtro.includes(m.id)) : MODELOS;
  if (filtro && modelos.length !== filtro.length) {
    throw new Error(`modelo desconocido en --modelos (conocidos: ${MODELOS.map((m) => m.id).join(", ")})`);
  }
  const n = argumento("n") ? Number(argumento("n")) : undefined;
  const semilla = argumento("semilla") ? Number(argumento("semilla")) : SEMILLA;

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
      .reduce((s, p) => s + peorCasoDeLlamada(p.prompt, TOPE_DE_SALIDA, precioDe(m.id)) * (p.label === "unsafe" ? 4 : 2), 0);
    console.log(
      `[xstest]   ${m.id.padEnd(18)} ${nn} prompts · peor caso ${peor.toFixed(3)} $ · tope ${m.tope} $` +
        (peor > m.tope ? " → se cortará por presupuesto (prefijo estratificado)" : ""),
    );
  }
  if ((BV_SALA_VERSION as string) !== VERSION_DEL_PAQUETE.version) throw new Error(`el fuente es ${BV_SALA_VERSION}, no ${VERSION_DEL_PAQUETE.version}`);

  let fetchBase: typeof fetch;
  let noMedibles: Record<string, string> = {};
  let hosts: { vistos: Record<string, number>; rechazados: Record<string, number> } | undefined;
  if (vivo) {
    if (!endpoints.anthropicApiKey || !endpoints.openaiApiKey) throw new Error("VIVO sin claves en el entorno (tsx --env-file=…/.env.bench)");
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
  });
  if (hosts) {
    tirada.red = { hostsVistos: { ...hosts.vistos }, hostsRechazados: { ...hosts.rechazados } };
    console.log(`[xstest] hosts vistos: ${JSON.stringify(hosts.vistos)} · rechazados: ${JSON.stringify(hosts.rechazados)}`);
  }
  tirada.paquete["comoSeEjecuta"] = vivo && !licencia ? ETIQUETA_DEV_OPEN : tirada.paquete["comoSeEjecuta"]!;
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
