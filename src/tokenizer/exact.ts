/**
 * Tokenizador EXACTO — la regla del proveedor, no una aproximación.
 *
 * Por qué existe. El baseline de una llamada que se ejecutó se reconstruye como
 * "lo enviado + lo quitado". Lo enviado lo mide el proveedor; lo quitado lo
 * contamos aquí. Con el estimador heurístico esos dos sumandos vienen de reglas
 * distintas, y la diferencia NO es ruido: el heurístico cobra cada símbolo suelto
 * como un token entero, así que infla el JSON (40% de símbolos) mucho más que el
 * TOON (16%). Medido en el escenario de la tabla: publicaba un baseline 3,68x el
 * naive real, o sea un +47,4% de ahorro donde el proveedor midió −49,6%.
 *
 * Cómo se instala. `gpt-tokenizer` son ~53 MB desempaquetados, así que NO es
 * dependencia dura: imponérsela a todo el que instale el SDK, cuando la mayoría
 * no necesita contabilidad medida, sería abusivo. Es peerDependency opcional:
 *
 *   pnpm add gpt-tokenizer
 *
 * Sin ella el layer sigue funcionando con el heurístico, y el `basis` de cada
 * informe lo dice — "estimated" en vez de "measured". Esa es la diferencia
 * importante: el producto no deja de funcionar, deja de AFIRMAR de más.
 */
import type { TokenEstimator } from "./estimator.js";

/** Lo que necesitamos de gpt-tokenizer. Tipado aquí para no depender de sus tipos. */
interface CodificadorBpe {
  encode(text: string): number[] | { length: number };
}

/**
 * Estimador exacto sobre una codificación BPE ya cargada.
 *
 * Se construye con el codificador ya resuelto en vez de importarlo dentro: así
 * este módulo no obliga a nadie a tener el paquete, y quien lo tiene decide qué
 * codificación carga (o200k_base para gpt-4o/4.1/5, cl100k_base para 3.5/4).
 */
export class ExactTokenizer implements TokenEstimator {
  readonly id: string;
  readonly exact = true;

  constructor(id: string, private readonly codificador: CodificadorBpe) {
    this.id = id;
  }

  count(text: string): number {
    if (text.length === 0) return 0;
    return this.codificador.encode(text).length;
  }
}

/** Modelos que usan cada codificación. Sirve para mapear el registro de una vez. */
export const MODELOS_POR_CODIFICACION: Readonly<Record<string, readonly string[]>> = {
  o200k_base: [
    "gpt-4o", "gpt-4o-mini", "gpt-4.1", "gpt-4.1-mini", "gpt-4.1-nano",
    "o1", "o1-mini", "o3", "o3-mini", "o4-mini",
  ],
  cl100k_base: ["gpt-4", "gpt-4-turbo", "gpt-3.5-turbo", "text-embedding-3-small", "text-embedding-3-large"],
} as const;

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
export async function registrarTokenizadorExacto(
  registro: {
    register(e: TokenEstimator): unknown;
    mapModel(model: string, tokenizerId: string): unknown;
  },
  opciones: { codificaciones?: readonly string[] } = {},
): Promise<boolean> {
  const codificaciones = opciones.codificaciones ?? ["o200k_base", "cl100k_base"];
  let algunaCargada = false;

  for (const nombre of codificaciones) {
    let modulo: CodificadorBpe;
    try {
      // Especificador en variable a propósito: impide que el empaquetador lo
      // resuelva estáticamente y arrastre el paquete al bundle de quien no lo usa.
      const especificador = `gpt-tokenizer/encoding/${nombre}`;
      modulo = (await import(/* @vite-ignore */ especificador)) as CodificadorBpe;
    } catch {
      continue; // No instalado, o esa codificación no existe: seguimos.
    }
    if (typeof modulo.encode !== "function") continue;

    registro.register(new ExactTokenizer(nombre, modulo));
    algunaCargada = true;

    for (const modelo of MODELOS_POR_CODIFICACION[nombre] ?? []) {
      // Con y sin prefijo de proveedor: el registro resuelve por id exacto, y el
      // mismo modelo llega como "gpt-4o-mini" o como "openai/gpt-4o-mini" según
      // se hable con OpenAI directo o a través de una pasarela.
      registro.mapModel(modelo, nombre);
      registro.mapModel(`openai/${modelo}`, nombre);
    }
  }

  return algunaCargada;
}
