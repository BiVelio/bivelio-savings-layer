/**
 * EL REPLAY DE LA PALANCA DE TTL — el núcleo puro (sin E/S).
 *
 * Qué mide: cuánto cambia la factura de Anthropic si el gateway rebaja las
 * escrituras de caché de 1h a 5m en los turnos donde buena parte del cuerpo es
 * nueva (gateway/tarifa.ts: `decidirRebaja`, `UMBRAL_REESCRITURA`). El NETO
 * resta a la prima ahorrada los fallos de caché que la propia rebaja provoca:
 * una entrada de 5m caduca antes que la de 1h que habría existido, y el turno
 * siguiente reescribe lo que habría leído.
 *
 * La DECISIÓN no se copia: `DecisorComoElGateway` llama a las funciones reales
 * de gateway/tarifa.ts (parsearMensajes, huellaDe, MemoriaDePrefijos,
 * fraccionNueva, decidirRebaja, rebajarTtlDeCache) en el mismo orden que
 * gateway/servidor.ts (la rama `cache_ttl_tuning` y la de sombra), con el reloj
 * de la captura en vez de Date.now(). Lo único escrito aquí a mano es la
 * clave del hilo — `${sessionId ?? "sin-sesion"}:${huella.system}`, la misma
 * plantilla que servidor.ts — porque vive inline en el servidor.
 *
 * Los PRECIOS salen de src/pricing/catalogo.ts (`precioDeLista`, el día de la
 * petición) y las primas de src/pricing/primas.ts vía tarifa.ts. Ni un número
 * de precio vive en este fichero: así no se repite la fe de erratas del 06-09
 * (un script con fable-5 al precio de Haiku 3.5 valoró el corpus en $279).
 *
 * EL MODELO DE CACHÉ (declarado, no descubierto — ver el informe):
 *
 *  · Línea base = lo que el proveedor FACTURÓ, petición a petición, con el
 *    usage real de la captura (Claude Code pide 1h siempre). No se simula.
 *  · Con la palanca, un turno rebajado paga su escritura de 1h a 1,25× en vez
 *    de 2× (la misma aritmética que `ahorroDeRebaja`).
 *  · RIESGO DENTRO DEL HILO (hilo = sesión + system, como el gateway): la
 *    entrada que deja un turno rebajado vive 5 min. Si el turno siguiente del
 *    hilo llega pasados 5 min (y antes de 1h, cuando la base también habría
 *    fallado), lo que habría leído de esa entrada —la parte del prefijo que no
 *    estaba ya bajo una entrada de 1h— se reescribe: lectura → escritura a la
 *    prima de ESE turno (2× si no se rebaja, 1,25× si también). Tras un turno
 *    no rebajado el prefijo entero vuelve a estar bajo 1h (la entrada se
 *    indexa por prefijo: la del turno más largo cubre a las anteriores).
 *  · RIESGO ENTRE HILOS (variante conservadora, `prefijoCompartido`): el
 *    primer turno de un hilo lee de una entrada que dejó OTRO hilo con las
 *    mismas tools + system (otra sesión, otro subagente del mismo tipo). Esa
 *    entrada la crea un arranque, y con la palanca los arranques van a 5m. Si
 *    el último arranque con ese prefijo fue hace más de su TTL, se pierde la
 *    lectura ENTERA del turno. Pesimista a propósito: supone que los turnos
 *    encadenados no refrescan la entrada corta del system y que todo lo leído
 *    venía de ella.
 *
 * Todo es determinista: mismo corpus, mismas cifras (el bootstrap lleva semilla).
 */
import {
  ahorroDeRebaja,
  decidirRebaja,
  fraccionNueva,
  huellaDe,
  MemoriaDePrefijos,
  parsearMensajes,
  PRIMA_1H,
  PRIMA_5M,
  rebajarTtlDeCache,
  type Huella,
} from "../../gateway/tarifa.js";
import { precioDeLista } from "../../src/pricing/catalogo.js";
import { mulberry32 } from "../stats.js";

export const MIN = 60_000;
export const TTL_5M_MS = 5 * MIN;
export const TTL_1H_MS = 60 * MIN;

// ─────────────────────────────────────────────────────────────────────────────
// 1 · La decisión, con el código real del gateway
// ─────────────────────────────────────────────────────────────────────────────

