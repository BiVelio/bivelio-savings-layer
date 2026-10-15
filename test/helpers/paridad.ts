// LOS VECTORES DE PARIDAD TS ↔ Python (plan Caveman 2026-10-14, D10).
//
// Una sola fuente de verdad: los CASOS se escriben aquí y lo ESPERADO lo
// calcula la implementación de TypeScript (la que corre en el SDK y en el
// gateway). `scripts/paridad-vectores.ts` lo vuelca a test/fixtures/paridad/,
// pytest (packages/python/tests/test_paridad.py) lo consume con las funciones
// de Python, y test/paridad-python.test.ts comprueba que el fichero en disco es
// EXACTAMENTE lo que TS calcula hoy («los vectores están frescos»): si alguien
// cambia la regla de TS sin regenerar, falla aquí; si regenera, el diff del
// fichero enseña qué cambió y pytest dice si Python sigue igual.
//
// Lo que entra:
//   · json-estricto: `compactToolOutput(texto, {profile: "lossless-data"})` con
//     el estimador heurístico (el único que Python puede reproducir sin
//     dependencias), y el estimador heurístico suelto.
//   · uso-por-intento: `normalizarUso` por dialecto y `tarifarIntento`. Python
//     NO lleva el catálogo de precios: el vector le da la FILA que el catálogo
//     de TS resolvió (o null si no hay), y Python hace con ella la aritmética
//     entera y la máquina de estados. Resolver el modelo contra el catálogo
//     sigue siendo cosa del gateway.

import { compactToolOutput, LOSSLESS_JSON_TRANSFORM_ID, LOSSLESS_JSON_VERSION, DEFAULT_MIN_SAVED_CHARS } from "../../src/compression/cola.js";
import { heuristicEstimator } from "../../src/tokenizer/estimator.js";
import { normalizarUso, tarifarIntento, type UsageBasis, type UsoCrudo } from "../../src/metering/intento.js";
import { PRECIOS_AL_DIA, claveDeCatalogo, diaUtc, precioDeLista, precioDeListaPropio } from "../../src/pricing/catalogo.js";
import { primaDeEscritura, primaDeEscritura1h } from "../../src/pricing/primas.js";

/** Versión del FORMATO de los ficheros de vectores (no de las reglas). */
export const VERSION_DE_VECTORES = 1;

export const RUTA_JSON_ESTRICTO = "test/fixtures/paridad/json-estricto.json";
export const RUTA_USO = "test/fixtures/paridad/uso-por-intento.json";

// ── json-estricto ────────────────────────────────────────────────────────────

const sangrado = (v: unknown, n: number | string = 2) => JSON.stringify(v, null, n);
const filas = (k: number) => Array.from({ length: k }, (_, i) => ({ id: i, nombre: `fila-${i}`, activo: i % 2 === 0, peso: i / 4 }));

