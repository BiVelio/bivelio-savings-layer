/**
 * EL FLUJO DE TRÁFICO QUE SE CONSTRUYE DESDE GSM8K — puro, sin red ni entorno.
 *
 * Un banco que manda cada problema una sola vez mide una caché que no puede
 * acertar nunca. Un banco que manda las repeticiones que él quiera mide lo que
 * él quiera. Este flujo fija las dos cosas con una semilla y las declara:
 *
 *   · N problemas únicos del split de test, elegidos con la semilla;
 *   · ~30 % del flujo son REPETICIONES EXACTAS de un problema ya visto;
 *   · ~20 % son PARÁFRASIS CERCANAS generadas con plantillas deterministas (nunca
 *     con el modelo bajo prueba), en cuatro clases:
 *       - `superficie`: minúsculas, sin «?», espacios dobles. Misma respuesta.
 *       - `lexica`: un preámbulo y sinónimos que no tocan cifras. Misma respuesta.
 *       - `variante-cifra`: el primer entero n pasa a n+1. OTRA respuesta.
 *       - `variante-palabra`: un número escrito en letra o un multiplicador
 *         («two», «twice», «half», «double») pasa al siguiente. OTRA respuesta.
 *     Las dos variantes son el caso adversario: se parecen al original tanto como
 *     una paráfrasis, y servirles la respuesta del original es servir un error
 *     con la confianza de un acierto;
 *   · un system prompt largo común (few-shot de 8 ejemplos del split de train),
 *     para que haya un prefijo cacheable de verdad.
 *
 * Cada petición derivada aparece DESPUÉS de su original, en una posición
 * uniforme entre la del original y el final del flujo.
 */
import { mulberry32 } from "../../stats.js";
import type { FilaGsm8k } from "./fuente.js";

export type ClaseDePeticion =
  | "original"
  | "repeticion"
  | "superficie"
  | "lexica"
  | "variante-cifra"
  | "variante-palabra";

export const CLASES: readonly ClaseDePeticion[] = [
  "original",
  "repeticion",
  "superficie",
  "lexica",
  "variante-cifra",
  "variante-palabra",
];
export const CLASES_CON_ORO: readonly ClaseDePeticion[] = ["original", "repeticion", "superficie", "lexica"];
export const CLASES_VARIANTE: readonly ClaseDePeticion[] = ["variante-cifra", "variante-palabra"];

export interface Problema {
  /** Índice de línea en test.jsonl (0-based): la identidad pública del problema. */
  idx: number;
  pregunta: string;
  oro: number;
}

export interface Peticion {
  /** Posición en el flujo (0-based). */
  pos: number;
  /** El problema del que sale (índice en test.jsonl). */
  familia: number;
  clase: ClaseDePeticion;
  texto: string;
  /**
   * La respuesta correcta, o `null` en las variantes: cambiarles una cifra cambia
   * la respuesta y no hay oro publicado para ellas. Se usan para seguridad (¿se
   * les sirvió la respuesta de otra pregunta?), nunca para exactitud.
   */
  oro: number | null;
}

// ─── El oro y la respuesta final ─────────────────────────────────────────────

/** El oro de GSM8K: lo que va tras «####», sin separadores de miles. */
export function oroDe(answer: string): number {
  const m = /####\s*(.+)\s*$/.exec(answer.trim());
  if (!m) throw new Error(`GSM8K answer without ####: ${answer.slice(-60)}`);
  const n = Number(m[1]!.replace(/[,$\s]/g, ""));
  if (!Number.isFinite(n)) throw new Error(`GSM8K gold is not a number: ${m[1]}`);
  return n;
}

const NUMERO = /-?\$?\s?\d[\d,]*(?:\.\d+)?/g;

function aNumero(s: string): number | null {
  const n = Number(s.replace(/[$,\s]/g, ""));
  return Number.isFinite(n) ? n : null;
}

/**
 * La respuesta numérica final de un texto del modelo: el número tras el último
 * «####»; si no hay, el último número del texto (la regla habitual de GSM8K).
 */
export function extraerNumeroFinal(texto: string): number | null {
  const marcas = texto.split("####");
  if (marcas.length > 1) {
    const tras = marcas[marcas.length - 1]!;
    const m = tras.match(NUMERO);
    if (m && m.length) return aNumero(m[0]!);
  }
  const todos = texto.match(NUMERO);
  return todos && todos.length ? aNumero(todos[todos.length - 1]!) : null;
}

