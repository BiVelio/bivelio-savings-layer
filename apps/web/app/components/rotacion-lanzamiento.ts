import {
  CLAVE_LANZAMIENTO,
  PLATAFORMAS,
  barajar,
  esOrdenValido,
  filasDe,
  ordenPorDefecto,
  repartir,
  siguienteFronteraDe,
  type Plataforma,
  type Reparto,
} from "@/lib/plataformas-de-lanzamiento";

/**
 * LA ROTACIÓN DE ESTA CARGA, compartida por la franja y la tarjeta.
 *
 * Un almacén mínimo fuera de React (los dos componentes viven en sitios
 * distintos del árbol y tienen que moverse a la vez): el orden al azar de esta
 * carga, el paso del carrusel y el reloj. La franja y la tarjeta lo leen con
 * `useSyncExternalStore` y calculan lo suyo con `repartir`.
 *
 *   · El orden lo decide el guion en línea antes del primer pintado
 *     (`window.__lz.o`); aquí solo se recoge. Si no lo dejó (navegador sin
 *     hojas construidas), se baraja aquí.
 *   · El paso lo mueve el carrusel (`avanzar`, `irA`). En las páginas sin
 *     tarjeta nadie lo mueve: la franja se queda en la plataforma de la carga.
 *   · El reloj salta solo al cruzar la siguiente frontera del registro (una
 *     plataforma abre o cierra con la pestaña abierta) y al volver a la
 *     pestaña. Nunca retrocede.
 *   · `retener`: mientras el ratón o el foco están sobre la franja o la
 *     tarjeta, el carrusel no avanza (nadie quiere que el enlace que va a
 *     pulsar cambie bajo el cursor).
 */
export interface Rotacion {
  /** Las plataformas, en el orden de esta carga. */
  orden: string[];
  /** El paso del carrusel. */
  k: number;
  /** El reloj: el instante con el que se decide qué toca. */
  t: number;
  /** El instante de la carga: fija qué piezas siguen en la pila. */
  t0: number;
}

/** setTimeout guarda el retraso en un int32: por encima de ~24,8 días dispara al instante. */
const RETRASO_MAXIMO = 2 ** 31 - 1;

export interface Entorno {
  ahora: () => number;
  azar: () => number;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (id: unknown) => void;
  /** El orden que dejó el guion en línea, si lo dejó. */
  ordenDelGuion?: () => unknown;
}

export function crearRotacion(entorno: Entorno, lista: readonly Plataforma[] = PLATAFORMAS) {
  const filas = filasDe(lista);
  const oyentes = new Set<() => void>();
  const retenciones = new Set<string>();
  const dejado = entorno.ordenDelGuion?.();
  const t0 = entorno.ahora();
  let estado: Rotacion = { orden: esOrdenValido(dejado, lista) ? dejado : barajar(ordenPorDefecto(lista), entorno.azar), k: 0, t: t0, t0 };
  let id: unknown;

  const avisar = () => oyentes.forEach((f) => f());
  const cambiar = (parcial: Partial<Rotacion>) => {
    estado = { ...estado, ...parcial };
    avisar();
  };
  const reevaluar = () => {
    if (id !== undefined) entorno.clearTimeout(id);
    id = undefined;
    const ahora = entorno.ahora();
    // Un reloj atrasado (o roto) no devuelve una ventana que ya pasó.
    const t = Number.isNaN(ahora) ? estado.t : Math.max(estado.t, ahora);
    if (t !== estado.t) cambiar({ t });
    const frontera = siguienteFronteraDe(t, lista);
    if (frontera !== null) id = entorno.setTimeout(reevaluar, Math.min(Math.max(frontera - t + 1, 0), RETRASO_MAXIMO));
  };
  reevaluar();

  const reparto = (r: Rotacion = estado): Reparto => repartir(filas, r.t0, r.t, r.orden, r.k);

  return {
    leer: () => estado,
    suscribir: (f: () => void) => {
      oyentes.add(f);
      return () => {
        oyentes.delete(f);
      };
    },
    reparto,
    reevaluar,
    /** El carrusel da `pasos` pasos (negativos: hacia atrás). */
    avanzar: (pasos = 1) => cambiar({ k: estado.k + pasos }),
    /** Lleva la tarjeta a la plataforma `plataforma`, por el camino más corto hacia delante. */
    irA: (plataforma: string) => {
      const { enTarjeta, tarjeta } = reparto();
      const de = tarjeta === null ? -1 : enTarjeta.indexOf(tarjeta);
      const a = enTarjeta.indexOf(plataforma);
      if (a < 0 || a === de) return;
      cambiar({ k: estado.k + ((a - de + enTarjeta.length) % enTarjeta.length) });
    },
    retener: (quien: string, si: boolean) => {
      if (si) retenciones.add(quien);
      else retenciones.delete(quien);
    },
    retenida: () => retenciones.size > 0,
    cancelar: () => {
      if (id !== undefined) entorno.clearTimeout(id);
      id = undefined;
    },
  };
}

export type RotacionViva = ReturnType<typeof crearRotacion>;

let unica: RotacionViva | null = null;

/** La rotación de esta página (una por documento), o null en el servidor. Se crea la primera vez que se pide en el navegador. */
export function rotacion(): RotacionViva | null {
  if (typeof window === "undefined") return null;
  if (!unica) {
    const creada = crearRotacion({
      ahora: () => Date.now(),
      azar: () => Math.random(),
      setTimeout: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeout: (id) => window.clearTimeout(id as number),
      ordenDelGuion: () => (window as unknown as Record<string, { o?: unknown } | undefined>)[CLAVE_LANZAMIENTO]?.o,
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") creada.reevaluar();
    });
    unica = creada;
  }
  return unica;
}

const sinSuscripcion = () => () => {};
/** Para `useSyncExternalStore`: suscripción, foto del navegador y foto del servidor (null: el reparto del servidor). */
export const suscribirRotacion = (f: () => void) => rotacion()?.suscribir(f) ?? sinSuscripcion();
export const leerRotacion = (): Rotacion | null => rotacion()?.leer() ?? null;
export const leerRotacionEnServidor = (): Rotacion | null => null;
