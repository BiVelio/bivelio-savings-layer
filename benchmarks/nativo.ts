/**
 * EL BRAZO B2 «NATIVO BIEN CONFIGURADO» — qué ajustes gratuitos del proveedor
 * aplican a ESTA petición, con su fuente, y cómo viajan por el cable.
 * ---------------------------------------------------------------------------
 * Puro: sin entorno, sin red y sin efectos, como `brazos.ts` y `transporte.ts`,
 * para que `test/brazo-nativo-b2.test.ts` pueda afirmar cada decisión y cada
 * byte del cuerpo sin pagar una llamada.
 *
 * POR QUÉ EXISTE. El informe de competencia (docs/COMPETENCIA-2026-09-26.md,
 * §3 y §8 rec. 3) concluye que no se puede dar una erosión honesta del valor
 * del SDK sin comparar contra lo que el proveedor ya regala: caché, búsqueda de
 * herramientas, compactación, esfuerzo. B1 es «la integración razonable»; B2 es
 * B1 más TODO lo que la documentación del proveedor ofrece sin coste y que
 * APLICA a la forma de esta petición — no «todo encendido».
 *
 * La diferencia importa. Un ajuste que no puede dispararse (la compactación
 * por umbral necesita 50.000 tokens de entrada; estos escenarios tienen unos
 * pocos miles) no mide nada y sí añade riesgo: cabeceras beta, 400. Así que
 * cada función tiene una REGLA de aplicabilidad con su fuente oficial, y el
 * artefacto publica cada decisión (`native.decisions`) para que un crítico
 * pueda comprobarla contra la documentación.
 *
 * POR QUÉ EN EL CABLE. `ProviderRequest` no tiene campos para el esfuerzo, la
 * búsqueda de herramientas ni el modo de caché, y añadirlos cambiaría la API
 * pública del paquete. `reescribirCuerpo` actúa DESPUÉS de que el adaptador
 * arme el cuerpo, así que el contrato, los mensajes y el esquema salen
 * codificados igual que en los demás brazos: todos pasan por el mismo
 * adaptador.
 *
 * Los textos de `motivo` se publican en el artefacto: en inglés.
 */
import type { ProviderRequest } from "../src/providers/types.js";
import { familiaDeModelo, razonaParaElBanco, type TransporteDelBanco } from "./scenarios.js";

/** Las funciones nativas sobre las que B2 decide algo, con su nombre público. */
export type FuncionNativa =
  | "reasoningEffort"
  | "promptCacheMode"
  | "promptCacheBreakpoint"
  | "anthropicCacheBreakpoint"
  | "toolSearch"
  | "compaction"
  | "contextEditing"
  | "implicitCache";

/** Lo que admite `BVSALA_AB_B2_EFFORT`. `default` = el valor por defecto del proveedor. */
export type EsfuerzoB2 = "none" | "minimal" | "low" | "medium" | "default";
export const ESFUERZOS_B2: readonly EsfuerzoB2[] = ["none", "minimal", "low", "medium", "default"];

export interface FuenteOficial {
  url: string;
  /** Fecha en que se leyó la página, AAAA-MM-DD. */
  consultado: string;
}

export interface DecisionNativa {
  funcion: FuncionNativa;
  /** B2 manda algo por esta función que B1 no manda (o lo conserva de B1). */
  aplicada: boolean;
  valor?: string | number | boolean;
  /** Público: en inglés. */
  motivo: string;
  fuente: FuenteOficial;
}

export type TransporteReal = Exclude<TransporteDelBanco, "mock">;

