// EXPERIMENTO EN VIVO (prerregistrado en el paper §9, ejecutado): el factorial
// 2×2 deduplicación × cache_control, con la MISMA carga en las cuatro celdas.
//
// Celdas (Anthropic, claude-haiku-4-5):
//   A · ni dedup ni marcado:  proveedor con maxCacheBreakpoints: 0 + exactCache: false
//   B · solo marcado:         proveedor normal + exactCache: false
//   C · solo dedup:           proveedor con maxCacheBreakpoints: 0 (default savings)
//   D · ambos (la capa):      defaults
// Cada celda lleva un manual con una SAL propia: la caché del proveedor es por
// contenido y un sal distinto la aísla de las otras celdas (sin sal, la celda B
// calentaría la caché que leen C y D, y la medida se mezclaría).
//
// La carga: 12 preguntas únicas + sus 12 repeticiones exactas, manual estable
// ~1500 tokens (por encima del mínimo cacheable de Anthropic). Se mide con el
// contador del proveedor (llamadas, cache_read/cache_creation, coste) y se
// atribuye: marcado = B−A, dedup = C−A, interacción = D − (B + C) + A.
//
// ENV: BVSALA_DEMO_ANTHROPIC_API_KEY (obligatoria), BVSALA_DEMO_ANTHROPIC_BASE_URL,
// BVSALA_EXP_OUT (default evidencia-factorial-vivo).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AnthropicProvider, createSavingsLayer, TokenizerRegistry, type SavingsRequest } from "../../src/index.js";

const OUT = process.env.BVSALA_EXP_OUT ?? "evidencia-factorial-vivo";

function manual(sal: string): string {
  const reglas: string[] = [];
  for (let i = 1; i <= 60; i++) {
    reglas.push(
      `Rule ${i}. Invoices are issued on the first business day of each month and cover the period from the previous invoice; ` +
        `a customer with a pending payment of over ${(i * 37) % 90 + 10} days receives a reminder by email at day ${i % 4 + 2} of the grace window, ` +
        `and the account is suspended only after two reminders unless the balance is below the threshold of ${i * 2}.50 EUR; ` +
        `disputes about invoice line items must be filed within ${i % 3 + 1}0 days of the invoice date and are resolved within five business days.`,
    );
  }
  return (
    `You are a billing support assistant for a SaaS company (${sal} division). You answer with the company handbook, which is this system prompt. ` +
    "Never invent policy; if the handbook does not cover the case, say 'not covered by the handbook'. " +
    "The handbook:\n\n" +
    reglas.join("\n")
  );
}

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

function peticion(sal: string, texto: string, savings: Record<string, unknown>): SavingsRequest {
  return {
    model: "anthropic/claude-haiku-4-5",
    messages: [
      { role: "system", content: manual(sal) },
      { role: "user", content: texto },
    ],
    maxOutputTokens: 60,
    temperature: 0,
    savings,
  } as SavingsRequest;
}

const FLUJO = [...PREGUNTAS, ...PREGUNTAS]; // 12 únicas + 12 repeticiones exactas

interface Fila {
  celda: string;
  peticiones: number;
  llamadas: number;
  evitadas: number;
  cacheRead: number;
  cacheWrite: number;
  costeUsd: number;
  resultadosDeCache: Record<string, number>;
}

async function celda(nombre: string, sal: string, maxBreakpoints: number, savings: Record<string, unknown>): Promise<Fila> {
  const capa = createSavingsLayer({
    provider: new AnthropicProvider({
      apiKey: process.env.BVSALA_DEMO_ANTHROPIC_API_KEY!,
      baseUrl: process.env.BVSALA_DEMO_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1",
      maxCacheBreakpoints: maxBreakpoints,
    }),
    tokenizer: new TokenizerRegistry(),
  });
  const fila: Fila = {
    celda: nombre,
    peticiones: FLUJO.length,
    llamadas: 0,
    evitadas: 0,
    cacheRead: 0,
    cacheWrite: 0,
    costeUsd: 0,
    resultadosDeCache: {},
  };
  for (const texto of FLUJO) {
    const r = await capa.generate(peticion(sal, texto, savings));
    fila.costeUsd += r.report.cost.actual;
    fila.llamadas += r.report.calls.actualLlm;
    fila.evitadas += r.report.calls.avoidedLlm;
    const resultado = r.report.cache.result;
    fila.resultadosDeCache[resultado] = (fila.resultadosDeCache[resultado] ?? 0) + 1;
    const nativo = r.report.nativeSavings;
    if (nativo?.basis === "measured") {
      fila.cacheRead += nativo.cacheReadTokens;
      fila.cacheWrite += nativo.cacheWriteTokens;
    }
  }
  fila.costeUsd = redondear(fila.costeUsd);
  return fila;
}

async function main() {
  if (!process.env.BVSALA_DEMO_ANTHROPIC_API_KEY) {
    throw new Error("BVSALA_DEMO_ANTHROPIC_API_KEY no está: sin clave no hay contador real.");
  }
  const A = await celda("A · ni dedup ni marcado", "North", 0, { exactCache: false });
  const B = await celda("B · solo marcado", "East", 4, { exactCache: false });
  const C = await celda("C · solo dedup", "South", 0, {});
  const D = await celda("D · ambos (la capa)", "West", 4, {});

  const coste = (c: Fila) => c.costeUsd;
  const evidencia = {
    titulo: "Factorial dedup × cache_control (2×2) — en vivo con el contador del proveedor",
    fecha: new Date().toISOString().slice(0, 10),
    metodo:
      "Misma carga en las cuatro celdas: 12 preguntas únicas + 12 repeticiones exactas, manual estable ~1500 tokens " +
      "(con una sal por celda para aislar la caché del proveedor entre celdas), claude-haiku-4-5, temperature 0. " +
      "A = ni dedup ni marcado; B = solo marcado; C = solo dedup; D = ambos. Costes medidos con el contador del proveedor.",
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
