import { sha256 } from "../util/hash.js";
import type {
  CompressionResult,
  Compressor,
} from "../compression/compression.js";

/**
 * Carry-over by content hash: an auxiliary result is paid for ONCE per
 * content-version, never per session and never per request.
 *
 * The layer's own auxiliary passes (an embedding for the semantic cache, a
 * compressor run over a message, tomorrow a summarizer over an evidence
 * document) are pure functions of their input text. Without a memo, the same
 * input pays the same pass again on every request that carries it; with one,
 * the cost is amortized to once per distinct content.
 *
 * CONTABILIDAD — Y ESTO ES DELIBERADO: lo que se ahorra aquí es gasto AUXILIAR
 * de la propia capa (red, cómputo o dinero que pagamos NOSOTROS por operar),
 * no tokens del proveedor del cliente. NUNCA entra en los 4 libros ni en
 * `netSavings`: acreditarlo allí sería ahorro sobre coste propio, la misma
 * clase de mentira que el libro 3 ya tuvo que expulsar una vez (comprimir
 * texto inyectado por la capa). Los contadores de `stats()` existen para
 * observar el mecanismo, no para reclamarlo.
 *
 * Origen del patrón: due diligence de NanoNets/Graft (2026-08-18) — su idea
 * más valiosa era exactamente esta (resúmenes LLM clavados a un content-hash
 * con carry-over de lo no cambiado). Reimplementado desde cero como patrón,
 * sin dependencia ni código copiado.
 */

/**
 * `ready` is a live value; `stale` keeps the previous value as a HINT after an
 * explicit invalidation — a future consumer (an evidence summarizer) can show
 * or seed with the old result while recomputing, exactly like a build cache
 * carries a stale summary. A stale entry never satisfies a read on its own.
 */
type EstadoDeEntrada = "ready" | "stale";

interface Entrada<T> {
  valor: T;
  estado: EstadoDeEntrada;
}

export interface CarryoverStats {
  /** Reads served from a `ready` entry — the inner pass was NOT paid. */
  aciertos: number;
  /** Reads that had to run the inner pass. */
  fallos: number;
  /** Concurrent duplicate reads that shared one in-flight computation. */
  coalescidas: number;
}

/**
 * The memo itself. Keyed by sha256 of a version prefix plus the content, with
 * a hard entry cap evicted in least-recently-used order.
 *
 * La VERSIÓN va en la clave por la lección del `extractorStamp` de Graft: si
 * cambia el código que produce el resultado, todo lo memorizado miente. Con el
 * almacén en memoria y una función fija por instancia la versión puede quedar
 * vacía sin riesgo (la instancia muere con su función); se vuelve OBLIGATORIA
 * el día que este almacén se persista o se comparta entre procesos.
 */
export class CarryoverPorHash<T> {
  private readonly entradas = new Map<string, Entrada<T>>();
  private readonly enVuelo = new Map<string, Promise<T>>();
  private readonly maxEntradas: number;
  private readonly version: string;
  private aciertos = 0;
  private fallos = 0;
  private coalescidas = 0;

  constructor(opts: { maxEntradas?: number; version?: string } = {}) {
    // El tope no es decorativo: un embedding son ~2 KB y un texto comprimido
    // puede ser grande. Sin tope, "memoizar" se convierte en "fugar memoria a
    // ritmo de tráfico".
    this.maxEntradas = opts.maxEntradas ?? 2048;
    this.version = opts.version ?? "";
  }

  private clave(contenido: string): string {
    return sha256(`${this.version}\u0000${contenido}`);
  }

  /** Current entry for a content, or null. A hit refreshes LRU recency. */
  inspeccionar(contenido: string): { estado: EstadoDeEntrada; valor: T } | null {
    const clave = this.clave(contenido);
    const entrada = this.entradas.get(clave);
    if (!entrada) return null;
    if (entrada.estado === "ready") {
      // Map conserva orden de inserción: borrar y reinsertar es el toque LRU.
      this.entradas.delete(clave);
      this.entradas.set(clave, entrada);
    }
    return { estado: entrada.estado, valor: entrada.valor };
  }

  /** Store a live value for a content, evicting the oldest entry over the cap. */
  guardar(contenido: string, valor: T): void {
    const clave = this.clave(contenido);
    this.entradas.delete(clave);
    this.entradas.set(clave, { valor, estado: "ready" });
    while (this.entradas.size > this.maxEntradas) {
      const masVieja = this.entradas.keys().next().value;
      if (masVieja == null) break;
      this.entradas.delete(masVieja);
    }
  }

  /**
   * Mark a content's entry stale, keeping the old value as a hint. Returns
   * whether there was anything to invalidate.
   */
  invalidar(contenido: string): boolean {
    const entrada = this.entradas.get(this.clave(contenido));
    if (!entrada) return false;
    entrada.estado = "stale";
    return true;
  }

