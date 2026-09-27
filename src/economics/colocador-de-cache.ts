// EL COLOCADOR DE PUNTOS DE RUPTURA DE CACHÉ (`cacheBreakpoints: "auto"`).
//
// Interno: comentarios en `//`, nada de esto se reexporta. Lo usa el pipeline.
//
// ── LA PREGUNTA ─────────────────────────────────────────────────────────────
//
// Dónde escribir la caché de prefijo del proveedor para leer lo máximo y no
// pagar la prima de escritura sobre tramos que nadie vuelve a leer. Las reglas,
// leídas el 2026-09-27 en las páginas oficiales (fuentes en
// docs/investigacion/2026-09-27/breakpoints-de-cache.md):
//
//   · Anthropic escribe SOLO en los puntos de ruptura («writes happen only at
//     breakpoints»), hasta 4 por petición, y en cada punto busca hacia atrás
//     como mucho 20 bloques una entrada ya escrita. Escribir cuesta 1,25× (TTL
//     5 min) o 2× (TTL 1 h); leer, 0,10× (0,05× Opus 5.5, 0,025× Fable 5.1). La
//     entrada se refresca gratis cada vez que se lee. Con TTL mixtos, los de 1 h
//     van delante de los de 5 min.
//   · OpenAI, de GPT-5.6 en adelante, cobra la escritura a 1,25× y ofrece un
//     modo explícito: sin puntos no escribe nada, y lo que va detrás del último
//     punto se cobra a tarifa normal sin prima. En el modo implícito el punto va
//     al final del último mensaje elegible (la pregunta). TTL fijo de 30 min.
//
// ── LO QUE LA VERJA DE PREFIJO NO VEÍA ──────────────────────────────────────
//
// `VerjaDeCacheDePrefijo` aprende la tasa de aciertos POR HUELLA DEL PREFIJO
// ESTABLE (sistema + historial). En una conversación esa huella cambia en cada
// turno —el historial crece—, así que ninguna se repite: la verja pasa la vida
// en «exploring (0/8)» y marca siempre. Lo mismo en tráfico de un solo uso con
// contexto propio en el prefijo ([sistema, documento, acuse] + pregunta): cada
// petición estrena huella, se marca, se paga 1,25× sobre el documento y nadie
// lo relee. La verja no puede apagarse porque nunca ve la misma huella dos
// veces. No es un fallo de la verja, es de granularidad: la pregunta «¿se
// reutiliza este tramo?» no es una propiedad de UN prefijo sino del TRÁFICO.
//
// ── LO QUE HACE ESTO ────────────────────────────────────────────────────────
//
// Un ESPEJO local de la coincidencia por prefijo del proveedor. Cada petición
// deja, por clase (modelo + herramientas + contrato + sistema), tres huellas:
//
//   S  el final de la cabecera de `system`   (lo que comparten todas)
//   H  el final del historial estable         (lo que va antes de la pregunta)
//   T  el final del prompt entero             (lo que una continuación extiende)
//
// y cada petición nueva busca, mensaje a mensaje, cuáles de esas huellas son
// prefijo suyo. Eso MIDE, sin marcar nada y sin pagar un céntimo, con qué
// frecuencia y con qué hueco se reutiliza cada tramo. La verja de prefijo tiene
// que pagar 8 marcas para medir h porque el proveedor solo informa de aciertos
// sobre lo marcado; la reutilización de la TRAMA, en cambio, se ve desde aquí.
//
// Con eso se decide, con los equilibrios de siempre:
//
//   · la COLA (punto en el último bloque) solo si las continuaciones superan el
//     equilibrio: p > (w − 1)/(w − r) = 0,25/1,15 ≈ 21,7 % con Anthropic 5 min;
//   · el HISTORIAL (punto antes de la pregunta) solo si ese tramo se reutiliza
//     por encima del mismo equilibrio; si no, el punto baja a la cabecera;
//   · el TTL de 1 h solo si lo que ahorra (releer todo el prefijo en vez de
//     reescribirlo cuando el hueco cae entre 5 min y 1 h) supera lo que cuesta
//     (0,75× sobre lo que ESTA petición escribe). Es la regla que el corpus del
//     gateway midió al revés (gateway/tarifa.ts): un fallo se paga sobre lo que
//     se LEE, un acierto se gana sobre lo que se ESCRIBE;
//   · en OpenAI GPT-5.6+, el modo explícito (ningún punto en la pregunta) solo
//     si las continuaciones en 30 min no llegan al equilibrio.
//
// Y lo que dice el espejo no se cree a ciegas: cuando predice que una petición
// va a leer la entrada que escribió el último punto de otra, el CONTADOR DEL
// PROVEEDOR lo confirma o no (lectura de ahora ≥ lectura+escritura de entonces).
// Si menos de la mitad de las predicciones se confirman, la clase vuelve a la
// colocación fija y la traza dice por qué.
//
// Lo que NUNCA hace: marcar más que la colocación fija sin muestras. Hasta
// reunir `muestrasMinimas` resoluciones, la decisión es la de siempre (cabecera
// + historial, sin cola, 5 min). Observar no cuesta nada, así que no hace falta
// explorar pagando.

