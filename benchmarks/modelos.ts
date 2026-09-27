/**
 * LOS MODELOS DE LA TIRADA, SUS ENDPOINTS Y EL PREVUELO QUE DECIDE SI SE GASTA.
 * ---------------------------------------------------------------------------
 * Sin `process.env` dentro: quien llama (ab-live.ts, la sonda) pasa el entorno
 * como dato, y las verjas pasan uno de mentira. Así una tirada de pago no puede
 * empezar por una variable que nadie miró, y un test no puede convertirse en
 * una tirada de pago por una variable del shell.
 *
 * EL PRESET DE 2026 (informe de competencia, §8 rec. 3): el ≥10 % publicado se
 * midió en gpt-4o-mini, que ya no es el modelo con el que un comprador técnico
 * compara. Los ids son los de la pasarela (https://ai-gateway.vercel.sh/v1/models,
 * consultado 2026-09-27); por un endpoint directo viajan sin el prefijo.
 */
import { endpointDeModelo, hayEndpoints, type ConfigDeTransporte } from "./transporte.js";
import { precioYPrima as precioYPrimaDelCatalogo, type PrecioYPrima } from "./coste.js";
import {
  HERRAMIENTAS_SOLO_SIN_RAZONAMIENTO_EN_CHAT,
  desnudo,
  tieneModoDeCacheExplicito,
  validarEsfuerzo,
  type EsfuerzoB2,
} from "./nativo.js";
import { familiaDeModelo, razonaParaElBanco } from "./scenarios.js";

export interface ModeloDelPreset {
  id: string;
  familia: "openai" | "anthropic" | "google";
  /** Sin endpoint NATIVO no se mide: su B2 dependería de campos que la pasarela no tiene. */
  exigeNativo?: boolean;
}

export const PRESETS = {
  "2026": {
    modelos: [
      // Fuente: https://developers.openai.com/api/docs/models/gpt-6-luna (consultado 2026-09-27)
      { id: "openai/gpt-6-luna", familia: "openai" },
      // Fuente: https://platform.claude.com/docs/en/build-with-claude/effort (consultado 2026-09-27)
      { id: "anthropic/claude-sonnet-5", familia: "anthropic", exigeNativo: true },
      // Fuente: https://ai.google.dev/gemini-api/docs/pricing (act. 2026-09-24, consultado 2026-09-27)
      { id: "google/gemini-3.8-flash", familia: "google" },
    ],
    opcionales: [
      { id: "anthropic/claude-haiku-4-5", motivo: "sin `effort` (no figura en supportedModels): su B2 queda en B1 + caché" },
      {
        id: "openai/gpt-oss-120b",
        motivo:
          "pesos abiertos servidos por la pasarela (id en https://ai-gateway.vercel.sh/v1/models, 2026-09-27); sin fila de catálogo no se publica",
      },
    ],
  },
} as const;

export type NombreDePreset = keyof typeof PRESETS;

export interface ModelosResueltos {
  /** `null` = sin modelo forzado: cada escenario con el suyo (la tirada de siempre). */
  modelos: (string | null)[];
  /** Los que el prevuelo exige con endpoint nativo. */
  exigenNativo: string[];
  preset?: string;
  /** Algo impide empezar: la tirada aborta con este texto. */
  error?: string;
  aviso?: string;
}

type Entorno = Readonly<Record<string, string | undefined>>;

/**
 * Qué modelos mide la tirada: `BVSALA_AB_PRESET` (`2026` o `2026+optional`),
 * `BVSALA_DEMO_MODELS` (lista) o `BVSALA_DEMO_MODEL` (uno). El preset es
 * incompatible con los otros dos: si conviven —por ejemplo, un
 * `BVSALA_DEMO_MODEL` olvidado en `.env.bench`— la tirada no adivina cuál
 * querías y aborta.
 */
