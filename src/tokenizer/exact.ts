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
    return this.encoder.encode(text).length;
  }
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
