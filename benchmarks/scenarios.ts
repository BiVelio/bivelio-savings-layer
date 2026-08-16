/**
 * Demonstration scenarios for BV-SALA.
 *
 * Each scenario exercises one savings lever and (where possible) carries a
 * quality check, so the harness proves TWO things at once: that we save money
 * AND that the answer is still correct. The point is to demonstrate *real*
 * savings — not to flatter the numbers.
 */
import type { JsonSchema, SavingsRequest, SavingsResult, ToolDescriptor } from "../src/index.js";

/**
 * Los libros que un escenario puede declarar. "none" = una llamada normal usada
 * como preparación, no una palanca.
 *
 * ES UNA LISTA EN TIEMPO DE EJECUCIÓN, y el tipo sale de ella —no al revés—
 * porque `sustrato-del-banco.test.ts` necesita comprobar el nombre declarado por
 * cada escenario, y un tipo de TypeScript no existe en tiempo de ejecución. La
 * verja tenía por eso su propia copia de esta lista escrita a mano, y las dos
 * copias divergieron en cuanto se añadió un libro: el tipo aceptaba
 * `provider_cached`, la verja no lo conocía, y el fallo salió al añadir el
 * escenario de Anthropic —no al añadir el libro—. Derivando el tipo de la lista
 * hay UNA sola definición y volver a divergir deja de ser posible.
 */
export const LIBROS = [
  "avoided_calls",
  "eliminated_tokens",
  "compressed_tokens",
  // El CUARTO libro faltaba en esta lista, y no por descuido: no había forma de
  // atribuirle nada. `grep -rn "cache_control" src/` daba cero, no existía
  // adaptador de Anthropic, y ningún escenario llegaba al mínimo de tramo, así
  // que `providerCachedInputTokens` salía 0 en los siete escenarios y en los dos
  // brazos. Un contrato sin productor: el informe prometía cuatro libros y el
  // banco sólo sabía nombrar tres.
  "provider_cached",
  "output_restriction",
  // El codebook de salida NO va en `output_restriction` aunque los dos toquen la
  // salida, y la diferencia no es de matiz: `output_restriction` es el techo de
  // `maxOutputTokens`, medido en −2,8% neto sobre 210 ensayos —o sea, una palanca
  // que NO ahorra—, y el codebook es el mecanismo contrario (que lo generado
  // ocupe menos sin perder un bit). Sumarlos en una fila haría que uno tapara al
  // otro y nadie sabría cuál de los dos mueve la cifra.
  "output_codebook",
  "none",
] as const;

/** Which of the four ledgers a scenario's saving is attributed to (for the
 * per-ledger A/B rollup). "none" = a plain call used as setup, not a lever. */
export type LedgerTag = (typeof LIBROS)[number];

/**
 * Las palancas OPT-IN de la 0.3.0, por su nombre en `savings`.
 *
 * Existe esta lista —y no basta el texto libre de `lever`— porque el informe
 * tiene que poder decir "esta palanca NO se ejercitó" en vez de dejar que el
 * lector suponga que se midió y salió cero. Una palanca que se pide y no
 * dispara (la verja económica la descartó, faltaba una dependencia, el sondeo
 * degradó) produce exactamente los mismos números que una palanca que no
 * ahorra, y esas dos cosas no se parecen en nada.
 *
 * `providerPrefixCache` no es un campo de `savings` sino una condición del
 * tráfico, pero se nombra igual porque tiene el mismo problema: se ejercita o no
 * según lo que devuelva el proveedor, y cuando no se ejercita hay que decirlo.
 */
export const PALANCAS = [
  "outputCodebook",
  "toolDiscovery",
  "compression",
  "semanticCache",
  "providerPrefixCache",
] as const;

export type Palanca = (typeof PALANCAS)[number];

/**
 * Las familias de modelo cuya economía de caché de prefijo es DISTINTA, no solo
 * más cara o más barata.
 *
 * Se replica aquí la detección de `economics/politica-compresion.ts` a
 * propósito: aquélla devuelve un tramo de caché (un dato del SDK) y ésta decide
 * si un escenario del BANCO tiene sentido contra un modelo dado. Son dos
 * preguntas distintas y atarlas obligaría a exportar identificadores internos.
 */
export type FamiliaDeModelo = "openai" | "anthropic" | "desconocida";

export function familiaDeModelo(model: string): FamiliaDeModelo {
  const id = model.toLowerCase();
  const barra = id.indexOf("/");
  const proveedor = barra > 0 ? id.slice(0, barra) : "";
  const desnudo = barra >= 0 ? id.slice(barra + 1) : id;
  if (proveedor === "openai" || proveedor === "azure-openai") return "openai";
  if (proveedor === "anthropic") return "anthropic";
  if (/^(gpt-|o[1-9](-|$)|chatgpt)/.test(desnudo)) return "openai";
  if (desnudo.startsWith("claude")) return "anthropic";
  return "desconocida";
}

/**
 * Si la palanca opt-in que el escenario declara LLEGÓ A DISPARAR, y por qué no
 * cuando no lo hizo.
 *
 * ES LA MITAD DEL VALOR DE ESTE BANCO. Una palanca que se pide y la verja
 * económica descarta produce EXACTAMENTE los mismos números que una palanca que
 * se aplicó y no ahorró: 0% y un libro a cero. Sin este campo, el lector del
 * artefacto no tiene forma de distinguir "medimos y no salió" de "no llegamos a
 * medir", y las dos llevan a decisiones opuestas.
 */
export interface EstadoDePalanca {
  palanca: Palanca;
  ejercitada: boolean;
  /** Lo que dijo la propia capa en su traza. Vacío si no dejó traza. */
  motivo: string;
}

/**
 * CÓMO VA A HABLAR EL BANCO CON EL PROVEEDOR EN ESTA TIRADA.
 *
 * No es un detalle de fontanería: decide qué palancas pueden siquiera VIAJAR.
 * `cache_control` —lo único que hace cachear a Anthropic, porque no cachea
 * sola— existe en el protocolo de Mensajes y en ningún otro. A través de una
 * pasarela que habla el protocolo de OpenAI no hay campo donde ponerlo, así que
 * la palanca no es que no ahorre: es que no se ejecuta.
 */
export type TransporteDelBanco = "mock" | "openai-compatible" | "anthropic-nativo";

/**
 * Una palanca que el TRANSPORTE configurado no puede ejercitar, con lo que
 * habría que configurar para poder medirla.
 *
 * ES UNA TERCERA CATEGORÍA, y hacen falta las tres. `ejercitada: false` dice
 * "se pidió y no disparó" —la verja la descartó, el sondeo degradó—, y eso es
 * una medición. Esto otro dice "aquí no se puede pedir", que no lo es. Publicar
 * lo segundo como si fuera lo primero es exactamente lo que pasó con el
 * escenario de Anthropic: 0 tokens cacheados en los dos brazos sobre un prefijo
 * de 7.287 tokens, publicado como si alguien hubiera medido un fracaso, cuando
 * lo que ocurrió es que el adaptador nativo no llegó a instanciarse nunca.
 */
export interface PalancaNoMedible {
  palanca: Palanca;
  escenario: string;
  /** Por qué no se puede medir con este transporte. */
  motivo: string;
  /** Qué hay que configurar para que sí se mida. Nunca vacío. */
  comoMedirla: string;
}

/**
 * ¿Puede este transporte ejercitar la palanca que el escenario mide?
 *
 * Devuelve `null` cuando sí, y la declaración de por qué no cuando no. La
 * decisión mira `familia` y no el modelo: la etiqueta ya significa "este
 * escenario mide una palanca del PROTOCOLO de esa familia" —es la razón por la
 * que existe—, y `Anthropic stable-prefix agent turn` es el único caso hoy.
 *
 * MOCK no cuenta como no medible y es deliberado: ahí ninguna cifra es una
 * afirmación de ahorro, la tirada existe para probar la fontanería (que la capa
 * marque el prefijo, que el adaptador reparta los mensajes) y el informe ya
 * avisa aparte de que el proveedor simulado nunca devuelve `cached_tokens`.
 */
export function noMedibleEnTransporte(
  s: Scenario,
  transporte: TransporteDelBanco,
): PalancaNoMedible | null {
  if (!s.palanca) return null;
  if (s.familia !== "anthropic" || transporte !== "openai-compatible") return null;
  return {
    palanca: s.palanca,
    escenario: s.name,
    motivo:
      "el endpoint configurado habla el protocolo de OpenAI, y `cache_control` sólo existe en la " +
      "API de Mensajes de Anthropic: no hay campo por el que enviarlo, así que la palanca no " +
      "llega a ejecutarse. Su cero no sería una medición.",
    comoMedirla:
      "declara un endpoint NATIVO de Anthropic en BVSALA_DEMO_ANTHROPIC_BASE_URL (+ " +
      "BVSALA_DEMO_ANTHROPIC_API_KEY) y el banco usará AnthropicProvider para los modelos de esa " +
      "familia.",
  };
}