/** Lo que el gateway decidió sobre una petición. */
export interface DecisionTtl {
  /** Clave del hilo de caché (sesión + hash del system). */
  hilo: string;
  /** Hash de tools + system: el prefijo que comparten hilos distintos. */
  prefijoComun: string;
  /** Fracción del cuerpo nueva respecto al turno anterior del hilo. */
  fraccion: number;
  /** El gateway reescribiría el TTL (decidirRebaja && había marcas de 1h). */
  rebajada: boolean;
  /** Marcas de 5m que el cliente ya traía (si > 0, `ahorroDeRebaja` no acredita). */
  yaEran5m: number;
  /** Declara herramientas de servidor (tampoco se acredita). */
  herramientaDeServidor: boolean;
  /** El cuerpo no pasó `parsearMensajes`: el gateway lo reenvía intacto. */
  intacto: boolean;
}

/**
 * Lo que de un cuerpo NO depende del orden de llegada: su huella y lo que
 * `rebajarTtlDeCache` haría con él (pura sobre el cuerpo). Se calcula al leer
 * la captura y el cuerpo se suelta; null = el gateway lo reenviaría intacto.
 */
export interface CuerpoPreparado {
  huella: Huella;
  /** null: no hay ni una marca de 1h que rebajar. */
  rebaja: { rebajadas: number; yaEran5m: number; herramientaDeServidor: boolean } | null;
}

export function prepararCuerpo(cuerpo: Buffer): CuerpoPreparado | null {
  const json = parsearMensajes(cuerpo);
  if (json === null) return null;
  // La huella ANTES de reescribir (rebajarTtlDeCache marca `json` en sitio).
  const huella = huellaDe(json);
  const r = rebajarTtlDeCache(json);
  return {
    huella,
    rebaja: r === null ? null : { rebajadas: r.rebajadas, yaEran5m: r.yaEran5m, herramientaDeServidor: r.herramientaDeServidor },
  };
}

/**
 * La rama de la palanca de servidor.ts, en su orden, con el reloj inyectado.
 * Una instancia = un gateway (una MemoriaDePrefijos compartida por todos los
 * hilos). Hay que llamarla en orden de LLEGADA: la captura graba al terminar
 * cada respuesta, así que el replay ordena por `at` antes de decidir.
 */
export class DecisorComoElGateway {
  private readonly memoria = new MemoriaDePrefijos();

