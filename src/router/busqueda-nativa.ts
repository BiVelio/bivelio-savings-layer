import type { ToolDescriptor, ToolSearchMode, ToolSearchOptions } from "../contracts/types.js";
import type { CostModel } from "../tokenizer/accounting.js";

// ═══════════════════════════════════════════════════════════════════════════
// LA BÚSQUEDA DE HERRAMIENTAS NATIVA DEL PROVEEDOR, frente al selector propio.
// ═══════════════════════════════════════════════════════════════════════════
//
// Módulo INTERNO: no se reexporta (router/index.ts solo exporta router.js y
// tool-selector.js). Lo público es `SavingsToggles.toolSearch` y los tipos
// `ToolSearchMode`/`ToolSearchOptions`, en contracts/types.ts, en inglés.
//
// QUÉ RESUELVE. El selector del SDK poda el catálogo ANTES de enviarlo. Eso
// choca con la ley de la bitácora del 10-09: `tools` va lo primero del prompt,
// así que un conjunto que cambia con la pregunta rompe la caché de prefijo
// entera. El selector lo apaña congelando el conjunto tras unos turnos, a
// cambio de dos cosas que no se ven en la factura pero sí en la función:
//
//   · con un catálogo SIN TIPAR (ninguno de los 10.636 catálogos MCP del corpus
//     declaraba `intents` ni `risk`) no hay señal y el selector lo manda ENTERO
//     (hasta 0.4.30 pasaban las `maxTools` primeras POR POSICIÓN y la novena
//     herramienta no existía para el modelo): no se pierde función, pero el
//     catálogo entero va en el prefijo en cada petición;
//   · con uno tipado, lo que no entra en el conjunto congelado no existe para
//     el modelo.
//
// La búsqueda nativa de Anthropic lo resuelve en el lado del proveedor: se
// mandan TODAS las definiciones con `defer_loading: true`, el proveedor las
// deja FUERA del prefijo, el modelo busca cuando necesita una y la definición
// encontrada entra DETRÁS del prefijo, en la conversación. Documentación
// oficial, leída el 2026-09-27
// (https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool):
//
//   «Internally, the API excludes deferred tools from the system-prompt prefix.
//    When Claude discovers a deferred tool through tool search, the API appends
//    a `tool_reference` block inline in the conversation […] The prefix is
//    untouched, so prompt caching is preserved.»
//
// Es exactamente lo que la ley pide: no se borra nada a mitad del prompt; lo
// nuevo se añade al final. Y ninguna herramienta queda inalcanzable.
//
// LO QUE NO ES: un ahorro de la capa. Lo cobra (o lo ahorra) el proveedor, y su
// contador lo refleja solo. La capa no acredita nada por ello (ver la regla E4-bis
// en pipeline/referencia.ts y la nota de `sentInputLocal` en el pipeline).

/**
 * Modelos con la búsqueda de herramientas del servidor, copiados de la tabla
 * «Model compatibility» de la página oficial (leída el 2026-09-27; releída el
 * 2026-09-29, cuando entró Claude Sonnet 5.5 en el mismo orden que la tabla).
 * Claude Sonnet 5 NO figura en ella y por eso no está: si el proveedor lo
 * admite, la tabla lo dirá y se añade; mandarlo antes sería apostar a un 400.
 *
 * Es la MISMA lista que `BUSQUEDA_ANTHROPIC` del banco (benchmarks/nativo.ts,
 * el brazo B2): `test/busqueda-nativa.test.ts` exige que no deriven.
 */