export interface PlanNativo {
  modelo: string;
  /** El transporte por el que va (o iría, en MOCK) la petición. */
  transporte: TransporteReal;
  /** Tirada MOCK: el plan es el del transporte que se usaría, sin cable real. */
  simulado: boolean;
  /**
   * Un modelo de Claude a través de un endpoint que habla el protocolo de
   * OpenAI: ni `cache_control` ni `output_config.effort` tienen campo allí, así
   * que B2 no puede ser lo que dice ser. Bloquea la publicación.
   */
  degradadoPorTransporte: boolean;
  decisiones: DecisionNativa[];
  /** Lo que `reescribirCuerpo` pondrá en el cuerpo. Vacío = B2 sale igual que B1. */
  cable: {
    openai?: { reasoningEffort?: string; promptCacheMode?: "explicit"; breakpointEnMensaje?: number };
    anthropic?: { effort?: string; busqueda?: { noDiferidas: string[] } };
  };
}

// ── Fuentes oficiales (todas consultadas el 2026-09-27) ──────────────────────
const CONSULTADO = "2026-09-27";
const fuente = (url: string): FuenteOficial => ({ url, consultado: CONSULTADO });
export const FUENTES = {
  esfuerzoAnthropic: fuente("https://platform.claude.com/docs/en/build-with-claude/effort"),
  busquedaAnthropic: fuente("https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool"),
  compactacionAnthropic: fuente("https://platform.claude.com/docs/en/build-with-claude/compaction-threshold"),
  edicionDeContexto: fuente("https://platform.claude.com/docs/en/build-with-claude/context-editing"),
  cacheAnthropic: fuente("https://platform.claude.com/docs/en/build-with-claude/prompt-caching"),
  chatOpenAI: fuente(
    "https://raw.githubusercontent.com/openai/openai-node/master/src/resources/chat/completions/completions.ts",
  ),
  cacheOpenAI: fuente("https://developers.openai.com/api/docs/guides/prompt-caching"),
  gpt6Luna: fuente("https://developers.openai.com/api/docs/models/gpt-6-luna"),
  geminiOpenAI: fuente("https://ai.google.dev/gemini-api/docs/openai"),
  cacheGemini: fuente("https://ai.google.dev/gemini-api/docs/caching"),
} as const;

/**
 * Modelos con `output_config.effort`, copiados del `supportedModels` de la
 * página oficial del parámetro (FUENTES.esfuerzoAnthropic, 2026-09-27; Sonnet
 * 5.5 añadido al releerla el 2026-09-29). Haiku 4.5 y Sonnet 4.5 NO están: su
 * B2 queda en B1 y lo declara.
 */
export const EFFORT_ANTHROPIC: readonly string[] = [
  "claude-fable-5-1",
  "claude-mythos-5-1",
  "claude-fable-5",
  "claude-mythos-5",
  "claude-mythos-preview",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-opus-4-5-20251101",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
];
/** Niveles de esfuerzo de Anthropic (FUENTES.esfuerzoAnthropic). */
const NIVELES_ANTHROPIC = new Set(["low", "medium", "high", "xhigh", "max"]);

/**
 * Modelos con la búsqueda de herramientas del servidor, de la tabla «Model
 * compatibility» (FUENTES.busquedaAnthropic, 2026-09-27; Sonnet 5.5 añadido al
 * releerla el 2026-09-29). Claude Sonnet 5 no figura en ella.
 */