/**
 * Lee de la traza de la capa si la palanca del escenario disparó.
 *
 * Se lee de `report.traces` y no de los libros a propósito: los libros son el
 * NÚMERO, y un número a cero es ambiguo. La traza es la DECISIÓN, con su motivo,
 * y es contrato publicado del SDK — el mismo texto que ve el cliente en su panel.
 *
 * `transporte` sólo lo usa la caché de prefijo, y para no mentir en el diagnóstico
 * de un cero: contra el proveedor simulado la causa se conoce (no reporta
 * `cached_tokens`), contra el endpoint nativo la causa candidata es otra (el
 * prefijo cambió o expiró el TTL) y contra una pasarela hay que nombrar el
 * enrutado. Omitirlo mantiene el diagnóstico genérico.
 */
export function estadoDePalanca(
  s: Scenario,
  r: SavingsResult,
  cacheOptimizado: number,
  transporte?: TransporteDelBanco,
): EstadoDePalanca | null {
  if (!s.palanca) return null;
  // LA PRIMERA traza de la etapa, no la última: la etapa del codebook deja DOS
  // —la decisión ("applied"/"skipped") y luego la expansión de la respuesta
  // ("expanded")—, y quedarse con la última daba "no ejercitada" sobre una
  // palanca que había disparado y estaba ahorrando un 24,8%. El detector de una
  // verja de honestidad no puede fallar hacia el lado del silencio.
  const traza = (etapa: string) => r.report.traces.find((t) => t.stage === etapa);
  const motivoDe = (t: { outcome: string; detail?: Record<string, unknown> } | undefined): string =>
    t ? `${t.outcome}${t.detail?.reason ? `: ${String(t.detail.reason)}` : ""}` : "la capa no dejó traza de esta etapa";

  switch (s.palanca) {
    case "outputCodebook": {
      const t = traza("output-codebook");
      return { palanca: s.palanca, ejercitada: t?.outcome === "applied", motivo: motivoDe(t) };
    }
    case "toolDiscovery": {
      const t = traza("tool-discovery");
      return { palanca: s.palanca, ejercitada: !!t?.outcome.startsWith("applied"), motivo: motivoDe(t) };
    }
    case "compression": {
      const t = traza("compression");
      return { palanca: s.palanca, ejercitada: t?.outcome === "applied", motivo: motivoDe(t) };
    }
    case "providerPrefixCache": {
      // Ésta no la decide la capa sino el PROVEEDOR: o devuelve tokens
      // cacheados o no. En MOCK nunca los devuelve, y por eso la tirada MOCK
      // dirá siempre que esta palanca no se ejercitó — que es la verdad.
      if (cacheOptimizado > 0) {
        return {
          palanca: s.palanca,
          ejercitada: true,
          motivo: `el proveedor sirvió ${cacheOptimizado} tokens desde su caché de prefijo`,
        };
      }
      // EL CERO DESNUDO NO VALE, Y ESTO ES LO QUE LO VISTE.
      //
      // «cached_tokens = 0» tiene tres causas que llevan a decisiones opuestas y
      // hasta ahora se publicaban con la misma frase:
      //
      //   1. el prompt no llega al mínimo de tramo → el proveedor no cachea nada
      //      por debajo, y el cero SÍ está explicado;
      //   2. la capa no marcó el prefijo (su verja económica lo descartó, o el
      //      escenario renuncia a la caché) → tampoco es cosa del proveedor;
      //   3. el prompt supera el mínimo, la capa marcó, y aun así vuelve 0 → el
      //      tamaño NO lo explica.
      //
      // El caso 3 es el que motivó esto: `Stable-prefix agent turn` manda ~5.258
      // tokens y midió 5.120 cacheados en `gpt-4o` (40 tramos de 128, que es la
      // granularidad de OpenAI) y CERO en `gpt-4o-mini`, con el mismo prompt byte
      // a byte. O sea que el mínimo de tramo no puede ser la explicación, y
      // dejar el 0 sin decirlo invita a leerlo como «la palanca no ahorra en el
      // modelo pequeño», que es justo lo que no se ha medido.
      const entrada = r.report?.tokens?.actualInput ?? 0;
      const marcado = traza("prefix-cache");
      let motivo: string;
      if (transporte === "mock") {
        motivo =
          "el proveedor simulado no reporta `cached_tokens`: esta palanca sólo es medible en " +
          "LIVE, por construcción";
      } else if (entrada > 0 && entrada < MINIMO_DE_TRAMO_TOKENS) {
        motivo =
          `cached_tokens = 0 y está explicado: el prompt mide ${entrada} tokens y no llega al ` +
          `mínimo de tramo (${MINIMO_DE_TRAMO_TOKENS}), por debajo del cual el proveedor no ` +
          "cachea nada";
      } else if (marcado && marcado.outcome !== "marked") {
        motivo =
          `cached_tokens = 0 y la capa NO marcó el prefijo: ${motivoDe(marcado)}. La palanca no ` +
          "llegó a pedirse, así que el cero no dice nada sobre el proveedor";
      } else {
        motivo =
          `cached_tokens = 0 con un prompt de ${entrada} tokens, POR ENCIMA del mínimo de tramo ` +
          `(${MINIMO_DE_TRAMO_TOKENS})${marcado ? " y con el prefijo marcado" : ""}: el tamaño ` +
          "del prompt NO explica este cero. Lo que queda no es que la palanca no ahorre, sino " +
          (transporte === "anthropic-nativo"
            ? "que el prefijo dejara de coincidir byte a byte entre peticiones, o que expirara " +
              "el TTL de la caché efímera (5 min) entre una y otra"
            : "que el endpoint no reporte cached_tokens, o que las peticiones no aterricen en " +
              "una instancia con el prefijo caliente — a través de una pasarela el enrutado no " +
              "es nuestro") +
          ". No lo leas como una medición";
      }
      return { palanca: s.palanca, ejercitada: false, motivo };
    }
    default:
      return { palanca: s.palanca, ejercitada: false, motivo: "sin detector" };
  }
}

export interface Scenario {
  name: string;
  /** Which savings lever this demonstrates. */
  lever: string;
  /** Which ledger the measured A/B delta is attributed to. */
  ledger: LedgerTag;
  request: SavingsRequest;
  /** Optional correctness check on the result. */
  expect?: (r: SavingsResult) => boolean;
  /** Run once before measuring, to populate the cache (for cache-hit demos). */
  warm?: boolean;
  /**
   * La palanca opt-in que este escenario enciende, si enciende alguna. El banco
   * comprueba después si de verdad DISPARÓ y lo publica; ver {@link PALANCAS}.
   */
  palanca?: Palanca;
  /**
   * La familia de modelo contra la que este escenario significa algo. Presente =
   * el banco lo SALTA con los demás modelos y lo dice en el informe, en vez de
   * medirlo igualmente y publicar un cero engañoso.
   *
   * El caso que lo motiva: el escenario de `cache_control` explícito mide una
   * palanca que en un endpoint de OpenAI no existe —ahí el proveedor cachea solo,
   * sin que nadie marque nada—, así que servido contra `gpt-4o-mini` mediría el
   * descuento del proveedor y lo apuntaría como aportación nuestra.
   */
  familia?: FamiliaDeModelo;
}

