import { sha256 } from "../util/hash.js";
import { stableStringify } from "../canonicalization/canonicalize.js";
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
 * MÓDULO INTERNO A PROPÓSITO: no se re-exporta desde el barrel de src/cache ni
 * desde src/index.ts, así que HOY no es API de clientes. La superficie pública
 * (envolver un compresor propio, el lote de F6, stats() enchufado a
 * telemetría) se abre cuando llegue su consumidor real — F4/F6 — con JSDoc en
 * inglés y documentación; hasta entonces los contratos los fijan los tests.
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

/**
 * An in-flight computation. `invalidado` is flipped by invalidar() so a result
 * that was computed BEFORE the invalidation can only land as a stale hint,
 * never as a live value.
 */
interface Vuelo<T> {
  promesa: Promise<T>;
  invalidado: boolean;
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
  private readonly enVuelo = new Map<string, Vuelo<T>>();
  private readonly maxEntradas: number;
  private readonly version: string;
  private aciertos = 0;
  private fallos = 0;
  private coalescidas = 0;

  constructor(opts: { maxEntradas?: number; version?: string } = {}) {
    // El tope no es decorativo: un embedding son ~2 KB y un texto comprimido
    // puede ser grande. Sin tope, "memoizar" se convierte en "fugar memoria a
    // ritmo de tráfico". Y el mínimo es 1: un tope de 0 sobrevivía al `??` y
    // hacía que guardar expulsara lo recién guardado — pie de escopeta, no
    // configuración.
    this.maxEntradas = Math.max(1, opts.maxEntradas ?? 2048);
    this.version = opts.version ?? "";
  }

  private clave(contenido: string): string {
    // Prefijo de LONGITUD, no separador: hace la frontera versión/contenido
    // inyectiva con solo caracteres imprimibles. Un separador elegido a mano
    // puede aparecer dentro de la versión y fabricar la clave de otra entrada
    // (y los bytes de control crudos en el fuente ya mordieron una vez en este
    // repo).
    return sha256(`${this.version.length}:${this.version}${contenido}`);
  }

  private inspeccionarPorClave(
    clave: string,
  ): { estado: EstadoDeEntrada; valor: T } | null {
    const entrada = this.entradas.get(clave);
    if (!entrada) return null;
    if (entrada.estado === "ready") {
      // Map conserva orden de inserción: borrar y reinsertar es el toque LRU.
      this.entradas.delete(clave);
      this.entradas.set(clave, entrada);
    }
    return { estado: entrada.estado, valor: entrada.valor };
  }

  /** Current entry for a content, or null. A hit refreshes LRU recency. */
  inspeccionar(contenido: string): { estado: EstadoDeEntrada; valor: T } | null {
    return this.inspeccionarPorClave(this.clave(contenido));
  }

  private guardarPorClave(
    clave: string,
    valor: T,
    estado: EstadoDeEntrada = "ready",
  ): void {
    this.entradas.delete(clave);
    this.entradas.set(clave, { valor, estado });
    while (this.entradas.size > this.maxEntradas) {
      const masVieja = this.entradas.keys().next().value;
      if (masVieja == null) break;
      this.entradas.delete(masVieja);
    }
  }

  /** Store a live value for a content, evicting the oldest entry over the cap. */
  guardar(contenido: string, valor: T): void {
    this.guardarPorClave(this.clave(contenido), valor);
  }

