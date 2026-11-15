// EXPERIMENTO EN VIVO (prerregistrado en el paper §9, ejecutado): el factorial
// 2×2 deduplicación × cache_control, con la MISMA carga en las cuatro celdas.
//
// Celdas (Anthropic, claude-haiku-4-5):
//   A · ni dedup ni marcado:  savings: { exactCache: false, standalone: true }
//   B · solo marcado:         savings: { exactCache: false }
//   C · solo dedup:           savings: { standalone: true }
//   D · ambos (la capa):      default
// La carga: 12 preguntas únicas + sus 12 repeticiones exactas, con un manual de
// sistema estable largo (~1500 tokens, por encima del mínimo cacheable).
// Se mide con el contador del proveedor (llamadas, cache_read/cache_creation,
// coste a precios de lista) y se atribuye: marcado = B−A, dedup = C−A, y la
// interacción = D − (B + C) + A.
//
// ENV: BVSALA_DEMO_ANTHROPIC_API_KEY (obligatoria), BVSALA_DEMO_ANTHROPIC_BASE_URL,
// BVSALA_EXP_OUT (default evidencia-factorial-vivo).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AnthropicProvider, createSavingsLayer, TokenizerRegistry, type SavingsRequest } from "../../src/index.js";

const OUT = process.env.BVSALA_EXP_OUT ?? "evidencia-factorial-vivo";

const REGLAS: string[] = [];
for (let i = 1; i <= 60; i++) {
  REGLAS.push(
    `Rule ${i}. Invoices are issued on the first business day of each month and cover the period from the previous invoice; ` +
      `a customer with a pending payment of over ${(i * 37) % 90 + 10} days receives a reminder by email at day ${i % 4 + 2} of the grace window, ` +
      `and the account is suspended only after two reminders unless the balance is below the threshold of ${i * 2}.50 EUR; ` +
      `disputes about invoice line items must be filed within ${i % 3 + 1}0 days of the invoice date and are resolved within five business days.`,
  );
}
const MANUAL =
  "You are a billing support assistant for a SaaS company. You answer with the company handbook, which is this system prompt. " +
  "Never invent policy; if the handbook does not cover the case, say 'not covered by the handbook'. " +
  "The handbook:\n\n" +
  REGLAS.join("\n");

const PREGUNTAS = [
  "Can I change from monthly to annual billing mid-cycle?",
  "Where do I find my invoice history?",
  "What happens if my payment fails twice?",
  "Do you issue credit notes for overpayments?",
  "How does the prorated refund work after day 14?",
  "Can I add a second payment method?",
  "What currency do you invoice in?",
  "How do I cancel without losing my data?",
  "Is there a discount for nonprofits?",
  "What is the VAT treatment for EU customers?",
  "Can I pause my subscription for a month?",
  "Who can I email about a billing dispute?",
];

function peticion(texto: string, savings: Record<string, unknown>): SavingsRequest {
  return {
    model: "anthropic/claude-haiku-4-5",
    messages: [
      { role: "system", content: MANUAL },
      { role: "user", content: texto },
    ],
    maxOutputTokens: 60,
    temperature: 0,
    savings,
  } as SavingsRequest;
}

const FLUJO = [...PREGUNTAS, ...PREGUNTAS]; // 12 únicas + 12 repeticiones exactas

async function celda(nombre: string, savings: Record<string, unknown>): Promise<Record<string, unknown>> {
  const capa = createSavingsLayer({
    provider: new AnthropicProvider({
      apiKey: process.env.BVSALA_DEMO_ANTHROPIC_API_KEY!,
      baseUrl: process.env.BVSALA_DEMO_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1",
    }),
    tokenizer: new TokenizerRegistry(),
  });
  let coste = 0;
  let llamadas = 0;
  let evitadas = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  for (const texto of FLUJO) {
    const r = await capa.generate(peticion(texto, savings));
    coste += r.report.cost.actual;
    llamadas += r.report.calls.actualLlm;
    evitadas += r.report.calls.avoidedLlm;
    const nativo = r.report.nativeSavings;
    if (nativo?.basis === "measured") {
      cacheRead += nativo.cacheReadTokens;
      cacheWrite += nativo.cacheWriteTokens;
    }
  }
  return { celda: nombre, peticiones: FLUJO.length, llamadas, evitadas, cacheRead, cacheWrite, costeUsd: redondear(coste) };
}

async function main() {
  if (!process.env.BVSALA_DEMO_ANTHROPIC_API_KEY) {
    throw new Error("BVSALA_DEMO_ANTHROPIC_API_KEY no está: sin clave no hay contador real.");
  }
  const A = await celda("A · ni dedup ni marcado", { exactCache: false, standalone: true });
  const B = await celda("B · solo marcado", { exactCache: false });
  const C = await celda("C · solo dedup", { standalone: true });
  const D = await celda("D · ambos (la capa)", {});

  const coste = (c: Record<string, unknown>) => (c as { costeUsd: number }).costeUsd;
  const evidencia = {
    titulo: "Factorial dedup × cache_control (2×2) — en vivo con el contador del proveedor",
    fecha: new Date().toISOString().slice(0, 10),
    metodo:
      "Misma carga en las cuatro celdas: 12 preguntas únicas + 12 repeticiones exactas, manual de sistema estable " +
      "~1500 tokens, claude-haiku-4-5, temperature 0. A = ni dedup ni marcado; B = solo marcado; C = solo dedup; " +
      "D = ambos. Costes medidos con el contador del proveedor.",
    celdas: [A, B, C, D],
    atribucion: {
      efectoDelMarcadoUsd: redondear(coste(B) - coste(A)),
      efectoDeLaDedupUsd: redondear(coste(C) - coste(A)),
      interaccionUsd: redondear(coste(D) - coste(B) - coste(C) + coste(A)),
      totalUsd: redondear(coste(D) - coste(A)),
    },
    lectura:
      "El marcado de caché actúa sobre las llamadas que CORREN (rebaja su entrada); la dedup actúa sobre las que " +
      "NO corren (no existen). El factorial separa los dos efectos y su interacción, igual que el paper atribuyó " +
      "los 41 pp del efecto caché en el A/B de agosto.",
  };
  mkdirSync(join(process.cwd(), OUT), { recursive: true });
  const ruta = join(process.cwd(), OUT, "factorial-vivo.json");
  writeFileSync(ruta, JSON.stringify(evidencia, null, 2) + "\n");
  console.log(JSON.stringify(evidencia, null, 2));
}

function redondear(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

main();
