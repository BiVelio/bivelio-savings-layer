import type { IncomingMessage, ServerResponse } from "node:http";

import type { SavingsReport } from "../src/contracts/types.js";

/**
 * EL BUZÓN DE INFORMES LOCALES — el `SavingsReport` de cada petición, de vuelta
 * al cliente que lo pide, en cualquier lenguaje.
 *
 * Hasta aquí el gateway medía cada petición y mandaba su informe a la ingesta
 * (el panel), pero el cliente que hizo la petición no veía nada: un script de
 * Python sabía lo que había gastado solo abriendo el panel. El SDK de
 * TypeScript devuelve un `SavingsReport` por llamada; esto es lo mismo para
 * quien llega por el gateway (docs/investigacion/2026-09-27/python.md).
 *
 * Reglas, y por qué:
 *
 *   · OPT-IN POR PETICIÓN. Solo una petición que trae `x-bvsala-report: 1`
 *     abre buzón. Sin esa cabecera no cambia NADA: ni una cabecera de más en la
 *     respuesta, ni un byte guardado. Claude Code, Codex y el resto siguen
 *     exactamente como estaban.
 *   · LA CABECERA ES DEL GATEWAY, NO DEL PROVEEDOR. Se retira antes de reenviar
 *     (es la única excepción al «todo lo que manda tu cliente viaja», y es una
 *     cabecera que el cliente dirige al gateway). La respuesta lleva
 *     `x-bvsala-request-id` con el id con el que el gateway registró la petición.
 *   · NADA SE CALCULA AQUÍ. El informe guardado es EL MISMO objeto que el
 *     gateway encoló para la ingesta (`emisor.record`): los números del panel,
 *     al precio de lista del catálogo, con el contador del proveedor. Si no se
 *     midió, el buzón dice por qué con el mismo motivo que la línea de log.
 *   · SOLO LOCAL. Las rutas `/_bvsala/v1/…` se atienden en el proceso y jamás
 *     viajan al upstream; el gateway escucha solo en 127.0.0.1. No hay CORS, y
 *     un `Host` que no sea de loopback recibe 403: una página con un nombre que
 *     resuelva a 127.0.0.1 (DNS rebinding) sería «mismo origen» para el
 *     navegador, y sin esa comprobación podría leerlas. Además no hay ruta que
 *     liste informes: sin el id (un UUID, o el id del proveedor) no hay informe.
 *     Van DETRÁS de la verja de licencia, como cualquier ruta: sin licencia, 402.
 *   · MEMORIA ACOTADA. Como mucho `capacidad` informes (por defecto 1000), el
 *     más viejo sale primero, y ninguno vive más de una hora.
 *   · LA SOMBRA NO ENTRA. Los informes `shadow` son hipotéticos y van aparte;
 *     el buzón solo guarda lo que la petición costó o evitó de verdad.
 */

/** La cabecera con la que un cliente pide su informe. Se retira antes de reenviar. */
export const CABECERA_PIDE_INFORME = "x-bvsala-report";
/** La cabecera de la respuesta con el id con que el gateway registró la petición. */
export const CABECERA_ID_DE_PETICION = "x-bvsala-request-id";
/** El prefijo de las rutas que atiende el gateway y nunca reenvía. */
export const PREFIJO_LOCAL = "/_bvsala/";
export const ESQUEMA_INFORME = "bvsala.gateway.report/1";
export const ESQUEMA_ESTADO = "bvsala.gateway.status/1";
export const ESQUEMA_RESUMEN = "bvsala.gateway.summary/1";
export const CAPACIDAD_POR_DEFECTO = 1000;
/** Lo más que una petición al buzón espera a que su informe se cierre. */
export const ESPERA_MAXIMA_MS = 30_000;
const VIDA_MAXIMA_MS = 60 * 60 * 1000;
/** Lo más que el vigía de id lee de un stream antes de rendirse (el id va en el primer evento). */
const MAX_BYTES_VIGIA = 256 * 1024;
/** Los ids que se aceptan: los de los proveedores (msg_…, chatcmpl-…, resp_…) y los UUID propios. */
const ID_SEGURO = /^[A-Za-z0-9._:-]{1,200}$/;