export const BUSQUEDA_ANTHROPIC: readonly string[] = [
  "claude-fable-5-1",
  "claude-mythos-5-1",
  "claude-fable-5",
  "claude-mythos-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-sonnet-5-5",
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-opus-4-6",
  "claude-sonnet-4-6",
  "claude-opus-4-5-20251101",
  "claude-sonnet-4-5-20250929",
  "claude-haiku-4-5-20251001",
];
/** El umbral documentado: «10 or more tools» o «more than 10k tokens» de definiciones. */
export const UMBRAL_BUSQUEDA = { herramientas: 10, tokensDeEsquemas: 10_000 } as const;
export const HERRAMIENTA_DE_BUSQUEDA = { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" } as const;
/** El mínimo del disparador de la compactación por umbral (FUENTES.compactacionAnthropic). */
export const MINIMO_COMPACTACION_TOKENS = 50_000;

/**
 * Valores de `reasoning_effort` que un modelo concreto NO admite, cuando su
 * página lo dice. gpt-6-luna: «`reasoning.effort` supports `none`, `low`,
 * `medium` (default), `high`, `xhigh`, and `max`» — sin `minimal`
 * (FUENTES.gpt6Luna, 2026-09-27). Un modelo que no está aquí se valida contra
 * la lista genérica de Chat Completions, y la sonda (`pnpm ab:sonda`) caza el
 * resto antes de gastar la tirada.
 */
const ESFUERZO_NO_ADMITIDO_OPENAI: Readonly<Record<string, readonly EsfuerzoB2[]>> = {
  "gpt-6-luna": ["minimal"],
};

/**
 * Modelos cuya página dice que Chat Completions solo admite `tools` con
 * `reasoning_effort: "none"`. gpt-6-luna: «Chat Completions supports function
 * calling only with `reasoning_effort` set to `none`» (FUENTES.gpt6Luna,
 * 2026-09-27). El banco no mide por Chat Completions un escenario con
 * herramientas contra estos modelos: el brazo B0 manda el esfuerzo por defecto
 * y el SDK no sabe mandar otro, así que cualquier cifra saldría de una petición
 * que el proveedor no admite (ver `ab-live.ts`, `repartirEscenarios`).
 */
export const HERRAMIENTAS_SOLO_SIN_RAZONAMIENTO_EN_CHAT: readonly string[] = ["gpt-6-luna"];

/** Modelos con `prompt_cache_options`: GPT-5.6 y posteriores (FUENTES.chatOpenAI). */
export function tieneModoDeCacheExplicito(modelo: string): boolean {
  return /^gpt-(5\.(6|[7-9])|[6-9])(\.|-|$)/.test(desnudo(modelo));
}

/** El id sin prefijo de proveedor y en minúsculas. */
export function desnudo(modelo: string): string {
  const barra = modelo.lastIndexOf("/");
  return (barra >= 0 ? modelo.slice(barra + 1) : modelo).toLowerCase();
}

/** Coincide con una entrada de lista oficial, con o sin la fecha de instantánea. */
function enLista(modelo: string, lista: readonly string[]): boolean {
  const base = (id: string) => id.replace(/-\d{8}$/, "");
  const m = base(desnudo(modelo));
  return lista.some((id) => base(id) === m);
}

/** El transporte por el que iría la petición si la tirada fuera LIVE. */
export function transporteDelPlan(modelo: string, transporte: TransporteDelBanco): TransporteReal {
  if (transporte !== "mock") return transporte;
  return familiaDeModelo(modelo) === "anthropic" ? "anthropic-nativo" : "openai-compatible";
}

/**
 * ¿Admite este modelo el esfuerzo pedido por este transporte? `null` = sí, o
 * no aplica (el plan lo declarará); un texto = el motivo por el que la tirada
 * no debe empezar. Lo usan el plan y el prevuelo.
 */
export function validarEsfuerzo(modelo: string, transporte: TransporteDelBanco, esfuerzo: EsfuerzoB2): string | null {
  if (!ESFUERZOS_B2.includes(esfuerzo)) {
    return `BVSALA_AB_B2_EFFORT=${String(esfuerzo)} is not one of ${ESFUERZOS_B2.join("|")}`;
  }
  if (esfuerzo === "default") return null;
  const t = transporteDelPlan(modelo, transporte);
  const familia = familiaDeModelo(modelo);
  const id = desnudo(modelo);
  if (t === "anthropic-nativo") {
    if (!enLista(modelo, EFFORT_ANTHROPIC)) return null; // no aplica: el plan lo declara
    return NIVELES_ANTHROPIC.has(esfuerzo)
      ? null
      : `${modelo}: Anthropic effort levels are low, medium, high, xhigh and max; "${esfuerzo}" does not exist there`;
  }
  if (familia === "openai" && razonaParaElBanco(modelo)) {
    const vetados = Object.entries(ESFUERZO_NO_ADMITIDO_OPENAI).find(([k]) => id === k || id.startsWith(`${k}-`))?.[1];
    return vetados?.includes(esfuerzo) ? `${modelo} does not accept reasoning_effort "${esfuerzo}" (${FUENTES.gpt6Luna.url})` : null;
  }
  if (familia === "google" && razonaParaElBanco(modelo)) {
    // Solo Gemini 2.5 Flash admite `none`: «Reasoning cannot be turned off for
    // Gemini 2.5 Pro or 3 models» (FUENTES.geminiOpenAI, 2026-09-27).
    if (esfuerzo === "none" && !/^gemini-2\.5-flash/.test(id)) {
      return `${modelo}: reasoning cannot be turned off on Gemini 2.5 Pro or Gemini 3 models, so reasoning_effort "none" is invalid (${FUENTES.geminiOpenAI.url})`;
    }
    return null;
  }
  return null;
}

export interface EntradaDelPlan {
  modelo: string;
  transporte: TransporteDelBanco;
  /** La petición del brazo B2 tal como la arma `construirBrazoNativo` (o B1). */
  peticion: ProviderRequest;
  esfuerzo: EsfuerzoB2;
  /** Herramientas que la integración tiene para esta petición (las de B0). */
  numHerramientas?: number;
  /** Tokens de las definiciones de esas herramientas. */
  tokensDeEsquemas?: number;
  /** Las que un integrador diligente no diferiría (`toolsB1`). */
  noDiferidas?: readonly string[];
}

/** El plan de B2 para una petición. Lanza si el esfuerzo pedido no existe para el modelo. */
export function planNativo(e: EntradaDelPlan): PlanNativo {
  const error = validarEsfuerzo(e.modelo, e.transporte, e.esfuerzo);
  if (error) throw new Error(error);

  const transporte = transporteDelPlan(e.modelo, e.transporte);
  const simulado = e.transporte === "mock";
  const familia = familiaDeModelo(e.modelo);
  const id = desnudo(e.modelo);
  const prefijo = e.peticion.stablePrefixMessages ?? 0;
  const numHerramientas = e.numHerramientas ?? e.peticion.tools?.length ?? 0;
  const tokensDeEsquemas = e.tokensDeEsquemas ?? 0;
  const decisiones: DecisionNativa[] = [];
  const cable: PlanNativo["cable"] = {};
  const d = (x: DecisionNativa): void => void decisiones.push(x);
  const porDefecto = e.esfuerzo === "default";
  const motivoPorDefecto = "BVSALA_AB_B2_EFFORT=default: B2 keeps the provider's default effort, so it trades no quality for it";

  const degradado = familia === "anthropic" && transporte === "openai-compatible";

  if (transporte === "google-nativo") {
    // Gemini por su API nativa (`GoogleProvider`). El reescritor del cable de B2
    // habla Chat Completions y Mensajes de Anthropic; aquí no reescribe nada, así
    // que B2 sale igual que B1 y se declara, en vez de meter campos de otro
    // dialecto en un cuerpo de `generateContent`.
    d({
      funcion: "reasoningEffort",
      aplicada: false,
      motivo:
        "Gemini's native API takes thinking as generationConfig.thinkingConfig, which the bench's B2 body rewriter " +
        "does not write; B2 stays at B1 on this transport",
      fuente: FUENTES.geminiOpenAI,
    });
    d({
      funcion: "implicitCache",
      aplicada: false,
      valor: "on by default in every arm",
      motivo:
        "implicit caching is on by default for Gemini 2.5 and newer in every arm, B0 included; explicit caching " +
        "(cachedContents) is not used by any arm",
      fuente: FUENTES.cacheGemini,
    });
    return { modelo: e.modelo, transporte, simulado, degradadoPorTransporte: false, decisiones, cable };
  }

  if (transporte === "anthropic-nativo") {
    // ── Esfuerzo (output_config.effort) ──
    if (!enLista(e.modelo, EFFORT_ANTHROPIC)) {
      d({
        funcion: "reasoningEffort",
        aplicada: false,
        motivo: `${id} is not in the effort parameter's supported models, so B2 stays at B1 here`,
        fuente: FUENTES.esfuerzoAnthropic,
      });
    } else if (porDefecto) {
      d({ funcion: "reasoningEffort", aplicada: false, motivo: motivoPorDefecto, fuente: FUENTES.esfuerzoAnthropic });
    } else {
      d({
        funcion: "reasoningEffort",
        aplicada: true,
        valor: e.esfuerzo,
        motivo:
          `output_config.effort = "${e.esfuerzo}", at or below the model default (high on every supported model except ` +
          "Claude Opus 5.5, medium); the Claude Sonnet 5 and Sonnet 4.6 guidance lists low for high-volume chat and " +
          "non-coding workloads",
        fuente: FUENTES.esfuerzoAnthropic,
      });
      cable.anthropic = { ...cable.anthropic, effort: e.esfuerzo };
    }
    // ── Caché explícita: la de B1, tal cual ──
    d({
      funcion: "anthropicCacheBreakpoint",
      aplicada: prefijo > 0,
      ...(prefijo > 0 ? { valor: prefijo } : {}),
      motivo:
        prefijo > 0
          ? "kept from B1: cache_control at the end of the stable prefix (B2 is a superset of B1)"
          : "no prefix repeats in this request (cold-salted, or no leading system message): B1 marks nothing and neither does B2",
      fuente: FUENTES.cacheAnthropic,
    });
    // ── Búsqueda de herramientas ──
    const sobreUmbral =
      numHerramientas >= UMBRAL_BUSQUEDA.herramientas || tokensDeEsquemas > UMBRAL_BUSQUEDA.tokensDeEsquemas;
    const soportada = enLista(e.modelo, BUSQUEDA_ANTHROPIC);
    const aplicaBusqueda = numHerramientas > 0 && sobreUmbral && soportada;
    d({
      funcion: "toolSearch",
      aplicada: aplicaBusqueda,
      ...(aplicaBusqueda ? { valor: HERRAMIENTA_DE_BUSQUEDA.type } : {}),
      motivo:
        numHerramientas === 0
          ? "no tools in this request"
          : !sobreUmbral
            ? `${numHerramientas} tools and about ${tokensDeEsquemas} tokens of definitions: under the documented threshold ` +
              "(10 or more tools, or more than 10k tokens of definitions), where standard tool calling is the better fit"
            : !soportada
              ? `${id} is not in the tool search model compatibility table`
              : `${numHerramientas} tools / about ${tokensDeEsquemas} schema tokens, over the documented threshold: every tool ` +
                "is sent, deferred except the ones B1 hand-picks",
      fuente: FUENTES.busquedaAnthropic,
    });
    if (aplicaBusqueda) {
      cable.anthropic = { ...cable.anthropic, busqueda: { noDiferidas: [...(e.noDiferidas ?? [])] } };
    }
    // ── Compactación y edición de contexto: no pueden dispararse aquí ──
    d({
      funcion: "compaction",
      aplicada: false,
      motivo:
        "threshold compaction triggers at 50,000 input tokens at the lowest (150,000 by default); these single-turn " +
        "requests never reach it, so sending it would only add a beta header that cannot fire",
      fuente: FUENTES.compactacionAnthropic,
    });
    d({
      funcion: "contextEditing",
      aplicada: false,
      motivo: "context editing clears earlier tool results and thinking blocks from the history; these single-turn requests have none",
      fuente: FUENTES.edicionDeContexto,
    });
  } else {
    // ── openai-compatible ──
    if (degradado) {
      d({
        funcion: "reasoningEffort",
        aplicada: false,
        motivo:
          "a Claude model through an OpenAI-protocol endpoint: output_config.effort has no field there, so B2 cannot apply it " +
          "(degraded by transport; declare a native Anthropic endpoint)",
        fuente: FUENTES.esfuerzoAnthropic,
      });
      d({
        funcion: "anthropicCacheBreakpoint",
        aplicada: false,
        motivo: "cache_control has no field in the OpenAI protocol: degraded by transport",
        fuente: FUENTES.cacheAnthropic,
      });
    } else if (!razonaParaElBanco(e.modelo) || (familia !== "openai" && familia !== "google")) {
      d({
        funcion: "reasoningEffort",
        aplicada: false,
        motivo:
          familia === "openai" || familia === "google"
            ? `${id} is not a reasoning model: reasoning_effort does not apply`
            : `${id} belongs to a family the bench does not map to a documented reasoning_effort`,
        fuente: familia === "google" ? FUENTES.geminiOpenAI : FUENTES.chatOpenAI,
      });
    } else if (
      familia === "openai" &&
      numHerramientas > 0 &&
      HERRAMIENTAS_SOLO_SIN_RAZONAMIENTO_EN_CHAT.some((k) => id === k || id.startsWith(`${k}-`))
    ) {
      d({
        funcion: "reasoningEffort",
        aplicada: true,
        valor: "none",
        motivo: `${id}: Chat Completions supports function calling only with reasoning_effort "none"`,
        fuente: FUENTES.gpt6Luna,
      });
      cable.openai = { ...cable.openai, reasoningEffort: "none" };
    } else if (porDefecto) {
      d({
        funcion: "reasoningEffort",
        aplicada: false,
        motivo: motivoPorDefecto,
        fuente: familia === "google" ? FUENTES.geminiOpenAI : FUENTES.chatOpenAI,
      });
    } else {
      d({
        funcion: "reasoningEffort",
        aplicada: true,
        valor: e.esfuerzo,
        motivo:
          familia === "google"
            ? `reasoning_effort = "${e.esfuerzo}", mapped by the Gemini OpenAI-compatible endpoint to thinking_level; reasoning cannot be turned off on Gemini 3`
            : `reasoning_effort = "${e.esfuerzo}"; B0 and B1 keep the provider default` +
              (id === "gpt-6-luna" || id.startsWith("gpt-6-luna-") ? " (medium on gpt-6-luna)" : ""),
        fuente: familia === "google" ? FUENTES.geminiOpenAI : id.startsWith("gpt-6") ? FUENTES.gpt6Luna : FUENTES.chatOpenAI,
      });
      cable.openai = { ...cable.openai, reasoningEffort: e.esfuerzo };
    }

    if (familia === "openai" && tieneModoDeCacheExplicito(e.modelo)) {
      d({
        funcion: "promptCacheMode",
        aplicada: true,
        valor: "explicit",
        motivo:
          "GPT-5.6 and later default to implicit mode, which places breakpoints automatically and bills cache writes at " +
          "1.25x the input rate (prompts of 1,024 tokens or more); explicit mode writes only at a declared breakpoint, and " +
          "the documentation recommends explicit-only mode to avoid unnecessary cache writes",
        fuente: FUENTES.cacheOpenAI,
      });
      cable.openai = { ...cable.openai, promptCacheMode: "explicit" };
      d({
        funcion: "promptCacheBreakpoint",
        aplicada: prefijo > 0,
        ...(prefijo > 0 ? { valor: prefijo - 1 } : {}),
        motivo:
          prefijo > 0
            ? `breakpoint on message ${prefijo - 1}, the end of the stable prefix B1 already declares`
            : "no prefix repeats in this request (cold-salted, or no leading system message): no breakpoint, so no cache writes",
        fuente: FUENTES.chatOpenAI,
      });
      if (prefijo > 0) cable.openai = { ...cable.openai, breakpointEnMensaje: prefijo - 1 };
    } else if (familia === "openai") {
      d({
        funcion: "implicitCache",
        aplicada: false,
        valor: "automatic in every arm",
        motivo:
          `${id} caches prompts automatically with no write premium and has no prompt_cache_options (GPT-5.6 and later only); ` +
          "B1's prompt_cache_key routing hint is kept",
        fuente: FUENTES.cacheOpenAI,
      });
    } else if (familia === "google") {
      d({
        funcion: "implicitCache",
        aplicada: false,
        valor: "on by default in every arm",
        motivo:
          "implicit caching is on by default for Gemini 2.5 and newer in every arm, B0 included (4,096-token minimum on " +
          "Gemini 3.x Flash); explicit caching is documented for generateContent and the caches API, not for the " +
          "OpenAI-compatible endpoint the bench talks",
        fuente: FUENTES.cacheGemini,
      });
    }

    d({
      funcion: "toolSearch",
      aplicada: false,
      motivo: "tool search is not part of Chat Completions (Responses API only), and the bench talks Chat Completions",
      fuente: FUENTES.chatOpenAI,
    });
    d({
      funcion: "compaction",
      aplicada: false,
      motivo: "compaction is not part of Chat Completions (Responses API only), and the bench talks Chat Completions",
      fuente: FUENTES.chatOpenAI,
    });
  }

  return {
    modelo: e.modelo,
    transporte,
    simulado,
    degradadoPorTransporte: degradado,
    decisiones,
    cable,
  };
}

/** ¿Sale B2 por el cable igual que B1? (ningún ajuste que reescribir) */
export function igualQueB1(plan: PlanNativo): boolean {
  const o = plan.cable.openai;
  const a = plan.cable.anthropic;
  return !(o && (o.reasoningEffort || o.promptCacheMode || o.breakpointEnMensaje != null)) && !(a && (a.effort || a.busqueda));
}

// ── El cable ─────────────────────────────────────────────────────────────────

type Objeto = Record<string, unknown>;
const esObjeto = (v: unknown): v is Objeto => typeof v === "object" && v !== null && !Array.isArray(v);

/** Marca el final de un mensaje de Chat Completions con el breakpoint explícito, sin tocar su texto. */
function conBreakpoint(mensaje: unknown): unknown {
  if (!esObjeto(mensaje)) return mensaje;
  const marca = { prompt_cache_breakpoint: { mode: "explicit" } };
  const c = mensaje["content"];
  if (typeof c === "string") return { ...mensaje, content: [{ type: "text", text: c, ...marca }] };
  if (Array.isArray(c)) {
    let ultimo = -1;
    c.forEach((p, i) => {
      if (esObjeto(p) && p["type"] === "text") ultimo = i;
    });
    if (ultimo < 0) return mensaje;
    return { ...mensaje, content: c.map((p, i) => (i === ultimo ? { ...(p as Objeto), ...marca } : p)) };
  }
  return mensaje;
}

/**
 * El cuerpo que sale por el cable para B2: el que armó el adaptador más los
 * ajustes del plan. Puro. Nunca quita mensajes, nunca toca su texto, y no toca
 * `temperature`, `max_tokens` ni `tools` salvo en los casos de abajo.
 */
export function reescribirCuerpo(plan: PlanNativo, url: string, cuerpo: Objeto): Objeto {
  const ruta = url.split("?")[0] ?? url;
  const out: Objeto = { ...cuerpo };
  const o = plan.cable.openai;
  if (o && /\/chat\/completions$/.test(ruta)) {
    if (o.reasoningEffort) out["reasoning_effort"] = o.reasoningEffort;
    if (o.promptCacheMode) {
      out["prompt_cache_options"] = { ...(esObjeto(out["prompt_cache_options"]) ? out["prompt_cache_options"] : {}), mode: "explicit" };
    }
    const i = o.breakpointEnMensaje;
    if (i != null && Array.isArray(out["messages"])) {
      out["messages"] = (out["messages"] as unknown[]).map((m, k) => (k === i ? conBreakpoint(m) : m));
    }
  }
  const a = plan.cable.anthropic;
  if (a && /\/messages$/.test(ruta)) {
    if (a.effort) {
      out["output_config"] = { ...(esObjeto(out["output_config"]) ? out["output_config"] : {}), effort: a.effort };
    }
    if (a.busqueda && Array.isArray(out["tools"])) {
      const quedan = new Set(a.busqueda.noDiferidas);
      const tools = (out["tools"] as unknown[]).map((t) => {
        if (!esObjeto(t)) return t;
        const nombre = t["name"];
        const esBusqueda = typeof t["type"] === "string" && (t["type"] as string).startsWith("tool_search_tool");
        if (esBusqueda || nombre === "bvsala_contract" || (typeof nombre === "string" && quedan.has(nombre))) return t;
        // `defer_loading` y `cache_control` no pueden convivir en la misma herramienta: 400.
        const { cache_control: _sinMarca, ...resto } = t;
        void _sinMarca;
        return { ...resto, defer_loading: true };
      });
      const yaTiene = tools.some((t) => esObjeto(t) && typeof t["type"] === "string" && (t["type"] as string).startsWith("tool_search_tool"));
      out["tools"] = yaTiene ? tools : [{ ...HERRAMIENTA_DE_BUSQUEDA }, ...tools];
    }
  }
  return out;
}

/**
 * Un `fetch` que aplica `reescribirCuerpo` al cuerpo JSON y delega en `base`.
 * `base` es SIEMPRE el `fetch` con plazo del banco (o el espía de la verja):
 * esto envuelve el plazo, nunca lo sustituye.
 */
export function conAjustesNativos(plan: PlanNativo, base: typeof fetch): typeof fetch {
  return ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (typeof init?.body !== "string") return base(input, init);
    let cuerpo: unknown;
    try {
      cuerpo = JSON.parse(init.body);
    } catch {
      return base(input, init);
    }
    if (!esObjeto(cuerpo)) return base(input, init);
    return base(input, { ...init, body: JSON.stringify(reescribirCuerpo(plan, url, cuerpo)) });
  }) as typeof fetch;
}

