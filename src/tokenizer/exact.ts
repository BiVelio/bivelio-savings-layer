/**
 * Tokenizador EXACTO — la regla del proveedor, no una aproximación.
 *
 * Por qué existe. El baseline de una llamada que se ejecutó se reconstruye como
 * "lo enviado + lo quitado". Lo enviado lo mide el proveedor; lo quitado lo
 * contamos aquí. Con el estimador heurístico esos dos sumandos vienen de reglas
 * distintas, y la diferencia NO es ruido: el heurístico cobra cada símbolo suelto
 * como un token entero, así que infla el JSON (40% de símbolos) mucho más que el
 * An estimator that is not calibrated for the destination model can miss by
 * enough to publish a baseline several times the real one, which would credit a
 * saving that never existed. That is why `basis` degrades instead of claiming.
 */
import type { TokenEstimator } from "./estimator.js";

/** Lo que necesitamos de gpt-tokenizer. Tipado aquí para no depender de sus tipos. */
interface BpeEncoder {
  encode(text: string): number[] | { length: number };
}

/**
 * Estimador exacto sobre una codificación BPE ya cargada.
 *
 * Se construye con el encoder ya resuelto en vez de importarlo dentro: así
 * este módulo no obliga a nadie a tener el paquete, y quien lo tiene decide qué
 * codificación carga (o200k_base para gpt-4o/4.1/5, cl100k_base para 3.5/4).
 */
export class ExactTokenizer implements TokenEstimator {
  readonly id: string;
  readonly exact = true;

  constructor(id: string, private readonly encoder: BpeEncoder) {
    this.id = id;
  }

  count(text: string): number {
    if (text.length === 0) return 0;
    if (text.length <= TIRADA_MAXIMA) return this.encoder.encode(text).length;
    const cortes = cortesDeTiradasLargas(text);
    if (cortes.length === 0) return this.encoder.encode(text).length;
    let total = 0;
    let desde = 0;
    for (const corte of cortes) {
      total += this.encoder.encode(text.slice(desde, corte)).length;
      desde = corte;
    }
    return total + this.encoder.encode(text.slice(desde)).length;
  }
}

// ─── Tiradas largas (auditoría del 2026-11-19, A2-4) ─────────────────────────
//
// El BPE de gpt-tokenizer parte el texto en piezas con una regex (una palabra,
// un grupo de signos, una racha de espacios) y funde cada pieza en tiempo
// CUADRÁTICO con su tamaño. En texto normal las piezas son de pocos caracteres
// y no se nota. Una sola pieza de 100 KB (espacios, saltos de línea, «=», «a»,
// chino sin puntuación) paraba el hilo 3 s, y una de 400 KB, 70 s: el recuento
// es síncrono y corre en cada petición, con texto que escribe el usuario final.
//
// Se cortan SOLO las tiradas largas y cada trozo se cuenta por separado: el
// coste pasa a ser lineal. Una «tirada» es una racha sin cambio entre tres
// clases: espacio (`\s`), cifra (`\p{N}`, que el BPE ya trocea de tres en tres
// y nunca se corta) y todo lo demás. Las clases son más anchas que las piezas
// de verdad a propósito: toda pieza larga cae dentro de una tirada larga, sea
// cual sea la codificación, y un texto no puede esquivar el corte alternando
// dos caracteres que el BPE trate como iguales.
//
// QUÉ CAMBIA EN EL RECUENTO. Un texto sin ninguna tirada de más de
// TIRADA_MAXIMA no se toca: una sola llamada, el mismo número. En una tirada
// larga de letras y signos se corta donde una letra precede a un signo, que es
// frontera de pieza en cl100k y en o200k (el texto chino o japonés, que no
// lleva espacios, se corta en su puntuación y cuenta igual). Si no hay ninguna
// en el tramo, se corta en seco, y cada corte en seco puede partir un token en
// dos: como mucho unos pocos tokens de MÁS por corte, nunca de menos.
const TIRADA_MAXIMA = 512;
const ESPACIO = /\s/;
const CIFRA = /\p{N}/u;
const LETRA = /\p{L}/u;
const LETRA_O_PEGADO = /[\p{L}\p{M}'’]/u;

/** 0 espacio, 1 cifra, 2 lo demás. */
function clase(c: number, ch: string): 0 | 1 | 2 {
  if (c < 0x80) return c === 32 || (c >= 9 && c <= 13) ? 0 : c >= 48 && c <= 57 ? 1 : 2;
  return ESPACIO.test(ch) ? 0 : CIFRA.test(ch) ? 1 : 2;
}

function esLetra(c: number, ch: string): boolean {
  if (c < 0x80) return (c >= 97 && c <= 122) || (c >= 65 && c <= 90);
  return LETRA.test(ch);
}

/** Posiciones, en orden, por las que partir `text` para que ninguna tirada pase de TIRADA_MAXIMA. */
function cortesDeTiradasLargas(text: string): number[] {
  const cortes: number[] = [];
  let claseDeRacha = -1;
  let desde = 0; // principio de la racha, o el último corte dentro de ella
  let frontera = -1; // última frontera segura (letra → signo) después de `desde`
  let anteriorEsLetra = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    const ch = text[i]!;
    const k = clase(c, ch);
    if (k !== claseDeRacha) {
      claseDeRacha = k;
      desde = i;
      frontera = -1;
    } else if (k === 2 && anteriorEsLetra && !(c < 0x80 ? esLetra(c, ch) || c === 39 : LETRA_O_PEGADO.test(ch))) {
      frontera = i;
    }
    anteriorEsLetra = k === 2 && esLetra(c, ch);
    if (k !== 1 && i - desde >= TIRADA_MAXIMA) {
      let corte = frontera > desde ? frontera : i;
      // Nunca entre las dos mitades de un par subrogado.
      if (corte === i && c >= 0xdc00 && c <= 0xdfff) corte = i - 1;
      cortes.push(corte);
      desde = corte;
      frontera = -1;
    }
  }
  return cortes;
}

