import { sha256 as hashSha256 } from "../util/hash.js";
import type { ChatMessage, SavingsRequest } from "../contracts/types.js";

/**
 * Canonicalization turns a raw request into a normalized, hashable form. This
 * is what makes the exact cache safe and the singleflight key correct: two
 * requests that mean the same thing must canonicalize identically, and two
 * requests that differ in any way that could change the answer must not.
 */
export interface CanonicalRequest {
  model: string;
  modelFamily: string;
  messages: ChatMessage[];
  /**
   * Text of the user-visible turns, normalized so that trivial near-duplicates
   * collide: Unicode form, case, whitespace, typographic marks and sentence
   * punctuation. Numbers, dates, quantities and negations are preserved exactly.
   */
  normalizedText: string;
  systemPromptHash: string;
  toolsetHash: string;
  /** Hash of the structured payload; part of the cache key so different data never collides. */
  structuredDataHash: string;
  schemaVersion: string;
  contractId: string | null;
  temperature: number | null;
  seed: number | null;
  tenantId: string;
  authorizationScope: string;
  /**
   * Quién pregunta, dentro del tenant. Sale de `context.sessionId`.
   *
   * Es lo que permite cachear una respuesta PERSONALIZADA sin servírsela a otro:
   * tenant y scope son compartidos por defecto, así que sin esto dos usuarios de
   * la misma organización comparten entrada de caché. `null` cuando no se
   * aporta, y entonces la política apaga la caché exacta para ese tráfico.
   */
  principal: string | null;
  locale: string;
  knowledgeEpoch: string;
  freshnessBucket: string;
  safetyPolicyVersion: string;
  tokenizer: string | undefined;
  original: SavingsRequest;
}

// ─── Normalización del texto que entra en la clave ───────────────────────────
//
// POR QUÉ CAMBIÓ. En la medición del 2026-08-13 (51 peticiones, A/B contra el
// contador del proveedor) la caché exacta aportó CERO llamadas evitadas: las 15
// que se apuntaron eran 9 del singleflight y 6 de los resolvers. Una de las
// causas está aquí: la normalización era `trim` + colapsar espacios +
// minúsculas, así que «¿Cuál es el total?» y «cual es el total» eran dos claves
// distintas y ninguna de las dos acertaba nunca. En español y en catalán eso no
// es un caso raro: la tilde y la interrogación de apertura las escribe quien
// escribe despacio y las omite quien escribe rápido, y es la MISMA persona en la
// misma sesión.
//
// DÓNDE ESTÁ LA LÍNEA. Normalizar de más no da más ahorro: convierte la caché de
// casi-duplicados en una máquina de contestar OTRA pregunta, que es el peor
// fallo que puede tener este producto porque el cliente no lo ve venir —le llega
// una respuesta bien formada—. El criterio es el mismo que ya usa
// `keyTokensMatch` en la caché semántica: se puede tocar lo que NO cambia los
// hechos (adorno tipográfico, caja, espacios, puntuación de frase) y no se puede
// tocar nada que cambie una CIFRA, una FECHA, una NEGACIÓN o una ENTIDAD. De ahí
// cada excepción de abajo, que son las que separan esto de un `replace(/\W/g,"")`:
//   · «1.234,56» y «3.14» conservan sus separadores. Quitar todos los puntos
//     convierte 3.14 en 314 y sirve un error de dos órdenes de magnitud con la
//     misma confianza que un acierto.
//   · «12:30» conserva los dos puntos y «20/07/2026» las barras: son fechas.
//   · «5"» y «5'» siguen siendo distintos: son pulgadas y pies.
//   · «3! + 2» conserva el factorial. Sin él, el resolver aritmético deja de
//     declinar —hoy declina porque no sabe qué es «!»— y contesta 5.
//   · los paréntesis no se tocan: «(2+3)*4» es 20 y «2+3*4» es 14.
//
// LOS DIACRÍTICOS SE PLIEGAN, y es una decisión con coste, no una obviedad. Se
// pliega toda marca sobre base latina a-z, incluidas ñ y ç: «año» y «ano» pasan a
// ser la misma clave, y «força» y «forca» también. Se acepta por dos razones. La
// primera es que para que eso llegue a servir una respuesta equivocada hacen
// falta dos textos IGUALES salvo la tilde, los dos preguntas plausibles, y del
// MISMO principal (la clave lleva tenant y principal, así que ni siquiera se
// comparten entre usuarios); el par realista no es «año/ano», es «pregunta bien
// escrita» contra «la misma sin tildes». La segunda es que la alternativa
// —plegar solo las vocales, dejando ñ y ç— deja guardarraíles MUERTOS: los
// marcadores de `policy.ts` están escritos como pares «acentuado|sin acentuar», y
// «dostępność» plegada a medias («dostepnośc») no casa con ninguna de las dos
// ramas, o sea que el polaco se queda sin detector de frescura.
//
// Lo que NO se pliega es la marca sobre base no latina. En devanagari o en
// tailandés el signo no es un adorno sobre la letra, es parte de la vocal, y
// quitarlo cambia la palabra.
const ESPACIOS = /\s+/g;

// Lo que meten solos el teclado del móvil, Word y los editores «listos»: comillas
// curvas, guiones largos, el apóstrofo tipográfico. El autor no eligió ninguno y
// no distinguen nada, pero parten la clave en dos.
const TIPOGRAFICAS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[‘’‚‛′´`]/g, "'"], // ‘ ’ ‚ ‛ ′ ´ `
  [/[“”„‟″«»]/g, '"'], // “ ” „ ‟ ″ « »
  [/[‐-―−]/g, "-"], // ‐ ‑ ‒ – — ― −
  [/⁄/g, "/"], // ⁄ (la barra de «½», que NFKC deja como 1⁄2)
  [/…/g, ""], // …
];