/** Los casos: un nombre que explica, el texto, y el mínimo de caracteres si no es el de por defecto. */
const CASOS_JSON: { nombre: string; texto: string; minSavedChars?: number }[] = [
  { nombre: "objeto sangrado que merece la pena", texto: sangrado({ filas: filas(12) }) },
  { nombre: "array sangrado con tabuladores", texto: sangrado(filas(24), "\t") },
  { nombre: "sangrado con CRLF", texto: sangrado({ filas: filas(10) }).replace(/\n/g, "\r\n") },
  { nombre: "pequeño: por debajo del mínimo", texto: sangrado({ a: 1, b: [1, 2] }) },
  { nombre: "pequeño con minSavedChars 1", texto: sangrado({ a: 1, b: [1, 2] }), minSavedChars: 1 },
  { nombre: "ya compacto: no cuesta menos tokens", texto: JSON.stringify({ filas: filas(12) }) },
  {
    nombre: "números tal como están escritos: 2^63+1, 1.10, 1e400, -0, 1E-7",
    texto: `{\n  "grande": 9223372036854775809,\n  "decimal": 1.10,\n  "enorme": 1e400,\n  "cero": -0,\n  "chico": 1E-7,\n  "relleno": ${sangrado(filas(8))}\n}`,
  },
  {
    nombre: "escapes y espacio DENTRO de las cadenas se conservan",
    texto: `{\n  "s": "a  b\\n\\t \\"c\\" \\\\ \\/ \\u00e9 \\ud83d\\ude00",\n  "relleno": ${sangrado(filas(8))}\n}`,
    minSavedChars: 1,
  },
  { nombre: "astrales y BMP en crudo dentro de cadenas", texto: sangrado({ emoji: "😀 ñ 中文 \u3000 fin", filas: filas(8) }) },
  { nombre: "la misma clave en objetos distintos no es duplicada", texto: sangrado({ a: { k: 1 }, b: { k: 2 }, filas: filas(8) }) },
  { nombre: "clave duplicada en la raíz", texto: `{\n  "a": 1,\n  "a": 2,\n  "relleno": ${sangrado(filas(8))}\n}` },
  { nombre: "clave duplicada a profundidad", texto: `{\n  "x": [ { "y": { "k": 1, "k": 1 } } ],\n  "relleno": ${sangrado(filas(8))}\n}` },
  { nombre: "duplicada por escape: \"a\" y \"\\u0061\"", texto: `{\n  "a": 1,\n  "\\u0061": 1,\n  "relleno": ${sangrado(filas(8))}\n}` },
  { nombre: "coma final", texto: `{\n  "a": [1, 2, ],\n  "relleno": ${sangrado(filas(8))}\n}` },
  { nombre: "comillas simples", texto: `{\n  'a': 1\n}` },
  { nombre: "comentario", texto: `{\n  // nota\n  "a": 1\n}` },
  { nombre: "NaN", texto: `{\n  "a": NaN\n}` },
  { nombre: "cero a la izquierda", texto: `{\n  "a": 01\n}` },
  { nombre: "escape desconocido", texto: `{\n  "a": "\\x41"\n}` },
  { nombre: "carácter de control sin escapar en una cadena", texto: `{\n  "a": "uno\u0001dos"\n}` },
  { nombre: "texto detrás del valor", texto: `{\n  "a": 1\n} y más` },
  { nombre: "NBSP entre lexemas", texto: `{\u00a0"a": 1\n}` },
  { nombre: "sustituto suelto EN CRUDO", texto: `{\n  "a": "x\ud800y",\n  "relleno": ${sangrado(filas(8))}\n}` },
  { nombre: "sustituto bajo suelto EN CRUDO", texto: `{\n  "a": "x\udc00y"\n}` },
  {
    nombre: "sustituto ESCAPADO: gramática válida, sale byte a byte",
    texto: `{\n  "a": "\\ud800",\n  "relleno": ${sangrado(filas(8))}\n}`,
    minSavedChars: 1,
  },
  { nombre: "espacio JSON delante y detrás del valor", texto: ` \n\t${sangrado({ filas: filas(10) })}\r\n ` },
  { nombre: "texto plano", texto: "Build succeeded in 3.2s\n  12 warnings\n" },
  { nombre: "número suelto en la raíz", texto: "   42   " },
  { nombre: "cadena suelta en la raíz", texto: '"hola"' },
  { nombre: "vacío", texto: "" },
  { nombre: "BOM delante", texto: `\ufeff${sangrado({ filas: filas(8) })}` },
  { nombre: "anidamiento profundo sin recursión", texto: `${"[\n".repeat(3000)}${"]\n".repeat(3000)}` },
  { nombre: "sin cerrar", texto: `{\n  "a": [1, 2\n` },
  { nombre: "literales true/false/null", texto: sangrado({ t: true, f: false, n: null, filas: filas(8) }) },
];

/** Textos para el estimador heurístico suelto: lo que Python tiene que contar igual. */
const TEXTOS_ESTIMADOR: string[] = [
  "",
  "hola",
  "Hello, world! 12345",
  "  \n\n   \t ",
  "a\u000bb\u000cc", // \v y \f son \s en JS
  "a\u00a0b\u1680c\u2000d\u200ae\u2028f\u2029g\u202fh\u205fi\u3000j\ufeffk", // \s Unicode de JS
  "a\u0085b\u001cc\u001fd", // NO son \s en JS (sí en Python): cuentan como símbolos
  "😀😀 ñandú 中文",
  "x".repeat(37),
  "1234567890123",
  '{"a":[1,2,3],"b":"texto largo con palabras"}',
];

