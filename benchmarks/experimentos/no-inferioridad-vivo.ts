// EXPERIMENTO EN VIVO (prerregistrado en el paper §9, ejecutado): la
// NO-INFERIORIDAD de la cascada — el mismo trabajo por el modelo fuerte solo,
// y por la cascada fuerte→barato con su verja, comparando coste Y calidad.
//
// Arm A · sin cascada: cada pregunta va SIEMPRE al modelo fuerte.
// Arm B · con cascada (`modelCascade: "on"`): la capa enruta al hermano barato
//         y solo escala al fuerte si la verja rechaza la respuesta.
// La calidad se mide CONTRA UNA LISTA DORADA (preguntas de respuesta única) y
// contra el propio brazo A (acuerdo entre brazos). El coste, con el contador
// del proveedor. Una capa NUEVA por brazo: la caché exacta no debe mezclarlos.
//
// ENV: BVSALA_DEMO_OPENAI_API_KEY (obligatoria), BVSALA_DEMO_OPENAI_BASE_URL,
// BVSALA_EXP_NI_MODELO (default openai/gpt-5), BVSALA_EXP_OUT.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { AnthropicProvider, createSavingsLayer, TokenizerRegistry, type SavingsRequest } from "../../src/index.js";

const OUT = process.env.BVSALA_EXP_OUT ?? "evidencia-no-inferioridad-vivo";
// El par por defecto de la cascada: opus-5-5 → haiku-4-5. Anthropic acepta
// temperature 0 (gpt-5 no: solo admite su default 1), y la comparación A/B
// necesita muestreo determinista.
const MODELO = process.env.BVSALA_EXP_NI_MODELO ?? "anthropic/claude-opus-5-5";

const PREGUNTAS: { q: string; dorada: string }[] = [
  { q: "What is the capital of France?", dorada: "paris" },
  { q: "What is the largest planet in the solar system?", dorada: "jupiter" },
  { q: "How many continents are there on Earth?", dorada: "7" },
  { q: "What is the chemical symbol for gold?", dorada: "au" },
  { q: "Who wrote Romeo and Juliet?", dorada: "shakespeare" },
  { q: "What is the longest river in the world?", dorada: "nile" },
  { q: "In what year did World War II end?", dorada: "1945" },
  { q: "What is the smallest prime number?", dorada: "2" },
  { q: "What element has the atomic number 8?", dorada: "oxygen" },
  { q: "What is the capital of Japan?", dorada: "tokyo" },
  { q: "Which planet is known as the Red Planet?", dorada: "mars" },
  { q: "What is the speed of light rounded, in km/s?", dorada: "300000" },
  { q: "What is the tallest mountain on Earth?", dorada: "everest" },
  { q: "What gas makes up most of Earth's atmosphere?", dorada: "nitrogen" },
  { q: "How many sides does a hexagon have?", dorada: "6" },
  { q: "What is the freezing point of water in Celsius?", dorada: "0" },
  { q: "Which ocean is the largest?", dorada: "pacific" },
  { q: "What is the capital of Australia?", dorada: "canberra" },
  { q: "Who painted the Mona Lisa?", dorada: "vinci" },
  { q: "What is the chemical symbol for iron?", dorada: "fe" },
  { q: "How many minutes are in two hours?", dorada: "120" },
  { q: "What is the fifth planet from the sun?", dorada: "jupiter" },
  { q: "What language has the most native speakers?", dorada: "mandarin" },
  { q: "What is the square root of 144?", dorada: "12" },
];

function normalizar(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, " ").replace(/\s+/g, " ").trim();
}

// Nombres de número → la cifra dorada. El juez es un match EXACTO normalizado:
// `includes` admitía «Not Paris» para «paris», «12» para «2» y «20» para «0»
// (hallazgo del informe de revisión 2026-11-15). Las respuestas cerradas se
// aceptan solo si normalizadas son IGUALES a la dorada o a una equivalencia
// declarada.
const EQUIVALENCIAS: Record<string, string> = {
  seven: "7",
  two: "2",
  zero: "0",
  six: "6",
  twelve: "12",
  "one hundred and twenty": "120",
  "one hundred twenty": "120",
};

function acierta(respuesta: string, dorada: string): boolean {
  const n = normalizar(respuesta);
  return n === dorada || EQUIVALENCIAS[n] === dorada;
}

function peticion(texto: string, cascade: boolean): SavingsRequest {
  return {
    model: MODELO,
    messages: [{ role: "user", content: texto + " Answer with the value only, no explanation." }],
    // El MISMO contrato en ambos brazos: la comparación es justa y la verja de la
    // cascada tiene forma que comprobar (structural).
    response: { schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] } },
    maxOutputTokens: 80,
    temperature: 0,
    savings: { deterministicResolvers: false, ...(cascade ? { modelCascade: "on" } : {}) },
  } as unknown as SavingsRequest;
}

