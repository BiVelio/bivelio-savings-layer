/**
 * EL AHORRO NETO DE LA REBAJA DE TTL · los fallos de caché que ella provoca.
 *
 * La rebaja de TTL (tarifa.ts) baja una escritura de caché de 1h (2×) a 5 min
 * (1,25×). Esa prima ahorrada es el BRUTO. Pero una entrada de 5 min caduca
 * antes: si el turno siguiente del hilo llega pasados 5 min (y antes de 1h),
 * lo que con 1h se habría LEÍDO (0,1×) hay que volver a ESCRIBIRLO. Ese
 * sobrecoste lo causa la palanca y hasta la 0.5.0 nadie lo restaba: el panel
 * enseñaba el bruto. El banco del 2026-10-03 (docs/benchmarks/2026-10-03/ttl.md)
 * midió que los fallos se comen alrededor de un 30 % del bruto.
 *
 * Este módulo lleva, por hilo, lo que el turno anterior dejó EN RIESGO, y dice
 * cuántos tokens perdió el turno actual por culpa de la rebaja. Dos caminos:
 *
 *  · APLICADA (licencias de pago): la rebaja viajó de verdad y el fallo
 *    OCURRIÓ. Se observa en el usage: el turno leyó menos de lo que compartía
 *    con el anterior y lo reescribió.
 *  · EN SOMBRA (licencia Medir): la petición viajó intacta a 1h y el fallo NO
 *    ocurrió. Es el contrafactual del banco (benchmarks/ttl/nucleo.ts), con la
 *    misma aritmética: de lo que este turno leyó, la parte que el turno
 *    anterior habría dejado bajo una entrada de 5 min ya caducada.
 *
 * Puro y en memoria: no persiste, no viaja. Si no se puede saber (el turno
 * anterior aún no ha terminado, o no hay turno anterior), no hay fallo que
 * restar — y tampoco se inventa.
 */
import type { Huella } from "./tarifa.js";

export const TTL_5M_MS = 5 * 60 * 1000;
export const TTL_1H_MS = 60 * 60 * 1000;

/** El conteo de caché de un turno, tal como lo declaró el proveedor. */
export interface UsoDeCache {
  cacheLeida: number;
  /** Escritura TOTAL (5m + 1h). */
  cacheEscrita: number;
  /** La parte de la escritura con TTL 1h. */
  cacheEscrita1h: number;
}

/** Lo que un turno ya terminado dejó cacheado. */
interface Cierre {
  /** Tokens del prefijo cacheado tras el turno (lectura + escritura). */
  cubierto: number;
  /**
   * APLICADA: tokens que el turno escribió a 5 min (lo que puede caducar).
   * SOMBRA: `cubierto − base1h`, lo que la rebaja habría dejado a 5 min.
   */
  enRiesgo: number;
  /** SOMBRA: de `cubierto`, lo que sigue bajo una entrada de 1h viva. */
  base1h: number;
}

/** Un turno de un hilo: se abre al llegar la petición y se cierra con su usage. */
export interface TurnoTtl {
  readonly inicioMs: number;
  readonly huella: Huella;
  /** ¿La rebaja se aplicó (o, en sombra, se habría aplicado) a este turno? Un 400 reintentado intacto la apaga. */
  rebajado: boolean;
  /**
   * ¿El turno anterior del hilo, tal como estaba cuando llegó este? `null` si
   * no lo hay, si caducó (más de 1h) o si aún no había terminado.
   */
  readonly previo: (Cierre & { rebajado: boolean; atribuible: boolean }) | null;
  /** Milisegundos desde la llegada del turno anterior. */
  readonly huecoMs: number;
  /** Fracción (0–1) del cuerpo del turno anterior que este turno conserva como prefijo. */
  readonly compartido: number;
  /** Lo rellena `cerrar`. */
  cierre: (Cierre & { atribuible: boolean }) | null;
}

/**
 * Qué fracción del cuerpo ANTERIOR (en bytes) sigue siendo prefijo del actual.
 * 0 si cambiaron system o tools (el prefijo se rompe en el primer byte). Es la
 * otra cara de `fraccionNueva` (tarifa.ts), medida sobre el turno anterior: lo
 * que, con la entrada viva, este turno habría leído de él.
 */
export function fraccionCompartida(anterior: Huella, actual: Huella): number {
  if (anterior.system !== actual.system || anterior.tools !== actual.tools) return 0;
  let total = anterior.bytesFijos;
  for (const b of anterior.bytes) total += b;
  if (total <= 0) return 0;
  let k = 0;
  while (k < anterior.mensajes.length && k < actual.mensajes.length && anterior.mensajes[k] === actual.mensajes[k]) k++;
  let comunes = anterior.bytesFijos;
  for (let i = 0; i < k; i++) comunes += anterior.bytes[i] ?? 0;
  return Math.min(1, comunes / total);
}

/** ¿El turno llega en la ventana en que una entrada de 5 min caducó y una de 1h seguiría viva? */
const enVentanaDeFallo = (t: TurnoTtl): boolean =>
  t.previo !== null && t.previo.rebajado && t.huecoMs > TTL_5M_MS && t.huecoMs <= TTL_1H_MS;

/**
 * APLICADA · tokens que este turno tuvo que REESCRIBIR porque la entrada de
 * 5 min que dejó la rebaja del turno anterior caducó. Observado, no supuesto:
 *
 *   esperados = lo que el turno anterior dejó cacheado × lo que este conserva
 *   perdidos  = esperados − lo que de verdad leyó
 *
 * acotado por lo que el turno anterior escribió a 5 min (solo eso pudo caducar)
 * y por lo que este turno escribió (no se reescribe más de lo escrito). Si la
 * caché acertó, leyó lo esperado y sale 0.
 *
 * Solo si la rebaja del turno anterior era ATRIBUIBLE (se acreditó limpia). Con
 * marcas de 5 min del cliente o herramientas de servidor el usage no dice qué
 * escritura era nuestra: ni se acreditó el ahorro ni se resta el fallo.
 */