export function resolverModelos(env: Entorno): ModelosResueltos {
  const lista = (env["BVSALA_DEMO_MODELS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const uno = env["BVSALA_DEMO_MODEL"]?.trim() || undefined;
  const preset = env["BVSALA_AB_PRESET"]?.trim() || undefined;
  if (preset) {
    if (lista.length || uno) {
      return {
        modelos: [],
        exigenNativo: [],
        preset,
        error:
          "BVSALA_AB_PRESET and BVSALA_DEMO_MODEL(S) are both set (check .env.bench too): the run will not guess which " +
          "one you meant. Unset one of them.",
      };
    }
    const [nombre, extra] = preset.split("+");
    const p = (PRESETS as Record<string, (typeof PRESETS)["2026"] | undefined>)[nombre ?? ""];
    if (!p || (extra !== undefined && extra !== "optional")) {
      return {
        modelos: [],
        exigenNativo: [],
        preset,
        error: `unknown BVSALA_AB_PRESET=${preset}: use ${Object.keys(PRESETS).map((k) => `${k} or ${k}+optional`).join(", ")}`,
      };
    }
    const modelos: string[] = p.modelos.map((m) => m.id);
    if (extra === "optional") modelos.push(...p.opcionales.map((m) => m.id));
    return {
      modelos,
      exigenNativo: p.modelos.filter((m) => "exigeNativo" in m && m.exigeNativo).map((m) => m.id),
      preset,
    };
  }
  if (lista.length) {
    return {
      modelos: lista,
      exigenNativo: [],
      ...(uno ? { aviso: "BVSALA_DEMO_MODELS and BVSALA_DEMO_MODEL are both set: the list wins, as before" } : {}),
    };
  }
  return { modelos: uno ? [uno] : [null], exigenNativo: [] };
}

/**
 * La configuración de transporte desde un entorno. Por EXISTENCIA: aquí se
 * leen las claves para pasarlas al adaptador, y nada de lo que sale de esta
 * función se imprime nunca — el banco solo publica el host.
 */
export function configDesdeEntorno(env: Entorno): ConfigDeTransporte {
  const v = (k: string): string | undefined => env[k] || undefined;
  return {
    baseUrl: v("BVSALA_DEMO_BASE_URL"),
    apiKey: v("BVSALA_DEMO_API_KEY"),
    keepPrefix: !!v("BVSALA_DEMO_KEEP_PREFIX"),
    anthropicBaseUrl: v("BVSALA_DEMO_ANTHROPIC_BASE_URL"),
    anthropicApiKey: v("BVSALA_DEMO_ANTHROPIC_API_KEY"),
    openaiBaseUrl: v("BVSALA_DEMO_OPENAI_BASE_URL"),
    openaiApiKey: v("BVSALA_DEMO_OPENAI_API_KEY"),
    googleBaseUrl: v("BVSALA_DEMO_GOOGLE_BASE_URL"),
    googleApiKey: v("BVSALA_DEMO_GOOGLE_API_KEY"),
  };
}

/** LIVE si hay cualquier endpoint declarado (pasarela o por familia). */
export function modoDe(cfg: ConfigDeTransporte): "LIVE" | "MOCK" {
  return hayEndpoints(cfg) ? "LIVE" : "MOCK";
}

/** El nombre de la variable que declararía el endpoint directo de una familia. */
function variableDeFamilia(modelo: string): string {
  const f = familiaDeModelo(modelo);
  return f === "anthropic"
    ? "BVSALA_DEMO_ANTHROPIC_BASE_URL"
    : f === "openai"
      ? "BVSALA_DEMO_OPENAI_BASE_URL"
      : f === "google"
        ? "BVSALA_DEMO_GOOGLE_BASE_URL"
        : "BVSALA_DEMO_BASE_URL";
}

export interface EntradaDelPrevuelo {
  /** Los modelos a medir. `obligatorio: false` = viene de un escenario, no de la tirada. */
  modelos: { id: string; obligatorio: boolean; exigeNativo?: boolean }[];
  modo: "LIVE" | "MOCK";
  cfg: ConfigDeTransporte;
  presupuesto: number;
  esfuerzo: EsfuerzoB2;
  permitirIlustrativo: boolean;
  margen: number;
  b2: boolean;
  /** Escenarios sin tope de salida declarado (el techo de la estimación no lo es ahí). */
  escenariosSinTope?: string[];
  /** Escenarios con herramientas, para avisar de los que un modelo no admite por Chat Completions. */
  escenariosConHerramientas?: string[];
  /** Inyectable: las verjas no dependen de que la unidad del catálogo de 2026 haya llegado. */
  precioYPrima?: (modelo: string) => PrecioYPrima;
}

export interface VeredictoDePrevuelo {
  aborta: boolean;
  motivos: string[];
  avisos: string[];
}

/**
 * ¿SE PUEDE EMPEZAR A GASTAR? Todo lo que haría inservible una tirada de pago
 * se comprueba ANTES de la primera llamada:
 *
 *   · sin presupuesto (`BVSALA_AB_BUDGET_USD`) en LIVE;
 *   · un modelo sin endpoint para su familia;
 *   · un modelo sin fila de catálogo (salvo `permitirIlustrativo`: corre, nunca publica);
 *   · un GPT-5.6+/GPT-6 cuya prima de escritura no es 1,25 (falta la unidad del catálogo de 2026);
 *   · un esfuerzo de B2 que el modelo no admite;
 *   · un modelo que exige endpoint nativo y no lo tiene.
 */
export function veredictoDePrevuelo(e: EntradaDelPrevuelo): VeredictoDePrevuelo {
  const motivos: string[] = [];
  const avisos: string[] = [];
  const precio = e.precioYPrima ?? precioYPrimaDelCatalogo;
  const live = e.modo === "LIVE";

  if (live && !(Number.isFinite(e.presupuesto) && e.presupuesto > 0)) {
    motivos.push(
      "BVSALA_AB_BUDGET_USD is mandatory in LIVE: the run keeps a running spend and stops when it passes the budget. " +
        "Set it to the ceiling this run prints (rounded up).",
    );
  }
  for (const m of e.modelos) {
    const endpoint = endpointDeModelo(m.id, e.cfg);
    if (live && !endpoint) {
      const texto =
        `${m.id}: no endpoint declared for its family — declare ${variableDeFamilia(m.id)} (+ _API_KEY) ` +
        "or the gateway (BVSALA_DEMO_BASE_URL)";
      if (m.obligatorio) motivos.push(texto);
      else avisos.push(`${texto}; its scenarios are declared not measurable`);
      continue;
    }
    if (live && m.exigeNativo && endpoint?.transporte !== "anthropic-nativo") {
      motivos.push(
        `${m.id} needs the native Anthropic endpoint (BVSALA_DEMO_ANTHROPIC_BASE_URL): through the gateway neither ` +
          "cache_control nor output_config.effort has a field, so arm B2 would be degraded",
      );
    }
    const pp = precio(m.id);
    if (!pp.conocido) {
      const texto = `${m.id}: no row in the SDK price catalogue, so its dollars would be illustrative`;
      if (live && !e.permitirIlustrativo) {
        motivos.push(`${texto}. Land the catalogue row first, or run (never publish) with BVSALA_AB_PERMITIR_PRECIO_ILUSTRATIVO=1`);
      } else {
        avisos.push(`${texto} (allowed: this run cannot be published)`);
      }
    }
    if (tieneModoDeCacheExplicito(m.id) && pp.prima !== 1.25) {
      const texto =
        `${m.id}: cache write premium is ${pp.prima}, but GPT-5.6+/GPT-6 write the cache at 1.25x ` +
        "(https://developers.openai.com/api/docs/guides/prompt-caching, checked 2026-09-27) — missing the GPT-5.6+/GPT-6 premium, which is rec. 1";
      if (live) motivos.push(texto);
      else avisos.push(texto);
    }
    if (e.b2) {
      const error = validarEsfuerzo(m.id, endpoint?.transporte ?? "mock", e.esfuerzo);
      if (error) motivos.push(error);
    }
    if (razonaParaElBanco(m.id) && !(e.margen > 0)) {
      avisos.push(
        `${m.id} reasons inside the output cap and BVSALA_AB_MARGEN_RAZONAMIENTO is 0: expect truncations on the ` +
          "calibration run, then set a margin",
      );
    }
    if (
      (e.escenariosConHerramientas?.length ?? 0) > 0 &&
      endpoint?.transporte !== "anthropic-nativo" &&
      HERRAMIENTAS_SOLO_SIN_RAZONAMIENTO_EN_CHAT.some((k) => desnudo(m.id) === k || desnudo(m.id).startsWith(`${k}-`))
    ) {
      avisos.push(
        `${m.id}: Chat Completions supports function calling only with reasoning_effort "none" ` +
          "(https://developers.openai.com/api/docs/models/gpt-6-luna, checked 2026-09-27); its scenarios with tools " +
          `(${e.escenariosConHerramientas!.join(", ")}) are declared not measurable on this transport`,
      );
    }
  }
  if ((e.escenariosSinTope?.length ?? 0) > 0) {
    avisos.push(
      `scenarios without an output cap (${e.escenariosSinTope!.join(", ")}): the estimate is not a ceiling there; ` +
        "the running budget cap is what protects the spend",
    );
  }
  return { aborta: motivos.length > 0, motivos, avisos };
}