  /**
   * The whole dance: serve a `ready` value, join an in-flight computation, or
   * run `calcula` and remember its result.
   *
   * Tres propiedades que los tests fijan:
   *  - un `calcula` SÍNCRONO se devuelve síncrono (acierto y fallo): envolver
   *    al embebedor local no puede añadir un `await` al camino de la petición;
   *  - dos lecturas concurrentes del mismo contenido comparten UNA ejecución
   *    (el mismo trabajo que el singleflight hace con el proveedor, aquí con
   *    el pase auxiliar);
   *  - un error NUNCA se memoriza: la promesa fallida se retira y el siguiente
   *    lector vuelve a intentar.
   *
   * `cacheable` deja al llamante vetar el guardado de un resultado (p. ej. una
   * compresión que salió `skipped`): se devuelve igual, pero no se recuerda.
   */
  obtener(
    contenido: string,
    calcula: (contenido: string) => Promise<T> | T,
    cacheable?: (valor: T) => boolean,
  ): Promise<T> | T {
    const previa = this.inspeccionar(contenido);
    if (previa?.estado === "ready") {
      this.aciertos += 1;
      return previa.valor;
    }
    const clave = this.clave(contenido);
    const volando = this.enVuelo.get(clave);
    if (volando) {
      this.coalescidas += 1;
      return volando;
    }
    this.fallos += 1;
    const resultado = calcula(contenido);
    if (!esPromesa(resultado)) {
      if (cacheable?.(resultado) !== false) this.guardar(contenido, resultado);
      return resultado;
    }
    const compartida = resultado.then(
      (valor) => {
        this.enVuelo.delete(clave);
        if (cacheable?.(valor) !== false) this.guardar(contenido, valor);
        return valor;
      },
      (error: unknown) => {
        this.enVuelo.delete(clave);
        throw error;
      },
    );
    this.enVuelo.set(clave, compartida);
    return compartida;
  }

  stats(): CarryoverStats {
    return {
      aciertos: this.aciertos,
      fallos: this.fallos,
      coalescidas: this.coalescidas,
    };
  }

  get size(): number {
    return this.entradas.size;
  }
}

function esPromesa<T>(x: Promise<T> | T): x is Promise<T> {
  return (
    x != null &&
    (typeof x === "object" || typeof x === "function") &&
    typeof (x as { then?: unknown }).then === "function"
  );
}

/**
 * Batch carry-over: N contents, ONE call to the expensive pass, and only for
 * the contents the memo does not already hold.
 *
 * Es el «N definiciones cuestan una petición, no N» del pase crux de Graft,
 * generalizado: el consumidor previsto son los resúmenes de evidencia de F6
 * (resumir 40 fragmentos de un documento en UNA llamada, y en la siguiente
 * petición re-resumir solo los fragmentos que cambiaron).
 *
 * Contrato con `procesa`: recibe los contenidos sucios DEDUPLICADOS y en su
 * orden de primera aparición, y tiene que devolver exactamente un resultado
 * por sucio. Un desajuste de longitud es un error del transformador y se
 * lanza — memorizar resultados desalineados corrompería la caché en silencio.
 */
export async function carryoverEnLote<T>(
  contenidos: readonly string[],
  procesa: (sucios: readonly string[]) => Promise<readonly T[]> | readonly T[],
  cache: CarryoverPorHash<T>,
): Promise<T[]> {
  const sucios: string[] = [];
  const vistos = new Set<string>();
  for (const contenido of contenidos) {
    if (vistos.has(contenido)) continue;
    vistos.add(contenido);
    if (cache.inspeccionar(contenido)?.estado !== "ready") sucios.push(contenido);
  }
  if (sucios.length > 0) {
    const resultados = await procesa(sucios);
    if (resultados.length !== sucios.length) {
      throw new Error(
        `carryoverEnLote: el transformador devolvió ${resultados.length} resultados para ${sucios.length} contenidos`,
      );
    }
    sucios.forEach((contenido, i) => cache.guardar(contenido, resultados[i]!));
  }
  return contenidos.map((contenido) => {
    const entrada = cache.inspeccionar(contenido);
    if (entrada == null) {
      // Solo alcanzable si `procesa` tocó la caché por debajo; mejor un error
      // claro que un `undefined` disfrazado de resultado.
      throw new Error("carryoverEnLote: contenido sin resultado tras procesar");
    }
    return entrada.valor;
  });
}

/**
 * A Compressor whose repeated inputs compress once.
 *
 * La compresión es función pura del texto (más ratio y spans protegidos), así
 * que servir el resultado anterior ante una entrada IDÉNTICA es correcto por
 * construcción — también entre peticiones y tenants distintos: los dos ya
 * tienen el texto entero en la mano, aquí no viaja nada que no trajeran.
 *
 * Solo se recuerdan resultados útiles (`fidelityPassed` y no `skipped`): un
 * `skipped` puede deberse a política transitoria y un fallo de fidelidad no
 * merece quedarse. El tope es más bajo que el del memo genérico porque cada
 * entrada carga un texto comprimido entero, no un vector.
 */
export function compresorConCarryover(
  inner: Compressor,
  opts: { maxEntradas?: number } = {},
): Compressor {
  const cache = new CarryoverPorHash<CompressionResult>({
    maxEntradas: opts.maxEntradas ?? 256,
  });
  return {
    async compress(req) {
      const material = [
        String(req.targetRatio ?? ""),
        (req.protectedSpans ?? [])
          .map((s) => `${s.id}\u0001${s.text}`)
          .join("\u0002"),
        req.text,
      ].join("\u0000");
      return cache.obtener(
        material,
        () => inner.compress(req),
        (valor) => valor.fidelityPassed && !valor.skipped,
      );
    },
  };
}