/** ¿Pidió esta petición su informe? Solo `1` o `true`: cualquier otra cosa es no. */
export function pideInforme(v: string | string[] | undefined): boolean {
  const s = (Array.isArray(v) ? v[0] : v)?.trim().toLowerCase();
  return s === "1" || s === "true";
}

export type EstadoDelInforme = "pending" | "metered" | "not_metered";

/** Lo que devuelve `GET /_bvsala/v1/reports/…`. Campos en inglés: es cable. */
export interface InformeLocal {
  schema: typeof ESQUEMA_INFORME;
  /** El id con el que el gateway registró la petición (el `requestId` del informe). */
  requestId: string;
  /** El `id` de la respuesta del proveedor (msg_…, chatcmpl-…, resp_…), si se vio. */
  responseId: string | null;
  path: string;
  status: EstadoDelInforme;
  /** Por qué no se midió, con las palabras de la línea de log. null si se midió o sigue en curso. */
  reason: string | null;
  /** El informe que el gateway encoló para el panel. null si no se midió o sigue en curso. */
  report: SavingsReport | null;
}

interface Entrada {
  informe: InformeLocal;
  abiertaMs: number;
}

/**
 * El buzón: un mapa acotado por id de petición y un índice por id de respuesta.
 * Todas las operaciones sobre un id que no se abrió son no-op, así que el
 * servidor puede llamarlas sin preguntar si la petición pidió informe.
 */
export class BuzonDeInformes {
  private readonly entradas = new Map<string, Entrada>();
  private readonly porRespuestaId = new Map<string, string>();
  private readonly oyentes = new Set<() => void>();
  private readonly capacidad: number;
  private readonly now: () => number;

  constructor(opts: { capacidad?: number; now?: () => number } = {}) {
    this.capacidad = Math.max(1, Math.floor(opts.capacidad ?? CAPACIDAD_POR_DEFECTO));
    this.now = opts.now ?? Date.now;
  }

  get tamano(): number {
    return this.entradas.size;
  }

  get limite(): number {
    return this.capacidad;
  }

  abrir(requestId: string, path: string): void {
    this.purgar();
    while (this.entradas.size >= this.capacidad) {
      const masVieja = this.entradas.keys().next().value;
      if (masVieja === undefined) break;
      this.quitar(masVieja);
    }
    this.entradas.set(requestId, {
      informe: { schema: ESQUEMA_INFORME, requestId, responseId: null, path, status: "pending", reason: null, report: null },
      abiertaMs: this.now(),
    });
    this.avisar();
  }

  /** El id de la respuesta del proveedor. El primero manda: un stream no cambia de id. */
  anotarRespuesta(requestId: string, responseId: string | null | undefined): void {
    const e = this.entradas.get(requestId);
    if (!e || e.informe.responseId !== null || !responseId || !ID_SEGURO.test(responseId)) return;
    e.informe.responseId = responseId;
    // Una gemela coalescida comparte id de respuesta con su primaria: el índice
    // apunta a la ÚLTIMA, y la primaria sigue alcanzable por su id de petición.
    this.porRespuestaId.set(responseId, requestId);
    this.avisar();
  }

  medido(requestId: string, report: SavingsReport): void {
    this.cerrar(requestId, "metered", null, report);
  }

  noMedido(requestId: string, reason: string): void {
    this.cerrar(requestId, "not_metered", reason, null);
  }

  /**
   * Lo que el buzón guarda AHORA (lo caducado ya fuera), en orden de llegada.
   * Solo para agregar (`resumenLocal`): ninguna ruta devuelve esta lista.
   */
  vigentes(): readonly InformeLocal[] {
    this.purgar();
    return [...this.entradas.values()].map((e) => e.informe);
  }

