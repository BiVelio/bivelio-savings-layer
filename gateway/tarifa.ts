/**
 * LA PALANCA DE TARIFA — el dinero que se ahorra sin tocar un solo token.
 *
 * El corpus del espía (3.305 peticiones reales, $279,23, 921 M de tokens,
 * 30-08 → 06-09) dice dónde está de verdad la factura:
 *
 *     lectura de caché   $137,23   49,1 %  ·  897,3 M tok  (97,4 %)
 *     escritura 1h        $68,05   24,4 %  ·   14,9 M tok   (1,6 %)
 *     salida              $46,36   16,6 %  ·    3,3 M tok   (0,4 %)
 *     escritura 5m        $24,31    8,7 %  ·    5,0 M tok   (0,5 %)
 *     entrada sin caché    $3,28    1,2 %  ·    0,8 M tok   (0,1 %)
 *
 * La ESCRITURA de caché se lleva un TERCIO del dinero con el 2 % de los
 * tokens, y casi toda es a TTL 1h — que Anthropic factura a 2× el precio de
 * entrada frente al 1,25× del TTL de 5 minutos. Claude Code pide 1h SIEMPRE
 * (12.580 apariciones de `"ttl":"1h"` en el corpus, CERO de `"5m"`).
 *
 * ¿Compra algo esa hora? Casi nunca. Medido sobre el mismo corpus, el hueco
 * hasta el turno siguiente es:
 *
 *     < 1 min   90,5 %      5-15 min   0,5 %
 *     1-3 min    5,9 %     15-60 min   0,4 %
 *     3-5 min    2,7 %        > 1 h    0,0 %
 *     ────────────────
 *     < 5 min   99,1 %
 *
 * En el 99,1 % de los turnos una entrada de 5 minutos habría bastado. Pagar
 * 2× por una hora de vida que se consume en menos de sesenta segundos es
 * dinero tirado: $22,37 de los $279,23 del corpus — el 8,0 % de la factura.
 *
 * Por qué esta palanca es DISTINTA de la elisión, y por qué importa tanto:
 *
 *  · NO cambia lo que el modelo lee. Ni un token entra, sale o se mueve. El
 *    riesgo de calidad no es «bajo»: es CERO por construcción.
 *  · Su ahorro es ARITMÉTICA, no contrafactual. La misma escritura, los
 *    mismos tokens que el proveedor declaró, dos tarifas públicas. No hay que
 *    imaginar «qué habría pasado si no» — que es justo lo que obliga a marcar
 *    la elisión como `estimated` (ver src/tokenizer/accounting.ts). Esta se
 *    cobra como `measured` con la cara bien alta.
 *
 * El riesgo real y su tamaño: si el hueco SÍ supera los 5 minutos, la entrada
 * caduca y el turno siguiente paga escritura (1,25×) donde habría pagado
 * lectura (0,1×). Un fallo cuesta 1,15× lo que un acierto ahorra 0,75× — es
 * decir, 1,53 aciertos pagan un fallo. Con 99,1 % de aciertos la esperanza es
 * +0,73× por unidad escrita. Aun así no se apuesta a ciegas: `decidirRebaja`
 * mantiene la 1h en cuanto la sesión demuestra que se enfría.
 *
 * Todo aquí es PURO y determinista, como la palanca de diales: ante cualquier
 * duda se devuelve null y el cuerpo original viaja intacto.
 */

/** Prima de escritura con TTL 5m (el defecto de Anthropic): 1,25× la entrada. */
export const PRIMA_5M = 1.25;
/** Prima de escritura con TTL 1h: 2× la entrada. */
export const PRIMA_1H = 2;

/**
 * Cuánto tiene que llevar callada una sesión para que NO se le rebaje el TTL.
 * Cuatro minutos, no cinco: si el turno anterior llegó a 4:30 el siguiente
 * cae peligrosamente cerca del borde de los 5, y el fallo cuesta más que el
 * acierto. Se cede el margen al lado seguro.
 */
export const UMBRAL_FRIO_MS = 4 * 60 * 1000;

/** Lo que la rebaja encontró y cambió en un cuerpo. */
export interface RebajaTtl {
  /** El cuerpo con los `ttl` de 1h reescritos a 5m. */
  cuerpo: Buffer<ArrayBuffer>;
  /** Cuántas marcas `cache_control` de 1h se reescribieron. */
  rebajadas: number;
  /**
   * Cuántas marcas pedían ya 5m ANTES de tocar nada. Si es > 0 el informe no
   * puede atribuirse la escritura entera (el usage no dice qué bloque escribió
   * qué tokens), así que el ahorro se declara 0 — quedarse corto por defecto,
   * la misma doctrina que la prima de escritura del medidor.
   */
  yaEran5m: number;
}

/** Dónde puede vivir una marca `cache_control` en un cuerpo /v1/messages. */
function marcarEn(nodo: unknown, cuenta: { rebajadas: number; yaEran5m: number }): void {
  if (nodo === null || typeof nodo !== "object") return;
  if (Array.isArray(nodo)) {
    for (const hijo of nodo) marcarEn(hijo, cuenta);
    return;
  }
  const obj = nodo as Record<string, unknown>;
  const cc = obj.cache_control;
  if (cc !== null && typeof cc === "object" && !Array.isArray(cc)) {
    const marca = cc as Record<string, unknown>;
    if (marca.ttl === "1h") {
      marca.ttl = "5m";
      cuenta.rebajadas++;
    } else if (marca.ttl === "5m") {
      cuenta.yaEran5m++;
    }
    // `cache_control` sin `ttl` = 5m implícito: es el defecto de la API. No se
    // toca (ya está en la tarifa barata) pero cuenta como 5m preexistente.
    else if (marca.ttl === undefined) cuenta.yaEran5m++;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (k === "cache_control") continue;
    if (v !== null && typeof v === "object") marcarEn(v, cuenta);
  }
}

