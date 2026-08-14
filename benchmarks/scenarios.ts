/**
 * Demonstration scenarios for BV-SALA.
 *
 * Each scenario exercises one savings lever and (where possible) carries a
 * quality check, so the harness proves TWO things at once: that we save money
 * AND that the answer is still correct. The point is to demonstrate *real*
 * savings — not to flatter the numbers.
 */
import type { SavingsRequest, SavingsResult, ToolDescriptor } from "../src/index.js";

/** Which of the four ledgers a scenario's saving is attributed to (for the
 * per-ledger A/B rollup). "none" = a plain call used as setup, not a lever. */
export type LedgerTag =
  | "avoided_calls"
  | "eliminated_tokens"
  | "compressed_tokens"
  | "output_restriction"
  | "none";

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
];