import type { ChatMessage } from "../contracts/types.js";
import type { CacheTier } from "./cache-tier.js";

/** El TTL de un punto de ruptura de Anthropic. OpenAI no lo elige (30 min fijo). */
export type TtlDeCache = "5m" | "1h";

/** Las ventanas que se miden, en ms: 5 min y 1 h (Anthropic) y 30 min (OpenAI GPT-5.6+). */
export const VENTANAS = { "5m": 5 * 60_000, "30m": 30 * 60_000, "1h": 60 * 60_000 } as const;
type Ventana = keyof typeof VENTANAS;
const ORDEN_VENTANAS: readonly Ventana[] = ["5m", "30m", "1h"];

/** El prefijo que el proveedor recorre hacia atrás desde cada punto (Anthropic): 20 posiciones. */
export const VENTANA_DE_BUSQUEDA = 20;

// ── Huellas encadenadas ─────────────────────────────────────────────────────
//
// No es SHA-256 a propósito: se calcula una por MENSAJE en cada petición y el
// SHA-256 del paquete es JavaScript puro (sirve en navegador y edge). Dos
// cyrb53 con semillas distintas dan ~106 bits; con unos pocos miles de entradas
// vivas la probabilidad de colisión es del orden de 1e-20. Una colisión solo
// movería una ESTADÍSTICA de reutilización, nunca una factura: lo que se cobra
// sale del contador del proveedor.

