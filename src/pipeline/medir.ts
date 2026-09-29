/**
 * LA LICENCIA «MEDIR» — el modo sombra del SDK.
 *
 * Con una licencia de plan `measure` (gratuita, permanente, sin tarjeta) la capa
 * NO aplica ninguna palanca: la petición sale al proveedor exactamente como la
 * construyó el cliente (el mismo camino directo que el fail-open, sin cachés, sin
 * singleflight, sin resolvers, sin compresión, sin cascada, sin marcas de caché
 * de prefijo, sin tier diferido) y NADA se sirve de caché. Lo que sí hace es
 * calcular, al lado, lo que habría ahorrado, y lo publica en `report.measure`
 * con `basis: "shadow"`: hipotético por construcción, jamás en la base de la
 * comisión ni sumado al dinero medido.
 *
 * Qué se simula, y por qué solo eso: las dos palancas que EVITAN la llamada —la
 * caché exacta y la coalescencia de duplicados en vuelo— se pueden valorar sin
 * inventar nada, porque la llamada que se habría evitado es ESTA, y su coste lo
 * acaba de declarar el contador del proveedor. Todo lo demás (caché semántica,
 * compresión, elisión, cascada, codebook, tier diferido…) necesita una llamada
 * al modelo, un embebedor o un derecho de pago para estimarse con honradez, así
 * que se enumera en `notSimulated`: la cifra es una COTA INFERIOR.
 *
 * Esta memoria guarda CLAVES (hashes sha256 de la identidad de la petición) y un
 * instante, nunca una respuesta ni un texto: no hay nada que servir porque no se
 * guarda nada servible.
 */

/** Dónde se activan las palancas (la cuenta de la organización, con su checkout). */
export const URL_DE_PAGO = "https://savings.bivelio.com/dashboard/account";

/** Las palancas que el modo sombra NO simula (por eso la cifra es una cota inferior). */
export const PALANCAS_NO_SIMULADAS: readonly string[] = [
  "semantic_cache",
  "deterministic_resolvers",
  "format_selection",
  "compression",
  "context_elision",
  "tool_result_elision",
  "model_cascade",
  "output_codebook",
  "prompt_cache_placement",
  "deferred_tier",
];

/**
 * El aviso de una vez por proceso. En INGLÉS y sin caracteres raros, como todo lo
 * que ve el cliente del paquete publicado. Dice las tres cosas que importan: que
 * no se cambia nada, dónde está la cifra, y cómo se pasa a pago.
 */
export const AVISO_MEDIR =
  "[bvsala] Measure license: the layer is running in SHADOW mode. Every request goes to your " +
  "provider exactly as you built it and nothing is served from any cache; `report.measure." +
  "wouldHaveSaved` shows what the levers would have saved (a lower bound, never billed). " +
  `To turn the levers on, upgrade to a paid plan at ${URL_DE_PAGO} - the layer picks up the ` +
  "new license by itself (with `serviceAccountKey` and `licenseServerUrl`) or on restart.";

/** Tope de claves recordadas: acota la memoria de un proceso de vida larga. */
export const MAX_CLAVES_VISTAS = 10_000;

/**
 * La memoria del modo sombra: qué peticiones cacheables ya corrieron (y hasta
 * cuándo habrían seguido en la caché exacta) y cuáles están en vuelo ahora mismo.
 */
export class MemoriaDeSombra {
  /** clave exacta → instante (ms) en que la entrada habría caducado. */
  private readonly vistas = new Map<string, number>();
  /** clave de singleflight → peticiones idénticas en vuelo. */
  private readonly enVuelo = new Map<string, number>();

  constructor(private readonly max: number = MAX_CLAVES_VISTAS) {}

  /** ¿Habría estado esta clave en la caché exacta en `ahoraMs`? */
  vista(clave: string, ahoraMs: number): boolean {
    const expira = this.vistas.get(clave);
    if (expira === undefined) return false;
    if (ahoraMs > expira) {
      this.vistas.delete(clave);
      return false;
    }
    return true;
  }

  /** Recuerda una respuesta que la caché exacta habría guardado hasta `expiraMs`. */
  anotar(clave: string, expiraMs: number): void {
    // Reinsertar la mueve al final: el orden de inserción hace de LRU barato.
    this.vistas.delete(clave);
    this.vistas.set(clave, expiraMs);
    while (this.vistas.size > this.max) {
      const primera = this.vistas.keys().next().value;
      if (primera === undefined) break;
      this.vistas.delete(primera);
    }
  }

  /** ¿Hay ahora mismo una petición idéntica en vuelo? */
  hayEnVuelo(clave: string): boolean {
    return (this.enVuelo.get(clave) ?? 0) > 0;
  }

  entrar(clave: string): void {
    this.enVuelo.set(clave, (this.enVuelo.get(clave) ?? 0) + 1);
  }

  salir(clave: string): void {
    const n = (this.enVuelo.get(clave) ?? 0) - 1;
    if (n <= 0) this.enVuelo.delete(clave);
    else this.enVuelo.set(clave, n);
  }

  /** Para tests: cuántas claves recuerda. */
  tamano(): number {
    return this.vistas.size;
  }
}

/** Redondeo a 1e-10 USD, el mismo grano que el resto del informe. */
export function redondearUsd(x: number): number {
  return Math.round(x * 1e10) / 1e10;
}
