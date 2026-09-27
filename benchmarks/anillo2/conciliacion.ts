/**
 * ANILLO 2 · CONCILIACIÓN DIARIA transcript↔espía — NÚCLEO PURO.
 *
 * La verja que le faltaba al A/B de días alternos: el arnés (arnes.ts) solo ve
 * lo que pasó por el espía, y una sesión de Claude Code lanzada A PELO (sin
 * `bvsala claude` encadenado por BVSALA_GATEWAY_UPSTREAM) va directa al
 * proveedor y no deja rastro en las capturas — ni en el brazo palanca ni en el
 * control. El día parece limpio y no lo es: falta parte de la org, y la parte
 * que falta no es aleatoria (es la que el dueño lanzó sin pensar en el A/B).
 * Caso real del 06-09-2026: sesión a pelo a las 14:47Z, pid 28708.
 *
 * Quien SÍ ve todas las sesiones de la máquina es Claude Code mismo: cada
 * petición al proveedor queda en ~/.claude/projects/**\/*.jsonl con su
 * `requestId`, que es EL MISMO `request-id` que el proveedor devuelve en la
 * respuesta y el espía guarda en `responseHeaders` (verificado 06-09: sesión
 * a27a1c77, 161/161 coincidencias). Conciliar los dos lados por ese id
 * responde, por día y por sesión: ¿pasó todo por el gateway? ¿qué quedó fuera
 * y cuánto dinero es?
 *
 * Reglas del cruce, y por qué:
 * - Un requestId sale en VARIAS líneas del transcript (una por bloque de
 *   contenido) y CADA línea trae su usage del momento: la primera lleva el
 *   parcial del message_start (output_tokens 4, 7…) y la última el definitivo
 *   (medido 06-09: 909 de 1.877 requestIds con usages distintos; elegir la
 *   primera dejaba el dinero un 8–19 % corto). El representante es la línea
 *   con MÁS output_tokens (empate: la última escrita), por un orden total para
 *   que el informe no dependa del orden de lectura. Aun así el transcript es
 *   COTA INFERIOR del dinero: en ~0,4 % de los turnos nunca recibe el usage
 *   final, y las peticiones laterales (títulos, compactaciones) de una sesión
 *   sin encadenar no están en ninguna fuente.
 * - `<synthetic>` no es una petición al proveedor (mensajes que Claude Code
 *   fabrica en local): se excluye, igual que las líneas sin requestId.
 * - El DÍA lo fija el timestamp del transcript (UTC, la unidad del A/B). Un
 *   registro del espía del día siguiente cuya respuesta pertenece a un turno
 *   del día (cruzó la medianoche) cuenta como visto: se acepta por `at` del
 *   día O por requestId presente en el transcript del día.
 * - «Lateral» = registro del espía sin transcript (títulos con sonnet-5 a
 *   max_tokens 64, reintentos fallidos…): no es fuga, pero se atribuye a la
 *   sesión de su cabecera para que el recuento cuadre.
 *
 * Todo lo de este fichero es puro y determinista (sesiones y mapas ordenados
 * por clave: el JSON debe ser byte a byte igual con la misma entrada en
 * cualquier orden). La lectura en streaming vive en conciliar.ts.
 * PRIVACIDAD: aquí solo entran ids, timestamps, modelo, usage y el nombre del
 * proyecto — jamás contenido.
 */
import { costeMedido, type UsoSse } from "../../gateway/medidor.js";
import { diaDe } from "./nucleo.js";

/** Modelo que Claude Code pone a los mensajes fabricados en local. */
export const MODELO_SINTETICO = "<synthetic>";

/**
 * La FORMA que cada campo del transcript tiene que casar para cruzar al
 * artefacto (verja de privacidad: un id es un id, no «cualquier string»).
 * Lo que Claude Code escribe hoy (06-09-2026): sessionId uuid, requestId
 * `req_` + alfanumérico, timestamp ISO en Z, modelo con letras/dígitos/.-_
 * (y `<synthetic>`), versión semver.
 */