// Real argument schemas: a tool's JSON schema travels in the prompt, so the
// tool selector's savings are only measurable when tools carry realistic
// parameters (an empty {} would make the dropped-tool token delta ~0).
const tools: ToolDescriptor[] = [
  {
    id: "get_weather", intents: ["weather forecast"], risk: "read",
    description: "Get the weather forecast for a city on a given date.",
    parameters: { type: "object", required: ["city", "date"], properties: {
      city: { type: "string", description: "City name, e.g. 'Madrid'" },
      date: { type: "string", description: "ISO date (YYYY-MM-DD)" },
      units: { type: "string", enum: ["celsius", "fahrenheit"] },
    } },
  },
  {
    id: "search_docs", intents: ["search documentation"], risk: "read",
    description: "Full-text search over the product documentation.",
    parameters: { type: "object", required: ["query"], properties: {
      query: { type: "string", description: "Search query" },
      top_k: { type: "integer", minimum: 1, maximum: 20 },
      section: { type: "string", enum: ["billing", "api", "guides", "faq"] },
    } },
  },
  {
    id: "delete_account", intents: ["delete account"], risk: "destructive",
    description: "Permanently delete a user account and all associated data.",
    parameters: { type: "object", required: ["user_id", "confirm"], properties: {
      user_id: { type: "string" }, confirm: { type: "boolean" },
    } },
  },
  {
    id: "get_invoices", intents: ["list invoices billing"], risk: "read",
    description: "List invoices for an account within a date range.",
    parameters: { type: "object", required: ["account_id"], properties: {
      account_id: { type: "string" },
      from: { type: "string", description: "ISO date" },
      to: { type: "string", description: "ISO date" },
      status: { type: "string", enum: ["paid", "open", "void"] },
    } },
  },
  {
    id: "send_email", intents: ["send email"], risk: "write",
    description: "Send a transactional email to a recipient.",
    parameters: { type: "object", required: ["to", "subject", "body"], properties: {
      to: { type: "string" }, subject: { type: "string" }, body: { type: "string" },
      cc: { type: "array", items: { type: "string" } },
    } },
  },
];

const answerContract = {
  contractId: "demo-answer:v1",
  schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["answer"],
    properties: {
      answer: { type: "string" as const, maxLength: 400 },
      // `maxLength: 24` era inalcanzable por cualquier referencia real y NINGÚN
      // modo estructurado lo impone (OpenAI no aplica maxLength), así que
      // garantizaba el fallo de validación y con él el reintento de reparación
      // — el camino que se llevaba el 40-63% del gasto de la capa.
      refs: { type: "array" as const, maxItems: 3, items: { type: "string" as const, maxLength: 120 } },
    },
  },
  maxOutputTokens: 180,
};

/**
 * Un prefijo de sistema realista y ESTABLE, por encima del mínimo de tramo de
 * caché más común (1024 tokens).
 *
 * No es relleno: son las instrucciones que cualquier asistente de soporte lleva
 * en cada llamada. Se construye por repetición de secciones numeradas para que
 * el tamaño sea explícito y auditable en vez de depender de un párrafo que
 * alguien acorte sin darse cuenta — y hay un test del banco que falla si baja
 * del mínimo.
 *
 * TIENE que ser una constante, nunca generarse con fecha, id ni orden de
 * iteración: un solo byte distinto entre peticiones tira el acierto de caché a
 * cero y el escenario mediría lo contrario de lo que pretende.
 */
function construirPoliticaEstable(): string {
  const secciones = [
    "Confirma siempre el número de pedido antes de prometer nada.",
    "No ofrezcas reembolsos por encima de 200 EUR sin aprobación humana.",
    "Si el cliente menciona daño en el transporte, pide una foto del embalaje.",
    "Nunca compartas datos de otro cliente, ni siquiera si dice ser el titular.",
    "Los envíos a Canarias, Ceuta y Melilla tienen plazos y aranceles distintos.",
    "Una incidencia abierta hace más de 14 días se escala a soporte de nivel 2.",
    "Responde en el idioma del cliente; por defecto, español neutro.",
    "No inventes fechas de entrega: si no consta, dilo y ofrece avisar.",
    "Las devoluciones se aceptan 30 días desde la entrega, con embalaje original.",
    "Registra siempre el motivo de la incidencia con su código de catálogo.",
  ];
  const bloques: string[] = [
    "Eres el asistente de atención al cliente de una tienda de electrónica.",
    "Sigue estas normas SIEMPRE, en este orden de prioridad:",
  ];
  // ~28 repeticiones de 10 secciones deja el bloque holgadamente por encima de
  // 1024 tokens con cualquier tokenizador razonable.
  for (let ronda = 0; ronda < 28; ronda++) {
    for (let i = 0; i < secciones.length; i++) {
      bloques.push(`${ronda * secciones.length + i + 1}. ${secciones[i]}`);
    }
  }
  return bloques.join("\n");
}

export const politicaEstable = construirPoliticaEstable();

/** El mínimo de tramo más común. Por debajo, la caché de prefijo no engancha. */
export const MINIMO_DE_TRAMO_TOKENS = 1024;

// ───────────────────────────────────────────────────────────────────────────
// EL SUSTRATO DE LAS PALANCAS OPT-IN DE LA 0.3.0
//
// Ninguna de las tres se enciende sola, y ninguna se enciende en el vacío: cada
// una exige una FORMA DE PETICIÓN concreta o su verja económica la descarta —con
// razón—. Un escenario que encienda la palanca sin traer esa forma mide cero y
// se lee como "la palanca no ahorra", que es la conclusión contraria a la
// verdadera. Lo que sigue es esa forma, con la cuenta que hay que superar
// escrita al lado.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Contrato de triaje con enums LARGOS y claves LARGAS: lo que el codebook de
 * salida necesita para tener algo que acortar.
 *
 * LA VERJA DE DINERO (`constraints/codebook.ts`) decide EN DINERO y exige un
 * ahorro neto de 8 tokens de ENTRADA equivalentes contando por los dos lados:
 * lo que adelgaza el `response_format` de la entrada, tarifado a precio de
 * entrada, más el delta de SALIDA medido, tarifado a precio de salida — que en
 * la familia 4o es 4x. Un contrato de `{answer: string}` no la pasa —no hay
 * enums que codificar y renombrar una clave ahorra un token—, y por eso el
 * contrato compartido del banco no sirve para medir esto.
 *
 * Medido con o200k_base sobre este esquema: el esquema compacto ahorra 29 tokens
 * de ENTRADA. Eso es determinista y es el lado bueno. El otro lado lo decide el
 * modelo, y con 29 tokens de esquema el equilibrio está en −5,25 tokens de
 * salida: el codebook paga mientras la respuesta no crezca más que eso.
 *
 * ⚠️ LA CIFRA VIEJA DE ESTE COMENTARIO ERA «NETO 36», y salía de modelar el
 * ahorro de salida sobre un testigo sintético (7 tokens) y sumarlo sin ponderar
 * por precio. En vivo, ese modelo se equivocaba de SIGNO en la mitad de los
 * casos: ver la nota del escenario «Triage decision (output codebook)».
 *
 * Es la forma de un clasificador real, no un contrato de laboratorio: decidir,
 * priorizar, categorizar y justificar es lo que hace un triaje de soporte en
 * cada ticket, y sus enums son largos porque los escribe quien tiene que leerlos
 * en un panel.
 */
export const contratoDeTriaje = {
  contractId: "demo-triaje:v1",
  schema: {
    type: "object" as const,
    additionalProperties: false,
    required: ["decision", "priority", "category", "sentiment", "recommended_action", "justification"],
    properties: {
      decision: {
        type: "string" as const,
        enum: ["approve_refund", "request_more_evidence", "escalate_to_human", "reject_with_explanation"],
      },
      priority: { type: "string" as const, enum: ["low", "normal", "high", "urgent"] },
      category: {
        type: "string" as const,
        enum: ["shipping_damage", "late_delivery", "wrong_item", "billing_error", "product_defect"],
      },
      sentiment: { type: "string" as const, enum: ["angry", "frustrated", "neutral", "satisfied"] },
      recommended_action: { type: "string" as const, maxLength: 200 },
      justification: { type: "string" as const, maxLength: 300 },
    },
  },
  maxOutputTokens: 220,
};

/** Los valores que el LLAMANTE declaró. Lo que reciba tiene que ser uno de
 *  éstos —nunca el código compacto—, y eso es lo que prueba la reversión. */
export const DECISIONES_DEL_TRIAJE = contratoDeTriaje.schema.properties.decision.enum;

/**
 * Los filtros que lleva TODA herramienta de consulta de un CRM. Van en las ocho
 * porque van en las ocho de verdad: paginación, rango, orden y proyección son la
 * mitad del esquema de cualquier endpoint de listado.
 *
 * Y son la mitad del VOLUMEN, que es de lo que va este escenario: el esquema
 * completo de cada herramienta viaja en cada petición aunque el modelo vaya a
 * usar una o ninguna.
 */