  porPeticion(requestId: string): InformeLocal | undefined {
    this.purgar();
    return this.entradas.get(requestId)?.informe;
  }

  porRespuesta(responseId: string): InformeLocal | undefined {
    this.purgar();
    const id = this.porRespuestaId.get(responseId);
    return id === undefined ? undefined : this.entradas.get(id)?.informe;
  }

  /**
   * Espera hasta `ms` a que `buscar` devuelva un informe CERRADO. Devuelve lo
   * último que vio: el informe cerrado, uno todavía `pending` si se acabó el
   * tiempo, o `undefined` si nunca apareció. `señal` corta la espera si el
   * cliente se va.
   */
  esperar(buscar: () => InformeLocal | undefined, ms: number, senal?: AbortSignal): Promise<InformeLocal | undefined> {
    const listo = (i: InformeLocal | undefined): boolean => i !== undefined && i.status !== "pending";
    const ya = buscar();
    if (listo(ya) || ms <= 0 || senal?.aborted) return Promise.resolve(ya);
    return new Promise((resolve) => {
      let hecho = false;
      const terminar = (): void => {
        if (hecho) return;
        hecho = true;
        clearTimeout(reloj);
        this.oyentes.delete(oyente);
        senal?.removeEventListener("abort", terminar);
        resolve(buscar());
      };
      const oyente = (): void => {
        if (listo(buscar())) terminar();
      };
      const reloj = setTimeout(terminar, Math.min(ms, ESPERA_MAXIMA_MS));
      this.oyentes.add(oyente);
      senal?.addEventListener("abort", terminar);
    });
  }

  private cerrar(requestId: string, status: Exclude<EstadoDelInforme, "pending">, reason: string | null, report: SavingsReport | null): void {
    const e = this.entradas.get(requestId);
    // El primer cierre manda: una petición se mide una vez.
    if (!e || e.informe.status !== "pending") return;
    e.informe.status = status;
    e.informe.reason = reason;
    // Una copia: lo que el cliente lee es lo que se encoló, aunque alguien
    // tocara el objeto después.
    e.informe.report = report === null ? null : structuredClone(report);
    this.avisar();
  }

  private quitar(requestId: string): void {
    const e = this.entradas.get(requestId);
    this.entradas.delete(requestId);
    const rid = e?.informe.responseId;
    if (rid && this.porRespuestaId.get(rid) === requestId) this.porRespuestaId.delete(rid);
  }

  private purgar(): void {
    const limite = this.now() - VIDA_MAXIMA_MS;
    for (const [id, e] of this.entradas) {
      // Orden de inserción: la primera que no ha caducado cierra la búsqueda.
      if (e.abiertaMs >= limite) break;
      this.quitar(id);
    }
  }

  private avisar(): void {
    for (const o of [...this.oyentes]) o();
  }
}

/**
 * El `id` de una respuesta del proveedor dentro de un JSON: el del cuerpo
 * (Messages, Chat Completions, Responses), el de `message_start` de Anthropic
 * (`message.id`) o el de los eventos de Responses (`response.id`).
 */
export function idDeRespuesta(json: unknown): string | null {
  if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as { id?: unknown; message?: { id?: unknown } | null; response?: { id?: unknown } | null };
  for (const c of [o.message?.id, o.response?.id, o.id]) {
    if (typeof c === "string" && ID_SEGURO.test(c)) return c;
  }
  return null;
}

/** El id de un cuerpo JSON ya servido. Nunca lanza. */
export function idDeCuerpoJson(cuerpo: Buffer): string | null {
  try {
    return idDeRespuesta(JSON.parse(cuerpo.toString("utf8")));
  } catch {
    return null;
  }
}

/**
 * Lee el id de respuesta de un stream SSE SIN tocarlo: el primer `data:` con
 * id (el primer evento, en los tres dialectos). Solo corre en peticiones que
 * pidieron informe, y deja de leer en cuanto lo tiene.
 */