export function perdidosConRebajaAplicada(turno: TurnoTtl, uso: UsoDeCache): number {
  if (!enVentanaDeFallo(turno) || turno.previo === null || !turno.previo.atribuible) return 0;
  const esperados = turno.previo.cubierto * turno.compartido;
  const perdidos = Math.min(esperados - uso.cacheLeida, turno.previo.enRiesgo, uso.cacheEscrita);
  return perdidos > 0 ? Math.floor(perdidos) : 0;
}

/**
 * SOMBRA · tokens que este turno LEYÓ (viajó intacto, a 1h) y que con la
 * rebaja habría tenido que reescribir: lo que leyó del turno anterior menos lo
 * que seguía bajo una entrada de 1h. La regla de benchmarks/ttl/nucleo.ts.
 */
export function perdidosConRebajaEnSombra(turno: TurnoTtl, uso: UsoDeCache): number {
  if (!enVentanaDeFallo(turno) || turno.previo === null) return 0;
  const perdidos = Math.min(uso.cacheLeida, turno.previo.cubierto) - turno.previo.base1h;
  return perdidos > 0 ? perdidos : 0;
}

/**
 * El DINERO de un fallo: los tokens perdidos pasan de lectura a escritura. Se
 * pagan a la prima de escritura de ESTE turno (`primaEscritura`: 1,25× si va a
 * 5 min, 2× si va a 1h) en vez de al precio de lectura. Nunca negativo.
 */
export function costeDeFallo(entrada: {
  perdidos: number;
  inputPer1k: number;
  /** Precio de lectura de caché por 1K; sin él, el 10 % de la entrada (la casa en Anthropic). */
  cachedInputPer1k?: number | undefined;
  primaEscritura: number;
}): number {
  const { perdidos, inputPer1k, primaEscritura } = entrada;
  if (perdidos <= 0 || inputPer1k <= 0) return 0;
  const lectura = entrada.cachedInputPer1k ?? inputPer1k * 0.1;
  return Math.max(0, (perdidos / 1_000) * (inputPer1k * primaEscritura - lectura));
}

/**
 * La memoria de turnos por hilo. Acotada como `MemoriaDePrefijos`: por tamaño
 * (LRU) y por edad (pasada 1h no queda caché que perder).
 */
export class MemoriaDeTurnos {
  private readonly hilos = new Map<string, TurnoTtl>();

  constructor(private readonly maxEntradas = 512) {}

  /** Abre el turno de este hilo y lo deja como «el anterior» del siguiente. */
  abrir(clave: string, huella: Huella, ahoraMs: number, rebajado: boolean): TurnoTtl {
    const anterior = this.hilos.get(clave);
    const hueco = anterior === undefined ? Infinity : ahoraMs - anterior.inicioMs;
    const vivo = anterior !== undefined && anterior.cierre !== null && hueco <= TTL_1H_MS ? anterior : null;
    const turno: TurnoTtl = {
      inicioMs: ahoraMs,
      huella,
      rebajado,
      previo: vivo !== null && vivo.cierre !== null ? { ...vivo.cierre, rebajado: vivo.rebajado } : null,
      huecoMs: hueco,
      compartido: vivo !== null ? fraccionCompartida(vivo.huella, huella) : 0,
      cierre: null,
    };
    this.hilos.delete(clave);
    this.hilos.set(clave, turno);
    while (this.hilos.size > this.maxEntradas) {
      const masViejo = this.hilos.keys().next();
      if (masViejo.done === true) break;
      this.hilos.delete(masViejo.value);
    }
    return turno;
  }

  get tamano(): number {
    return this.hilos.size;
  }
}

/**
 * Cierra un turno con el usage que declaró el proveedor.
 *
 * APLICADA (`sombra: false`): en riesgo queda lo que el turno escribió a 5 min,
 * y solo si la rebaja se aplicó. `atribuible` = la rebaja se acreditó limpia.
 *
 * SOMBRA (`sombra: true`): el estado del banco. Tras un turno NO rebajado todo
 * el prefijo vuelve a estar bajo 1h; tras uno rebajado, solo lo que leyó de
 * una entrada de 1h viva (`perdidos` ya descontados).
 */
export function cerrarTurno(
  turno: TurnoTtl,
  uso: UsoDeCache,
  opciones: { sombra: boolean; atribuible: boolean; perdidos: number },
): void {
  const cubierto = uso.cacheLeida + uso.cacheEscrita;
  if (!opciones.sombra) {
    const escrita5m = Math.max(0, uso.cacheEscrita - uso.cacheEscrita1h);
    const enRiesgo = turno.rebajado ? escrita5m : 0;
    turno.cierre = { cubierto, enRiesgo, base1h: cubierto - enRiesgo, atribuible: opciones.atribuible };
    return;
  }
  const lecturaSimulada = Math.max(0, uso.cacheLeida - opciones.perdidos);
  let base1h: number;
  if (!turno.rebajado) base1h = cubierto;
  else if (turno.previo !== null && turno.previo.rebajado && turno.huecoMs <= TTL_5M_MS) {
    base1h = Math.min(lecturaSimulada, turno.previo.base1h);
  } else base1h = lecturaSimulada;
  turno.cierre = { cubierto, enRiesgo: cubierto - base1h, base1h, atribuible: true };
}
