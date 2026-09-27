import { createSavingsLayer } from "../../src/pipeline/create.js";
import { AnthropicProvider } from "../../src/providers/anthropic.js";
import type { ChatMessage, SavingsRequest } from "../../src/contracts/types.js";
import type { CacheAnthropicSimulada } from "./simulador.js";

/**
 * Tres formas de tráfico para comparar colocaciones de puntos de ruptura sobre
 * el simulador de la caché de Anthropic. Deterministas: sin azar y con reloj
 * inyectado, para que el mismo escenario dé la misma factura en cada tirada.
 *
 *  · AGENTE: un bucle de herramientas. Cada paso extiende el prompt anterior
 *    con la llamada del asistente y un resultado grande. Pasos cada pocos
 *    segundos. Es el tráfico donde la cola vale más.
 *  · RAG DE UN SOLO USO: cabecera compartida + un documento propio en el
 *    historial + la pregunta. Nadie reenvía el documento. Es donde la colocación
 *    fija paga prima sobre lo que nadie relee.
 *  · CHAT LENTO: conversaciones a ritmo humano, con huecos de 8 min entre
 *    turnos. La caché de 5 min caduca siempre; la de 1 h, no.
 */

export interface Reloj {
  ahora: () => number;
  avanzar: (ms: number) => void;
}

export function reloj(inicio = 1_800_000_000_000): Reloj {
  let t = inicio;
  return { ahora: () => t, avanzar: (ms) => void (t += ms) };
}

export const MODELO = "anthropic/claude-sonnet-4-5";

export function capaSobre(
  sim: CacheAnthropicSimulada,
  r: Reloj,
  modo: "fixed" | "auto" | "cola-siempre",
): ReturnType<typeof createSavingsLayer> {
  return createSavingsLayer({
    // «cola-siempre» es lo que hacen Vercel (`caching: 'auto'`), LangChain y
    // LiteLLM: el punto en el último mensaje en TODAS las peticiones.
    provider: new AnthropicProvider({ fetchImpl: sim.fetch, automaticCache: modo === "cola-siempre" }),
    ...(modo === "auto" ? { cacheBreakpoints: "auto" as const } : {}),
    now: r.ahora,
    silenceWarnings: true,
  });
}

// ~3.000 tokens de reglas fijas: por encima de cualquier mínimo cacheable.
const SISTEMA_AGENTE = "Eres un agente de código. Lee antes de editar, ejecuta los tests y explica cada cambio. ".repeat(140);
const SISTEMA_RAG = "Responde solo con lo que diga el documento, cita la sección y di 'no consta' si no está. ".repeat(90);
const SISTEMA_CHAT = "Eres el asistente de una aseguradora. Sé breve, amable y no inventes coberturas. ".repeat(100);

function texto(semilla: string, caracteres: number): string {
  let s = "";
  let i = 0;
  while (s.length < caracteres) s += `${semilla}-${i++} `;
  return s.slice(0, caracteres);
}

async function enviar(layer: ReturnType<typeof createSavingsLayer>, messages: ChatMessage[]): Promise<void> {
  const req: SavingsRequest = { model: MODELO, messages: messages.map((m) => ({ ...m })) } as SavingsRequest;
  await layer.generate(req);
}

/** Bucles de agente: `runs` tareas de `pasos` pasos, un paso cada `huecoMs`. Resultados de ~2.000 tokens. */
export async function agente(
  layer: ReturnType<typeof createSavingsLayer>,
  r: Reloj,
  o: { runs: number; pasos: number; huecoMs: number; entreRuns: number; resultadoChars?: number },
): Promise<void> {
  for (let run = 0; run < o.runs; run++) {
    const msgs: ChatMessage[] = [
      { role: "system", content: SISTEMA_AGENTE },
      { role: "user", content: `Tarea ${run}: arregla el test que falla en el módulo ${run}.` },
    ];
    for (let paso = 0; paso < o.pasos; paso++) {
      await enviar(layer, msgs);
      r.avanzar(o.huecoMs);
      const id = `c${run}_${paso}`;
      msgs.push({
        role: "assistant",
        content: `Leo el fichero ${paso}.`,
        toolCalls: [{ id, name: "leer_fichero", arguments: JSON.stringify({ ruta: `src/m${run}/f${paso}.ts` }) }],
      });
      msgs.push({ role: "tool", toolCallId: id, name: "leer_fichero", content: texto(`r${run}p${paso}`, o.resultadoChars ?? 8_000) });
    }
    r.avanzar(o.entreRuns);
  }
}

/** RAG de un solo uso: `n` peticiones cada `huecoMs`, cada una con su documento de ~6.000 tokens. */
export async function ragDeUnSoloUso(
  layer: ReturnType<typeof createSavingsLayer>,
  r: Reloj,
  o: { n: number; huecoMs: number },
): Promise<void> {
  for (let i = 0; i < o.n; i++) {
    await enviar(layer, [
      { role: "system", content: SISTEMA_RAG },
      { role: "user", content: `Documento:\n${texto(`doc${i}`, 24_000)}` },
      { role: "assistant", content: "Documento recibido." },
      { role: "user", content: `¿Qué dice la sección ${i % 7}?` },
    ]);
    r.avanzar(o.huecoMs);
  }
}

/** Chat a ritmo humano: `conversaciones` de `turnos` turnos, `huecoMs` entre turnos. */
export async function chatLento(
  layer: ReturnType<typeof createSavingsLayer>,
  r: Reloj,
  o: { conversaciones: number; turnos: number; huecoMs: number },
): Promise<void> {
  for (let c = 0; c < o.conversaciones; c++) {
    const msgs: ChatMessage[] = [{ role: "system", content: SISTEMA_CHAT }];
    for (let t = 0; t < o.turnos; t++) {
      msgs.push({ role: "user", content: `Conversación ${c}, turno ${t}: ${texto(`q${c}${t}`, 1_200)}` });
      await enviar(layer, msgs);
      r.avanzar(o.huecoMs);
      msgs.push({ role: "assistant", content: `Respuesta ${c}.${t}: ${texto(`a${c}${t}`, 2_000)}` });
    }
  }
}