export class VigiaDeIdDeRespuesta {
  private resto = "";
  private leidos = 0;
  private id: string | null = null;

  observar(chunk: Buffer | string): void {
    if (this.id !== null || this.leidos > MAX_BYTES_VIGIA) return;
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    this.leidos += s.length;
    this.resto += s;
    let idx: number;
    while ((idx = this.resto.indexOf("\n")) >= 0) {
      const linea = this.resto.slice(0, idx).replace(/\r$/, "");
      this.resto = this.resto.slice(idx + 1);
      if (!linea.startsWith("data:")) continue;
      const data = linea.slice(5).trim();
      if (data === "" || data === "[DONE]") continue;
      try {
        const id = idDeRespuesta(JSON.parse(data));
        if (id !== null) {
          this.id = id;
          this.resto = "";
          return;
        }
      } catch {
        /* un data ilegible no puede tumbar el passthrough */
      }
    }
    if (this.leidos > MAX_BYTES_VIGIA) this.resto = "";
  }

  valor(): string | null {
    return this.id;
  }
}

/** Lo que `GET /_bvsala/v1/status` cuenta del gateway. Nada secreto: ni claves, ni org, ni jti. */
export interface EstadoLocal {
  schema: typeof ESQUEMA_ESTADO;
  gateway: "bvsala";
  version: string;
  /** Solo el ORIGEN del upstream, sin credenciales ni ruta. */
  upstream: string;
  license: { state: string; plan: string | null; expiresAt: string | null };
  /** Si hay clave de servicio: sin ella nada se mide ni se registra. */
  metering: boolean;
  reports: { requestHeader: string; responseHeader: string; capacity: number };
}

// ── EL RESUMEN (D12): agregados, nunca informes ─────────────────────────────
//
// Lo lee el servidor MCP de solo lectura (gateway/mcp.ts) por
// `GET /_bvsala/v1/summary`. Es una SUMA de lo que el buzón ya guarda, y lo que
// no devuelve es tan importante como lo que sí:
//   · ni un requestId ni un responseId: sin el id no hay informe (la regla del
//     buzón sigue intacta), y un agregado no se puede usar para pedir uno;
//   · ni contenido: de cada informe se leen contadores, la base del coste, el
//     modelo, el motivo de no medido y los CÓDIGOS de decisión de la cola;
//   · dinero de bases distintas jamás sumado: `measured`, `reference`,
//     `estimated`… van cada uno en su cubo, como en el panel.
// La «sesión» es la de Claude Code (`attribution.sessionId`, un id opaco que el
// propio informe ya lleva); sin ella, `unattributed`.

/** Un cubo de dinero: una sola base de coste. */
export interface CuboDeCoste {
  requests: number;
  actualUsd: number;
  baselineUsd: number;
  netSavingsUsd: number;
}

export interface ResumenDeSesion {
  /** El `attribution.sessionId` del informe, o `null` sin atribución. */
  sessionId: string | null;
  requests: { total: number; metered: number; notMetered: number; pending: number };
  /** Por base de coste: nunca se suman entre sí. */
  costByBasis: Record<string, CuboDeCoste>;
  /** Por qué no se midió, con su número de peticiones. */
  notMeteredReasons: Record<string, number>;
  models: Record<string, number>;
}

export interface OportunidadesDeCompactacion {
  /** Cuántos tool outputs trajeron una decisión de `lossless-data`. */
  decisions: number;
  applied: number;
  /** Por código de motivo (`applied`, `not_json`, `duplicate_keys`…). */
  byReason: Record<string, number>;
  /** Tokens ESTIMADOS antes y después de lo aplicado. Nunca un ahorro verificado. */
  appliedTokensBefore: number;
  appliedTokensAfter: number;
  tokenBasis: "estimated";
}

export interface ResumenLocal {
  schema: typeof ESQUEMA_RESUMEN;
  /** La ventana: lo que el buzón guarda (los últimos `capacity`, una hora como mucho). */
  window: { reports: number; capacity: number; maxAgeMinutes: number };
  sessions: ResumenDeSesion[];
  toolOutputCompaction: OportunidadesDeCompactacion;
}

