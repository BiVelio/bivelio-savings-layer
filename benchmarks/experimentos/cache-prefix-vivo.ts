// EXPERIMENTO EN VIVO (prerregistrado en el paper §9, ejecutado): el reorden
// del prefijo cacheable, A/B contra el MISMO proveedor con su propio contador.
//
// Arm A — la capa SIN `savings.cachePrefix`: el timestamp de la plantilla viaja
//         DENTRO del prefijo marcado con `cache_control` → el emparejamiento por
//         bytes falla en cada petición → cero lecturas de caché y una escritura
//         completa (1,25×) pagada en cada llamada.
// Arm B — la capa CON `savings.cachePrefix: true`: el prefijo marcado es solo la
//         parte estable → la primera petición la escribe y las siguientes la
//         LEEN a 0,1×; solo la línea del timestamp viaja a precio completo.
//
// Se mide con el contador del proveedor (`nativeSavings.cacheReadTokens` y
// `cacheWriteTokens`), y el coste se publica a precios de lista del catálogo.
//
// ENV: BVSALA_DEMO_ANTHROPIC_API_KEY (obligatoria), BVSALA_DEMO_ANTHROPIC_BASE_URL
// (default api.anthropic.com/v1), BVSALA_EXP_MODEL (default anthropic/claude-haiku-4-5),
// BVSALA_EXP_N (peticiones por brazo, default 20), BVSALA_EXP_OUT (dir de salida).
//
// Coste esperado: céntimos (N×(plantilla ~350 tokens + salida ~30) a tarifa
// haiku). Sin tope duro por aquí: el workflow que lo lanza fija el presupuesto.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AnthropicProvider, createSavingsLayer, TokenizerRegistry, type SavingsRequest } from "../../src/index.js";

const N = Number(process.env.BVSALA_EXP_N ?? 20);
const MODELO = process.env.BVSALA_EXP_MODEL ?? "anthropic/claude-haiku-4-5";
const OUT = process.env.BVSALA_EXP_OUT ?? "evidencia-cache-prefix-vivo";

// El prefijo estable tiene que superar el MÍNIMO CACHEABLE del proveedor
// (Anthropic: ~1024 tokens en Haiku): por debajo, el `cache_control` se ignora
// y no hay ni escritura ni lectura. Un manual de política largo y determinista
// (~1500 tokens) deja la comparación limpia: brazo A escribe el manual entero
// con el timestamp dentro; brazo B cachea el manual estable y solo el
// timestamp viaja fuera.
const REGLAS: string[] = [];
for (let i = 1; i <= 60; i++) {
  REGLAS.push(
    `Rule ${i}. Invoices are issued on the first business day of each month and cover the period from the previous invoice; ` +
      `a customer with a pending payment of over ${(i * 37) % 90 + 10} days receives a reminder by email at day ${i % 4 + 2} of the grace window, ` +
      `and the account is suspended only after two reminders unless the balance is below the threshold of ${i * 2}.50 EUR; ` +
      `disputes about invoice line items must be filed within ${i % 3 + 1}0 days of the invoice date and are resolved within five business days.`,
  );
}
const PLANTILLA_ESTABLE =
  "You are a billing support assistant for a SaaS company. You answer with the company handbook, which is this system prompt. " +
  "Never invent policy; if the handbook does not cover the case, say 'not covered by the handbook'. " +
  "The handbook:\n\n" +
  REGLAS.join("\n");

function sistema(ts: string): string {
  return `${PLANTILLA_ESTABLE}\nGenerated at ${ts}.`;
}

function peticion(ts: string, cachePrefix: boolean): SavingsRequest {
  return {
    model: MODELO,
    messages: [
      { role: "system", content: sistema(ts) },
      { role: "user", content: "I want to move from monthly to annual in the middle of the month. Is it possible?" },
    ],
    maxOutputTokens: 80,
    temperature: 0,
    savings: { cachePrefix },
  } as SavingsRequest;
}