function cyrb53(str: string, semilla: number): number {
  let h1 = 0xdeadbeef ^ semilla;
  let h2 = 0x41c6ce57 ^ semilla;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

function huella(texto: string): string {
  return cyrb53(texto, 0).toString(36) + "." + cyrb53(texto, 0x9e3779b9).toString(36);
}

// Todo lo que el adaptador pone en el cable a partir de un mensaje: rol,
// nombre, id de llamada y llamadas a herramienta, además del texto. Lo que no
// viaja (`metadata`) no entra.
function textoDelMensaje(m: ChatMessage): string {
  const llamadas = m.toolCalls?.length
    ? m.toolCalls.map((c) => `${c.id ?? ""}\u0003${c.name}\u0003${c.arguments}`).join("\u0004")
    : "";
  return `${m.role}\u0001${m.name ?? ""}\u0001${m.toolCallId ?? ""}\u0001${llamadas}\u0001${m.content}`;
}

/**
 * `h[k]` es la huella de los `k` primeros mensajes, encadenada desde `raiz`
 * (modelo, herramientas y contrato: lo que va delante de los mensajes en el
 * cable). `h[0]` es la de la raíz sola. Longitud `mensajes.length + 1`.
 */
export function huellasDePrefijos(raiz: string, mensajes: readonly ChatMessage[]): string[] {
  const h = [huella(`bvsala-prefijo\u0000${raiz}`)];
  for (const m of mensajes) h.push(huella(`${h[h.length - 1]}\u0002${textoDelMensaje(m)}`));
  return h;
}

/** Cuántos mensajes iniciales son `system`: la cabecera que la API de Mensajes iza a `system`. */
export function cabeceraDeSistema(mensajes: readonly ChatMessage[]): number {
  let n = 0;
  while (n < mensajes.length && mensajes[n]!.role === "system") n += 1;
  return n;
}

// ── El espejo ───────────────────────────────────────────────────────────────

/** Los tres tramos que se observan. */
export type TipoDeTramo = "S" | "H" | "T";

interface Entrada {
  clase: string;
  tipo: TipoDeTramo;
  huella: string;
  /** Mensajes que cubre (la huella es la de `h[indice]`). */
  indice: number;
  escrita: number;
  /** Ventanas ya contadas (bit 0: 5m, 1: 30m, 2: 1h). */
  contadas: number;
  /** Se descartó por capacidad: no cuenta ni como reutilizada ni como no. */
  descartada: boolean;
  /**
   * Solo si fue el ÚLTIMO punto que se marcó en su petición y el proveedor
   * informó: lectura + escritura de caché de esa petición, o sea la posición de
   * ese punto en tokens DEL PROVEEDOR. Es lo que permite comprobar con su
   * contador, y sin estimar un solo token, que una continuación la leyó.
   */
  posicionDelProveedor?: number;
  /** TTL con el que se marcó (para no predecir un acierto que ya caducó). */
  ttl?: TtlDeCache;
}

interface Contador {
  /** Entradas cuya suerte en esta ventana ya se sabe. */
  resueltas: number;
  /** De ellas, las reutilizadas dentro de la ventana. */
  reutilizadas: number;
  /**
   * Solo tiene sentido en la de 1 h: reutilizadas DESPUÉS de 5 min. Se cuenta
   * aparte, sobre el MISMO denominador, porque restar la tasa de 5 min a la de
   * 1 h mezcla denominadores distintos: una entrada sin reutilizar se resuelve
   * a los 5 min en una y a la hora en la otra, y la resta sale inflada justo
   * en la primera hora (medido: un bucle de agente con pasos cada 4 s daba un
   * 1,8 % «después de 5 min» que no existía).
   */
  tardias: number;
}

type Contadores = Record<Ventana, Contador>;

function pendientesVacios(): Record<Ventana, number> {
  return { "5m": 0, "30m": 0, "1h": 0 };
}

function contadoresVacios(): Contadores {
  return {
    "5m": { resueltas: 0, reutilizadas: 0, tardias: 0 },
    "30m": { resueltas: 0, reutilizadas: 0, tardias: 0 },
    "1h": { resueltas: 0, reutilizadas: 0, tardias: 0 },
  };
}

interface EstadoDeClase {
  contadores: Record<TipoDeTramo, Contadores>;
  /**
   * Entradas registradas cuya suerte en cada ventana aún no se sabe (ni se
   * reutilizaron ni pasó la ventana). Se publican para que la decisión las
   * cuente del lado PESIMISTA: la censura por la derecha favorece siempre a
   * las reutilizaciones (se resuelven en cuanto llegan; los fracasos, cuando
   * vence la ventana), y en la de 1 h eso inflaría la tasa durante una hora.
   * Ver `concluir`.
   */
  pendientes: Record<TipoDeTramo, Record<Ventana, number>>;
  /** FIFO por instante de registro, con cabeza desplazada. */
  cola: Entrada[];
  cabeza: number;
  /** Punteros por ventana: índice absoluto de la primera entrada aún no vencida en ella. */
  cursores: Record<Ventana, number>;
  predichas: number;
  confirmadas: number;
  apagada: boolean;
}

/** Lo que un tramo reutiliza, en fracción de las entradas ya resueltas en cada ventana. */
export interface TasaDeReutilizacion {
  /** Resueltas en 5 min (el denominador de `en5m`). */
  muestras5m: number;
  muestras30m: number;
  muestras1h: number;
  /** Reutilizadas dentro de cada ventana (los numeradores). */
  k5m: number;
  k30m: number;
  k1h: number;
  /** De las resueltas en 1 h, las reutilizadas pasados los 5 min. */
  kTardias: number;
  /** Registradas cuya suerte en la ventana aún no se sabe (ver `intervaloPesimista`). */
  pendientes5m: number;
  pendientes30m: number;
  pendientes1h: number;
  en5m: number;
  en30m: number;
  en1h: number;
}

export interface EstadisticaDeClase {
  S: TasaDeReutilizacion;
  H: TasaDeReutilizacion;
  T: TasaDeReutilizacion;
  /** Predicciones de lectura comprobables contra el contador del proveedor, y cuántas confirmó. */
  predichas: number;
  confirmadas: number;
  /** La clase volvió a la colocación fija porque el proveedor no confirmó lo que el espejo veía. */
  apagada: boolean;
}

/** La entrada viva más larga que una petición nueva extiende. */
export interface Coincidencia {
  tipo: TipoDeTramo;
  /** Mensajes que cubre. */
  indice: number;
  huecoMs: number;
  /** Presente si esa entrada fue el último punto marcado de su petición: la posición del proveedor. */
  posicionDelProveedor?: number;
  ttl?: TtlDeCache;
}

export interface OpcionesDelEspejo {
  /** Entradas vivas como máximo por clase (se deja de registrar al llegar; default 2048). */
  maxPorClase?: number;
  /** Clases como máximo (se olvida la menos usada; default 256). */
  maxClases?: number;
  /** Predicciones comprobadas antes de juzgar al espejo contra el proveedor (default 8). */
  prediccionesMinimas?: number;
  /** Fracción mínima de predicciones confirmadas por el proveedor (default 0,5). */
  confirmacionMinima?: number;
  /** A partir de cuántas resoluciones por ventana se reducen los contadores a la mitad (default 512). */
  memoria?: number;
}

/**
 * El espejo de la caché de prefijo. En memoria y por instancia, como la verja:
 * lo que aprende es una propiedad del tráfico de ESTE proceso, y un proceso que
 * reaprende no cuesta dinero —la decisión por defecto es la colocación fija—.
 */
export class EspejoDeCache {
  private readonly clases = new Map<string, EstadoDeClase>();
  private readonly porHuella = new Map<string, Entrada>();
  private readonly maxPorClase: number;
  private readonly maxClases: number;
  private readonly prediccionesMinimas: number;
  private readonly confirmacionMinima: number;
  private readonly memoria: number;

  constructor(o: OpcionesDelEspejo = {}) {
    this.maxPorClase = Math.max(16, o.maxPorClase ?? 2048);
    this.maxClases = Math.max(1, o.maxClases ?? 256);
    this.prediccionesMinimas = Math.max(1, o.prediccionesMinimas ?? 8);
    this.confirmacionMinima = o.confirmacionMinima ?? 0.5;
    this.memoria = Math.max(32, o.memoria ?? 512);
  }

  /**
   * Una petición LLEGA: se buscan, mensaje a mensaje, las entradas vivas que son
   * prefijo suyo, se apuntan como reutilizadas con su hueco, y se devuelve la
   * más larga (la que leería el proveedor). No registra nada de esta petición:
   * eso va en `registrar`, DESPUÉS de la respuesta, igual que el proveedor, que
   * solo deja leer una entrada cuando la primera respuesta ya empezó.
   */
  observar(clase: string, huellas: readonly string[], ahora: number): Coincidencia | null {
    const estado = this.estadoDe(clase);
    this.vencer(estado, ahora);
    let mejor: Coincidencia | null = null;
    for (let k = 1; k < huellas.length; k++) {
      const e = this.porHuella.get(huellas[k]!);
      if (!e || e.descartada || e.clase !== clase || e.indice !== k) continue;
      const hueco = Math.max(0, ahora - e.escrita);
      if (hueco > VENTANAS["1h"]) continue; // ya vencida en todas las ventanas
      this.resolverReutilizada(estado, e, hueco);
      mejor = {
        tipo: e.tipo,
        indice: k,
        huecoMs: hueco,
        ...(e.posicionDelProveedor !== undefined ? { posicionDelProveedor: e.posicionDelProveedor } : {}),
        ...(e.ttl ? { ttl: e.ttl } : {}),
      };
    }
    return mejor;
  }

  /**
   * La petición ya tiene respuesta: se registran sus tramos. `ultimoMarcado` es
   * el tramo del último punto que la capa puso y `posicionDelProveedor` la
   * lectura + escritura de caché que informó el proveedor (solo si informó).
   */
  registrar(e: {
    clase: string;
    huellas: readonly string[];
    tramos: Partial<Record<TipoDeTramo, number>>;
    /**
     * Cuándo SALIÓ la petición, no cuándo volvió. El proveedor cuenta el TTL
     * «from the start of the request that writes or reads the cache entry»;
     * medir el hueco desde la respuesta lo acortaría en lo que tardó la
     * generación, y un hueco de 4:30 medido podría ser uno de 5:30 real.
     */
    enviada: number;
    ultimoMarcado?: TipoDeTramo | null;
    posicionDelProveedor?: number | null;
    ttl?: TtlDeCache;
  }): void {
    const estado = this.estadoDe(e.clase);
    this.vencer(estado, e.enviada);
    // Con el instante de ENVÍO tal cual, aunque una petición larga vuelva
    // después de otra corta y la FIFO deje de ir en orden. Los cursores de
    // `vencer` se paran en la primera entrada aún viva, así que una entrada
    // «adelantada» solo se resuelve algo más tarde de lo debido: un fracaso
    // que tarda en contarse, que la decisión ya trata como fracaso mientras está
    // pendiente. Adelantar el instante para mantener el orden acortaría el
    // hueco medido, y un 5:01 real contado como 4:59 sí sería un error caro.
    const escrita = e.enviada;
    for (const tipo of ["S", "H", "T"] as const) {
      const indice = e.tramos[tipo];
      if (indice === undefined || indice <= 0 || indice >= e.huellas.length) continue;
      if (estado.cola.length - estado.cabeza >= this.maxPorClase) break;
      const huellaDelTramo = e.huellas[indice]!;
      const esElUltimo = e.ultimoMarcado === tipo;
      const entrada: Entrada = {
        clase: e.clase,
        tipo,
        huella: huellaDelTramo,
        indice,
        escrita,
        contadas: 0,
        descartada: false,
        ...(esElUltimo && e.posicionDelProveedor != null && e.posicionDelProveedor > 0
          ? { posicionDelProveedor: e.posicionDelProveedor }
          : {}),
        ...(esElUltimo && e.ttl ? { ttl: e.ttl } : {}),
      };
      // La misma huella registrada otra vez (la cabecera de cada petición, una
      // plantilla fija). Si seguía viva, `observar` ya la contó como
      // reutilizada; si quedaba pendiente (nadie la extendió), se retira sin
      // contarla, y manda la nueva.
      const vieja = this.porHuella.get(huellaDelTramo);
      if (vieja && vieja.contadas !== 0b111) this.descartar(vieja);
      this.porHuella.set(huellaDelTramo, entrada);
      estado.cola.push(entrada);
      for (const v of ORDEN_VENTANAS) estado.pendientes[tipo][v] += 1;
    }
  }

  /**
   * El contador del proveedor frente a lo que predijo el espejo. Llamar solo
   * cuando la petición marcó un punto que alcanza la entrada coincidente (su
   * último punto está en o detrás de ella y a menos de 20 posiciones) y el
   * proveedor informó de su lectura.
   */
  verificar(clase: string, c: Coincidencia, leidosDelProveedor: number): void {
    if (c.posicionDelProveedor === undefined) return;
    const ttl = c.ttl ?? "5m";
    if (c.huecoMs > VENTANAS[ttl]) return; // ya caducada: el fallo no dice nada del espejo
    const estado = this.estadoDe(clase);
    estado.predichas += 1;
    // Un 2 % de holgura: la posición es del MISMO proveedor sobre el mismo
    // prefijo, así que debería coincidir al token; la holgura solo absorbe un
    // bloque que el adaptador pusiera distinto sin cambiar el prefijo.
    if (leidosDelProveedor >= c.posicionDelProveedor * 0.98) estado.confirmadas += 1;
    if (
      estado.predichas >= this.prediccionesMinimas &&
      estado.confirmadas / estado.predichas < this.confirmacionMinima
    ) {
      estado.apagada = true;
    }
  }

  estadistica(clase: string, ahora: number): EstadisticaDeClase {
    const estado = this.estadoDe(clase);
    this.vencer(estado, ahora);
    const tasa = (c: Contadores, pend: Record<Ventana, number>): TasaDeReutilizacion => ({
      pendientes5m: pend["5m"],
      pendientes30m: pend["30m"],
      pendientes1h: pend["1h"],
      muestras5m: c["5m"].resueltas,
      muestras30m: c["30m"].resueltas,
      muestras1h: c["1h"].resueltas,
      k5m: c["5m"].reutilizadas,
      k30m: c["30m"].reutilizadas,
      k1h: c["1h"].reutilizadas,
      kTardias: c["1h"].tardias,
      en5m: fraccion(c["5m"]),
      en30m: fraccion(c["30m"]),
      en1h: fraccion(c["1h"]),
    });
    return {
      S: tasa(estado.contadores.S, estado.pendientes.S),
      H: tasa(estado.contadores.H, estado.pendientes.H),
      T: tasa(estado.contadores.T, estado.pendientes.T),
      predichas: estado.predichas,
      confirmadas: estado.confirmadas,
      apagada: estado.apagada,
    };
  }

  /** Para los tests: cuántas entradas vivas hay en total. */
  get vivas(): number {
    return this.porHuella.size;
  }

  private estadoDe(clase: string): EstadoDeClase {
    let e = this.clases.get(clase);
    if (e) {
      // LRU: se reinserta al final.
      this.clases.delete(clase);
      this.clases.set(clase, e);
      return e;
    }
    e = {
      contadores: { S: contadoresVacios(), H: contadoresVacios(), T: contadoresVacios() },
      pendientes: { S: pendientesVacios(), H: pendientesVacios(), T: pendientesVacios() },
      cola: [],
      cabeza: 0,
      cursores: { "5m": 0, "30m": 0, "1h": 0 },
      predichas: 0,
      confirmadas: 0,
      apagada: false,
    };
    this.clases.set(clase, e);
    while (this.clases.size > this.maxClases) {
      const [vieja, estadoViejo] = this.clases.entries().next().value as [string, EstadoDeClase];
      for (let i = estadoViejo.cabeza; i < estadoViejo.cola.length; i++) {
        const en = estadoViejo.cola[i]!;
        if (this.porHuella.get(en.huella) === en) this.porHuella.delete(en.huella);
      }
      this.clases.delete(vieja);
    }
    return e;
  }

  // Retirada sin contar: sale de las pendientes y ya no se resuelve nunca.
  private descartar(e: Entrada): void {
    const estado = this.clases.get(e.clase);
    ORDEN_VENTANAS.forEach((v, bit) => {
      if (e.contadas & (1 << bit)) return;
      if (estado) estado.pendientes[e.tipo][v] = Math.max(0, estado.pendientes[e.tipo][v] - 1);
      e.contadas |= 1 << bit;
    });
    e.descartada = true;
  }

  private resolverReutilizada(estado: EstadoDeClase, e: Entrada, hueco: number): void {
    ORDEN_VENTANAS.forEach((v, bit) => {
      if (e.contadas & (1 << bit)) return;
      estado.pendientes[e.tipo][v] = Math.max(0, estado.pendientes[e.tipo][v] - 1);
      const c = estado.contadores[e.tipo][v];
      c.resueltas += 1;
      if (hueco <= VENTANAS[v]) c.reutilizadas += 1;
      if (v === "1h" && hueco <= VENTANAS["1h"] && hueco > VENTANAS["5m"]) c.tardias += 1;
      e.contadas |= 1 << bit;
    });
    this.reducirSiHaceFalta(estado.contadores[e.tipo]);
  }

  // Cada ventana tiene su cursor sobre la FIFO: todo lo que queda por delante
  // del cursor ya pasó esa ventana sin reutilizarse (o se contó al reutilizarse).
  // Amortizado O(1) por entrada, sin recorrer la hora entera en cada petición.
  private vencer(estado: EstadoDeClase, ahora: number): void {
    ORDEN_VENTANAS.forEach((v, bit) => {
      let i = Math.max(estado.cursores[v], estado.cabeza);
      while (i < estado.cola.length && ahora - estado.cola[i]!.escrita > VENTANAS[v]) {
        const e = estado.cola[i]!;
        if (!e.descartada && !(e.contadas & (1 << bit))) {
          estado.pendientes[e.tipo][v] = Math.max(0, estado.pendientes[e.tipo][v] - 1);
          estado.contadores[e.tipo][v].resueltas += 1;
          this.reducirSiHaceFalta(estado.contadores[e.tipo]);
        }
        e.contadas |= 1 << bit;
        i += 1;
      }
      estado.cursores[v] = i;
    });
    // Lo que venció en la ventana más larga ya no puede coincidir: fuera.
    while (estado.cabeza < estado.cursores["1h"]) {
      const e = estado.cola[estado.cabeza]!;
      if (this.porHuella.get(e.huella) === e) this.porHuella.delete(e.huella);
      estado.cabeza += 1;
    }
    if (estado.cabeza > 1024 && estado.cabeza * 2 > estado.cola.length) {
      estado.cola.splice(0, estado.cabeza);
      for (const v of ORDEN_VENTANAS) estado.cursores[v] -= estado.cabeza;
      estado.cabeza = 0;
    }
  }

  // Memoria finita: el tráfico cambia de forma (un agente nuevo, otro
  // producto), y un contador que suma para siempre tardaría horas en notarlo.
  private reducirSiHaceFalta(c: Contadores): void {
    for (const v of ORDEN_VENTANAS) {
      if (c[v].resueltas >= this.memoria) {
        c[v].resueltas = Math.floor(c[v].resueltas / 2);
        c[v].reutilizadas = Math.floor(c[v].reutilizadas / 2);
        c[v].tardias = Math.floor(c[v].tardias / 2);
      }
    }
  }
}

function fraccion(c: Contador): number {
  return c.resueltas > 0 ? c.reutilizadas / c.resueltas : 0;
}

// ── La decisión ─────────────────────────────────────────────────────────────

/**
 * El equilibrio de marcar un tramo con un TTL cuya escritura cuesta `w` y cuya
 * lectura cuesta `r`, frente a NO marcarlo (pagarlo a 1× cada vez que viaja).
 *
 * Si con probabilidad `p` la petición siguiente vuelve a mandar el tramo dentro
 * del TTL, el número esperado de relecturas es `p/(1−p)`. Marcando: `w` una vez
 * y `r` por relectura; sin marcar: 1 cada vez. Compensa con
 *
 *     w − 1 < (1 − r) · p/(1 − p)   ⇔   p > (w − 1) / (w − r)
 *
 * Con 1,25 / 0,10 (5 min) sale 0,25/1,15 ≈ 0,2174, el mismo número que la verja
 * de prefijo; con 2 / 0,10 (1 h), 1/1,9 ≈ 0,5263; con la lectura de Opus 5.5
 * (0,05), 0,25/1,20 ≈ 0,2083.
 */
export function equilibrioDeTramo(w: number, r: number): number {
  const denominador = w - r;
  if (!(denominador > 0)) return 1;
  return Math.max(0, (w - 1) / denominador);
}

export interface EntradaDeColocacion {
  estadistica: EstadisticaDeClase;
  tramo: CacheTier;
  /** Prima de la escritura de 1 h de este modelo (Anthropic: 2). `null` si el proveedor no tiene TTL de 1 h. */
  primaDeUnaHora: number | null;
  /** Tokens de la capa en cada frontera (`H` = el prefijo estable, `T` = el prompt entero). */
  tokens: { S: number; H: number; T: number };
  /** Hay historial por detrás de la cabecera (si no, H coincide con S y no hay decisión que tomar). */
  hayHistorial: boolean;
  /**
   * Tokens que el espejo cree que se leerán en esta petición (la coincidencia
   * viva más larga). Perezoso: solo hace falta para decidir la hora, y contar
   * los tokens de un prefijo largo no es gratis.
   */
  lecturaPrevista: () => number;
  /** Resoluciones mínimas en la ventana antes de concluir nada (default 5; decide Wilson). */
  muestrasMinimas?: number;
}

export interface Colocacion {
  /** Punto al final del historial estable (si no, solo en la cabecera). */
  historial: boolean;
  /** Punto en el último bloque, para que una continuación lea el prompt entero. */
  cola: boolean;
  ttl: TtlDeCache;
  /** Motivo publicable en la traza (en inglés: viaja en `report.traces`). */
  razon: string;
  /** El equilibrio de 5 min (el de la hora va en la razón cuando cuenta). */
  equilibrio: number;
}

/**
 * El intervalo de Wilson (95 %) de una proporción `k/n`. Se decide con él y no
 * con el cociente a secas: con 5 de 5 continuaciones el límite inferior ya es
 * 0,57 —la cola se enciende sin esperar a 20 muestras—, y con 0 de n hace falta
 * n ≥ 14 para que el superior baje del 21,7 % y se quite un punto. Lo que no
 * está claro se queda como en la colocación fija.
 */
export function intervaloDeWilson(k: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [0, 1];
  const p = k / n;
  const z2 = z * z;
  const centro = (p + z2 / (2 * n)) / (1 + z2 / n);
  const margen = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / (1 + z2 / n);
  return [Math.max(0, centro - margen), Math.min(1, centro + margen)];
}

/**
 * ¿Compensa con certeza (`true`), no compensa con certeza (`false`) o no se
 * sabe (`null`)?
 *
 * LA CENSURA POR LA DERECHA. Una reutilización se sabe en cuanto llega; un
 * fracaso, solo cuando vence la ventana. Entre las entradas ya resueltas sobran
 * éxitos, así que su tasa está sesgada HACIA ARRIBA (en la ventana de 1 h,
 * durante toda una hora). De ahí la forma:
 *
 *  · para concluir que COMPENSA, las pendientes —registradas cuya suerte aún
 *    no se sabe— cuentan como fracasos: el sesgo no puede empujar un «sí»;
 *  · para concluir que NO compensa basta con las resueltas: su sesgo va en
 *    contra de esa conclusión, así que si aun así sale «no», es que no.
 */
function concluir(k: number, n: number, pendientes: number, eq: number, minimas: number): boolean | null {
  if (n + pendientes >= minimas && intervaloDeWilson(k, n + pendientes)[0] > eq) return true;
  if (n >= minimas && intervaloDeWilson(k, n)[1] < eq) return false;
  return null;
}

interface Juicio {
  /** `true`: compensa con certeza; `false`: no compensa con certeza; `null`: no se sabe aún. */
  en5m: boolean | null;
  en1h: boolean | null;
}

/**
 * La colocación para Anthropic (puntos explícitos, TTL de 5 min o 1 h).
 *
 * Por defecto —sin muestras, o con la clase apagada— es EXACTAMENTE la
 * colocación fija de siempre: cabecera + historial, sin cola, 5 min.
 */
export function decidirColocacion(e: EntradaDeColocacion): Colocacion {
  const minimas = e.muestrasMinimas ?? 5;
  const r = e.tramo.cacheReadMultiplier;
  const w5 = e.tramo.cacheWriteMultiplier;
  const w1h = e.primaDeUnaHora != null && e.primaDeUnaHora > w5 ? e.primaDeUnaHora : null;
  const eq5 = equilibrioDeTramo(w5, r);
  const eq1h = w1h != null ? equilibrioDeTramo(w1h, r) : null;
  const fija: Colocacion = { historial: true, cola: false, ttl: "5m", razon: "", equilibrio: eq5 };

  if (e.estadistica.apagada) {
    return {
      ...fija,
      razon:
        `fixed placement: the provider's counter confirmed only ${e.estadistica.confirmadas} of ` +
        `${e.estadistica.predichas} cache reads the layer predicted for this traffic, so the ` +
        `layer stopped trusting its own reuse measurement here`,
    };
  }

  const juzgar = (t: TasaDeReutilizacion): Juicio => ({
    en5m: concluir(t.k5m, t.muestras5m, t.pendientes5m, eq5, minimas),
    en1h: eq1h != null ? concluir(t.k1h, t.muestras1h, t.pendientes1h, eq1h, minimas) : null,
  });
  const motivos: string[] = [];
  const H = e.estadistica.H;
  const T = e.estadistica.T;
  const jH = juzgar(H);
  const jT = juzgar(T);
  const muestras = (t: TasaDeReutilizacion): string => `${t.k5m}/${t.muestras5m} in 5 min, ${t.k1h}/${t.muestras1h} in 1 h`;

  // EL HISTORIAL. Se quita solo cuando está CLARO que con 5 min no compensa y
  // no está claro que con 1 h sí; sin certeza se queda como en la fija.
  let historial = true;
  if (e.hayHistorial) {
    if (jH.en5m === true || jH.en1h === true) {
      motivos.push(`history re-sent (${muestras(H)}): above break-even, marked`);
    } else if (jH.en5m === false) {
      historial = false;
      motivos.push(
        `history re-sent only ${muestras(H)} (break-even ${pct(eq5)}): breakpoint moved back to the ` +
          `system header, no write premium on a prefix nobody re-reads`,
      );
    } else {
      motivos.push(`history: not conclusive yet (${muestras(H)}), fixed placement kept`);
    }
  }

  // LA COLA. Solo con certeza de que compensa: es lo que la fija no hace.
  const cola = jT.en5m === true || jT.en1h === true;
  motivos.push(
    cola
      ? `continued ${muestras(T)}: above break-even, tail marked so the next turn reads this whole prompt`
      : jT.en5m === false
        ? `continued only ${muestras(T)} (break-even ${pct(eq5)}): tail not marked`
        : `tail: not conclusive yet (${muestras(T)}), not marked`,
  );

  // EL TTL: uno por petición (los de 1 h tienen que ir delante de los de
  // 5 min), decidido por el ÚLTIMO punto, que es el que lee el turno siguiente.
  //
  //  · Si con 5 min el último tramo no compensa con certeza y con 1 h sí, 1 h.
  //  · Si con 5 min ya compensa, 1 h solo si sale a cuenta con los tamaños de
  //    ESTA petición. El error caro está medido en gateway/tarifa.ts: decidir
  //    por el reloj. Un hueco de 5 min a 1 h obliga a REESCRIBIR todo lo que se
  //    habría leído (P), mientras que la hora solo encarece lo que se escribe
  //    ahora (D):
  //
  //        1 h compensa  ⇔  p(5 min < hueco ≤ 1 h) · (w5 − r) · P  >  (w1h − w5) · D
  //
  //    con p en su límite INFERIOR de Wilson: la prima de la hora se paga
  //    seguro y el hueco largo es una estimación.
  let ttl: TtlDeCache = "5m";
  if (w1h != null) {
    const tipo: TipoDeTramo = cola ? "T" : historial && e.hayHistorial ? "H" : "S";
    const tasa = e.estadistica[tipo];
    const j = tipo === "T" ? jT : tipo === "H" ? jH : juzgar(tasa);
    const P = tipo === "T" ? e.tokens.T : tipo === "H" ? e.tokens.H : e.tokens.S;
    if (j.en5m !== true && j.en1h === true) {
      ttl = "1h";
      motivos.push(`1h TTL: re-sent ${muestras(tasa)} (1 h break-even ${pct(eq1h!)}), while 5 min does not pay`);
    } else if (j.en5m === true && tasa.muestras1h >= minimas && P > 0) {
      const [tardias] = intervaloDeWilson(tasa.kTardias, tasa.muestras1h + tasa.pendientes1h);
      const D = Math.max(0, P - e.lecturaPrevista());
      const gana = tardias * (w5 - r) * P;
      const cuesta = (w1h - w5) * D;
      if (gana > cuesta) {
        ttl = "1h";
        motivos.push(
          `1h TTL: at least ${pct(tardias)} of re-sends come after 5 min; re-reading ${P} tokens then ` +
            `beats the extra premium on the ${D} written now`,
        );
      }
    }
  }

  return { historial, cola, ttl, razon: motivos.join("; "), equilibrio: eq5 };
}

/**
 * OpenAI GPT-5.6+ en su API: ¿modo explícito (sin punto en la pregunta) y
 * dónde va el único punto? Sin muestras, el modo del proveedor (el de siempre).
 */
export function decidirExplicitaOpenAI(e: {
  estadistica: EstadisticaDeClase;
  tramo: CacheTier;
  hayHistorial: boolean;
  muestrasMinimas?: number;
}): { explicita: boolean; historial: boolean; razon: string; equilibrio: number } {
  const minimas = e.muestrasMinimas ?? 5;
  const eq = equilibrioDeTramo(e.tramo.cacheWriteMultiplier, e.tramo.cacheReadMultiplier);
  const T = e.estadistica.T;
  const H = e.estadistica.H;
  // Explícito solo cuando está CLARO que las continuaciones no pagan la
  // escritura de la pregunta (el superior de Wilson por debajo del equilibrio).
  const claroQueNo = (k: number, n: number, pendientes: number): boolean =>
    concluir(k, n, pendientes, eq, minimas) === false;
  if (e.estadistica.apagada) {
    return {
      explicita: false,
      historial: true,
      razon:
        `provider default kept: the provider's counter confirmed only ${e.estadistica.confirmadas} of ` +
        `${e.estadistica.predichas} predicted cache reads`,
      equilibrio: eq,
    };
  }
  if (!claroQueNo(T.k30m, T.muestras30m, T.pendientes30m)) {
    return {
      explicita: false,
      historial: true,
      razon:
        `provider default kept: continued ${T.k30m}/${T.muestras30m} within 30 min, not clearly below ` +
        `the ${pct(eq)} break-even`,
      equilibrio: eq,
    };
  }
  const historial = !e.hayHistorial || !claroQueNo(H.k30m, H.muestras30m, H.pendientes30m);
  return {
    explicita: true,
    historial,
    razon:
      `explicit mode: continued only ${T.k30m}/${T.muestras30m} within 30 min (break-even ${pct(eq)}), so ` +
      `the question is not written; breakpoint at the ${historial ? "end of the stable history" : "system header"}`,
    equilibrio: eq,
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}