export const MODELOS_CON_BUSQUEDA_NATIVA: readonly string[] = [
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

/**
 * El umbral que documenta el proveedor («When to use tool search»): «You have
 * 10 or more tools available» o «Your tool definitions consume more than 10k
 * tokens». Por debajo, «Standard tool calling […] is a better fit». Es el mismo
 * que usa el banco para su brazo B2.
 */
export const UMBRAL_DOCUMENTADO = { herramientas: 10, tokensDeEsquemas: 10_000 } as const;

/** Cuántas definiciones devuelve una búsqueda por defecto («up to 5 by default»). */
export const RESULTADOS_POR_BUSQUEDA = 5;

/**
 * Longitud máxima documentada de la consulta, en CARACTERES: 200 para la regex
 * y 500 para BM25. Se usa como cota de los tokens de salida que cuesta escribir
 * una búsqueda (un token nunca cubre menos de un carácter en la práctica), y es
 * a propósito el PEOR caso: la verja tiene que salir a cuenta aunque el modelo
 * escriba la consulta más larga que la API admite.
 */
export const LONGITUD_MAXIMA_DE_LA_CONSULTA = { regex: 200, bm25: 500 } as const;

/** «Maximum deferred tools: 10,000 tools with `defer_loading: true` per request». */
export const MAXIMO_DE_DIFERIDAS = 10_000;

/** La herramienta de búsqueda de cada variante, tal y como la documenta el proveedor. */
export const HERRAMIENTA_DE_BUSQUEDA = {
  bm25: { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
  regex: { type: "tool_search_tool_regex_20251119", name: "tool_search_tool_regex" },
} as const;

/** Nombre que el contrato de salida ocupa como herramienta en el adaptador de Anthropic. */
const HERRAMIENTA_DE_CONTRATO = "bvsala_contract";

/** El id sin prefijo de proveedor y en minúsculas (`anthropic/claude-x` → `claude-x`). */
function desnudo(modelo: string): string {
  const barra = modelo.lastIndexOf("/");
  return (barra >= 0 ? modelo.slice(barra + 1) : modelo).toLowerCase();
}

/**
 * ¿Está este modelo en la tabla de compatibilidad? Con o sin la fecha de
 * instantánea: `claude-haiku-4-5` y `claude-haiku-4-5-20251001` son el mismo
 * modelo. La misma regla que `enLista` del banco.
 */
export function admiteBusquedaNativa(modelo: string): boolean {
  const base = (id: string): string => id.replace(/-\d{8}$/, "");
  const m = base(desnudo(modelo));
  return MODELOS_CON_BUSQUEDA_NATIVA.some((id) => base(id) === m);
}

/** La palanca ya normalizada: la forma corta (`"auto"`) y la larga dicen lo mismo. */
export interface OpcionesDeBusqueda {
  modo: ToolSearchMode;
  siempreCargadas: string[];
  variante: "bm25" | "regex";
}

/**
 * Normaliza `savings.toolSearch`. Un valor que no se entiende se trata como
 * `"off"`: una palanca que cambia el cuerpo de la petición no se enciende por
 * una errata.
 */
export function normalizarBusqueda(valor: ToolSearchMode | ToolSearchOptions | undefined): OpcionesDeBusqueda {
  const apagada: OpcionesDeBusqueda = { modo: "off", siempreCargadas: [], variante: "bm25" };
  if (valor === undefined) return apagada;
  const modoValido = (m: unknown): m is ToolSearchMode => m === "off" || m === "auto" || m === "always";
  if (typeof valor === "string") return modoValido(valor) ? { ...apagada, modo: valor } : apagada;
  if (typeof valor !== "object" || valor === null || !modoValido(valor.mode)) return apagada;
  return {
    modo: valor.mode,
    siempreCargadas: Array.isArray(valor.alwaysLoaded)
      ? [...new Set(valor.alwaysLoaded.filter((id): id is string => typeof id === "string"))]
      : [],
    variante: valor.variant === "regex" ? "regex" : "bm25",
  };
}

/**
 * Un catálogo REAL (MCP, OpenAI) llega como `{name, description, input_schema}`:
 * sin `intents` y sin `risk`. El tipo los exige, pero TypeScript no protege en
 * ejecución, y medido sobre 10.636 catálogos del corpus real **ninguno** los
 * declaraba. Sin esta comprobación, en el selector pasaban tres cosas a la vez:
 *
 *  1. `t.risk === "read"` es falso cuando `risk` es `undefined`, así que fuera
 *     de `TOOL_ACTION` el elegible quedaba VACÍO y el modelo recibía CERO
 *     herramientas: se le rompe la función al cliente en silencio.
 *  2. La ruta `TOOL_ACTION` reventaba con `TypeError: tool.intents is not
 *     iterable` al puntuar.
 *  3. Y el libro 2 acreditaba el 100 % del bloque como ahorro — cobrábamos
 *     comisión por haber roto la petición.
 *
 * Con un catálogo así no hay nada que seleccionar: no hay señal. El selector lo
 * pasa íntegro (sin tope: `maxTools` solo acota lo que se elige por relevancia)
 * y la búsqueda nativa no le aplica la verja de riesgo. Vive aquí, y no en `tool-selector.ts`, para que las dos rutas
 * usen la misma regla.
 */
export function catalogoSinTipar(tools: readonly ToolDescriptor[]): boolean {
  return (
    !tools.some((t) => Array.isArray(t.intents) && t.intents.length > 0) &&
    !tools.some((t) => typeof t.risk === "string")
  );
}

/** Lo que el adaptador tiene que poder hacer, tal como lo declaró al construirse. */
export type CapacidadDeBusqueda = "oficial" | "compatible";

/** Lo que hay que saber de ESTA petición para decidir. */
export interface EntradaDeBusquedaNativa {
  opciones: OpcionesDeBusqueda;
  /**
   * `oficial`: un adaptador propio que habla con la API del proveedor.
   * `compatible`: un adaptador propio contra otro host (un proxy, un gateway).
   * `undefined`: un proveedor de terceros, que no atestigua nada.
   */
  capacidad: CapacidadDeBusqueda | undefined;
  /** El modelo que se va a llamar. */
  modelo: string;
  /**
   * Las candidatas, YA filtradas por riesgo (la misma verja que el selector),
   * cada una con los tokens de su definición contados con la regla del baseline.
   */
  herramientas: { id: string; tokens: number }[];
  /** ¿Lleva la petición un contrato de salida? */
  hayContrato: boolean;
  /** ¿Está encendida la cascada de modelos (`on` o `shadow`)? */
  cascadaActiva: boolean;
  /** Precio del modelo servido. */
  precio: CostModel;
  /**
   * Precio de un token leído de caché como fracción del normal (0,1; 0,05 en
   * Opus 5.5). Se usa el MENOR que se conozca: cuanto más barata la lectura,
   * menos vale sacar el catálogo del prefijo y más difícil es que la verja pase.
   */
  lecturaDeCache: number;
}

export interface DecisionDeBusquedaNativa {
  aplicar: boolean;
  /** En inglés: acaba en `report.traces[].detail.reason`, que es campo público del informe. */
  razon: string;
  variante: "bm25" | "regex";
  /** Las que viajan SIN diferir, en el orden del llamante. Vacío si no se aplica. */
  siempreCargadas: string[];
  diferidas: number;
  tokensDiferidos: number;
  /** Lo que deja de leerse de caché por petición, en dinero (verja de `auto`). */
  ahorroDelPrefijo?: number;
  /** El peor caso de UNA búsqueda por petición, en dinero (verja de `auto`). */
  costeDeUnaBusqueda?: number;
}

/**
 * ¿Se usa la búsqueda nativa en esta petición?
 *
 * REQUISITOS DUROS (en `always` también): un adaptador propio que la sepa
 * mandar; un modelo de la tabla oficial; sin contrato de salida (en Anthropic
 * viaja como una herramienta forzada con `tool_choice`, y esa combinación con
 * definiciones diferidas no está documentada ni medida); sin cascada (el modelo
 * barato o su escalada tendrían que admitirla también, y la sombra llama a otro
 * modelo con el mismo cuerpo); al menos una herramienta que diferir; no más de
 * las 10.000 diferidas que admite la API; y ninguna herramienta del llamante
 * con el nombre de la de búsqueda (dos homónimas son un 400).
 *
 * `auto` exige además el host oficial —Claude Code hace lo mismo: con un base
 * URL ajeno la apaga, porque un proxy puede no reenviar los bloques de la
 * búsqueda—, el umbral documentado y la verja de dinero:
 *
 *     ahorro del prefijo  = r · precioEntrada · tokens diferidos
 *     coste de 1 búsqueda = precioEntrada · (las 5 definiciones MÁS GRANDES)
 *                         + precioSalida  · (la consulta más larga admitida)
 *
 * y se aplica solo si `ahorro ≥ coste`. Es el caso MÁS ADVERSO para la búsqueda
 * nativa: la caché del catálogo entero siempre caliente (si no lo está, mandarlo
 * entero cuesta la prima de escritura, 1,25×, y la nativa gana de largo), y
 * TODAS las peticiones buscando una vez y cargando las cinco definiciones más
 * caras a precio de entrada sin caché. Cuando la verja pasa, diferir sale más
 * barato que mandar el catálogo entero incluso así. No se le supone al tráfico
 * una tasa de búsqueda: suponerla sería inventarse un número; se mide después
 * (`report.traces`, entrada `tool-search`).
 *
 * Lo que la verja NO compara es el selector: el selector puede costar menos
 * tokens porque manda menos herramientas, y lo que no manda no se puede llamar.
 * Esa diferencia no es de dinero sino de función, y la decide quien enciende la
 * palanca.
 */
export function decidirBusquedaNativa(e: EntradaDeBusquedaNativa): DecisionDeBusquedaNativa {
  const { opciones } = e;
  const variante = opciones.variante;
  const no = (razon: string, extra: Partial<DecisionDeBusquedaNativa> = {}): DecisionDeBusquedaNativa => ({
    aplicar: false,
    razon,
    variante,
    siempreCargadas: [],
    diferidas: 0,
    tokensDiferidos: 0,
    ...extra,
  });

  if (opciones.modo === "off") return no("toolSearch is off");
  if (e.herramientas.length === 0) return no("no tools in this request");
  if (e.capacidad === undefined) {
    return no(
      "this provider is not an adapter of this package that can send the provider's tool search; " +
        "OpenAI documents tool search for its Responses and Agents APIs, not for Chat Completions, which is " +
        "what the OpenAI-compatible adapter speaks",
    );
  }
  if (!admiteBusquedaNativa(e.modelo)) {
    return no(`${desnudo(e.modelo)} is not in the provider's tool search model compatibility table`);
  }
  if (e.hayContrato) {
    return no(
      "this request carries an output contract, which travels as a forced tool on this provider; " +
        "combining it with deferred tools is not documented, so the selector keeps this request",
    );
  }
  if (e.cascadaActiva) {
    return no("the model cascade is on: the cheaper model and the escalation would both have to support tool search");
  }
  const busqueda = HERRAMIENTA_DE_BUSQUEDA[variante];
  if (e.herramientas.some((t) => t.id === busqueda.name)) {
    return no(`one of your tools is already named \`${busqueda.name}\``);
  }

  const ids = new Set(e.herramientas.map((t) => t.id));
  // Solo las que existen en esta petición y no son el contrato: pedir que se
  // cargue una herramienta que no viaja no significa nada.
  const siempreCargadas = opciones.siempreCargadas.filter((id) => ids.has(id) && id !== HERRAMIENTA_DE_CONTRATO);
  const fijas = new Set(siempreCargadas);
  const diferidas = e.herramientas.filter((t) => !fijas.has(t.id));
  const tokensDiferidos = diferidas.reduce((n, t) => n + t.tokens, 0);
  const base = { siempreCargadas, diferidas: diferidas.length, tokensDiferidos };

  if (diferidas.length === 0) return no("every tool is in `alwaysLoaded`: nothing to defer", base);
  if (diferidas.length > MAXIMO_DE_DIFERIDAS) {
    return no(`${diferidas.length} tools to defer, over the provider's limit of ${MAXIMO_DE_DIFERIDAS}`, base);
  }

  if (opciones.modo === "always") {
    return {
      aplicar: true,
      variante,
      ...base,
      razon:
        `toolSearch "always": ${diferidas.length} tool(s) deferred behind the provider's ${variante} search, ` +
        `${siempreCargadas.length} always loaded; no size or cost check (you chose it)`,
    };
  }

  // ── auto ──
  if (e.capacidad !== "oficial") {
    return no(
      "the adapter is not talking to the provider's own API host; a proxy may not forward the search blocks. " +
        'Use toolSearch "always" if yours does',
      base,
    );
  }
  const total = e.herramientas.reduce((n, t) => n + t.tokens, 0);
  if (e.herramientas.length < UMBRAL_DOCUMENTADO.herramientas && total <= UMBRAL_DOCUMENTADO.tokensDeEsquemas) {
    return no(
      `${e.herramientas.length} tools and about ${total} tokens of definitions: under the provider's documented ` +
        "threshold (10 or more tools, or more than 10k tokens), where standard tool calling fits better",
      base,
    );
  }

  const precioEntrada = e.precio.inputPer1k / 1000;
  const precioSalida = e.precio.outputPer1k / 1000;
  const r = Math.min(1, Math.max(0, e.lecturaDeCache));
  const cargaPeorCaso = diferidas
    .map((t) => t.tokens)
    .sort((a, b) => b - a)
    .slice(0, RESULTADOS_POR_BUSQUEDA)
    .reduce((n, t) => n + t, 0);
  const ahorroDelPrefijo = r * precioEntrada * tokensDiferidos;
  const costeDeUnaBusqueda =
    precioEntrada * cargaPeorCaso + precioSalida * LONGITUD_MAXIMA_DE_LA_CONSULTA[variante];
  const cifras = { ahorroDelPrefijo, costeDeUnaBusqueda };

  if (ahorroDelPrefijo < costeDeUnaBusqueda) {
    return no(
      `deferring ${tokensDiferidos} tokens of definitions saves ${ahorroDelPrefijo.toFixed(6)} per request even with ` +
        `a warm prompt cache, less than one worst-case search costs (${costeDeUnaBusqueda.toFixed(6)}: the ` +
        `${RESULTADOS_POR_BUSQUEDA} largest definitions uncached plus the longest query); the selector keeps this request`,
      { ...base, ...cifras },
    );
  }
  return {
    aplicar: true,
    variante,
    ...base,
    ...cifras,
    razon:
      `${diferidas.length} tool(s) deferred behind the provider's ${variante} search (${tokensDiferidos} tokens of ` +
      `definitions out of the cached prefix): it pays even if every request searches once with a warm cache ` +
      `(${ahorroDelPrefijo.toFixed(6)} saved vs ${costeDeUnaBusqueda.toFixed(6)} worst-case search). ` +
      "The provider's counter measures it; the layer credits nothing for it",
  };
}

/**
 * La verja de riesgo del selector, aplicada a la ruta nativa: una petición que
 * el router no clasifica como acción no recibe herramientas de escritura. Solo
 * con un catálogo TIPADO y el router encendido —con uno sin tipar no hay riesgo
 * del que derivar nada, igual que en el selector—.
 */
export function candidatasPorRiesgo(
  tools: readonly ToolDescriptor[],
  permiteEscrituras: boolean,
  routerApagado: boolean,
): ToolDescriptor[] {
  if (routerApagado || catalogoSinTipar(tools)) return [...tools];
  return tools.filter((t) => permiteEscrituras || t.risk === "read");
}