/**
 * Reescribe a 5m los `cache_control.ttl === "1h"` del cuerpo.
 *
 * Devuelve `null` — «no tocar, reenviar intacto» — si:
 *  · el cuerpo llega comprimido (no se construye el camino de recompresión),
 *  · no parsea como JSON o no tiene forma de /v1/messages (model + messages),
 *  · no hay ni una sola marca de 1h que rebajar (no cambiar nada > cambiar
 *    para nada: así la coalescencia y el espía ven el cuerpo original).
 */
export function rebajarTtlDeCache(cuerpo: Buffer, codificacion?: string): RebajaTtl | null {
  if (codificacion !== undefined && codificacion !== "" && codificacion !== "identity") return null;
  try {
    const json = JSON.parse(cuerpo.toString("utf8")) as Record<string, unknown>;
    if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
    if (typeof json.model !== "string" || !Array.isArray(json.messages)) return null;
    const cuenta = { rebajadas: 0, yaEran5m: 0 };
    for (const clave of ["system", "messages", "tools"]) marcarEn(json[clave], cuenta);
    if (cuenta.rebajadas === 0) return null;
    return { cuerpo: Buffer.from(JSON.stringify(json), "utf8"), rebajadas: cuenta.rebajadas, yaEran5m: cuenta.yaEran5m };
  } catch {
    return null;
  }
}

/**
 * ¿Se rebaja el TTL de ESTA petición? Pura: el reloj y la memoria entran por
 * parámetro.
 *
 * · Sesión nueva (sin turno anterior): SÍ. Es la apuesta con mejor esperanza
 *   —el 99,1 % de los turnos encadena en menos de 5 min— y además la primera
 *   escritura de una sesión es la GORDA: dejarla a 1h por prudencia tiraría
 *   por la borda la mayor parte del premio.
 * · Sesión caliente (el turno anterior llegó hace menos de UMBRAL_FRIO_MS):
 *   SÍ. Es exactamente el caso que el corpus mide.
 * · Sesión que se demostró FRÍA (el hueco anterior pasó del umbral): NO. Aquí
 *   la hora sí compra vida y se paga con gusto.
 */
export function decidirRebaja(entrada: { ultimoTurnoMs?: number; ahoraMs: number; umbralMs?: number }): boolean {
  const { ultimoTurnoMs, ahoraMs, umbralMs = UMBRAL_FRIO_MS } = entrada;
  if (ultimoTurnoMs === undefined) return true;
  return ahoraMs - ultimoTurnoMs < umbralMs;
}

/**
 * El DINERO que la rebaja ahorró en esta petición. Aritmética exacta sobre el
 * usage que el proveedor ya declaró: los mismos tokens, dos tarifas públicas.
 *
 * `cacheEscrita5m` son los tokens que el proveedor facturó a 1,25× DESPUÉS de
 * nuestra rebaja; sin ella habrían ido a 2×. La diferencia (0,75× el precio de
 * entrada) es el ahorro, y no hay contrafactual que imaginar.
 *
 * Devuelve 0 —y no miente— cuando la atribución no es limpia: si el cliente ya
 * traía marcas de 5m propias, el usage no dice qué bloque escribió qué tokens.
 */
export function ahorroDeRebaja(entrada: {
  cacheEscrita5m: number;
  inputPer1k: number;
  yaEran5m: number;
}): number {
  const { cacheEscrita5m, inputPer1k, yaEran5m } = entrada;
  if (yaEran5m > 0 || cacheEscrita5m <= 0 || inputPer1k <= 0) return 0;
  return (cacheEscrita5m / 1_000) * inputPer1k * (PRIMA_1H - PRIMA_5M);
}

/**
 * El RITMO de cada sesión: cuándo se vio su último turno. Acotado por tamaño
 * —un gateway de escritorio no puede crecer sin techo— y por edad: una entrada
 * más vieja que la ventana ya no informa de nada (la caché que describía
 * caducó hace rato).
 */
export class RitmoDeSesiones {
  private readonly visto = new Map<string, number>();

  constructor(
    private readonly maxEntradas = 512,
    private readonly maxEdadMs = 60 * 60 * 1000,
  ) {}

  /** El último turno visto de esta sesión, o undefined si no hay o caducó. */
  ultimo(clave: string, ahoraMs: number): number | undefined {
    const t = this.visto.get(clave);
    if (t === undefined) return undefined;
    if (ahoraMs - t > this.maxEdadMs) {
      this.visto.delete(clave);
      return undefined;
    }
    return t;
  }

  /** Anota este turno. Reinserta para que el orden del Map sea LRU real. */
  anotar(clave: string, ahoraMs: number): void {
    this.visto.delete(clave);
    this.visto.set(clave, ahoraMs);
    while (this.visto.size > this.maxEntradas) {
      const masViejo = this.visto.keys().next();
      if (masViejo.done === true) break;
      this.visto.delete(masViejo.value);
    }
  }

  get tamano(): number {
    return this.visto.size;
  }
}