const filtrosComunes: Record<string, JsonSchema> = {
  account_id: { type: "string", description: "Identificador de la cuenta del cliente (obligatorio)." },
  from: { type: "string", description: "Fecha inicial del rango, en ISO 8601 (YYYY-MM-DD). Inclusive." },
  to: { type: "string", description: "Fecha final del rango, en ISO 8601 (YYYY-MM-DD). Inclusive." },
  limit: { type: "integer", minimum: 1, maximum: 200, description: "Número máximo de filas a devolver. Por defecto 25." },
  cursor: { type: "string", description: "Cursor de paginación devuelto por la llamada anterior." },
  sort_by: { type: "string", enum: ["created_at", "updated_at", "amount", "status"], description: "Campo por el que ordenar el resultado." },
  sort_order: { type: "string", enum: ["asc", "desc"], description: "Sentido de la ordenación." },
  locale: { type: "string", description: "Idioma de las etiquetas devueltas, como es-ES o ca-ES." },
  currency: { type: "string", enum: ["EUR", "USD", "GBP"], description: "Moneda en la que expresar los importes monetarios." },
  include_archived: { type: "boolean", description: "Incluir también los registros archivados o dados de baja." },
  fields: {
    type: "array",
    maxItems: 20,
    items: { type: "string" },
    description: "Proyección: nombres de campo a devolver. Vacío devuelve el registro completo.",
  },
};

function herramientaDeConsulta(spec: {
  id: string;
  description: string;
  intents: string[];
  propias: Record<string, JsonSchema>;
}): ToolDescriptor {
  return {
    id: spec.id,
    intents: spec.intents,
    // TODAS de lectura, y no por comodidad. `peorCasoDeEsquemas` mete SIEMPRE las
    // de escritura en la segunda llamada —una acción no puede perderse en un
    // sondeo—, así que una destructiva en el catálogo reduce el ahorro que la
    // verja puede reconocer y el escenario mediría la mezcla de dos cosas.
    risk: "read",
    description: spec.description,
    parameters: {
      type: "object",
      required: ["account_id"],
      properties: { ...filtrosComunes, ...spec.propias },
    },
  };
}

/**
 * EL CATÁLOGO GRANDE que la palanca `toolDiscovery` necesita para que su verja
 * económica diga que sí.
 *
 * LA CUENTA QUE HAY QUE SUPERAR (`router/schema-on-demand.ts`), en tokens:
 *
 *     esquemasCompletos − 2·descriptoresLigeros − esquemasDeLaSegunda − 2·prompt
 *         ≥ 2 · 96 · (precio de salida / precio de entrada)
 *
 * El sondeo cuesta el prompt otra vez y hasta 96 tokens de salida, y la regla
 * exige que la ganancia cubra ADEMÁS el caso en que el sondeo no elija nada. Con
 * ocho herramientas y la razón salida/entrada más dura de las que mide el banco
 * (5x, Anthropic) hacen falta ~340 tokens de esquema por herramienta. Éstas
 * miden 470 cada una con o200k_base —3.762 en total—, así que la verja aprueba
 * con margen en los tres modelos que mide el banco. Con cinco herramientas
 * pequeñas —el catálogo del escenario "Tool-heavy request"— la descarta, y hace
 * bien: dos llamadas costarían más que una.
 *
 * SON OCHO, ni más ni menos, y ese número es el tope del selector
 * (`ToolSelector.maxTools`, 8). Con nueve, el selector descartaría una y ese
 * descarte se acredita en el LIBRO 2, así que el escenario mediría a la vez la
 * poda del selector y el sondeo, y la cifra no sería atribuible a ninguno de los
 * dos. Ocho es el catálogo más grande que esta capa llega a transmitir.
 *
 * TODOS los `intents` llevan la palabra "cliente", que está en la pregunta: así
 * las ocho puntúan y ninguna se cae. Un escenario donde el selector poda no mide
 * esta palanca.
 */
export const catalogoGrande: ToolDescriptor[] = [
  herramientaDeConsulta({
    id: "listar_pedidos",
    description: "Lista los pedidos del cliente con su estado, importe y línea de productos.",
    intents: ["pedidos del cliente", "compras del cliente"],
    propias: {
      status: { type: "string", enum: ["draft", "placed", "paid", "shipped", "delivered", "cancelled"], description: "Estado del pedido." },
      channel: { type: "string", enum: ["web", "app", "phone", "marketplace", "store"], description: "Canal por el que entró el pedido." },
      min_amount: { type: "number", minimum: 0, description: "Importe mínimo del pedido, en la moneda indicada." },
      include_lines: { type: "boolean", description: "Devolver también las líneas de producto de cada pedido." },
      warehouse: { type: "string", description: "Código del almacén desde el que se sirvió el pedido." },
    },
  }),
  herramientaDeConsulta({
    id: "listar_incidencias",
    description: "Lista las incidencias abiertas y cerradas del cliente, con su motivo de catálogo.",
    intents: ["incidencias del cliente", "reclamaciones del cliente"],
    propias: {
      severity: { type: "string", enum: ["low", "medium", "high", "critical"], description: "Gravedad asignada a la incidencia." },
      reason_code: { type: "string", description: "Código de motivo del catálogo interno de incidencias." },
      assigned_team: { type: "string", enum: ["tier1", "tier2", "logistics", "billing"], description: "Equipo al que está asignada." },
      only_open: { type: "boolean", description: "Devolver únicamente las incidencias todavía abiertas." },
      breached_sla: { type: "boolean", description: "Filtrar por las que han incumplido el acuerdo de nivel de servicio." },
    },
  }),
  herramientaDeConsulta({
    id: "listar_facturas",
    description: "Lista las facturas del cliente con su estado de cobro y método de pago.",
    intents: ["facturas del cliente", "pagos del cliente"],
    propias: {
      status: { type: "string", enum: ["draft", "open", "paid", "void", "uncollectible"], description: "Estado de la factura." },
      payment_method: { type: "string", enum: ["card", "sepa", "transfer", "paypal"], description: "Método de pago utilizado." },
      min_total: { type: "number", minimum: 0, description: "Importe total mínimo de la factura." },
      include_lines: { type: "boolean", description: "Devolver también las líneas de la factura." },
      tax_region: { type: "string", description: "Región fiscal aplicada (peninsular, canarias, ceuta, melilla)." },
    },
  }),
  herramientaDeConsulta({
    id: "listar_envios",
    description: "Lista los envíos del cliente con transportista, seguimiento y fecha prevista.",
    intents: ["envios del cliente", "seguimiento del cliente"],
    propias: {
      carrier: { type: "string", enum: ["seur", "correos", "dhl", "ups", "gls"], description: "Transportista que llevó el envío." },
      status: { type: "string", enum: ["label_created", "in_transit", "out_for_delivery", "delivered", "returned", "lost"], description: "Estado del envío." },
      tracking_number: { type: "string", description: "Número de seguimiento exacto, si se conoce." },
      destination_zip: { type: "string", description: "Código postal de destino." },
      late_only: { type: "boolean", description: "Devolver solo los envíos que llegaron fuera de plazo." },
    },
  }),
  herramientaDeConsulta({
    id: "listar_devoluciones",
    description: "Lista las devoluciones del cliente con su motivo, estado y reembolso asociado.",
    intents: ["devoluciones del cliente", "reembolsos del cliente"],
    propias: {
      status: { type: "string", enum: ["requested", "approved", "received", "refunded", "rejected"], description: "Estado de la devolución." },
      reason: { type: "string", enum: ["damaged", "wrong_item", "not_as_described", "changed_mind", "late"], description: "Motivo declarado por el cliente." },
      refund_method: { type: "string", enum: ["original", "store_credit", "bank_transfer"], description: "Vía por la que se devolvió el dinero." },
      min_refund: { type: "number", minimum: 0, description: "Importe mínimo reembolsado." },
      requires_pickup: { type: "boolean", description: "Filtrar por las que necesitan recogida a domicilio." },
    },
  }),
  herramientaDeConsulta({
    id: "listar_conversaciones",
    description: "Lista las conversaciones de soporte del cliente por canal y agente.",
    intents: ["conversaciones del cliente", "soporte del cliente"],
    propias: {
      channel: { type: "string", enum: ["email", "chat", "phone", "whatsapp", "social"], description: "Canal de la conversación." },
      agent_id: { type: "string", description: "Identificador del agente que la atendió." },
      sentiment: { type: "string", enum: ["angry", "frustrated", "neutral", "satisfied"], description: "Sentimiento detectado en la conversación." },
      include_transcript: { type: "boolean", description: "Devolver la transcripción completa, no solo el resumen." },
      min_messages: { type: "integer", minimum: 1, description: "Número mínimo de mensajes de la conversación." },
    },
  }),
  herramientaDeConsulta({
    id: "consultar_suscripcion",
    description: "Devuelve la suscripción y el consumo del cliente por periodo de facturación.",
    intents: ["suscripcion del cliente", "consumo del cliente"],
    propias: {
      plan: { type: "string", enum: ["free", "starter", "pro", "enterprise"], description: "Plan contratado." },
      status: { type: "string", enum: ["trialing", "active", "past_due", "cancelled"], description: "Estado de la suscripción." },
      metric: { type: "string", enum: ["seats", "requests", "storage", "bandwidth"], description: "Métrica de consumo a devolver." },
      granularity: { type: "string", enum: ["day", "week", "month"], description: "Granularidad de la serie de consumo." },
      include_overage: { type: "boolean", description: "Incluir el exceso facturado sobre el plan." },
    },
  }),
  herramientaDeConsulta({
    id: "listar_valoraciones",
    description: "Lista las valoraciones y encuestas que ha respondido el cliente.",
    intents: ["valoraciones del cliente", "encuestas del cliente"],
    propias: {
      survey_type: { type: "string", enum: ["nps", "csat", "ces", "product_review"], description: "Tipo de encuesta o valoración." },
      min_score: { type: "integer", minimum: 0, maximum: 10, description: "Puntuación mínima." },
      max_score: { type: "integer", minimum: 0, maximum: 10, description: "Puntuación máxima." },
      with_comment: { type: "boolean", description: "Solo las que llevan comentario escrito." },
      product_sku: { type: "string", description: "Referencia del producto valorado." },
    },
  }),
];