/** Modelos que usan cada codificación. Sirve para mapear el registro de una vez. */
export const MODELS_BY_ENCODING: Readonly<Record<string, readonly string[]>> = {
  o200k_base: [
    "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
    "o1", "o1-mini", "o3", "o3-mini", "o4-mini",
  ],
  cl100k_base: ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo", "text-embedding-3-small", "text-embedding-3-large"],
} as const;

export function codificacionDeModelo(model: string): string | undefined {
  const sinProveedor = model.startsWith("openai/") ? model.slice("openai/".length) : model;
  return Object.entries(MODELS_BY_ENCODING).find(([, modelos]) => modelos.includes(sinProveedor))?.[0];
}

/**
 * Carga `gpt-tokenizer` si está instalado y registra el tokenizador exacto para
 * los modelos de OpenAI. Devuelve `false` —sin lanzar— cuando no está: la
 * ausencia del paquete opcional no es un error, solo significa que la
 * contabilidad se publicará como estimada.
 *
 * Se importa solo la codificación pedida, no el paquete entero: `gpt-tokenizer`
 * expone un punto de entrada por codificación y cargarlas todas serían decenas
 * de MB en memoria sin motivo.
 */
export async function registerExactTokenizer(
  registro: {
    register(e: TokenEstimator): unknown;
    mapModel(model: string, tokenizerId: string): unknown;
  },
  opciones: { codificaciones?: readonly string[] } = {},
): Promise<boolean> {
  const codificaciones = opciones.codificaciones ?? ["o200k_base", "cl100k_base"];
  let algunaCargada = false;

  for (const encodingName of codificaciones) {
    let mod: BpeEncoder;
    try {
      // Especificador en variable a propósito: impide que el empaquetador lo
      // resuelva estáticamente y arrastre el paquete al bundle de quien no lo usa.
      const specifier = `gpt-tokenizer/encoding/${encodingName}`;
      mod = (await import(/* @vite-ignore */ specifier)) as BpeEncoder;
    } catch {
      continue; // No instalado, o esa codificación no existe: seguimos.
    }
    if (typeof mod.encode !== "function") continue;

    registro.register(new ExactTokenizer(encodingName, mod));
    algunaCargada = true;

    for (const model of MODELS_BY_ENCODING[encodingName] ?? []) {
      // Con y sin prefijo de proveedor: el registro resuelve por id exacto, y el
      // mismo model llega como "gpt-4o-mini" o como "openai/gpt-4o-mini" según
      // se hable con OpenAI directo o a través de una pasarela.
      registro.mapModel(model, encodingName);
      registro.mapModel(`openai/${model}`, encodingName);
    }
  }

  return algunaCargada;
}