export const FORMA = {
  sessionId: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  requestId: /^req_[A-Za-z0-9]{1,64}$/,
  timestamp: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/,
  model: /^[A-Za-z0-9<>._-]{1,64}$/,
  version: /^\d+\.\d+\.\d+$/,
} as const;

/** Una petición al proveedor vista desde el transcript de Claude Code. */
export interface TurnoTranscript {
  sessionId: string;
  requestId: string;
  timestamp: string;
  model: string;
  /** basename del cwd del transcript, o "?" si no viene. */
  proyecto: string;
  /** isSidechain, o fichero bajo subagents/. */
  subagente: boolean;
  usage?: UsoSse;
  /** Versión de Claude Code (campo `version` del transcript): el confundidor
   *  de cliente que la auditoría de paridad ya vigila en el espía. */
  version?: string;
}

/** Una respuesta del proveedor vista desde la captura del espía. */
export interface VistoEnEspia {
  requestId: string;
  at: string;
  /** Cabecera x-claude-code-session-id de la petición. */
  sesionCabecera?: string;
  /** Status HTTP de la respuesta: separa un reintento fallido (529…) de una
   *  petición lateral de verdad. */
  status?: number;
}

export type EstadoSesion = "encadenada" | "parcial" | "sin-encadenar";

export interface SesionConciliada {
  sessionId: string;
  proyecto: string;
  estado: EstadoSesion;
  /** requestIds únicos del día en el transcript. */
  turnos: number;
  /** de esos, cuántos están en el espía. */
  vistos: number;
  /** turnos − vistos: peticiones que fueron al proveedor sin pasar por el gateway. */
  fugas: number;
  /** fugas cuyo dinero no se pudo medir (sin usage o modelo sin precio):
   *  dineroFueraUsd se queda corto en esa cuantía. */
  fugasSinPrecio: number;
  /** registros del espía sin transcript atribuidos a esta sesión por cabecera. */
  laterales: number;
  /** turnos que vienen de subagentes. */
  subagentes: number;
  dineroFueraUsd: number;
  dineroTotalUsd: number;
  primerTurno: string;
  ultimoTurno: string;
  modelos: Record<string, number>;
  clientes: Record<string, number>;
}

export interface GlobalConciliado {
  dia: string;
  sesiones: number;
  turnos: number;
  vistos: number;
  fugas: number;
  fugasSinPrecio: number;
  pctTurnosFuera: number;
  dineroFueraUsd: number;
  dineroTotalUsd: number;
  /** request-ids del espía del día sin transcript (todos). */
  lateralesSinTranscript: number;
  /** de esos, sin cabecera de sesión o con una sesión que no tiene turnos ese día. */
  lateralesHuerfanos: number;
  /** de esos, con status HTTP ≥ 400 (reintentos que el transcript no apunta). */
  lateralesConError: number;
  /** registros del espía del día cuyo requestId es de un turno de OTRO día
   *  (cruzó la medianoche): ni vistos de hoy ni laterales. */
  deOtroDia: number;
  /** Primer y último `at` de TODO lo que el espía vio en la ventana leída:
   *  separa «espía mudo desde X» de «sesión sin encadenar». */
  primerAtEspia: string | null;
  ultimoAtEspia: string | null;
  fisuras: string[];
}