/**
 * Un hilo de soporte reenviado, con la ficha del pedido y el pie legal repetidos
 * IDÉNTICOS en cada mensaje. Es el contexto que la palanca `compression`
 * necesita para que sus tres verjas la dejen pasar.
 *
 * LAS TRES CUENTAS (`compression/compression.ts` + `economics/`):
 *   1. TAMAÑO: el contexto comprimible —los mensajes que NO son `system`, porque
 *      un `system` no se comprime nunca— tiene que superar 2000 tokens.
 *   2. AHORRO NETO: lo que el compresor quite de verdad, ≥ 200 tokens.
 *   3. DINERO: el prompt ya comprimido no puede caer por debajo del mínimo de
 *      tramo de la caché de prefijo (1024). Sin `compressionEconomics.prefix`
 *      declarado —y no se declara: nadie ha medido la tasa de aciertos de este
 *      tráfico— la capa se niega a comprimir un prompt fuera del tramo, y hace
 *      bien: ahí quitar tokens sube la factura.
 *
 * VA TODO EN UN SOLO MENSAJE de usuario porque el pipeline comprime MENSAJE A
 * MENSAJE: repartir el hilo en seis mensajes dejaría cada repetición en un
 * mensaje distinto y el compresor no vería ninguna.
 *
 * ES UNA CONSTANTE, como el prefijo estable: ni fechas de hoy, ni ids
 * generados, ni orden de iteración. Un texto que cambie entre repeticiones
 * mediría ruido.
 */
function construirHiloDeSoporte(): string {
  const ficha = [
    "── FICHA DEL PEDIDO ─────────────────────────────────────────",
    "Pedido: 40218-ES   ·   Cuenta: acme-8891   ·   Canal: web",
    "Fecha de compra: 2026-06-02   ·   Entrega prevista: 2026-06-09",
    "Transportista: SEUR   ·   Seguimiento: 9F41-2287-1130-ES",
    "Destino: Calle Mayor 14, 3B, 28013 Madrid (peninsular)",
    "Importe: 419,90 EUR   ·   Método de pago: tarjeta terminada en 4417",
    "Línea 1: auriculares supraaurales BX-700, 1 unidad, 249,90 EUR",
    "Línea 2: base de carga inalámbrica QI-30, 2 unidades, 85,00 EUR",
    "Garantía: 24 meses desde la entrega, con embalaje original",
    "Ventana de devolución: 30 días desde la entrega confirmada",
    "Región fiscal: peninsular   ·   IVA aplicado: 21%",
    "Gestor asignado: equipo tier1, cola de incidencias de logística",
    "Estado actual del pedido: entregado con incidencia abierta",
    "─────────────────────────────────────────────────────────────",
  ];
  const pie = [
    "-- ",
    "Atención al Cliente · Tienda de electrónica · Horario de 9:00 a 18:00 CET",
    "Este mensaje y sus adjuntos son confidenciales y van dirigidos únicamente a su destinatario.",
    "Si lo ha recibido por error, le rogamos que lo comunique al remitente y lo elimine de su sistema.",
    "No está permitida la reproducción total o parcial de este mensaje sin autorización previa.",
    "Los datos personales se tratan conforme a la política de privacidad publicada en nuestro sitio web.",
    "Puede ejercer sus derechos de acceso, rectificación y supresión escribiendo al buzón de privacidad.",
    "Antes de imprimir este mensaje, piense si es realmente necesario. El medio ambiente es cosa de todos.",
  ];
  // Los cuerpos son lo ÚNICO que no se repite, así que son los que fijan el
  // tamaño del prompt YA COMPRIMIDO. Y ese tamaño es una condición de la
  // medición, no un detalle de redacción: si lo comprimido cae por debajo del
  // mínimo de tramo de la caché de prefijo (1024 tokens), la capa se NIEGA a
  // comprimir —y hace bien, ahí quitar tokens sube la factura— y el escenario
  // volvería a medir cero. Medido con o200k_base: 3.770 tokens de hilo que
  // quedan en 1.765 tras quitar 105 líneas repetidas — 741 por encima del
  // mínimo. Con los cuerpos a la mitad quedaban en 1.002 y la capa se abstenía
  // por 22 tokens. Hay un test del banco que falla si esto se acorta.
  const cuerpos = [
    [
      "Buenos días. El paquete llegó ayer con la caja de los auriculares abollada por una esquina.",
      "El producto parece funcionar, pero la caja está claramente golpeada y el precinto cedido.",
      "Adjunto tres fotos del embalaje tal y como me lo entregó el repartidor, sin abrir del todo.",
      "En la primera se ve la esquina inferior derecha hundida, con el cartón abierto en la unión.",
      "En la segunda se aprecia que el precinto original está cortado y vuelto a pegar con celo.",
      "En la tercera se ve la etiqueta de transporte, por si el número de bulto os sirve de algo.",
      "El repartidor no me hizo firmar nada ni me dejó anotar la incidencia en su terminal.",
      "Le pregunté si podía rechazar el paquete y me dijo que ya no, que constaba como entregado.",
      "Me gustaría saber si tengo derecho a cambio o si esto se considera daño estético sin más.",
      "Prefiero resolverlo por escrito, porque por teléfono ya me han dado dos versiones distintas.",
    ],
    [
      "Buenos días, gracias por avisar y por las fotos, que se ven perfectamente.",
      "He abierto la incidencia con el código de catálogo de daño en transporte y la he pasado a logística.",
      "El repartidor debería haber anotado la reserva en el albarán; queda constancia de que no lo hizo.",
      "Eso no le perjudica: con las fotos y la fecha de entrega la reclamación al transportista sale igual.",
      "Necesitaría que me confirme si el contenido presenta también algún golpe o solo la caja exterior.",
      "Le pido que revise en concreto la diadema, la funda rígida y el cable trenzado de repuesto.",
      "Si alguno de esos tres tuviera marca, el caso cambia de categoría y el plazo se acorta.",
      "En cuanto lo confirme puedo tramitar la recogida sin coste y el envío de una unidad nueva.",
      "La recogida la haría el mismo transportista, en la dirección del pedido y en horario de mañana.",
      "Si prefiere otra dirección o franja, dígamelo y lo dejo anotado antes de cerrar la solicitud.",
    ],
    [
      "El contenido está bien, lo he probado esta mañana y suena correctamente por los dos canales.",
      "La diadema no tiene marcas y la funda venía dentro sin arrugas ni roces visibles.",
      "El cable de repuesto tampoco tiene nada, sigue en su bolsa precintada de fábrica.",
      "O sea que el daño es solo de la caja exterior, pero es que la caja era media parte del regalo.",
      "El problema es ese: pensaba regalarlo la semana que viene y así no puedo entregarlo.",
      "Entiendo que para vosotros sea daño estético, pero para un regalo la presentación cuenta.",
      "La dirección de recogida es la misma del pedido y por la mañana me viene bien cualquier día.",
      "Si podéis, avisadme la víspera, porque no siempre hay alguien en casa a primera hora.",
      "Si el cambio tarda más de diez días, prefiero directamente la devolución del importe completo.",
      "Con diez días ya no llego a la fecha del regalo y tendría que comprar otra cosa distinta.",
    ],
    [
      "Entendido. Le confirmo que la recogida está programada y que no tiene ningún coste para usted.",
      "Queda anotada para mañana en horario de mañana, con aviso la víspera como me pide.",
      "El plazo habitual de sustitución es de cuatro a seis días laborables desde que sale la recogida.",
      "Ese plazo cuenta desde que el transportista escanea el bulto, no desde hoy, para que lo tenga.",
      "Si en ese plazo no ha recibido la unidad nueva, la devolución del importe se tramita automáticamente.",
      "La devolución iría contra el mismo medio de pago, sin que usted tenga que volver a escribir.",
      "Le he anotado en la incidencia que el regalo tiene fecha, para que logística lo priorice.",
      "También he pedido que la unidad nueva salga con embalaje reforzado y doble precinto.",
      "No puedo garantizarle el estado de la caja al llegar, pero sí que salga en perfecto estado de aquí.",
      "Cualquier cosa, responda a este mismo hilo y me llega directamente a mí sin pasar por la cola.",
    ],
    [
      "Han pasado ocho días laborables y no he recibido nada, ni la recogida ni la unidad nueva.",
      "Nadie vino el día que me dijisteis y tampoco recibí el aviso de la víspera que quedó anotado.",
      "He llamado dos veces al teléfono de soporte y las dos veces se ha cortado la llamada en la espera.",
      "La primera vez estuve veintidós minutos y la segunda dieciocho, según el registro del móvil.",
      "En el seguimiento del transportista no aparece ninguna recogida asociada a este pedido.",
      "A estas alturas ya no me sirve para el regalo, así que quiero la devolución del importe.",
      "He tenido que comprar otro modelo en una tienda física para llegar a la fecha, así que el cambio sobra.",
      "Le agradecería una fecha concreta para el reembolso y no un plazo estimado más.",
      "Si hace falta que yo lleve el paquete a un punto de recogida, dígamelo y lo llevo mañana mismo.",
      "Lo que no quiero es otra semana sin noticias y volver a empezar la conversación desde cero.",
    ],
    [
      "Lamento mucho lo ocurrido y le confirmo que la incidencia sube a soporte de nivel 2 por antigüedad.",
      "He comprobado el registro y la orden de recogida se generó pero nunca llegó a asignarse a un repartidor.",
      "El error es nuestro y no le corresponde a usted arreglarlo llevando el paquete a ningún sitio.",
      "El reembolso de 419,90 EUR se emite contra la tarjeta terminada en 4417 en cuanto la recogida se cierre.",
      "He solicitado que la recogida se reasigne hoy mismo con prioridad, y me consta el número de expediente.",
      "En cuanto el transportista escanee el bulto, el abono sale en el mismo día hábil.",
      "Le paso mi extensión directa para que no vuelva a pasar por la cola general del teléfono.",
      "También he dejado nota para que la próxima compra lleve el gasto de envío bonificado.",
      "Vuelvo a escribirle en cuanto logística confirme la recogida, con la fecha exacta del abono.",
      "Gracias por la paciencia y disculpe el tiempo que le hemos hecho perder con esto.",
    ],
  ];

  const bloques: string[] = [
    "Este es el hilo completo de la incidencia, tal y como está en el buzón. Resume qué ha pasado y qué falta por hacer.",
  ];
  cuerpos.forEach((cuerpo, i) => {
    bloques.push("");
    bloques.push(`===== MENSAJE ${i + 1} DE ${cuerpos.length} =====`);
    // La ficha y el pie viajan en CADA mensaje, byte a byte iguales. Es lo que
    // hace un hilo reenviado de verdad, y es la redundancia que el compresor
    // puede quitar sin perder un bit: la primera copia se queda.
    bloques.push(...ficha);
    bloques.push(...cuerpo);
    bloques.push(...pie);
  });
  return bloques.join("\n");
}