interface FilaDeBrazo {
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
  costeUsd: number;
  nativoPresente: number;
  trazasDePrefijo: Record<string, unknown>[];
}

async function brazo(cachePrefix: boolean): Promise<FilaDeBrazo> {
  const capa = createSavingsLayer({
    provider: new AnthropicProvider({
      apiKey: process.env.BVSALA_DEMO_ANTHROPIC_API_KEY!,
      baseUrl: process.env.BVSALA_DEMO_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1",
    }),
    tokenizer: new TokenizerRegistry(),
  });
  const fila: FilaDeBrazo = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, costeUsd: 0, nativoPresente: 0, trazasDePrefijo: [] };
  for (let i = 0; i < N; i++) {
    // El MISMO timestamp en los dos brazos: comparación pareada.
    const ts = new Date(Date.UTC(2026, 10, 15, 10, 0, 0, i)).toISOString();
    const r = await capa.generate(peticion(ts, cachePrefix));
    const nativo = r.report.nativeSavings;
    fila.input += r.report.tokens.actualInput;
    fila.output += r.report.tokens.actualOutput;
    fila.costeUsd += r.report.cost.actual;
    if (nativo?.basis === "measured") {
      fila.cacheRead += nativo.cacheReadTokens;
      fila.cacheWrite += nativo.cacheWriteTokens;
      fila.nativoPresente += 1;
    }
    // Las trazas del prefijo de la PRIMERA petición: dicen por qué marcó o no.
    if (i === 0) {
      fila.trazasDePrefijo = r.report.traces
        .filter((t) => t.stage.startsWith("prefix-cache") || t.stage === "cache-prefix")
        .map((t) => ({ stage: t.stage, outcome: t.outcome, detail: t.detail }));
    }
  }
  return fila;
}

async function main() {
  if (!process.env.BVSALA_DEMO_ANTHROPIC_API_KEY) {
    throw new Error("BVSALA_DEMO_ANTHROPIC_API_KEY no está: sin clave no hay contador real.");
  }
  const a = await brazo(false);
  const b = await brazo(true);

  const hitRate = (f: FilaDeBrazo) => (f.cacheRead + f.cacheWrite > 0 ? f.cacheRead / (f.cacheRead + f.cacheWrite) : 0);
  const evidencia = {
    titulo: "Reorden del prefijo cacheable — A/B en vivo con el contador del proveedor",
    fecha: new Date().toISOString().slice(0, 10),
    metodo:
      `N=${N} peticiones por brazo contra ${MODELO}, mismas timestamps en ambos brazos. Arm A sin ` +
      "cachePrefix (el timestamp viaja dentro del prefijo marcado), arm B con savings.cachePrefix (el prefijo " +
      "marcado es solo la parte estable). Contadores del proveedor (cache_read/cache_creation), coste a precios de lista.",
    casos: [
      {
        brazo: "A · sin cachePrefix",
        peticiones: N,
        ...a,
        hitRate: hitRate(a),
        costePorPeticion: a.costeUsd / N,
      },
      {
        brazo: "B · con cachePrefix",
        peticiones: N,
        ...b,
        hitRate: hitRate(b),
        costePorPeticion: b.costeUsd / N,
      },
    ],
    lectura:
      "Arm A: el prefijo marcado cambia en cada petición → hit-rate ~0 y la escritura completa (1,25×) se paga " +
      "siempre. Arm B: la primera petición escribe la parte estable y las N−1 siguientes la LEEN a 0,1× — el " +
      "hit-rate se acerca a (N−1)/N y el coste por petición cae. La diferencia es la medida REAL de lo que el " +
      "reorden desbloquea; el ahorro es del proveedor (su caché acierta).",
  };
  mkdirSync(join(process.cwd(), OUT), { recursive: true });
  const ruta = join(process.cwd(), OUT, "cache-prefix-vivo.json");
  writeFileSync(ruta, JSON.stringify(evidencia, null, 2) + "\n");
  console.log(JSON.stringify(evidencia, null, 2));
}

main();
