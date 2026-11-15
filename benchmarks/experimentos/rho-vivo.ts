// EXPERIMENTO EN VIVO (prerregistrado en el paper §9, ejecutado): la curva ρ —
// el ahorro del SDK en función de la tasa de repetición exacta.
//
// Arm A — sin capa: TODAS las preguntas van al proveedor (su coste medido).
// Arm B — con la capa: las repeticiones EXACTAS se sirven de la caché exacta
//         sin llamar al proveedor (`report.calls.avoidedLlm`).
// La variable controlada es ρ (fracción de preguntas que son repeticiones
// exactas de una ya enviada). El resultado es la curva medida: ahorro ≈ ρ.
//
// ENV: BVSALA_DEMO_OPENAI_API_KEY (obligatoria), BVSALA_DEMO_OPENAI_BASE_URL,
// BVSALA_EXP_RHO_MODEL (default openai/gpt-4o-mini), BVSALA_EXP_K (preguntas
// únicas, default 20), BVSALA_EXP_RHOS (default "0.3,0.6"), BVSALA_EXP_OUT.
//
// Coste esperado: céntimos (gpt-4o-mini, preguntas cortas, temperature 0).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OpenAICompatibleProvider, createSavingsLayer, TokenizerRegistry, type SavingsRequest } from "../../src/index.js";

const K = Number(process.env.BVSALA_EXP_K ?? 20);
const RHOS = (process.env.BVSALA_EXP_RHOS ?? "0.3,0.6").split(",").map((s) => Number(s.trim()));
const MODELO = process.env.BVSALA_EXP_RHO_MODEL ?? "openai/gpt-4o-mini";
const OUT = process.env.BVSALA_EXP_OUT ?? "evidencia-rho-vivo";

const PLANTILLAS = [
  "What is the capital of {pais}?",
  "How many legs does a {animal} have?",
  "What is 7 + {n}?",
  "Name a {color} fruit.",
  "Which is bigger: a {cosaA} or a {cosaB}?",
];

/** K preguntas ÚNICAS, deterministas, temperature 0. */
function preguntasUnicas(): string[] {
  const out: string[] = [];
  for (let i = 0; i < K; i++) {
    const p = PLANTILLAS[i % PLANTILLAS.length]!;
    out.push(
      p
        .replace("{pais}", ["France", "Japan", "Brazil", "Egypt"][i % 4]!)
        .replace("{animal}", ["dog", "cat", "horse", "spider"][i % 4]!)
        .replace("{n}", String(i))
        .replace("{color}", ["red", "yellow", "green", "blue"][i % 4]!)
        .replace("{cosaA}", ["apple", "car", "house", "book"][i % 4]!)
        .replace("{cosaB}", ["melon", "bike", "tent", "shelf"][i % 4]!),
    );
  }
  return out;
}

/** El flujo para una ρ: K únicas + floor(K×ρ) repeticiones exactas intercaladas al final. */
function flujo(unica: string[], rho: number): string[] {
  const repeticiones = Math.floor(K * rho);
  return [...unica, ...unica.slice(0, repeticiones)];
}

function peticion(texto: string, exactCache: boolean): SavingsRequest {
  return {
    model: MODELO,
    messages: [{ role: "user", content: texto }],
    maxOutputTokens: 24,
    temperature: 0,
    // Sin resolutores locales: la curva mide SOLO la caché exacta.
    savings: { exactCache, deterministicResolvers: false },
  } as SavingsRequest;
}

async function main() {
  if (!process.env.BVSALA_DEMO_OPENAI_API_KEY) {
    throw new Error("BVSALA_DEMO_OPENAI_API_KEY no está: sin clave no hay contador real.");
  }
  // UNA capa NUEVA por ρ: la caché exacta es por proceso, y compartirla entre
  // niveles contaría como aciertos de una ρ las únicas de la anterior.
  const unicas = preguntasUnicas();

  const filas: unknown[] = [];
  for (const rho of RHOS) {
    const capa = createSavingsLayer({
      provider: new OpenAICompatibleProvider({
        apiKey: process.env.BVSALA_DEMO_OPENAI_API_KEY!,
        baseUrl: process.env.BVSALA_DEMO_OPENAI_BASE_URL ?? "https://api.openai.com/v1",
      }),
      tokenizer: new TokenizerRegistry(),
    });
    const flujoDePreguntas = flujo(unicas, rho);
    // Arm A: MISMA instrumentación, con la caché exacta apagada: todo al proveedor.
    let costeA = 0;
    for (const texto of flujoDePreguntas) {
      const r = await capa.generate(peticion(texto, false));
      costeA += r.report.cost.actual;
    }
    // Arm B: la caché exacta sirve las repeticiones sin llamar.
    let costeB = 0;
    let llamadasB = 0;
    let evitadasB = 0;
    for (const texto of flujoDePreguntas) {
      const r = await capa.generate(peticion(texto, true));
      costeB += r.report.cost.actual;
      llamadasB += r.report.calls.actualLlm;
      evitadasB += r.report.calls.avoidedLlm;
    }
    filas.push({
      rho,
      peticiones: flujoDePreguntas.length,
      repeticiones: flujoDePreguntas.length - K,
      costeA: redondear(costeA),
      costeB: redondear(costeB),
      llamadasDelProveedorEnB: llamadasB,
      evitadasEnB: evitadasB,
      ahorroMedido: flujoDePreguntas.length > 0 ? redondear(1 - costeB / costeA) : 0,
      repeticionesEsperadasEvitadas: flujoDePreguntas.length - K,
    });
  }

  const evidencia = {
    titulo: "Curva ρ — ahorro del SDK frente a la tasa de repetición exacta (en vivo)",
    fecha: new Date().toISOString().slice(0, 10),
    metodo:
      `K=${K} preguntas únicas por ρ, temperature 0, ${MODELO}. Arm A: todas al proveedor. Arm B: por la capa, ` +
      "cuya caché exacta sirve las repeticiones sin llamar (contador `avoidedLlm`). Costes medidos con el contador del proveedor.",
    filas,
    lectura:
      "La caché exacta es una identidad: cada repetición evitada es una llamada (y su coste) que no ocurre. La " +
      "curva esperada es ahorro ≈ ρ; la medida confirma o corrige el rendimiento real de la caché exacta en vivo.",
  };
  mkdirSync(join(process.cwd(), OUT), { recursive: true });
  const ruta = join(process.cwd(), OUT, "rho-vivo.json");
  writeFileSync(ruta, JSON.stringify(evidencia, null, 2) + "\n");
  console.log(JSON.stringify(evidencia, null, 2));
}

function redondear(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

main();