export const hiloDeSoporte = construirHiloDeSoporte();

export const scenarios: Scenario[] = [
  {
    name: "Local arithmetic",
    lever: "avoided_calls (deterministic resolver)",
    ledger: "avoided_calls",
    request: {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "What is (2 + 2) * 3?" }],
    },
    expect: (r) => r.text.trim() === "12" && r.report.calls.actualLlm === 0,
  },
  {
    name: "FAQ (first ask)",
    lever: "baseline (populates cache)",
    ledger: "none",
    request: {
      model: "openai/gpt-4o-mini",
      // CON el dato en el prompt. Sin él la pregunta no tiene respuesta
      // correcta: los dos brazos se inventaban un número distinto y el juez
      // —con razón— decía que no eran equivalentes. Eso no medía la capa, medía
      // dos alucinaciones, y hundía la verja de calidad 8 de cada 12 veces.
      // Los dos escenarios FAQ llevan el mismo prompt byte a byte, que es la
      // condición para que la caché acierte.
      messages: [
        { role: "system", content: "Refund policy: the standard refund window is 30 days from purchase." },
        { role: "user", content: "What is the standard refund window in days?" },
      ],
      response: answerContract,
      context: { tenantId: "acme", knowledgeEpoch: "kb-2026-07" },
    },
  },
  {
    name: "FAQ (repeat ask)",
    lever: "avoided_calls (exact cache hit)",
    ledger: "avoided_calls",
    warm: true,
    request: {
      model: "openai/gpt-4o-mini",
      // CON el dato en el prompt. Sin él la pregunta no tiene respuesta
      // correcta: los dos brazos se inventaban un número distinto y el juez
      // —con razón— decía que no eran equivalentes. Eso no medía la capa, medía
      // dos alucinaciones, y hundía la verja de calidad 8 de cada 12 veces.
      // Los dos escenarios FAQ llevan el mismo prompt byte a byte, que es la
      // condición para que la caché acierte.
      messages: [
        { role: "system", content: "Refund policy: the standard refund window is 30 days from purchase." },
        { role: "user", content: "What is the standard refund window in days?" },
      ],
      response: answerContract,
      context: { tenantId: "acme", knowledgeEpoch: "kb-2026-07" },
    },
    expect: (r) => r.report.cache.result === "exact" && r.report.calls.actualLlm === 0,
  },
  {
    name: "Summarize provided text",
    lever: "avoided retrieval (NO_RETRIEVAL routing)",
    ledger: "eliminated_tokens",
    request: {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Summarize the following text: our Q2 report shows steady growth in EU markets with rising retention." }],
      response: answerContract,
    },
    expect: (r) => r.report.routing.executionClass === "NO_RETRIEVAL",
  },
  {
    name: "Tool-heavy request",
    lever: "fewer tool tokens (tool selector)",
    ledger: "eliminated_tokens",
    request: {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "what is the weather forecast for tomorrow?" }],
      tools,
      response: answerContract,
    },
    expect: (r) => r.report.calls.actualTools <= 1,
  },
  {
    name: "Large uniform table",
    lever: "compressed_tokens (TOON/CSV format selector)",
    ledger: "compressed_tokens",
    request: {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Summarize the attached user table." }],
      // Contrato PROPIO con un tope que cabe. El compartido tope a 180 tokens
      // una tarea cuya respuesta natural son ~360 (medido: el brazo naive, sin
      // tope, emitió 362), así que el JSON se cortaba a media cadena y no
      // validaba NUNCA. Eso no medía la palanca de compresión: medía una mala
      // configuración del banco. Un cliente que pide el resumen de 50 filas y lo
      // limita a 180 tokens tiene el mismo problema, y ahora el layer se lo dice
      // en vez de pagar dos llamadas para acabar igual.
      response: {
        contractId: "demo-answer-largo:v1",
        schema: {
          type: "object" as const,
          additionalProperties: false,
          required: ["answer"],
          properties: {
            answer: { type: "string" as const, maxLength: 1200 },
            refs: { type: "array" as const, maxItems: 3, items: { type: "string" as const, maxLength: 120 } },
          },
        },
        maxOutputTokens: 600,
      },
      structuredData: {
        users: Array.from({ length: 50 }, (_, i) => ({
          id: 1000 + i,
          name: `user_${i}`,
          role: i % 3 === 0 ? "admin" : "member",
          plan: i % 2 ? "pro" : "free",
          active: i % 4 !== 0,
        })),
      },
    },
    // Antes: `r.report.tokens.compressedInput > 0` — comprobaba su propio libro.
    // El escenario que perdió 49,5% de dinero y sobreacreditó su ledger 3x se
    // puntuaba "calidad 2/2" por afirmar que el ledger que infló no es cero.
    // Una verja de calidad tiene que mirar la RESPUESTA, no la contabilidad.
    expect: (r) => r.report.constraints.structurallyValid === true && r.text.trim().length > 0,
  },
  {
    name: "Constrained structured answer",
    lever: "output restriction (schema + maxOutputTokens)",
    ledger: "output_restriction",
    request: {
      model: "openai/gpt-4o-mini",
      messages: [{ role: "user", content: "Give a one-line summary of BV-SALA with up to three references." }],
      response: answerContract,
    },
    expect: (r) => r.report.constraints.structurallyValid === true,
  },
  {
    // EL ESCENARIO QUE FALTABA, y su ausencia sesgaba el titular entero.
    //
    // Ningún escenario del banco llegaba al mínimo de tramo de la caché de
    // prefijo del proveedor: el mayor manda 1212 tokens en el brazo naive, y el
    // resto se mueve entre 19 y 300. Medido en la tirada del 2026-08-13 con
    // preguntas de FAQ, la entrada eran ~16 tokens por petición. Con prompts así
    // `usage.prompt_tokens_details.cached_tokens` sale 0 en LOS DOS BRAZOS —está
    // en el artefacto, `providerCachedInputTokens: 0` en los siete escenarios—,
    // o sea que el banco no puede ni ver esa palanca, ni la nuestra ni la que el
    // cliente ya tendría sin nosotros.
    //
    // Este escenario reproduce la forma de tráfico donde vive el dinero de
    // verdad: un turno de agente con instrucciones largas y estables delante y
    // una pregunta corta y variable al final. Es lo que hace un asistente de
    // soporte o un extractor documental en cada llamada, y es donde la caché de
    // prefijo decide la factura.
    //
    // El prefijo va en un `system` y se repite IDÉNTICO entre repeticiones, que
    // es la condición que pide el proveedor. Lo variable, al final.
    name: "Stable-prefix agent turn",
    lever: "provider prefix cache (stable system prefix over the tier minimum)",
    ledger: "none",
    palanca: "providerPrefixCache",
    // Solo contra OpenAI: aquí el proveedor cachea SOLO, sin que nadie marque
    // nada, así que lo que se ve es el descuento que el cliente ya tendría sin
    // nosotros — que es justo lo que hay que poder ver. Contra Anthropic esa
    // lectura no existe sin `cache_control`, y el escenario de abajo es el que
    // mide ese caso.
    familia: "openai",
    request: {
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: politicaEstable },
        { role: "user", content: "El pedido 40218 llegó con una caja abollada. ¿Qué le respondo al cliente?" },
      ],
      response: answerContract,
    },
    expect: (r) => r.report.constraints.structurallyValid === true && r.text.trim().length > 0,
  },
  {
    // LA PALANCA QUE EL BANCO NO PODÍA NI VER.
    //
    // `providerCachedInputTokens` salía 0 en los siete escenarios y en LOS DOS
    // BRAZOS: ningún prompt llegaba al mínimo de tramo (el mayor manda 1212
    // tokens; el resto se mueve entre 19 y 300), así que la caché de prefijo del
    // proveedor era invisible aquí. No se podía medir ni lo que el cliente ya
    // obtiene sin nosotros, ni lo que aportaríamos.
    //
    // POR QUÉ ESTE ESCENARIO VA CONTRA ANTHROPIC y no contra la familia 4o. Son
    // dos economías distintas y sólo una aísla nuestra aportación:
    //
    //   · OpenAI cachea SOLA. El descuento (50%) le llega al cliente lo use o no
    //     nuestra capa, así que un A/B ahí mide sobre todo el descuento del
    //     proveedor. Por eso `accounting.ts` tarifa los tokens cacheados a la
    //     tarifa cacheada en los DOS lados: no es ahorro nuestro.
    //   · Anthropic NO cachea sola: exige `cache_control` EXPLÍCITO, y el brazo
    //     naive no lo pone porque casi nadie lo pone. Aquí el acierto lo provoca
    //     la capa, la lectura vale el 10% de la entrada, y la diferencia entre
    //     los dos brazos es atribuible.
    //
    // La forma del tráfico es la que importa: instrucciones largas y ESTABLES
    // delante, pregunta corta y variable al final. Es lo que hace un asistente
    // de soporte en cada llamada, y es donde la caché de prefijo decide la
    // factura.
    //
    // El prefijo es una CONSTANTE construida por repetición: ni fecha, ni id, ni
    // orden de iteración de un mapa. Un solo byte distinto entre peticiones tira
    // el acierto a cero y el escenario mediría lo contrario de lo que pretende.
    name: "Anthropic stable-prefix agent turn",
    lever: "provider prefix cache (explicit cache_control over a stable system prefix)",
    // Libro 4. Va aparte de los otros tres y NO se suma con ellos: estos tokens
    // siguen en el prompt, sólo se facturan más baratos.
    ledger: "provider_cached",
    palanca: "providerPrefixCache",
    // SOLO contra Anthropic, y esto es una verja y no una etiqueta. Servido
    // contra un endpoint de OpenAI —que es lo que pasaba en cuanto
    // `BVSALA_DEMO_MODEL` sobrescribía el modelo de TODOS los escenarios— este
    // escenario mediría el descuento que OpenAI aplica sola y lo publicaría en el
    // libro 4 como aportación de la capa. El banco lo salta y lo dice.
    familia: "anthropic",
    request: {
      model: "anthropic/claude-sonnet-4-5",
      messages: [
        { role: "system", content: politicaDeSoporte() },
        { role: "user", content: "El pedido 40218 llegó con la caja abollada. ¿Qué le respondo?" },
      ],
      response: answerContract,
    },
    expect: (r) => r.report.constraints.structurallyValid === true && r.text.trim().length > 0,
  },
  {
    // PALANCA OPT-IN #1: codebook de salida.
    //
    // El modelo escribe `{"d":"A",...}` en vez de `{"decision":"approve_refund",
    // ...}` y la capa lo devuelve expandido. Mismo contenido, menos símbolos, en
    // el lado CARO de la factura: un token de salida cuesta ~4x uno de entrada.
    //
    // Los dos brazos resuelven la MISMA tarea con el MISMO contrato: el brazo A
    // manda el esquema del llamante (es lo que mandaría un equipo sin la capa) y
    // el B manda el compacto.
    //
    // ═════════════════════════════════════════════════════════════════════════
    // ⚠️ ESTE ESCENARIO MINTIÓ EN MOCK, Y LA LECCIÓN VALE PARA TODO EL BANCO.
    // ═════════════════════════════════════════════════════════════════════════
    //
    // En MOCK publicaba +24,8 % de ahorro. Es un ARTEFACTO DEL SIMULADOR:
    // `providers/mock.ts` fabrica la respuesta A PARTIR DEL ESQUEMA que recibe,
    // así que con un esquema compacto fabrica una respuesta compacta, siempre,
    // contra cualquier modelo. Lo que en un modelo de verdad decide la mitad
    // cara de esta palanca —cuánto ESCRIBE— el simulador no lo modela.
    //
    // Medido en vivo, mismo escenario, mismos 8 pares, dos modelos:
    //
    //     modelo         A (sin capa)   B (codebook)   Δ salida   neto
    //     gpt-4o           184 / 75      158 / 72         +3      +8,0 %  (95 %lo 4,8 %)
    //     gpt-4o-mini      184 / 72      158 / 88        −16      −8,2 %
    //
    // La ENTRADA baja igual en los dos (−26 tokens): eso es el esquema compacto
    // y es determinista. Lo que cambia de SIGNO es la salida, y depende del
    // MODELO: el pequeño pierde guía semántica con `"d"` en vez de `"decision"`
    // y rellena más. Con solo la tirada del pequeño la conclusión fue «retirar
    // la palanca», y la del grande la invirtió: UNA TIRADA CONTRA UN SOLO MODELO
    // NO ES UN RESULTADO, ni aquí ni en ninguna otra fila de este banco.
    //
    // Por eso este escenario declara `gpt-4o`: es el modelo para el que hay un
    // delta medido POSITIVO, así que la palanca dispara y se mide lo que se
    // quiere medir. Forzando `BVSALA_DEMO_MODELS=gpt-4o-mini` la capa la
    // descarta y lo dice en la traza — que también es el resultado correcto, y
    // el informe lo distingue de «se aplicó y no ahorró» (ver `estadoDePalanca`).
    name: "Triage decision (output codebook)",
    lever: "output codebook (compact contract to the provider, caller's shape back)",
    ledger: "output_codebook",
    palanca: "outputCodebook",
    request: {
      model: "openai/gpt-4o",
      messages: [
        {
          role: "user",
          content:
            "Triage this support ticket: the customer's order arrived with a dented box after a " +
            "three-day delay; the product itself works. They ask for a replacement, not a refund. " +
            "Decide, prioritise, categorise and justify in one sentence.",
        },
      ],
      response: contratoDeTriaje,
      savings: { outputCodebook: true },
    },
    // MIRA LA RESPUESTA, no la contabilidad. Y mira lo único que puede
    // demostrar que la reversión funcionó: que lo que llega está en la forma
    // del LLAMANTE. Si el codebook se aplicara y la expansión fallara, aquí
    // llegaría "A" en vez de "approve_refund" y esto se caería — que es
    // precisamente el fallo que devuelve datos plausibles y equivocados.
    expect: (r) => {
      const d = r.data as { decision?: unknown } | null;
      return (
        r.report.constraints.structurallyValid === true &&
        typeof d?.decision === "string" &&
        (DECISIONES_DEL_TRIAJE as readonly string[]).includes(d.decision)
      );
    },
  },
  {
    // PALANCA OPT-IN #2: schema-on-demand (`toolDiscovery`).
    //
    // NO LLEVA PREFIJO ESTABLE, y no es un descuido: esta palanca RENUNCIA a la
    // caché de prefijo del proveedor en todas las peticiones, esté o no aplicada
    // (lo dice su JSDoc: las herramientas se renderizan lo PRIMERO y el sondeo
    // decide cuáles viajan, así que el frente del prompt varía). Un escenario
    // que mezclara las dos mediría la resta de dos palancas y la atribuiría a
    // una.
    //
    // Tampoco lleva contrato de salida: con herramientas en juego, el modelo
    // puede responder pidiendo una llamada (`finishReason: "tool_calls"`, texto
    // vacío) y eso es una respuesta correcta, no un fallo de contrato.
    name: "Big tool catalogue (schema-on-demand)",
    lever: "toolDiscovery (probe with light descriptors, then only the schemas needed)",
    // Los tokens de esquema que no viajan en la llamada de verdad. El LIBRO 2 de
    // la capa NO los acredita —el pipeline lo explica: no salieron gratis, los
    // pagó una llamada extra— pero el dinero medido aquí sí es real y tiene que
    // caer en algún sitio; cae en el libro de la entrada eliminada, CON el coste
    // del sondeo dentro del mismo saco. Si el sondeo no compensa, esta fila sale
    // negativa, que es la verdad.
    ledger: "eliminated_tokens",
    palanca: "toolDiscovery",
    request: {
      model: "openai/gpt-4o-mini",
      messages: [
        {
          role: "user",
          content:
            "Prepara el resumen del cliente acme-8891 antes de que le llame su gestor: " +
            "qué ha pedido este trimestre y qué ha fallado.",
        },
      ],
      tools: catalogoGrande,
      savings: { toolDiscovery: true },
    },
    // La respuesta útil de un turno con herramientas es una de estas dos: una
    // petición de llamada a una herramienta QUE EXISTE, o un texto. Un nombre
    // inventado sería el fallo caro —el modelo dice "ya lo consulto" y no
    // consulta nada— y aquí se cae.
    expect: (r) => {
      const llamadas = r.toolCalls ?? [];
      if (llamadas.length > 0) {
        const ids = new Set(catalogoGrande.map((t) => t.id));
        return llamadas.every((c) => ids.has(c.name));
      }
      return r.text.trim().length > 0;
    },
  },
  {
    // PALANCA OPT-IN #3: compresión de contexto largo.
    //
    // El contexto es un hilo de soporte reenviado donde la ficha del pedido y el
    // pie legal se repiten IDÉNTICOS en cada mensaje. El compresor del banco
    // (`benchmarks/compresor.ts`) quita únicamente líneas literalmente repetidas
    // dentro del mismo texto: no reescribe nada, así que no hay pérdida que
    // discutir y el ahorro es defendible sin juez.
    //
    // Exige un `compressor` inyectado en la capa. Sin él el pipeline avisa por
    // consola y la palanca no dispara — el banco lo inyecta, y si un día dejara
    // de hacerlo el informe diría "no ejercitada" en vez de publicar un cero.
    name: "Forwarded support thread (compression)",
    lever: "context compression (drop verbatim repetitions from a forwarded thread)",
    ledger: "compressed_tokens",
    palanca: "compression",
    request: {
      model: "openai/gpt-4o-mini",
      messages: [
        { role: "system", content: "Eres un asistente que resume incidencias de soporte para el equipo de nivel 2." },
        { role: "user", content: hiloDeSoporte },
      ],
      response: {
        contractId: "demo-resumen-hilo:v1",
        schema: {
          type: "object" as const,
          additionalProperties: false,
          required: ["answer"],
          properties: {
            answer: { type: "string" as const, maxLength: 1200 },
            refs: { type: "array" as const, maxItems: 3, items: { type: "string" as const, maxLength: 120 } },
          },
        },
        maxOutputTokens: 500,
      },
      savings: { compression: true },
    },
    // La RESPUESTA, no el libro. `compressedInput > 0` sería puntuarse a sí mismo
    // con el número que la propia palanca infla — el error que ya se corrigió en
    // el escenario de la tabla de 50 filas.
    expect: (r) => r.report.constraints.structurallyValid === true && r.text.trim().length > 0,
  },
  // NO HAY ESCENARIO DE `semanticCache`, Y ES DELIBERADO.
  //
  // La palanca exige un `EmbeddingFn` y en este repo no hay ninguna
  // implementación. Se puede montar en diez líneas un "embedding" por hash de
  // palabras, pero eso no mide una caché SEMÁNTICA: mide solapamiento léxico, que
  // es justo lo que la verja determinista de `cache/semantic.ts` ya comprueba por
  // debajo. El escenario saldría verde midiendo otra cosa, y un banco que mide
  // otra cosa es peor que un banco que no mide.
  //
  // Así que no se finge: el informe la lista como NO EJERCITADA con el motivo, y
  // el que lea la cifra sabe que ahí no hay dato. Ver `PALANCAS_SIN_ESCENARIO`.
];