  /**
   * Mark a content's entry stale, keeping the old value as a hint. Returns
   * whether there was anything to invalidate — an in-flight computation counts.
   *
   * Un cálculo EN VUELO también se invalida: se marca y se suelta del mapa, de
   * forma que (a) su resultado, que es pre-invalidación, solo puede aterrizar
   * como pista stale y nunca pisa un valor fresco posterior, y (b) un lector
   * nuevo arranca un cálculo limpio en vez de coalescer sobre el viejo. Sin
   * esto, una invalidación que llegara en pleno vuelo se perdía en silencio.
   */
  invalidar(contenido: string): boolean {
    const clave = this.clave(contenido);
    const vuelo = this.enVuelo.get(clave);
    if (vuelo) {
      vuelo.invalidado = true;
      this.enVuelo.delete(clave);
    }
    const entrada = this.entradas.get(clave);
    if (entrada) entrada.estado = "stale";
    return entrada != null || vuelo != null;
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
   * compresión que salió `skipped`, o un embedding vacío de un proveedor
   * degradado): se devuelve igual, pero no se recuerda.
   */
  obtener(
    contenido: string,
    calcula: (contenido: string) => Promise<T> | T,
    cacheable?: (valor: T) => boolean,
  ): Promise<T> | T {
    // La clave se computa UNA sola vez. Importa: sobre textos de cientos de KB
    // el sha256 en JS puro es el coste dominante de este camino, y computarla
    // en inspeccionar, aquí y en guardar eran dos pases de más por miss.
    const clave = this.clave(contenido);
    const previa = this.inspeccionarPorClave(clave);
    if (previa?.estado === "ready") {
      this.aciertos += 1;
      return previa.valor;
    }
    const volando = this.enVuelo.get(clave);
    if (volando) {
      this.coalescidas += 1;
      return volando.promesa;
    }
    this.fallos += 1;
    const resultado = calcula(contenido);
    if (!esPromesa(resultado)) {
      if (cacheable?.(resultado) !== false) this.guardarPorClave(clave, resultado);
      return resultado;
    }
    const vuelo: Vuelo<T> = { promesa: resultado, invalidado: false };
    const compartida = resultado.then(
      (valor) => {
        if (this.enVuelo.get(clave) === vuelo) this.enVuelo.delete(clave);
        if (cacheable?.(valor) !== false) {
          if (vuelo.invalidado) {
            // Aterrizaje pre-invalidación: como mucho refresca la PISTA. Si un
            // cálculo posterior ya dejó un valor fresco, no se toca.
            const actual = this.entradas.get(clave);
            if (!actual || actual.estado !== "ready") {
              this.guardarPorClave(clave, valor, "stale");
            }
          } else {
            this.guardarPorClave(clave, valor);
          }
        }
        return valor;
      },
      (error: unknown) => {
        if (this.enVuelo.get(clave) === vuelo) this.enVuelo.delete(clave);
        throw error;
      },
    );
    vuelo.promesa = compartida;
    this.enVuelo.set(clave, vuelo);
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
 *
 * Los valores del lote viajan por un mapa LOCAL y nunca se releen de la caché:
 * la LRU puede expulsar miembros del propio lote (un lote mayor que el tope —
 * exactamente el caso F6 de cientos de fragmentos) y un invalidar concurrente
 * puede dejarlos stale, y ninguna de las dos cosas puede costar resultados ya
 * pagados ni colar una pista stale como resultado vivo. La caché es un memo
 * del que este lote se BENEFICIA, no el canal por el que devuelve.
 */
export async function carryoverEnLote<T>(
  contenidos: readonly string[],
  procesa: (sucios: readonly string[]) => Promise<readonly T[]> | readonly T[],
  cache: CarryoverPorHash<T>,
): Promise<T[]> {
  const valores = new Map<string, T>();
  const sucios: string[] = [];
  const vistos = new Set<string>();
  for (const contenido of contenidos) {
    if (vistos.has(contenido)) continue;
    vistos.add(contenido);
    const entrada = cache.inspeccionar(contenido);
    if (entrada?.estado === "ready") valores.set(contenido, entrada.valor);
    else sucios.push(contenido);
  }
  if (sucios.length > 0) {
    const resultados = await procesa(sucios);
    if (resultados.length !== sucios.length) {
      throw new Error(
        `carryoverEnLote: el transformador devolvió ${resultados.length} resultados para ${sucios.length} contenidos`,
      );
    }
    sucios.forEach((contenido, i) => {
      const valor = resultados[i]!;
      cache.guardar(contenido, valor);
      valores.set(contenido, valor);
    });
  }
  return contenidos.map((contenido) => valores.get(contenido)!);
}

/**
 * A Compressor whose repeated inputs compress once.
 *
 * La compresión es función pura del texto (más ratio y spans protegidos), así
 * que servir el resultado anterior ante una entrada IDÉNTICA es correcto por
 * construcción. El AISLAMIENTO entre tenants no se resuelve aquí: el pipeline
 * mantiene un envoltorio POR TENANT — un memo compartido sería un oráculo
 * lateral (un acierto a ~0 ms delata que otro tenant envió el mismo contenido).
 *
 * Solo se recuerdan resultados útiles (`fidelityPassed`, no `skipped`) y que
 * quepan en el tope de BYTES por entrada: el memo guarda textos comprimidos
 * enteros, y sin ese tope 256 entradas de ~400 KB serían ~100 MB en una
 * instancia longeva. Un resultado enorme se devuelve igual — solo no se
 * recuerda.
 */
export function compresorConCarryover(
  inner: Compressor,
  opts: { maxEntradas?: number; maxBytesPorEntrada?: number } = {},
): Compressor {
  const cache = new CarryoverPorHash<CompressionResult>({
    maxEntradas: opts.maxEntradas ?? 256,
  });
  const maxBytes = opts.maxBytesPorEntrada ?? 256 * 1024;
  return {
    async compress(req) {
      // Codificación INYECTIVA de la identidad completa de la petición vía
      // stableStringify — el mismo patrón que usan las claves de caché del
      // resto del producto. Los separadores centinela elegidos a mano eran
      // colisionables por construcción: un span cuyo texto contuviera el
      // separador fabricaba la clave de OTRA petición y arrastraba su
      // fidelityPassed a un conjunto de spans distinto.
      const material = stableStringify({
        ratio: req.targetRatio ?? null,
        spans: (req.protectedSpans ?? []).map((s) => [s.id, s.text]),
        text: req.text,
      });
      return cache.obtener(
        material,
        () => inner.compress(req),
        (valor) =>
          valor.fidelityPassed &&
          !valor.skipped &&
          valor.compressed.length <= maxBytes,
      );
    },
  };
}