const cubo = (): CuboDeCoste => ({ requests: 0, actualUsd: 0, baselineUsd: 0, netSavingsUsd: 0 });
const numero = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
// Un código de motivo o un nombre de modelo es metadato; aun así, acotado y sin
// saltos de línea, para que un valor raro no se convierta en un canal.
const etiqueta = (v: unknown, max = 120): string | null => {
  if (typeof v !== "string") return null;
  const t = v.replace(/[\u0000-\u001f]/g, " ").trim();
  return t === "" ? null : t.slice(0, max);
};
const sumar = (m: Record<string, number>, k: string, n = 1) => {
  m[k] = (m[k] ?? 0) + n;
};

/** El resumen del buzón: agregados por sesión y las decisiones de la cola. Pura. */
export function resumenLocal(informes: readonly InformeLocal[], capacidad: number): ResumenLocal {
  const sesiones = new Map<string | null, ResumenDeSesion>();
  const compactacion: OportunidadesDeCompactacion = {
    decisions: 0,
    applied: 0,
    byReason: {},
    appliedTokensBefore: 0,
    appliedTokensAfter: 0,
    tokenBasis: "estimated",
  };
  for (const i of informes) {
    const r = i.report;
    const sid = etiqueta(r?.attribution?.sessionId, 200);
    let s = sesiones.get(sid);
    if (!s) {
      s = { sessionId: sid, requests: { total: 0, metered: 0, notMetered: 0, pending: 0 }, costByBasis: {}, notMeteredReasons: {}, models: {} };
      sesiones.set(sid, s);
    }
    s.requests.total++;
    if (i.status === "pending") {
      s.requests.pending++;
      continue;
    }
    if (i.status === "not_metered" || !r) {
      s.requests.notMetered++;
      sumar(s.notMeteredReasons, etiqueta(i.reason) ?? "unknown");
      continue;
    }
    s.requests.metered++;
    const modelo = etiqueta(r.model);
    if (modelo) sumar(s.models, modelo);
    const base = etiqueta(r.cost?.basis, 40) ?? "unknown";
    const c = (s.costByBasis[base] ??= cubo());
    c.requests++;
    c.actualUsd += numero(r.cost?.actual);
    c.baselineUsd += numero(r.cost?.baselineEstimate);
    c.netSavingsUsd += numero(r.cost?.netSavingsUsd);
    for (const d of r.toolOutputCompaction?.decisions ?? []) {
      compactacion.decisions++;
      sumar(compactacion.byReason, etiqueta(d.reason, 40) ?? "unknown");
      if (d.status === "applied") {
        compactacion.applied++;
        compactacion.appliedTokensBefore += numero(d.tokensBefore);
        compactacion.appliedTokensAfter += numero(d.tokensAfter);
      }
    }
  }
  return {
    schema: ESQUEMA_RESUMEN,
    window: { reports: informes.length, capacity: capacidad, maxAgeMinutes: VIDA_MAXIMA_MS / 60_000 },
    sessions: [...sesiones.values()],
    toolOutputCompaction: compactacion,
  };
}

/** El origen de una URL sin usuario ni contraseña. Una URL ilegible se dice tal cual: "unknown". */
export function origenPublico(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "unknown";
  }
}

/** ¿Es esta una ruta local del gateway? Devuelve la ruta y la query, o null. */
export function rutaLocal(reqUrl: string | undefined): URL | null {
  let u: URL;
  try {
    u = new URL(reqUrl ?? "/", "http://127.0.0.1");
  } catch {
    return null;
  }
  return u.pathname.startsWith(PREFIJO_LOCAL) ? u : null;
}