/**
 * Palancas que el banco NO puede ejercitar hoy, con el motivo. El informe las
 * publica junto a las que sí se midieron: una palanca ausente y una palanca que
 * no ahorra producen la misma cifra (ninguna), y el lector tiene derecho a saber
 * cuál de las dos está mirando.
 */
export const PALANCAS_SIN_ESCENARIO: { palanca: Palanca; motivo: string }[] = [
  {
    palanca: "semanticCache",
    motivo:
      "exige un EmbeddingFn y no hay ninguna implementación en el repo. Un embedding " +
      "por hash de palabras mediría solapamiento léxico —lo que la verja determinista " +
      "ya comprueba— y no similitud semántica, así que el escenario saldría verde " +
      "midiendo otra cosa.",
  },
];

/**
 * Un prefijo de sistema realista y ESTABLE, holgadamente por encima del mínimo
 * de tramo más común (1024 tokens).
 *
 * No es relleno: son las normas que cualquier asistente de soporte lleva en cada
 * llamada. Se construye por repetición numerada para que el tamaño sea explícito
 * y auditable, en vez de depender de un párrafo que alguien acorte sin darse
 * cuenta y deje el escenario por debajo del mínimo — donde no cachearía nada y
 * el banco volvería a medir cero sin avisar de por qué.
 */