function respuestaDe(r: { data?: unknown; text: string }): string {
  const d = r.data as { answer?: string } | undefined;
  return typeof d?.answer === "string" ? d.answer : r.text;
}

async function main() {
  if (!process.env.BVSALA_DEMO_ANTHROPIC_API_KEY) {
    throw new Error("BVSALA_DEMO_ANTHROPIC_API_KEY no está: sin clave no hay contador real.");
  }
  const hacerCapa = () =>
    createSavingsLayer({
      provider: new AnthropicProvider({
        apiKey: process.env.BVSALA_DEMO_ANTHROPIC_API_KEY!,
        baseUrl: process.env.BVSALA_DEMO_ANTHROPIC_BASE_URL ?? "https://api.anthropic.com/v1",
      }),
      tokenizer: new TokenizerRegistry(),
    });

  const capaA = hacerCapa();
  let costeA = 0;
  const respuestasA: string[] = [];
  let aciertosA = 0;
  for (const p of PREGUNTAS) {
    const r = await capaA.generate(peticion(p.q, false));
    costeA += r.report.cost.actual;
    respuestasA.push(respuestaDe(r));
    if (acierta(respuestaDe(r), p.dorada)) aciertosA += 1;
  }

  const capaB = hacerCapa();
  let costeB = 0;
  const respuestasB: string[] = [];
  let aciertosB = 0;
  let escaladas = 0;
  let servidasPorBarato = 0;
  for (const p of PREGUNTAS) {
    const r = await capaB.generate(peticion(p.q, true));
    costeB += r.report.cost.actual;
    respuestasB.push(respuestaDe(r));
    if (acierta(respuestaDe(r), p.dorada)) aciertosB += 1;
    const mc = r.report.modelCascade;
    if (mc) {
      if (mc.servedModel !== mc.requestedModel) servidasPorBarato += 1;
      if (mc.escalated === true) escaladas += 1;
    }
  }

  let acuerdo = 0;
  for (let i = 0; i < PREGUNTAS.length; i++) {
    if (normalizar(respuestasA[i]!) === normalizar(respuestasB[i]!)) acuerdo += 1;
  }

  // Las RESPUESTAS INDIVIDUALES se publican: sin ellas, los aciertos no se
  // pueden regradar de forma independiente (hallazgo del informe de revisión).
  const respuestas = PREGUNTAS.map((p, i) => ({
    pregunta: p.q,
    dorada: p.dorada,
    A: respuestasA[i]!,
    B: respuestasB[i]!,
    aciertaA: acierta(respuestasA[i]!, p.dorada),
    aciertaB: acierta(respuestasB[i]!, p.dorada),
  }));

  const evidencia = {
    titulo: "Cascada: coste y calidad — piloto exploratorio (juez exacto normalizado)",
    fecha: new Date().toISOString().slice(0, 10),
    metodo:
      `${PREGUNTAS.length} preguntas de respuesta única con lista dorada, ${MODELO} (cascada por defecto a su hermano barato), temperature 0. ` +
      "Arm A: siempre el fuerte. Arm B: modelCascade on (enruta al barato, escala si la verja rechaza). Calidad contra la lista dorada " +
      "con un juez de match EXACTO normalizado (con equivalencias de números escritos); acuerdo entre brazos; coste con el contador del " +
      "proveedor. Las respuestas individuales de ambos brazos se publican para su regrado independiente.",
    casos: [
      { brazo: "A · sin cascada", costeUsd: redondear(costeA), aciertosDorados: aciertosA, de: PREGUNTAS.length },
      {
        brazo: "B · con cascada",
        costeUsd: redondear(costeB),
        aciertosDorados: aciertosB,
        de: PREGUNTAS.length,
        servidasPorElBarato: servidasPorBarato,
        escaladas: escaladas,
        acuerdoConA: acuerdo,
      },
    ],
    respuestas,
    lectura:
      "PILOTO EXPLORATORIO, no una prueba de no-inferioridad (sin margen δ ni diseño de potencia prespecificado; el conjunto es " +
      "trivia seleccionada). El juez corrige el fallo del informe de revisión 2026-11-15: ya no acepta subcadenas («Not Paris», " +
      "«12» para «2»). La verja de la cascada certifica la forma, no la verdad; este piloto mide el acuerdo factual de forma " +
      "exploratoria y publica cada respuesta para que cualquiera pueda regradar.",
  };
  mkdirSync(join(process.cwd(), OUT), { recursive: true });
  const ruta = join(process.cwd(), OUT, "no-inferioridad-vivo.json");
  writeFileSync(ruta, JSON.stringify(evidencia, null, 2) + "\n");
  console.log(JSON.stringify(evidencia, null, 2));
}

function redondear(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

main();