const PUNTUACION = /[¿?¡!;.,:'"·•]/g;
const DIACRITICO_LATINO = /([a-z])\p{M}+/gu;
const MARCA_HUERFANA = /(^|\s)\p{M}+/gu;
const LETRA = /\p{L}/u;

function esDigito(c: string): boolean {
  return c >= "0" && c <= "9";
}

/**
 * Normalized form of a turn's text, as it enters the cache key.
 *
 * Folded away: Unicode form, case, whitespace, typographic marks, Latin
 * diacritics and sentence punctuation. Preserved exactly: numbers, decimal and
 * thousands separators, times, dates, units, negations, math operators and any
 * combining mark outside the Latin alphabet.
 */
export function normalizeText(text: string): string {
  // NFKC primero, y la tabla tipográfica DESPUÉS: parte del trabajo lo destapa
  // la propia NFKC («½» sale como «1⁄2», con barra de fracción, y hay que
  // convertirla o «½ de 10» y «1/2 de 10» siguen siendo dos claves).
  let out = text.normalize("NFKC").toLowerCase();
  for (const [signo, ascii] of TIPOGRAFICAS) out = out.replace(signo, ascii);
  out = out
    .normalize("NFD")
    .replace(DIACRITICO_LATINO, "$1")
    .replace(MARCA_HUERFANA, "$1")
    .normalize("NFC");

  // Cada signo decide MIRANDO A SUS VECINOS. Es la diferencia entre quitar
  // puntuación y estropear datos: el mismo carácter es adorno entre letras y
  // dato entre cifras.
  out = out.replace(PUNTUACION, (signo: string, i: number, todo: string) => {
    const antes = todo[i - 1] ?? "";
    const despues = todo[i + 1] ?? "";
    switch (signo) {
      case "¿":
      case "?":
      case "¡":
      case ";":
        return "";
      case "!":
        // Pegado a una cifra es un factorial, y el resolver aritmético declina al
        // verlo. Quitarlo le hace leer «3! + 2» como «3 + 2» y responder 5.
        return esDigito(antes) ? signo : "";
      case ".":
      case ",":
        if (esDigito(antes) && esDigito(despues)) return signo; // 1.234,56
        // «.5» es medio, no cinco.
        if (esDigito(despues) && !esDigito(antes) && !LETRA.test(antes)) return signo;
        return "";
      case ":":
        return esDigito(antes) && esDigito(despues) ? signo : ""; // 12:30
      case "'":
      case '"':
        // Dentro de palabra es ortografía, no adorno: l'import, s'ha,
        // aujourd'hui, don't. Y «aujourd'hui» es un marcador de frescura de
        // `policy.ts`: borrarle el apóstrofo apaga el guardarraíl en francés.
        if (LETRA.test(antes) && LETRA.test(despues)) return signo;
        // Pegado a una cifra es una UNIDAD: 5' son pies y 5" pulgadas.
        return esDigito(antes) || esDigito(despues) ? signo : "";
      default:
        // El punto volado del catalán (col·legi ≡ col.legi ≡ collegi) es adorno;
        // «2·3» es una multiplicación.
        return esDigito(antes) || esDigito(despues) ? signo : "";
    }
  });

  return out.replace(ESPACIOS, " ").trim();
}

export function sha256(input: string): string {
  return hashSha256(input);
}

/** Stable JSON stringify with sorted keys so hashes are order-independent. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

function modelFamilyOf(model: string): string {
  // "openai/gpt-4o-mini" -> "openai/gpt-4o", "gpt-4o-mini-2024" -> "gpt-4o".
  const noVersion = model.replace(/[-_]?\d{4,}.*$/, "");
  return noVersion.replace(/[-_](mini|nano|small|large|latest)$/i, "");
}

export function canonicalize(request: SavingsRequest): CanonicalRequest {
  const ctx = request.context ?? {};

  const systemMessages = request.messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");

  const conversational = request.messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role}:${normalizeText(m.content)}`)
    .join("\n");

  const tools = (request.tools ?? [])
    .map((t) => ({ id: t.id, risk: t.risk, parameters: t.parameters ?? null }))
    .sort((a, b) => a.id.localeCompare(b.id));

  return {
    model: request.model,
    modelFamily: modelFamilyOf(request.model),
    messages: request.messages,
    normalizedText: conversational,
    systemPromptHash: sha256(systemMessages),
    toolsetHash: sha256(stableStringify(tools)),
    structuredDataHash:
      request.structuredData !== undefined
        ? sha256(stableStringify(request.structuredData))
        : "none",
    schemaVersion: request.response?.version ?? request.response?.contractId ?? "none",
    contractId: request.response?.contractId ?? null,
    temperature: request.temperature ?? null,
    seed: request.seed ?? null,
    tenantId: ctx.tenantId ?? "anonymous",
    authorizationScope: ctx.authorizationScope ?? "default",
    principal: ctx.sessionId ?? null,
    locale: ctx.locale ?? "und",
    knowledgeEpoch: ctx.knowledgeEpoch ?? "none",
    freshnessBucket: ctx.freshnessBucket ?? "any",
    safetyPolicyVersion: ctx.safetyPolicyVersion ?? "none",
    tokenizer: request.tokenizer,
    original: request,
  };
}