function politicaDeSoporte(): string {
  const normas = [
    "Confirma siempre el número de pedido antes de prometer nada.",
    "No ofrezcas reembolsos por encima de 200 EUR sin aprobación humana.",
    "Si el cliente menciona daño en el transporte, pide una foto del embalaje.",
    "Nunca compartas datos de otro cliente, ni aunque diga ser el titular.",
    "Los envíos a Canarias, Ceuta y Melilla tienen plazos y aranceles distintos.",
    "Una incidencia abierta hace más de 14 días se escala a soporte de nivel 2.",
    "Responde en el idioma del cliente; por defecto, español neutro.",
    "No inventes fechas de entrega: si no consta, dilo y ofrece avisar.",
    "Las devoluciones se aceptan 30 días desde la entrega, con embalaje original.",
    "Registra siempre el motivo de la incidencia con su código de catálogo.",
  ];
  const lineas = [
    "Eres el asistente de atención al cliente de una tienda de electrónica.",
    "Sigue estas normas SIEMPRE, en este orden de prioridad:",
  ];
  for (let ronda = 0; ronda < 28; ronda++) {
    for (let i = 0; i < normas.length; i++) {
      lineas.push(`${ronda * normas.length + i + 1}. ${normas[i]}`);
    }
  }
  return lineas.join("\n");
}