export interface InformeConciliacion {
  global: GlobalConciliado;
  porSesion: SesionConciliada[];
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const objetoOrdenado = (m: Map<string, number>): Record<string, number> =>
  Object.fromEntries([...m.entries()].sort(([a], [b]) => cmp(a, b)));

function cuenta(m: Map<string, number>, k: string): void {
  m.set(k, (m.get(k) ?? 0) + 1);
}

/**
 * Orden total entre dos líneas del MISMO requestId: gana la que trae usage
 * (el dinero sale de ahí), entre ellas la de MÁS output_tokens (el usage
 * definitivo, no el parcial del message_start), luego la de timestamp MAYOR
 * (la última escrita), y el resto de campos — usage serializado incluido —
 * solo desempatan para que la elección no dependa del orden de lectura.
 */
function antes(a: TurnoTranscript, b: TurnoTranscript): boolean {
  const ua = a.usage ? 0 : 1;
  const ub = b.usage ? 0 : 1;
  if (ua !== ub) return ua < ub;
  const oa = a.usage?.output_tokens ?? 0;
  const ob = b.usage?.output_tokens ?? 0;
  if (oa !== ob) return oa > ob;
  if (a.timestamp !== b.timestamp) return cmp(a.timestamp, b.timestamp) > 0;
  const clave = (t: TurnoTranscript) =>
    [t.sessionId, t.proyecto, t.model, t.subagente ? "1" : "0", t.version ?? "", JSON.stringify(t.usage ?? null)].join(" ");
  return cmp(clave(a), clave(b)) < 0;
}

/**
 * Deduplica por requestId y excluye lo que no es una petición al proveedor
 * (sin requestId, o modelo `<synthetic>`). Devuelve ordenado por requestId.
 */
export function deduplicarTurnos(transcript: TurnoTranscript[]): TurnoTranscript[] {
  const porId = new Map<string, TurnoTranscript>();
  for (const t of transcript) {
    if (!t.requestId || t.model === MODELO_SINTETICO) continue;
    const previo = porId.get(t.requestId);
    if (!previo || antes(t, previo)) porId.set(t.requestId, t);
  }
  return [...porId.values()].sort((a, b) => cmp(a.requestId, b.requestId));
}

/**
 * Dinero de un turno según el medidor (null si no hay usage o el modelo no tiene
 * precio), al precio del DÍA DEL TURNO: la conciliación es de días pasados, y
 * con un cambio de precio anunciado el precio de hoy no es el que se facturó.
 */
export function dineroDe(t: TurnoTranscript): number | null {
  if (!t.usage) return null;
  return costeMedido(t.model, t.usage, Date.parse(t.timestamp))?.costeUsd ?? null;
}

/**
 * La conciliación de UN día: transcript (todas las sesiones de la máquina)
 * contra espía (lo que pasó por el gateway encadenado).
 */
export function conciliar(dia: string, transcript: TurnoTranscript[], espia: VistoEnEspia[]): InformeConciliacion {
  // 1) Transcript: dedupe global (un requestId que cruza la medianoche se
  //    queda en el día de su primera línea), luego el día.
  const turnosDia = deduplicarTurnos(transcript).filter((t) => diaDe(t.timestamp) === dia);
  const idsDelDia = new Set(turnosDia.map((t) => t.requestId));

  // Los requestIds de TODA la ventana (no solo del día): un registro del espía
  // de hoy que responde a un turno de ayer no es lateral, es «de otro día».
  const idsVentana = new Set(deduplicarTurnos(transcript).map((t) => t.requestId));

  // 2) Espía: dedupe por request-id (la primera respuesta por `at`; empate por
  //    cabecera y status, determinista), y se admite lo del día O lo que
  //    responde a un turno del día.
  const vistoPorId = new Map<string, VistoEnEspia>();
  let primerAtEspia: string | null = null;
  let ultimoAtEspia: string | null = null;
  const claveV = (x: VistoEnEspia) => [x.at, x.sesionCabecera ?? "", String(x.status ?? "")].join(" ");
  for (const v of espia) {
    if (!v.requestId) continue;
    if (primerAtEspia === null || cmp(v.at, primerAtEspia) < 0) primerAtEspia = v.at;
    if (ultimoAtEspia === null || cmp(v.at, ultimoAtEspia) > 0) ultimoAtEspia = v.at;
    const previo = vistoPorId.get(v.requestId);
    if (!previo || cmp(claveV(v), claveV(previo)) < 0) vistoPorId.set(v.requestId, v);
  }
  const vistosDia = [...vistoPorId.values()]
    .filter((v) => diaDe(v.at) === dia || idsDelDia.has(v.requestId))
    .sort((a, b) => cmp(a.requestId, b.requestId));

  // 3) Laterales: lo que el espía vio y ningún transcript del día apunta,
  //    atribuido a la sesión de la cabecera.
  const lateralesPorSesion = new Map<string, number>();
  let lateralesSinTranscript = 0;
  let lateralesConError = 0;
  let lateralesSinCabecera = 0;
  let deOtroDia = 0;
  for (const v of vistosDia) {
    if (idsDelDia.has(v.requestId)) continue;
    if (idsVentana.has(v.requestId)) {
      deOtroDia += 1;
      continue;
    }
    lateralesSinTranscript += 1;
    if ((v.status ?? 0) >= 400) lateralesConError += 1;
    if (v.sesionCabecera) cuenta(lateralesPorSesion, v.sesionCabecera);
    else lateralesSinCabecera += 1;
  }

  // 4) Por sesión.
  interface Acc {
    proyecto: string;
    turnos: TurnoTranscript[];
  }
  const porSesion = new Map<string, Acc>();
  for (const t of turnosDia) {
    const a = porSesion.get(t.sessionId) ?? porSesion.set(t.sessionId, { proyecto: t.proyecto, turnos: [] }).get(t.sessionId)!;
    a.turnos.push(t);
  }

  const sesiones: SesionConciliada[] = [];
  const fisuras: string[] = [];
  let totalTurnos = 0;
  let totalVistos = 0;
  let totalFugasSinPrecio = 0;
  let dineroFuera = 0;
  let dineroTotal = 0;
  for (const sessionId of [...porSesion.keys()].sort(cmp)) {
    const a = porSesion.get(sessionId)!;
    const modelos = new Map<string, number>();
    const clientes = new Map<string, number>();
    let vistos = 0;
    let fugasSinPrecio = 0;
    let subagentes = 0;
    let fuera = 0;
    let total = 0;
    let primero = "";
    let ultimo = "";
    // El proyecto de la sesión es el cwd de su PRIMER turno principal (no
    // subagente): los subagentes corren en subdirectorios y la moda etiquetaba
    // una sesión de privacy-gateway como «web». Sin turnos principales ese
    // día, la moda como respaldo (empate → el menor, determinista).
    const proyectos = new Map<string, number>();
    let principal: TurnoTranscript | null = null;
    for (const t of a.turnos) {
      if (!t.subagente && (principal === null || cmp(t.timestamp, principal.timestamp) < 0)) principal = t;
      cuenta(modelos, t.model);
      cuenta(clientes, t.version ?? "?");
      cuenta(proyectos, t.proyecto);
      if (t.subagente) subagentes += 1;
      if (!primero || cmp(t.timestamp, primero) < 0) primero = t.timestamp;
      if (!ultimo || cmp(t.timestamp, ultimo) > 0) ultimo = t.timestamp;
      const dinero = dineroDe(t);
      if (dinero !== null) total += dinero;
      if (vistoPorId.has(t.requestId)) {
        vistos += 1;
      } else if (dinero === null) {
        fugasSinPrecio += 1;
      } else {
        fuera += dinero;
      }
    }
    const turnos = a.turnos.length;
    const fugas = turnos - vistos;
    const estado: EstadoSesion = vistos === 0 ? "sin-encadenar" : fugas === 0 ? "encadenada" : "parcial";
    const proyecto =
      principal?.proyecto ?? [...proyectos.entries()].sort(([ka, na], [kb, nb]) => nb - na || cmp(ka, kb))[0]![0];
    const laterales = lateralesPorSesion.get(sessionId) ?? 0;
    const sinPrecio = fugasSinPrecio ? ` (+${fugasSinPrecio} turnos sin precio)` : "";
    if (estado === "sin-encadenar")
      fisuras.push(`sesión ${sessionId} (${proyecto}) sin encadenar: ${turnos} turnos, $${r4(fuera)} fuera del A/B${sinPrecio}`);
    else if (estado === "parcial")
      fisuras.push(
        `sesión ${sessionId} (${proyecto}) parcial: ${fugas} de ${turnos} turnos fuera del corpus, $${r4(fuera)} fuera del A/B${sinPrecio}`,
      );
    sesiones.push({
      sessionId,
      proyecto,
      estado,
      turnos,
      vistos,
      fugas,
      fugasSinPrecio,
      laterales,
      subagentes,
      dineroFueraUsd: r4(fuera),
      dineroTotalUsd: r4(total),
      primerTurno: primero,
      ultimoTurno: ultimo,
      modelos: objetoOrdenado(modelos),
      clientes: objetoOrdenado(clientes),
    });
    totalTurnos += turnos;
    totalVistos += vistos;
    totalFugasSinPrecio += fugasSinPrecio;
    dineroFuera += fuera;
    dineroTotal += total;
  }

  // Laterales cuya cabecera no es ninguna sesión con turnos ese día.
  let lateralesHuerfanos = lateralesSinCabecera;
  for (const [sid, n] of lateralesPorSesion) if (!porSesion.has(sid)) lateralesHuerfanos += n;

  // 5) Fisuras globales, en texto llano.
  const fugas = totalTurnos - totalVistos;
  const pct = totalTurnos > 0 ? r1((fugas / totalTurnos) * 100) : 0;
  if (totalTurnos === 0) fisuras.push("día sin turnos en los transcripts: nada que conciliar");
  else if (totalVistos === 0)
    fisuras.push("espía sin ninguna petición del día: espía caído o ninguna sesión encadenada — el día entero queda fuera del A/B");
  if (fugas > 0)
    fisuras.push(
      `día con fugas: ${pct} % de los turnos de la org no están en el corpus (${fugas} de ${totalTurnos}, $${r4(dineroFuera)} de $${r4(dineroTotal)})${
        totalFugasSinPrecio ? ` — ${totalFugasSinPrecio} fugas sin precio no suman` : ""
      }`,
    );
  // Espía MUDO a media jornada: turnos del transcript claramente posteriores al
  // último registro del espía. No dice si el espía cayó o si nadie se encadenó
  // después, pero sí desde cuándo no entra nada — el dato que el operador
  // necesita para elegir entre resucitar el espía y reencadenar sesiones.
  if (ultimoAtEspia !== null && totalVistos > 0) {
    const limite = new Date(new Date(ultimoAtEspia).getTime() + 5 * 60_000).toISOString();
    const posteriores = turnosDia.filter((t) => cmp(t.timestamp, limite) > 0 && !vistoPorId.has(t.requestId));
    if (posteriores.length) {
      const dinero = posteriores.reduce((s, t) => s + (dineroDe(t) ?? 0), 0);
      fisuras.push(
        `espía mudo desde ${ultimoAtEspia}: ${posteriores.length} turnos ($${r4(dinero)}) posteriores sin rastro — ¿espía caído o sesiones nuevas sin encadenar?`,
      );
    }
  }

  return {
    global: {
      dia,
      sesiones: sesiones.length,
      turnos: totalTurnos,
      vistos: totalVistos,
      fugas,
      fugasSinPrecio: totalFugasSinPrecio,
      pctTurnosFuera: pct,
      dineroFueraUsd: r4(dineroFuera),
      dineroTotalUsd: r4(dineroTotal),
      lateralesSinTranscript,
      lateralesHuerfanos,
      lateralesConError,
      deOtroDia,
      primerAtEspia,
      ultimoAtEspia,
      fisuras,
    },
    porSesion: sesiones,
  };
}