/** Los nombres con los que un cliente local llama al gateway. */
const HOSTS_LOCALES = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** ¿Viene la petición a nombre de loopback? Sin `Host` (HTTP/1.0) se acepta: el socket ya es local. */
export function hostLocal(host: string | undefined): boolean {
  if (host === undefined || host === "") return true;
  let nombre: string;
  try {
    nombre = new URL(`http://${host}`).hostname.toLowerCase();
  } catch {
    return false;
  }
  return HOSTS_LOCALES.has(nombre);
}

function responderJson(res: ServerResponse, status: number, cuerpo: unknown): void {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(cuerpo));
}

function error(res: ServerResponse, status: number, tipo: string, mensaje: string): void {
  responderJson(res, status, { type: "error", error: { type: tipo, message: mensaje } });
}

/**
 * Atiende una ruta local. Las rutas:
 *
 *   GET /_bvsala/v1/status
 *   GET /_bvsala/v1/summary            (agregados, sin ids ni contenido: D12)
 *   GET /_bvsala/v1/reports/<requestId>[?wait_ms=N]
 *   GET /_bvsala/v1/reports?response_id=<id>[&wait_ms=N]
 *
 * Mensajes en inglés: los lee el cliente.
 */
export async function atenderRutaLocal(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  ctx: { buzon: BuzonDeInformes; estado: () => EstadoLocal },
): Promise<void> {
  req.resume();
  if (!hostLocal(req.headers.host)) {
    error(res, 403, "forbidden", "bvsala gateway: local routes answer only to 127.0.0.1 or localhost");
    return;
  }
  if (req.method !== "GET") {
    res.setHeader("allow", "GET");
    error(res, 405, "method_not_allowed", "bvsala gateway: local routes only answer GET");
    return;
  }
  if (url.pathname === "/_bvsala/v1/status") {
    responderJson(res, 200, ctx.estado());
    return;
  }
  if (url.pathname === "/_bvsala/v1/summary") {
    responderJson(res, 200, resumenLocal(ctx.buzon.vigentes(), ctx.buzon.limite));
    return;
  }
  const espera = Number(url.searchParams.get("wait_ms") ?? "0");
  if (!Number.isFinite(espera) || espera < 0) {
    error(res, 400, "invalid_request", "bvsala gateway: wait_ms must be a non-negative number of milliseconds");
    return;
  }
  const ms = Math.min(Math.floor(espera), ESPERA_MAXIMA_MS);
  const corte = new AbortController();
  res.on("close", () => corte.abort());

  let buscar: (() => InformeLocal | undefined) | null = null;
  let quien = "";
  const m = /^\/_bvsala\/v1\/reports\/([^/]+)$/.exec(url.pathname);
  if (m) {
    let id = "";
    try {
      id = decodeURIComponent(m[1]!);
    } catch {
      id = "";
    }
    if (!ID_SEGURO.test(id)) {
      error(res, 400, "invalid_request", "bvsala gateway: malformed request id");
      return;
    }
    buscar = () => ctx.buzon.porPeticion(id);
    quien = `request id ${id}`;
  } else if (url.pathname === "/_bvsala/v1/reports") {
    const rid = url.searchParams.get("response_id") ?? "";
    if (!ID_SEGURO.test(rid)) {
      error(res, 400, "invalid_request", "bvsala gateway: pass ?response_id=<the id of the provider's response>");
      return;
    }
    buscar = () => ctx.buzon.porRespuesta(rid);
    quien = `response id ${rid}`;
  }
  if (buscar === null) {
    error(res, 404, "not_found", `bvsala gateway: no local route ${url.pathname}`);
    return;
  }
  const informe = await ctx.buzon.esperar(buscar, ms, corte.signal);
  if (res.destroyed) return;
  if (informe === undefined) {
    error(
      res,
      404,
      "not_found",
      `bvsala gateway: no report for ${quien}. Reports exist only for requests sent with the header ` +
        `"${CABECERA_PIDE_INFORME}: 1", while this gateway process keeps them (the last ${ctx.buzon.limite}, one hour at most).`,
    );
    return;
  }
  responderJson(res, 200, informe);
}