// ── Lo que se publica ────────────────────────────────────────────────────────

/** Una decisión con los nombres públicos del artefacto (inglés). */
export interface DecisionPublica {
  feature: FuncionNativa;
  applied: boolean;
  value?: string | number | boolean;
  reason: string;
  source: { url: string; checked: string };
  /** A nivel de modelo: los escenarios donde se aplicó. */
  scenarios?: string[];
}

export function decisionPublica(x: DecisionNativa): DecisionPublica {
  return {
    feature: x.funcion,
    applied: x.aplicada,
    ...(x.valor !== undefined ? { value: x.valor } : {}),
    reason: x.motivo,
    source: { url: x.fuente.url, checked: x.fuente.consultado },
  };
}

/** Lo que B2 hizo en UN escenario: qué aplicó y qué no, con el motivo. */
export function resumenDelPlan(plan: PlanNativo): {
  applied: FuncionNativa[];
  skipped: { feature: FuncionNativa; reason: string }[];
  sameAsB1: boolean;
} {
  return {
    applied: plan.decisiones.filter((x) => x.aplicada).map((x) => x.funcion),
    skipped: plan.decisiones.filter((x) => !x.aplicada).map((x) => ({ feature: x.funcion, reason: x.motivo })),
    sameAsB1: igualQueB1(plan),
  };
}

/**
 * Las decisiones de un MODELO a partir de las de sus escenarios: una por
 * función, aplicada si lo fue en alguno, con la lista de escenarios donde se
 * aplicó. El motivo es el del primer escenario que la aplicó (o el del primero,
 * si ninguno).
 */
export function resumirPlanes(planes: { escenario: string; plan: PlanNativo }[]): DecisionPublica[] {
  const orden: FuncionNativa[] = [];
  const por = new Map<FuncionNativa, { escenario: string; d: DecisionNativa }[]>();
  for (const { escenario, plan } of planes) {
    for (const d of plan.decisiones) {
      if (!por.has(d.funcion)) {
        por.set(d.funcion, []);
        orden.push(d.funcion);
      }
      por.get(d.funcion)!.push({ escenario, d });
    }
  }
  return orden.map((f) => {
    const todas = por.get(f)!;
    const aplicadas = todas.filter((x) => x.d.aplicada);
    const rep = (aplicadas[0] ?? todas[0])!.d;
    return { ...decisionPublica({ ...rep, aplicada: aplicadas.length > 0 }), scenarios: aplicadas.map((x) => x.escenario) };
  });
}