  decidir(prep: CuerpoPreparado | null, sessionId: string | undefined, ahoraMs: number): DecisionTtl {
    if (prep === null) {
      return { hilo: `${sessionId ?? "sin-sesion"}:?`, prefijoComun: "?", fraccion: 1, rebajada: false, yaEran5m: 0, herramientaDeServidor: false, intacto: true };
    }
    const { huella, rebaja } = prep;
    const hilo = `${sessionId ?? "sin-sesion"}:${huella.system}`;
    const anterior = this.memoria.ultima(hilo, ahoraMs);
    this.memoria.anotar(hilo, huella, ahoraMs);
    const fraccion = fraccionNueva(anterior, huella);
    const rebajada = decidirRebaja({ fraccionNueva: fraccion }) && rebaja !== null;
    return {
      hilo,
      prefijoComun: `${huella.tools}:${huella.system}`,
      fraccion,
      rebajada,
      yaEran5m: rebajada ? rebaja!.yaEran5m : 0,
      herramientaDeServidor: rebajada ? rebaja!.herramientaDeServidor : false,
      intacto: false,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2 · La simulación de la factura
// ─────────────────────────────────────────────────────────────────────────────

/** Tokens del usage que el proveedor declaró. */
export interface UsoTtl {
  entrada: number;
  lectura: number;
  escritura5m: number;
  escritura1h: number;
  /** Escritura sin desglose por TTL: se factura (y se simula) a 5m, sin ahorro. */
  escrituraSinDesglose: number;
  salida: number;
}

/** Una petición ya decidida, sin contenido: lo único que el modelo necesita. */
export interface PeticionTtl {
  atMs: number;
  /** Id opaco de la sesión (el replay lo guarda HASHEADO). Cluster del bootstrap. */
  sesion: string;
  hilo: string;
  prefijoComun: string;
  modelo: string;
  uso: UsoTtl;
  rebajada: boolean;
  yaEran5m: number;
  herramientaDeServidor: boolean;
}

export interface OpcionesSimulacion {
  /** Añade el riesgo entre hilos (variante conservadora). */
  prefijoCompartido: boolean;
  /**
   * A qué prima se reescribe un fallo. "del-turno" (lo correcto): 2× si el
   * turno que falla no se rebaja, 1,25× si también. "5m": siempre 1,25×, la
   * aritmética del informe del 06-09 («un fallo cuesta 1,15× sobre lo gordo»),
   * solo para reproducirlo.
   */
  primaFallo?: "del-turno" | "5m";
}

/** El resultado de una petición, en USD a precio de lista. */
export interface FilaTtl {
  atMs: number;
  dia: string;
  sesion: string;
  hilo: string;
  modelo: string;
  /** Lo que facturó el proveedor (la línea base: siempre 1h). */
  costeBase: number;
  /** Prima ahorrada: escritura 1h a 1,25× en vez de 2× (si se rebajó). */
  ahorroPrima: number;
  /** Lo que `ahorroDeRebaja` acreditaría (el bruto que mide producción). */
  ahorroAcreditable: number;
  /** Sobrecoste de los fallos inducidos: lectura que pasa a escritura. */
  costeFallos: number;
  /** Tokens que la base leyó y la palanca tiene que reescribir. */
  tokensPerdidos: number;
  rebajada: boolean;
  /** La petición sufre un fallo inducido por la palanca. */
  fallo: boolean;
  /** El fallo viene de otro hilo (variante conservadora). */
  falloEntreHilos: boolean;
  /** Sin precio en el catálogo: fuera de las sumas. */
  sinPrecio: boolean;
  /** Tokens leídos de caché y escritos a 1h (los de la base). */
  tokensLectura: number;
  tokensEscritura1h: number;
  /** La prima de la hora de esta petición: el techo de lo que la palanca puede ahorrar. */
  primaDeLaHora: number;
}

export function diaDe(atMs: number): string {
  return new Date(atMs).toISOString().slice(0, 10);
}

interface PrecioTtl {
  entradaPorToken: number;
  lecturaPorToken: number;
  salidaPorToken: number;
}

function precioDe(modelo: string, atMs: number): PrecioTtl | null {
  const p = precioDeLista(modelo, atMs);
  if (p === undefined) return null;
  return {
    entradaPorToken: p.inputPer1k / 1000,
    // Sin lectura en la fila, la de la casa en Anthropic (10 %). Hoy toda fila de Claude la trae.
    lecturaPorToken: (p.cachedInputPer1k ?? p.inputPer1k * 0.1) / 1000,
    salidaPorToken: p.outputPer1k / 1000,
  };
}

/** Coste de lista de un usage tal como lo facturó el proveedor. */
export function costeDeUso(u: UsoTtl, p: PrecioTtl): number {
  return (
    u.entrada * p.entradaPorToken +
    u.lectura * p.lecturaPorToken +
    (u.escritura5m + u.escrituraSinDesglose) * p.entradaPorToken * PRIMA_5M +
    u.escritura1h * p.entradaPorToken * PRIMA_1H +
    u.salida * p.salidaPorToken
  );
}

interface EstadoHilo {
  ultimoMs: number;
  rebajado: boolean;
  /** Tokens del prefijo cacheado tras el último turno (lectura + escritura). */
  cubierto: number;
  /** De ellos, los que están bajo una entrada de 1h viva. */
  base1h: number;
}

interface EstadoPrefijo {
  ultimoMs: number;
  ttlMs: number;
}

/**
 * Reproduce la factura con la palanca, petición a petición, en orden de
 * llegada. Devuelve una fila por petición (las sin precio, marcadas).
 */
export function simular(peticiones: readonly PeticionTtl[], opciones: OpcionesSimulacion): FilaTtl[] {
  const orden = [...peticiones].sort((a, b) => a.atMs - b.atMs);
  const hilos = new Map<string, EstadoHilo>();
  const prefijos = new Map<string, EstadoPrefijo>();
  const filas: FilaTtl[] = [];

  for (const pet of orden) {
    const p = precioDe(pet.modelo, pet.atMs);
    const u = pet.uso;
    const fila: FilaTtl = {
      atMs: pet.atMs,
      dia: diaDe(pet.atMs),
      sesion: pet.sesion,
      hilo: pet.hilo,
      modelo: pet.modelo,
      costeBase: 0,
      ahorroPrima: 0,
      ahorroAcreditable: 0,
      costeFallos: 0,
      tokensPerdidos: 0,
      rebajada: pet.rebajada,
      fallo: false,
      falloEntreHilos: false,
      sinPrecio: p === null,
      tokensLectura: u.lectura,
      tokensEscritura1h: u.escritura1h,
      primaDeLaHora: p === null ? 0 : u.escritura1h * p.entradaPorToken * (PRIMA_1H - PRIMA_5M),
    };

    const s = hilos.get(pet.hilo);
    const hueco = s === undefined ? Infinity : pet.atMs - s.ultimoMs;
    let perdidos = 0;
    let entreHilos = false;

    // Riesgo dentro del hilo: la entrada de 5m del turno anterior caducó.
    if (s !== undefined && s.rebajado && hueco > TTL_5M_MS && hueco <= TTL_1H_MS) {
      perdidos = Math.max(0, Math.min(u.lectura, s.cubierto) - s.base1h);
    }

    // Riesgo entre hilos: arranque (para la caché) que leyó de la entrada de otro.
    const arranque = s === undefined || hueco > TTL_1H_MS;
    if (opciones.prefijoCompartido && arranque && u.lectura > 0) {
      const g = prefijos.get(pet.prefijoComun);
      if (g !== undefined) {
        const desde = pet.atMs - g.ultimoMs;
        // La base (1h) la habría tenido viva; la palanca la dejó caducar.
        if (desde <= TTL_1H_MS && desde > g.ttlMs) {
          perdidos = u.lectura;
          entreHilos = true;
        }
      }
    }

    const lecturaSim = u.lectura - perdidos;
    if (p !== null) {
      fila.costeBase = costeDeUso(u, p);
      if (pet.rebajada) {
        fila.ahorroPrima = u.escritura1h * p.entradaPorToken * (PRIMA_1H - PRIMA_5M);
        fila.ahorroAcreditable = ahorroDeRebaja({
          cacheEscrita5m: u.escritura1h,
          inputPer1k: p.entradaPorToken * 1000,
          yaEran5m: pet.yaEran5m,
          herramientaDeServidor: pet.herramientaDeServidor,
        });
      }
      if (perdidos > 0) {
        const prima = opciones.primaFallo === "5m" || pet.rebajada ? PRIMA_5M : PRIMA_1H;
        fila.costeFallos = perdidos * (p.entradaPorToken * prima - p.lecturaPorToken);
      }
    }
    fila.tokensPerdidos = perdidos;
    fila.fallo = perdidos > 0;
    fila.falloEntreHilos = entreHilos && perdidos > 0;

    // Estado del hilo tras este turno.
    const cubierto = u.lectura + u.escritura5m + u.escritura1h + u.escrituraSinDesglose;
    let base1h: number;
    if (!pet.rebajada) base1h = cubierto;
    else if (s !== undefined && s.rebajado && hueco <= TTL_5M_MS) base1h = Math.min(lecturaSim, s.base1h);
    else base1h = lecturaSim;
    hilos.set(pet.hilo, { ultimoMs: pet.atMs, rebajado: pet.rebajada, cubierto, base1h });

    // Estado del prefijo común: solo lo tocan los arranques.
    if (arranque) {
      const g = prefijos.get(pet.prefijoComun);
      const vivo = g !== undefined && pet.atMs - g.ultimoMs <= g.ttlMs && u.lectura > 0 && !entreHilos;
      prefijos.set(pet.prefijoComun, {
        ultimoMs: pet.atMs,
        ttlMs: vivo ? g.ttlMs : pet.rebajada ? TTL_5M_MS : TTL_1H_MS,
      });
    }

    filas.push(fila);
  }
  return filas;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3 · Agregados e intervalos
// ─────────────────────────────────────────────────────────────────────────────

export interface Agregado {
  peticiones: number;
  sesiones: number;
  dias: number;
  costeBase: number;
  ahorroPrima: number;
  ahorroAcreditable: number;
  costeFallos: number;
  neto: number;
  /** Neto sobre la factura base, en %. */
  netoPct: number;
  rebajas: number;
  fallos: number;
  fallosEntreHilos: number;
  tokensPerdidos: number;
  tokensLectura: number;
  tokensEscritura1h: number;
  /** De ellos, los escritos a 1h en turnos que la palanca rebaja. */
  tokensEscritura1hRebajados: number;
  /** Σ prima de la hora: lo máximo que cualquier política de TTL podría ahorrar. */
  primaDeLaHora: number;
  sinPrecio: number;
}

export function agregar(filas: readonly FilaTtl[]): Agregado {
  const conPrecio = filas.filter((f) => !f.sinPrecio);
  let costeBase = 0;
  let ahorroPrima = 0;
  let ahorroAcreditable = 0;
  let costeFallos = 0;
  let rebajas = 0;
  let fallos = 0;
  let fallosEntreHilos = 0;
  let tokensPerdidos = 0;
  let tokensLectura = 0;
  let tokensEscritura1h = 0;
  let tokensEscritura1hRebajados = 0;
  let primaDeLaHora = 0;
  for (const f of conPrecio) {
    primaDeLaHora += f.primaDeLaHora;
    tokensLectura += f.tokensLectura;
    tokensEscritura1h += f.tokensEscritura1h;
    if (f.rebajada) tokensEscritura1hRebajados += f.tokensEscritura1h;
    costeBase += f.costeBase;
    ahorroPrima += f.ahorroPrima;
    ahorroAcreditable += f.ahorroAcreditable;
    costeFallos += f.costeFallos;
    if (f.rebajada) rebajas++;
    if (f.fallo) fallos++;
    if (f.falloEntreHilos) fallosEntreHilos++;
    tokensPerdidos += f.tokensPerdidos;
  }
  const neto = ahorroPrima - costeFallos;
  return {
    peticiones: conPrecio.length,
    sesiones: new Set(conPrecio.map((f) => f.sesion)).size,
    dias: new Set(conPrecio.map((f) => f.dia)).size,
    costeBase,
    ahorroPrima,
    ahorroAcreditable,
    costeFallos,
    neto,
    netoPct: costeBase > 0 ? (neto / costeBase) * 100 : 0,
    rebajas,
    fallos,
    fallosEntreHilos,
    tokensPerdidos,
    tokensLectura,
    tokensEscritura1h,
    tokensEscritura1hRebajados,
    primaDeLaHora,
    sinPrecio: filas.length - conPrecio.length,
  };
}

export interface Intervalo {
  /** Por qué se remuestrea: "sesion" o "dia". */
  por: "sesion" | "dia";
  clusters: number;
  remuestreos: number;
  netoUsd: [number, number];
  netoPct: [number, number];
}

function percentil(ordenados: number[], q: number): number {
  if (ordenados.length === 0) return 0;
  const i = Math.min(ordenados.length - 1, Math.max(0, Math.floor(q * (ordenados.length - 1))));
  return ordenados[i]!;
}

/**
 * Bootstrap por CLUSTER (sesión o día): se remuestrean clusters enteros con
 * reemplazo y se recalculan el neto total y el neto sobre la factura (razón de
 * sumas). Percentiles 2,5 y 97,5. Semilla fija: mismo corpus, mismo intervalo.
 */
export function bootstrap(filas: readonly FilaTtl[], por: "sesion" | "dia", remuestreos = 10_000, semilla = 20261003): Intervalo {
  const grupos = new Map<string, { neto: number; base: number }>();
  for (const f of filas) {
    if (f.sinPrecio) continue;
    const k = por === "sesion" ? f.sesion : f.dia;
    const g = grupos.get(k) ?? { neto: 0, base: 0 };
    g.neto += f.ahorroPrima - f.costeFallos;
    g.base += f.costeBase;
    grupos.set(k, g);
  }
  const lista = [...grupos.values()];
  const n = lista.length;
  const rnd = mulberry32(semilla);
  const netos: number[] = [];
  const pcts: number[] = [];
  for (let b = 0; b < remuestreos && n > 0; b++) {
    let neto = 0;
    let base = 0;
    for (let i = 0; i < n; i++) {
      const g = lista[Math.floor(rnd() * n)]!;
      neto += g.neto;
      base += g.base;
    }
    netos.push(neto);
    pcts.push(base > 0 ? (neto / base) * 100 : 0);
  }
  netos.sort((a, b) => a - b);
  pcts.sort((a, b) => a - b);
  return {
    por,
    clusters: n,
    remuestreos,
    netoUsd: [percentil(netos, 0.025), percentil(netos, 0.975)],
    netoPct: [percentil(pcts, 0.025), percentil(pcts, 0.975)],
  };
}

/** Agrupa filas por una clave y agrega cada grupo. */
export function desglosar(filas: readonly FilaTtl[], clave: (f: FilaTtl) => string): Record<string, Agregado> {
  const grupos = new Map<string, FilaTtl[]>();
  for (const f of filas) {
    const k = clave(f);
    (grupos.get(k) ?? grupos.set(k, []).get(k)!).push(f);
  }
  return Object.fromEntries([...grupos.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, fs]) => [k, agregar(fs)]));
}