export function mismaCifra(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && Math.abs(a - b) < 1e-6;
}

// ─── El system prompt ────────────────────────────────────────────────────────

export const INSTRUCCION =
  "You solve grade-school math word problems. Reason step by step, keep the working short, " +
  'and finish with a final line of the form "#### <number>" that contains only the numeric answer.';

/** Quita las anotaciones de calculadora de GSM8K (`<<16-3-4=9>>`). */
export function sinCalculadora(answer: string): string {
  return answer.replace(/<<[^>]*>>/g, "");
}

/** Barajado de Fisher-Yates con semilla. */
export function barajar<T>(xs: readonly T[], rng: () => number): T[] {
  const out = xs.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Los 8 ejemplos del few-shot: del split de TRAIN, elegidos con la semilla. */
export function ejemplosFewShot(train: readonly FilaGsm8k[], semilla: number, k = 8): number[] {
  return barajar(
    train.map((_, i) => i),
    mulberry32(semilla ^ 0x5f3759df),
  ).slice(0, k);
}

export function systemPrompt(train: readonly FilaGsm8k[], ejemplos: readonly number[]): string {
  const bloques = ejemplos.map((i) => {
    const f = train[i]!;
    return `Question: ${f.question.trim()}\nAnswer: ${sinCalculadora(f.answer).trim()}`;
  });
  return `${INSTRUCCION}\n\n${bloques.join("\n\n")}`;
}

/** El mensaje de usuario: el mismo formato que los ejemplos. */
export function mensajeDeUsuario(texto: string): string {
  return `Question: ${texto}`;
}

// ─── Las plantillas de paráfrasis ────────────────────────────────────────────

/** Misma pregunta, otra superficie: minúsculas, sin «?», espacios dobles. */
export function parafrasisSuperficie(t: string): string {
  return t.toLowerCase().replace(/\?/g, "").replace(/ /g, "  ").trim();
}

const PREAMBULOS = ["Here is a word problem. ", "Please solve the following. ", "Math question: "] as const;
const SINONIMOS: readonly [RegExp, string][] = [
  [/\bbought\b/g, "purchased"],
  [/\bbuys\b/g, "purchases"],
  [/\beach\b/g, "every"],
  [/\bgets\b/g, "receives"],
  [/\bwants to\b/g, "would like to"],
  [/\bin total\b/g, "altogether"],
];

/** Misma pregunta con otras palabras: un preámbulo y sinónimos que no tocan cifras. */
export function parafrasisLexica(t: string, rng: () => number): string {
  let out = t;
  for (const [re, sust] of SINONIMOS) out = out.replace(re, sust);
  return PREAMBULOS[Math.floor(rng() * PREAMBULOS.length)]! + out;
}

/**
 * OTRA pregunta que se parece: el primer entero `n` (no parte de un decimal ni
 * de un número con separador de miles) pasa a `n+1`. `null` si no hay ninguno.
 */
export function varianteCifra(t: string): string | null {
  const re = /(?<![\d.,])\d+(?![\d.,]\d)/g;
  const m = re.exec(t);
  if (!m) return null;
  const n = Number(m[0]);
  return t.slice(0, m.index) + String(n + 1) + t.slice(m.index + m[0].length);
}

const SIGUIENTE_PALABRA: Record<string, string> = {
  two: "three",
  three: "four",
  four: "five",
  five: "six",
  six: "seven",
  seven: "eight",
  eight: "nine",
  nine: "ten",
  ten: "eleven",
  twice: "three times",
  half: "a third",
  double: "triple",
  triple: "quadruple",
};
const PALABRA_NUMERO = new RegExp(`\\b(${Object.keys(SIGUIENTE_PALABRA).join("|")})\\b`, "i");

/**
 * OTRA pregunta que se parece, sin tocar un solo dígito: el primer número en
 * letra o multiplicador pasa al siguiente. Es la que una guarda de hechos que
 * solo mire dígitos no ve. `null` si el texto no tiene ninguno.
 */
export function variantePalabra(t: string): string | null {
  const m = PALABRA_NUMERO.exec(t);
  if (!m) return null;
  const palabra = m[1]!;
  let nueva = SIGUIENTE_PALABRA[palabra.toLowerCase()]!;
  if (palabra[0] === palabra[0]!.toUpperCase()) nueva = nueva[0]!.toUpperCase() + nueva.slice(1);
  return t.slice(0, m.index) + nueva + t.slice(m.index + palabra.length);
}

/** Aplica la plantilla de una clase derivada; `null` si no hay nada que cambiar. */
export function aplicarPlantilla(clase: ClaseDePeticion, t: string, rng: () => number): string | null {
  switch (clase) {
    case "superficie":
      return parafrasisSuperficie(t);
    case "lexica":
      return parafrasisLexica(t, rng);
    case "variante-cifra":
      return varianteCifra(t);
    case "variante-palabra":
      return variantePalabra(t);
    default:
      return t;
  }
}

// ─── El flujo ────────────────────────────────────────────────────────────────

export interface OpcionesDelFlujo {
  nUnicos: number;
  semilla: number;
  /** Fracción del flujo total que son repeticiones exactas. Por defecto 0.3. */
  fraccionRepeticiones?: number;
  /** Fracción del flujo total que son paráfrasis/variantes. Por defecto 0.2. */
  fraccionParafrasis?: number;
}

export interface Flujo {
  peticiones: Peticion[];
  problemas: Problema[];
  cuenta: Record<ClaseDePeticion, number>;
}

/**
 * El flujo, determinista dada la semilla. Con N únicos el total es N/(1−r−p):
 * N=100 → 200 peticiones, 60 repeticiones y 40 paráfrasis (10 de cada clase).
 */
export function construirFlujo(test: readonly FilaGsm8k[], o: OpcionesDelFlujo): Flujo {
  const r = o.fraccionRepeticiones ?? 0.3;
  const p = o.fraccionParafrasis ?? 0.2;
  if (!(r >= 0 && p >= 0 && r + p < 1)) throw new Error("fractions must be >= 0 and sum < 1");
  if (!(o.nUnicos >= 1 && o.nUnicos <= test.length)) throw new Error(`nUnicos out of range: ${o.nUnicos}`);
  const rng = mulberry32(o.semilla);
  const problemas: Problema[] = barajar(
    test.map((_, i) => i),
    rng,
  )
    .slice(0, o.nUnicos)
    .map((idx) => ({ idx, pregunta: test[idx]!.question.trim(), oro: oroDe(test[idx]!.answer) }));

  const total = Math.round(o.nUnicos / (1 - r - p));
  const nRep = Math.round(total * r);
  const nPar = total - o.nUnicos - nRep;

  interface Pendiente {
    t: number;
    familia: number;
    clase: ClaseDePeticion;
    texto: string;
    oro: number | null;
  }
  // Tiempos: los originales en 0..N-1; cada derivada, uniforme tras su original.
  const pendientes: Pendiente[] = problemas.map((pr, i) => ({
    t: i,
    familia: pr.idx,
    clase: "original",
    texto: pr.pregunta,
    oro: pr.oro,
  }));
  const tras = (i: number): number => i + 0.5 + rng() * (o.nUnicos - i - 0.5);

  for (let k = 0; k < nRep; k++) {
    const i = Math.floor(rng() * problemas.length);
    const pr = problemas[i]!;
    pendientes.push({ t: tras(i), familia: pr.idx, clase: "repeticion", texto: pr.pregunta, oro: pr.oro });
  }

  const derivadas: ClaseDePeticion[] = ["superficie", "lexica", "variante-cifra", "variante-palabra"];
  for (let k = 0; k < nPar; k++) {
    const clase = derivadas[k % derivadas.length]!;
    for (let intento = 0; intento < 1000; intento++) {
      const i = Math.floor(rng() * problemas.length);
      const pr = problemas[i]!;
      const texto = aplicarPlantilla(clase, pr.pregunta, rng);
      if (texto === null || texto === pr.pregunta) continue;
      const esVariante = CLASES_VARIANTE.includes(clase);
      pendientes.push({ t: tras(i), familia: pr.idx, clase, texto, oro: esVariante ? null : pr.oro });
      break;
    }
  }

  pendientes.sort((a, b) => a.t - b.t);
  const peticiones: Peticion[] = pendientes.map((q, pos) => ({
    pos,
    familia: q.familia,
    clase: q.clase,
    texto: q.texto,
    oro: q.oro,
  }));
  const cuenta = Object.fromEntries(
    CLASES.map((c) => [c, peticiones.filter((q) => q.clase === c).length]),
  ) as Record<ClaseDePeticion, number>;
  return { peticiones, problemas, cuenta };
}