export interface VectorJson {
  nombre: string;
  entrada: { texto: string; minSavedChars: number };
  esperado: {
    changed: boolean;
    text: string;
    status: "applied" | "bypassed";
    reason: string;
    tokensBefore: number;
    tokensAfter: number;
    candidateTokens: number | null;
    originalChars: number;
    compactChars: number;
  };
}

export function vectoresJsonEstricto() {
  const casos: VectorJson[] = CASOS_JSON.map((c) => {
    const minSavedChars = c.minSavedChars ?? DEFAULT_MIN_SAVED_CHARS;
    const r = compactToolOutput(c.texto, { profile: "lossless-data", minSavedChars });
    const d = r.decision!;
    return {
      nombre: c.nombre,
      entrada: { texto: c.texto, minSavedChars },
      esperado: {
        changed: r.changed,
        text: r.text,
        status: d.status,
        reason: d.reason,
        tokensBefore: d.tokensBefore,
        tokensAfter: d.tokensAfter,
        candidateTokens: d.candidateTokens ?? null,
        originalChars: r.originalChars,
        compactChars: r.compactChars,
      },
    };
  });
  return {
    formato: VERSION_DE_VECTORES,
    generadoPor: "scripts/paridad-vectores.ts (desde test/helpers/paridad.ts)",
    transform: { id: LOSSLESS_JSON_TRANSFORM_ID, version: LOSSLESS_JSON_VERSION },
    estimador: heuristicEstimator.id,
    casos,
    estimadorHeuristico: TEXTOS_ESTIMADOR.map((texto) => ({ texto, tokens: heuristicEstimator.count(texto) })),
  };
}

// ── uso-por-intento ──────────────────────────────────────────────────────────

/** Un día fijo: un tramo de precio futuro no mueve los vectores. */
const DIA = Date.UTC(2026, 9, 1);

const ANTHROPIC = { input_tokens: 1000, cache_read_input_tokens: 8000, cache_creation_input_tokens: 2000, output_tokens: 500 };
const CHAT = { prompt_tokens: 11000, completion_tokens: 500, prompt_tokens_details: { cached_tokens: 8000, cache_write_tokens: 2000 } };

const CASOS_USO: { nombre: string; modelo: string; crudo: UsoCrudo; basis?: UsageBasis }[] = [
  { nombre: "anthropic completo con caché", modelo: "claude-sonnet-4-5", crudo: { dialecto: "anthropic", uso: ANTHROPIC } },
  {
    nombre: "anthropic con desglose de 1 h",
    modelo: "claude-sonnet-4-5",
    crudo: {
      dialecto: "anthropic",
      uso: { ...ANTHROPIC, cache_creation: { ephemeral_5m_input_tokens: 500, ephemeral_1h_input_tokens: 1500 } },
    },
  },
  {
    nombre: "anthropic sin total de escritura: se reconstruye del desglose",
    modelo: "claude-sonnet-4-5",
    crudo: { dialecto: "anthropic", uso: { input_tokens: 10, output_tokens: 5, cache_creation: { ephemeral_5m_input_tokens: 7, ephemeral_1h_input_tokens: 3 } } },
  },
  {
    nombre: "anthropic con iteraciones de compactación",
    modelo: "claude-sonnet-4-5",
    crudo: {
      dialecto: "anthropic",
      uso: {
        ...ANTHROPIC,
        iterations: [
          { type: "compaction", input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 10, cache_creation: { ephemeral_1h_input_tokens: 5 } },
          { type: "message", input_tokens: 999 },
          null,
        ],
      },
    },
  },
  {
    nombre: "anthropic: compactación con contador fraccionario → usage-invalid",
    modelo: "claude-sonnet-4-5",
    crudo: { dialecto: "anthropic", uso: { ...ANTHROPIC, iterations: [{ type: "compaction", input_tokens: 1.5 }] } },
  },
  { nombre: "anthropic cortado tras message_start", modelo: "claude-sonnet-4-5", crudo: { dialecto: "anthropic", uso: { input_tokens: 4300, output_tokens: 1 }, final: false } },
  { nombre: "anthropic sin usage", modelo: "claude-sonnet-4-5", crudo: { dialecto: "anthropic", uso: null } },
  { nombre: "anthropic: contador como cadena no es contador", modelo: "claude-sonnet-4-5", crudo: { dialecto: "anthropic", uso: { input_tokens: "100" as unknown as number, output_tokens: 5 } } },
  { nombre: "anthropic: un booleano no es contador", modelo: "claude-sonnet-4-5", crudo: { dialecto: "anthropic", uso: { input_tokens: true as unknown as number, output_tokens: 5 } } },
  { nombre: "anthropic: contador fraccionario en primer nivel", modelo: "claude-sonnet-4-5", crudo: { dialecto: "anthropic", uso: { input_tokens: 10.5, output_tokens: 5 } } },
  { nombre: "anthropic: contador por encima de 2^53", modelo: "claude-sonnet-4-5", crudo: { dialecto: "anthropic", uso: { input_tokens: 2 ** 53, output_tokens: 5 } } },
  { nombre: "anthropic: contador negativo", modelo: "claude-sonnet-4-5", crudo: { dialecto: "anthropic", uso: { input_tokens: -1, output_tokens: 5 } } },
  { nombre: "chat completo con caché", modelo: "gpt-4o-mini", crudo: { dialecto: "openai-chat", uso: CHAT } },
  {
    nombre: "chat con caché por encima del total: se recorta",
    modelo: "gpt-4o-mini",
    crudo: { dialecto: "openai-chat", uso: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 50 } } },
  },
  {
    nombre: "chat con reasoning_tokens (desglose, no sumando)",
    modelo: "o4-mini",
    crudo: { dialecto: "openai-chat", uso: { prompt_tokens: 200, completion_tokens: 900, completion_tokens_details: { reasoning_tokens: 700 } } },
  },
  {
    nombre: "chat compatible de Gemini: pensamiento solo en total_tokens",
    modelo: "gemini-2.5-flash",
    crudo: { dialecto: "openai-chat", uso: { prompt_tokens: 200, completion_tokens: 50, total_tokens: 400 } },
  },
  { nombre: "chat sin el chunk final", modelo: "gpt-4o-mini", crudo: { dialecto: "openai-chat", uso: CHAT, final: false } },
  { nombre: "chat sin completion_tokens", modelo: "gpt-4o-mini", crudo: { dialecto: "openai-chat", uso: { prompt_tokens: 100 } } },
  {
    nombre: "responses con razonamiento",
    modelo: "gpt-5.5",
    crudo: { dialecto: "openai-responses", uso: { input_tokens: 11000, output_tokens: 500, input_tokens_details: { cached_tokens: 8000 }, output_tokens_details: { reasoning_tokens: 300 } } },
  },
  { nombre: "responses sin usage", modelo: "gpt-5.5", crudo: { dialecto: "openai-responses", uso: undefined } },
  {
    nombre: "provider-usage completo con 1 h",
    modelo: "claude-sonnet-4-5",
    crudo: { dialecto: "provider-usage", uso: { inputTokens: 11000, outputTokens: 500, cachedInputTokens: 8000, cacheWriteInputTokens: 2000, cacheWrite1hInputTokens: 500, reasoningTokens: 0 } },
  },
  { nombre: "provider-usage incompleto y todo a 0 → absent", modelo: "gpt-4o-mini", crudo: { dialecto: "provider-usage", uso: { inputTokens: 0, outputTokens: 0, complete: false } } },
  { nombre: "provider-usage incompleto con solo la entrada", modelo: "claude-sonnet-4-5", crudo: { dialecto: "provider-usage", uso: { inputTokens: 4300, outputTokens: 0, complete: false } } },
  { nombre: "provider-usage incompleto con los dos contadores", modelo: "claude-sonnet-4-5", crudo: { dialecto: "provider-usage", uso: { inputTokens: 4300, outputTokens: 20, complete: false } } },
  { nombre: "modelo desconocido → unpriced", modelo: "acme-llm-9", crudo: { dialecto: "anthropic", uso: ANTHROPIC } },
  { nombre: "alias -latest: precio heredado → uncertain", modelo: "gpt-4o-mini-latest", crudo: { dialecto: "openai-chat", uso: CHAT } },
  { nombre: "instantánea con fecha: fila propia", modelo: "claude-sonnet-4-5-20250929", crudo: { dialecto: "anthropic", uso: ANTHROPIC } },
  { nombre: "estimación → uncertain", modelo: "claude-sonnet-4-5", crudo: { dialecto: "anthropic", uso: ANTHROPIC }, basis: "estimated" },
  { nombre: "conteo del cliente → uncertain", modelo: "claude-sonnet-4-5", crudo: { dialecto: "anthropic", uso: ANTHROPIC }, basis: "client_observed" },
  { nombre: "cero de entrada → implausible", modelo: "gpt-4o-mini", crudo: { dialecto: "openai-chat", uso: { prompt_tokens: 0, completion_tokens: 10 } } },
  { nombre: "justo en 200K: priced", modelo: "gpt-5.5", crudo: { dialecto: "openai-responses", uso: { input_tokens: 200_000, output_tokens: 10 } } },
  { nombre: "200K + 1: long-context-tier", modelo: "gpt-5.5", crudo: { dialecto: "openai-responses", uso: { input_tokens: 200_001, output_tokens: 10 } } },
  { nombre: "fracciones de micro-USD: se redondea UNA vez", modelo: "gpt-4o-mini", crudo: { dialecto: "openai-chat", uso: { prompt_tokens: 7, completion_tokens: 3 } } },
  { nombre: "mitad exacta de micro-USD: hacia arriba, no al par", modelo: "gpt-4o-mini", crudo: { dialecto: "openai-chat", uso: { prompt_tokens: 30, completion_tokens: 0 } } },
  { nombre: "gemini con escritura de caché (prima 1)", modelo: "gemini-2.5-pro", crudo: { dialecto: "provider-usage", uso: { inputTokens: 5000, outputTokens: 100, cachedInputTokens: 1000, cacheWriteInputTokens: 500 } } },
];

/** La fila que el catálogo de TS resuelve para un modelo ese día: lo único que Python no calcula. */
export interface FilaDePrecio {
  catalogKey: string;
  inputPer1k: number;
  cachedInputPer1k: number | null;
  outputPer1k: number;
  prima5m: number;
  prima1h: number;
  /** ¿Es la fila PROPIA del modelo (o una instantánea con fecha), o la de un pariente? */
  propio: boolean;
}

function filaDe(modelo: string, at: number): FilaDePrecio | null {
  const lista = precioDeLista(modelo, at);
  const clave = claveDeCatalogo(modelo);
  if (!lista || clave === undefined) return null;
  return {
    catalogKey: clave,
    inputPer1k: lista.inputPer1k,
    cachedInputPer1k: lista.cachedInputPer1k ?? null,
    outputPer1k: lista.outputPer1k,
    prima5m: primaDeEscritura(modelo),
    prima1h: primaDeEscritura1h(modelo),
    propio: precioDeListaPropio(modelo, at) !== undefined,
  };
}

export function vectoresUso() {
  return {
    formato: VERSION_DE_VECTORES,
    generadoPor: "scripts/paridad-vectores.ts (desde test/helpers/paridad.ts)",
    priceVersion: PRECIOS_AL_DIA,
    priceDay: diaUtc(DIA),
    casos: CASOS_USO.map((c) => {
      const uso = normalizarUso(c.crudo, c.basis ? { basis: c.basis } : {});
      return {
        nombre: c.nombre,
        entrada: { crudo: c.crudo, basis: c.basis ?? null, modelo: c.modelo },
        fila: filaDe(c.modelo, DIA),
        esperado: { uso, precio: tarifarIntento(c.modelo, uso, DIA) },
      };
    }),
  };
}

/** El texto EXACTO de cada fichero: JSON con dos espacios y salto final. */
export function textoDeVectores(): Record<string, string> {
  return {
    [RUTA_JSON_ESTRICTO]: `${JSON.stringify(vectoresJsonEstricto(), null, 2)}\n`,
    [RUTA_USO]: `${JSON.stringify(vectoresUso(), null, 2)}\n`,
  };
}
