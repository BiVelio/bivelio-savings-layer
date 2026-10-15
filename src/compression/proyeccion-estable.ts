import { heuristicEstimator } from "../tokenizer/estimator.js";
import { sha256, sha256DeBytes } from "../util/hash.js";
import { recorrerJsonEstricto } from "../util/json-estricto.js";
import {
  compactToolOutput,
  DEFAULT_MIN_SAVED_CHARS,
  LOSSLESS_JSON_TRANSFORM_ID,
  LOSSLESS_JSON_VERSION,
  type ToolOutputDecisionReason,
} from "./cola.js";
import type { AlmacenRecuperable, AmbitoRecuperable } from "../retrieval/almacen-recuperable.js";
import type {
  AlmacenDeElecciones,
  ClaveDeRama,
  ClaveDeSegmento,
  EleccionPersistida,
  EstadoDeRama,
} from "../retrieval/elecciones-persistidas.js";

/**
 * Proyección estable (D06 del plan Caveman 2026-10-14) para la ruta piloto:
 * Anthropic Messages SIN stream, a través del SDK.
 *
 * Toma el cuerpo de la petición tal como lo tiene el llamante (su historial
 * canónico) y devuelve una COPIA para mandar al proveedor en la que solo puede
 * cambiar el `content` de algunos `tool_result`, más —solo en modo
 * recuperable con un ejecutor registrado— una herramienta añadida al final de
 * `tools`. Todo lo demás sale idéntico: system, user, assistant, `tool_use`
 * con sus ids y argumentos, bloques de pensamiento firmados o redactados,
 * `cache_control` (también el del propio `tool_result`), `is_error`. Se
 * comprueba antes de devolver.
 *
 * QUÉ DECIDE, Y CUÁNDO:
 *  · Un `tool_result` solo se decide AL NACER: cuando está detrás del último
 *    `assistant` (llegó en esta petición). Uno anterior sin elección guardada
 *    ya se mandó tal cual en un turno previo, y cambiarlo ahora rompería la
 *    caché de prefijo: se fija como `identity`.
 *  · La decisión se GUARDA (elecciones persistidas) y cada turno siguiente
 *    manda los mismos bytes mientras sigan autorizados. Por eso el segundo
 *    turno lleva el mismo hash y la caché de prefijo sigue casando.
 *  · JSON estricto: solo el compacto sin omisiones de D03 (`json-lossless`).
 *    Nunca se omite nada de un JSON.
 *  · Texto grande (logs, salidas de tests) en modo `recoverable`: una vista
 *    previa determinista (cabeza, líneas con señales de fallo, cola) con un
 *    handle; el original exacto va al almacén recuperable de D04 ANTES de
 *    devolver la vista previa, y se verifica su sha256.
 *  · Sin recuperación comprobada no hay omisiones: sin ejecutor, sin almacén,
 *    con `tool_choice: none`, con un nombre de herramienta que choca, segmento
 *    de más de 1 MiB o almacén lleno → JSON sin omisiones o el original.
 *
 * HISTORIA Y ÉPOCAS:
 *  · Añadir mensajes al final conserva la época.
 *  · Editar, reordenar o bifurcar (el manifiesto de la rama ya no es prefijo)
 *    abre época nueva: las elecciones de la vieja no se reutilizan y la
 *    historia se manda como la tiene el llamante.
 *  · Antes de cada envío se revalida la huella de política VIGENTE contra
 *    todas las sustituciones que se reenviarían. Si alguna se decidió bajo
 *    otra política, nunca se reenvían sus bytes: se reconstruye en época
 *    nueva (por defecto) o se deniega (`alCambiarPolitica: "denegar"`).
 *    Igual si una sustitución con omisiones ya no es recuperable (handle
 *    caducado, sin ejecutor): se reconstruye.
 *  · Una revisión nueva del adaptador no reescribe la historia viva: lo
 *    vigente se sigue mandando y lo que propondría la revisión nueva queda
 *    como registro de sombra.
 *
 * MODOS: `off` (por defecto; ni toca el cuerpo ni lee almacenes), `record`
 * (decide y lo cuenta en el informe, pero manda el cuerpo original y no
 * escribe nada), `lossless` (solo JSON sin omisiones, persistido) y
 * `recoverable`.
 *
 * Un fallo de autorización o de política no se salta: lanza
 * {@link ErrorDeProyeccion} y no hay envío. Las cifras de tokens son
 * estimaciones (`basis: "estimated"`), nunca ahorro verificado.
 *
 * El ámbito (tenant, proyecto, sesión, rama) tiene que venir de la identidad
 * autenticada del llamante, nunca del cuerpo.
 */

export type ModoDeProyeccion = "off" | "record" | "lossless" | "recoverable";

/** Nombre de la herramienta de recuperación que ve el modelo. */
export const HERRAMIENTA_DE_RECUPERACION = "bvsala_retrieve";
/** Revisión del adaptador de esta ruta. Cambiar la salida para la misma entrada la sube. */
export const REVISION_DEL_ADAPTADOR = "anthropic-messages/proyeccion-1";
export const VISTA_PREVIA_TRANSFORM_ID = "recoverable-preview";
export const VISTA_PREVIA_VERSION = "1";
export const IDENTIDAD_TRANSFORM_ID = "identity";

/** Bytes a partir de los cuales un texto (no JSON) es candidato a vista previa. */
export const UMBRAL_RECUPERABLE_POR_DEFECTO = 16 * 1024;
/** Guardarraíles del piloto (plan p. 10): 1 MiB por segmento, 8 MiB por petición. */
export const MAXIMO_POR_SEGMENTO = 1024 * 1024;
export const MAXIMO_POR_PETICION = 8 * 1024 * 1024;
/** Lease de tarea: lo que se fija un handle cada vez que se manda (plan p. 6: hasta 2 h). */
export const LEASE_POR_DEFECTO_MS = 2 * 60 * 60 * 1000;

export const ESQUEMA_DE_RECUPERACION = Object.freeze({
  name: HERRAMIENTA_DE_RECUPERACION,
  description:
    "Returns the exact original of a tool result that was shortened. Call it with the handle shown in the shortened " +
    "result when you need content that was omitted. Optional start_line/end_line (1-based, inclusive) return only " +
    "those lines.",
  input_schema: {
    type: "object",
    properties: {
      handle: { type: "string" },
      start_line: { type: "integer", minimum: 1 },
      end_line: { type: "integer", minimum: 1 },
    },
    required: ["handle"],
    additionalProperties: false,
  },
});

export type CodigoDeErrorDeProyeccion = "invalid_request" | "idempotency_conflict" | "policy_changed" | "epoch_changed";

/** Lo que detiene una proyección: no hay envío, ni bypass que lo salte. */
export class ErrorDeProyeccion extends Error {
  constructor(
    readonly code: CodigoDeErrorDeProyeccion,
    mensaje: string,
  ) {
    super(`[bvsala] ${code}: ${mensaje}`);
    this.name = "ErrorDeProyeccion";
  }
}

export interface ResultadoDeHerramienta {
  content: string;
  is_error: boolean;
}

/**
 * Quien ejecuta de verdad la herramienta de recuperación. Solo si el llamante
 * registra uno se ofrece la herramienta al modelo: nunca un schema sin ejecutor.
 */
export interface EjecutorDeRecuperacion {
  recuperar(ambito: AmbitoRecuperable, politica: string, input: unknown): Promise<ResultadoDeHerramienta>;
}

export interface OpcionesDeProyeccion {
  /** Por defecto `off`. */
  modo?: ModoDeProyeccion;
  /** De la identidad autenticada, nunca del cuerpo. */
  ambito: ClaveDeRama;
  /** Huella de la política de privacidad vigente. Obligatoria. */
  politica: string;
  elecciones: AlmacenDeElecciones;
  /** Donde va el original de lo que se omite (D04). */
  almacen?: AlmacenRecuperable;
  /** El ejecutor real de la recuperación. Sin él no se omite nada ni se ofrece la herramienta. */
  ejecutor?: EjecutorDeRecuperacion;
  /** Qué hacer si una sustitución histórica se decidió bajo otra política. Por defecto `reconstruir`. */
  alCambiarPolitica?: "reconstruir" | "denegar";
  adapterRevision?: string;
  umbralRecuperableBytes?: number;
  minSavedChars?: number;
  leaseMs?: number;
  contarTokens?: (texto: string) => number;
  /** Nombre del contador, para el informe. */
  tokenizer?: string;
  now?: () => number;
}

export type EstadoDeSegmento = "applied" | "reused" | "bypassed" | "recorded";

export type MotivoDeSegmento =
  | ToolOutputDecisionReason
  | "recoverable"
  | "would_recover"
  | "identity"
  | "born_before"
  | "is_error"
  | "unsupported_shape"
  | "recovery_result"
  | "segment_too_large"
  | "recovery_unavailable"
  | "store_rejected";

export interface DecisionDeSegmento {
  segmentId: string;
  status: EstadoDeSegmento;
  reason: MotivoDeSegmento;
  transformId: string;
  version: string;
  /** Si lo enviado omite algo y lleva handle (el handle no se informa). */
  recoverable: boolean;
  sourceSha256: string;
  replacementSha256: string;
  /** Estimados. */
  tokensBefore: number;
  tokensAfter: number;
  /** La elección vigente es de otra revisión del adaptador y la nueva quedó en sombra. */
  shadowRecorded?: boolean;
}

export type MotivoDeEpocaNueva = "history_rewritten" | "policy_changed" | "recovery_unavailable";

export interface InformeDeProyeccion {
  mode: ModoDeProyeccion;
  status: "applied" | "bypassed";
  /** `applied` cuando cambió algún byte; si no, por qué no. */
  reason: string;
  epoch: number | null;
  /** Por qué se abrió época nueva en esta petición, si se abrió. */
  epochOpened?: MotivoDeEpocaNueva;
  recoveryAvailable: boolean;
  recoveryToolInjected: boolean;
  adapterRevision: string;
  segments: DecisionDeSegmento[];
  estimate: {
    basis: "estimated";
    tokenizer: string;
    /** Tokens de los tool_result elegibles, antes y después. */
    inputBefore: number;
    inputAfter: number;
    /** El schema de la herramienta de recuperación, si se añadió. */
    overheadTokens: number;
  };
}

type Registro = Record<string, unknown>;

export interface Proyeccion {
  /** Lo que se manda. En `off` y `record`, el MISMO objeto que entró. */
  cuerpo: Registro;
  informe: InformeDeProyeccion;
  /** Ejecuta un `tool_use` de la herramienta de recuperación con el ámbito y la política de ESTA proyección. */
  ejecutar?: (input: unknown) => Promise<ResultadoDeHerramienta>;
}

export interface OpcionesDeLlamada {
  idempotencyKey?: string;
  /**
   * Ronda interna de un bucle de recuperación: la historia lleva al final
   * intercambios que el llamante puede no guardar, así que no se anotan en el
   * manifiesto de la rama.
   */
  interna?: boolean;
}

interface Segmento {
  segmentId: string;
  texto: string;
  sourceHash: string;
  indiceMensaje: number;
  indiceBloque: number;
  enLaCola: boolean;
  protegido?: MotivoDeSegmento;
  /** `string`: content es texto; `bloque`: content es [un bloque text]. */
  forma: "string" | "bloque";
}

interface Plan {
  segmento: Segmento;
  decision: DecisionDeSegmento;
  reemplazo?: string;
  handle?: string;
}

const RE_SENAL =
  /\b(error|errors|fail|failed|failure|failing|failures|exception|traceback|panic|fatal|warn|warning|warnings|exit code|exit status|assert|assertion|skipped)\b/i;
const LINEAS_DE_CABEZA = 20;
const LINEAS_DE_COLA = 20;
const MAXIMO_DE_SENALES = 20;
const LARGO_DE_LINEA = 240;
const utf8 = new TextEncoder();

/**
 * La vista previa determinista de un texto grande: función solo del texto y
 * del handle. Cabecera con el modo de recuperarlo, las primeras y las últimas
 * líneas, y en medio las líneas con señales de fallo (error, fail, warning,
 * exit code…) con su número de línea. Lo que omite lo dice.
 */
export function vistaPrevia(texto: string, handle: string): string {
  const lineas = texto.split("\n");
  const bytes = utf8.encode(texto).length;
  const corta = (l: string) => (l.length > LARGO_DE_LINEA ? `${l.slice(0, LARGO_DE_LINEA)}… [line truncated]` : l);
  const cabecera =
    `[bvsala: shortened tool result: ${lineas.length} lines, ${bytes} bytes. The exact original is available: ` +
    `call ${HERRAMIENTA_DE_RECUPERACION} with {"handle":"${handle}"} (optionally "start_line"/"end_line").]`;
  if (lineas.length <= LINEAS_DE_CABEZA + LINEAS_DE_COLA) {
    return [cabecera, "--- first lines ---", ...lineas.map(corta)].join("\n");
  }
  const medio = lineas.slice(LINEAS_DE_CABEZA, lineas.length - LINEAS_DE_COLA);
  const senales: string[] = [];
  let totalSenales = 0;
  medio.forEach((l, i) => {
    if (!RE_SENAL.test(l)) return;
    totalSenales++;
    if (senales.length < MAXIMO_DE_SENALES) senales.push(`L${LINEAS_DE_CABEZA + i + 1}: ${corta(l)}`);
  });
  const partes = [
    cabecera,
    `--- lines 1-${LINEAS_DE_CABEZA} ---`,
    ...lineas.slice(0, LINEAS_DE_CABEZA).map(corta),
    `--- ${medio.length} lines omitted (${LINEAS_DE_CABEZA + 1}-${lineas.length - LINEAS_DE_COLA}); ` +
      `${totalSenales} of them match error/fail/warning/exit markers` +
      (totalSenales > senales.length ? `, first ${senales.length} shown` : "") +
      " ---",
    ...senales,
    `--- lines ${lineas.length - LINEAS_DE_COLA + 1}-${lineas.length} ---`,
    ...lineas.slice(lineas.length - LINEAS_DE_COLA).map(corta),
  ];
  return partes.join("\n");
}

/** JSON canónico (claves ordenadas): el manifiesto no depende del orden en que el llamante serializa. */
function jsonCanonico(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(jsonCanonico).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Registro;
    return `{${Object.keys(o)
      .sort()
      .filter((k) => o[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${jsonCanonico(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function esRegistro(v: unknown): v is Registro {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function esJsonEstructurado(texto: string): boolean {
  const t = texto.trimStart();
  if (!(t.startsWith("{") || t.startsWith("["))) return false;
  return recorrerJsonEstricto(texto).ok;
}

function campoValido(v: unknown): v is string {
  return typeof v === "string" && v.length > 0 && v.length <= 256;
}

/**
 * El proyector de la ruta piloto. Uno por llamante (o por proceso); el estado
 * vive en los almacenes que se le pasan, no en él.
 */
export class ProyectorEstable {
  private readonly modo: ModoDeProyeccion;
  private readonly revision: string;
  private readonly umbral: number;
  private readonly minimo: number;
  private readonly lease: number;
  private readonly contar: (t: string) => number;
  private readonly tokenizer: string;
  private readonly now: () => number;

  constructor(private readonly o: OpcionesDeProyeccion) {
    this.modo = o.modo ?? "off";
    this.revision = o.adapterRevision ?? REVISION_DEL_ADAPTADOR;
    this.umbral = Math.max(1, Math.floor(o.umbralRecuperableBytes ?? UMBRAL_RECUPERABLE_POR_DEFECTO));
    this.minimo = Math.max(1, o.minSavedChars ?? DEFAULT_MIN_SAVED_CHARS);
    this.lease = Math.max(0, o.leaseMs ?? LEASE_POR_DEFECTO_MS);
    this.contar = o.contarTokens ?? ((t) => heuristicEstimator.count(t));
    this.tokenizer = o.tokenizer ?? (o.contarTokens ? "custom" : "heuristic");
    this.now = o.now ?? (() => Date.now());
  }

  async proyectar(cuerpo: Registro, llamada: OpcionesDeLlamada = {}): Promise<Proyeccion> {
    if (this.modo === "off") return { cuerpo, informe: this.informeVacio("off", null) };
    this.validar(cuerpo);
    if (cuerpo.stream === true) return { cuerpo, informe: this.informeVacio("unsupported_route", null) };
    if (utf8.encode(JSON.stringify(cuerpo)).length > MAXIMO_POR_PETICION) {
      return { cuerpo, informe: this.informeVacio("payload_budget", null) };
    }
    const grabando = this.modo === "record";
    const { ambito } = this.o;

    if (llamada.idempotencyKey !== undefined && !grabando) {
      if (!campoValido(llamada.idempotencyKey)) throw new ErrorDeProyeccion("invalid_request", "idempotencyKey inválida");
      const huella = sha256(jsonCanonico([cuerpo, this.modo, this.o.politica, this.revision]));
      const r = await this.o.elecciones.reservarIdempotencia(ambito, llamada.idempotencyKey, huella);
      if (r === "conflicto") {
        throw new ErrorDeProyeccion("idempotency_conflict", "la misma clave de idempotencia llegó con otro cuerpo");
      }
    }

    const mensajes = (cuerpo.messages as unknown[]).map((m) => sha256(jsonCanonico(m)));
    let { epoch, abierta, estado } = await this.epocaDe(mensajes, llamada.interna === true, grabando);
    const disponible = this.recuperacionDisponible(cuerpo);
    const segmentos = segmentosDe(cuerpo);

    // La revalidación: todo lo que se reenviaría, bajo la política de AHORA y
    // con su recuperación todavía en pie. La época nueva no tiene elecciones,
    // así que la segunda vuelta no debería fallar; si falla, no hay envío.
    for (let vuelta = 0; ; vuelta++) {
      const problema = await this.revalidar(segmentos, epoch, disponible);
      if (!problema) break;
      // Nunca se sigue con un problema sin resolver: eso reenviaría bytes no autorizados.
      if (vuelta >= 2) throw new ErrorDeProyeccion("epoch_changed", "la historia no se pudo revalidar ni en una época nueva");
      if (problema === "policy_changed" && this.o.alCambiarPolitica === "denegar") {
        throw new ErrorDeProyeccion("policy_changed", "una sustitución ya enviada se decidió bajo otra política; no se reenvía");
      }
      if (grabando) {
        epoch += 1;
      } else {
        const r = await this.abrirEpoca(estado, epoch);
        epoch = r.epoch;
        estado = r.estado;
      }
      abierta = problema;
    }

    const planes: Plan[] = [];
    for (const s of segmentos) planes.push(await this.decidir(s, epoch, disponible, grabando));

    const inyectar = disponible && !grabando;
    const ambitoDeEpoca: AmbitoRecuperable = { ...ambito, epoch };
    const cambia = planes.some((p) => p.reemplazo !== undefined && p.reemplazo !== p.segmento.texto);
    let salida = cuerpo;
    if (!grabando && (cambia || inyectar)) {
      salida = structuredClone(cuerpo);
      for (const p of planes) if (p.reemplazo !== undefined) ponerTexto(salida, p.segmento, p.reemplazo);
      if (inyectar) {
        const tools = Array.isArray(salida.tools) ? (salida.tools as unknown[]) : [];
        salida.tools = [...tools, structuredClone(ESQUEMA_DE_RECUPERACION)];
      }
      afirmarSoloCambiaLoPermitido(cuerpo, salida, planes, inyectar);
      // Mientras la tarea usa un handle, no caduca (lease acotado por el almacén).
      if (this.o.almacen && this.lease > 0) {
        for (const p of planes) if (p.handle) await this.o.almacen.pin(ambitoDeEpoca, p.handle, this.now() + this.lease);
      }
    }

    const overhead = inyectar ? this.contar(JSON.stringify(ESQUEMA_DE_RECUPERACION)) : 0;
    const decisiones = planes.map((p) => p.decision);
    const informe: InformeDeProyeccion = {
      mode: this.modo,
      status: cambia && !grabando ? "applied" : "bypassed",
      reason: grabando ? "record_only" : cambia ? "applied" : segmentos.length === 0 ? "no_candidate" : "no_change",
      epoch,
      ...(abierta ? { epochOpened: abierta } : {}),
      recoveryAvailable: disponible,
      recoveryToolInjected: inyectar,
      adapterRevision: this.revision,
      segments: decisiones,
      estimate: {
        basis: "estimated",
        tokenizer: this.tokenizer,
        inputBefore: decisiones.reduce((a, d) => a + d.tokensBefore, 0),
        inputAfter: decisiones.reduce((a, d) => a + d.tokensAfter, 0),
        overheadTokens: overhead,
      },
    };
    const ejecutor = this.o.ejecutor;
    const politica = this.o.politica;
    return {
      cuerpo: salida,
      informe,
      ...(inyectar && ejecutor ? { ejecutar: (input: unknown) => ejecutor.recuperar(ambitoDeEpoca, politica, input) } : {}),
    };
  }

  private validar(cuerpo: Registro): void {
    const { ambito, politica } = this.o;
    if (!esRegistro(cuerpo) || !Array.isArray(cuerpo.messages)) {
      throw new ErrorDeProyeccion("invalid_request", "el cuerpo no es una petición de Messages");
    }
    if (!ambito || ![ambito.tenantId, ambito.projectId, ambito.sessionId, ambito.branchId].every(campoValido)) {
      throw new ErrorDeProyeccion("invalid_request", "ámbito incompleto: sin identidad no se proyecta");
    }
    if (!campoValido(politica)) throw new ErrorDeProyeccion("invalid_request", "sin huella de política no se proyecta");
  }

  private recuperacionDisponible(cuerpo: Registro): boolean {
    if (this.modo !== "recoverable" || !this.o.almacen || !this.o.ejecutor) return false;
    if (esRegistro(cuerpo.tool_choice) && cuerpo.tool_choice.type === "none") return false;
    const tools = Array.isArray(cuerpo.tools) ? cuerpo.tools : [];
    return !tools.some((t) => esRegistro(t) && t.name === HERRAMIENTA_DE_RECUPERACION);
  }

  private async epocaDe(
    manifiesto: string[],
    interna: boolean,
    grabando: boolean,
  ): Promise<{ epoch: number; abierta?: MotivoDeEpocaNueva; estado: EstadoDeRama | undefined }> {
    const { elecciones, ambito } = this.o;
    for (let intento = 0; intento < 4; intento++) {
      const estado = await elecciones.rama(ambito);
      if (!estado) {
        const nuevo: EstadoDeRama = { epoch: 0, manifiesto: interna ? [] : manifiesto, aperturas: 0 };
        if (grabando) return { epoch: 0, estado: undefined };
        const r = await elecciones.fijarRama(ambito, undefined, nuevo);
        if (r.ok) return { epoch: 0, estado: r.estado };
        continue;
      }
      const esPrefijo = estado.manifiesto.length <= manifiesto.length && estado.manifiesto.every((h, i) => h === manifiesto[i]);
      if (esPrefijo) {
        if (grabando || interna || estado.manifiesto.length === manifiesto.length) return { epoch: estado.epoch, estado };
        const r = await elecciones.fijarRama(ambito, estado, { ...estado, manifiesto });
        if (r.ok) return { epoch: estado.epoch, estado: r.estado };
        continue;
      }
      // Editado, reordenado o bifurcado: época nueva.
      if (grabando) return { epoch: estado.epoch + 1, abierta: "history_rewritten", estado };
      const nuevo: EstadoDeRama = {
        epoch: estado.epoch + 1,
        manifiesto: interna ? estado.manifiesto : manifiesto,
        aperturas: estado.aperturas + 1,
      };
      const r = await elecciones.fijarRama(ambito, estado, nuevo);
      if (r.ok) return { epoch: nuevo.epoch, abierta: "history_rewritten", estado: r.estado };
    }
    throw new ErrorDeProyeccion("epoch_changed", "la rama cambió de época varias veces durante la proyección");
  }

  private async abrirEpoca(estado: EstadoDeRama | undefined, desde: number): Promise<{ epoch: number; estado: EstadoDeRama }> {
    const { elecciones, ambito } = this.o;
    let actual = estado;
    for (let intento = 0; intento < 4; intento++) {
      const base = actual ?? { epoch: desde, manifiesto: [], aperturas: 0 };
      // Si otro escritor ya abrió una época por encima, se usa esa.
      if (base.epoch > desde) return { epoch: base.epoch, estado: base };
      const nuevo: EstadoDeRama = { ...base, epoch: desde + 1, aperturas: base.aperturas + 1 };
      const r = await elecciones.fijarRama(ambito, actual, nuevo);
      if (r.ok) return { epoch: nuevo.epoch, estado: r.estado };
      actual = r.estado;
    }
    throw new ErrorDeProyeccion("epoch_changed", "no se pudo abrir época nueva");
  }

  private claveDe(s: Segmento, epoch: number): ClaveDeSegmento {
    return { ...this.o.ambito, epoch, segmentId: s.segmentId, sourceHash: s.sourceHash };
  }

  /** null si todo lo que se reenviaría sigue autorizado y recuperable. */
  private async revalidar(segmentos: Segmento[], epoch: number, disponible: boolean): Promise<MotivoDeEpocaNueva | null> {
    let recuperacionCaida = false;
    for (const s of segmentos) {
      if (s.protegido) continue;
      const v = await this.o.elecciones.vigente(this.claveDe(s, epoch));
      // `identity` reenvía el texto que el llamante trae AHORA (ya autorizado
      // por Privacy): no es una sustitución que revalidar.
      if (!v || v.transformId === IDENTIDAD_TRANSFORM_ID) continue;
      if (v.privacyPolicyHash !== this.o.politica) return "policy_changed";
      if (v.handle && !(await this.recuperable(v.handle, epoch, disponible))) recuperacionCaida = true;
    }
    return recuperacionCaida ? "recovery_unavailable" : null;
  }

  private async recuperable(handle: string, epoch: number, disponible: boolean): Promise<boolean> {
    if (!disponible || !this.o.almacen) return false;
    const r = await this.o.almacen.get({ ...this.o.ambito, epoch }, handle, {
      policyFingerprint: this.o.politica,
      maxBytes: 4,
    });
    return r.ok;
  }

  private async decidir(s: Segmento, epoch: number, disponible: boolean, grabando: boolean): Promise<Plan> {
    const antes = this.contar(s.texto);
    const base = { segmentId: s.segmentId, sourceSha256: s.sourceHash, tokensBefore: antes };
    const identidad = (status: EstadoDeSegmento, reason: MotivoDeSegmento): DecisionDeSegmento => ({
      ...base,
      status,
      reason,
      transformId: IDENTIDAD_TRANSFORM_ID,
      version: "1",
      recoverable: false,
      replacementSha256: s.sourceHash,
      tokensAfter: antes,
    });
    if (s.protegido) return { segmento: s, decision: identidad("bypassed", s.protegido) };

    const clave = this.claveDe(s, epoch);
    const vigente = grabando ? undefined : await this.o.elecciones.vigente(clave);
    if (vigente) {
      let shadowRecorded = false;
      if (vigente.adapterRevision !== this.revision) {
        // La revisión nueva no toca lo vigente: lo que haría queda en sombra.
        const propuesta = this.candidato(s, disponible, vigente.handle);
        await this.o.elecciones.sombra({ ...clave, adapterRevision: this.revision }, propuesta.eleccion);
        shadowRecorded = true;
      }
      return {
        segmento: s,
        reemplazo: vigente.replacement,
        ...(vigente.handle ? { handle: vigente.handle } : {}),
        decision: {
          ...base,
          status: "reused",
          reason: vigente.handle ? "recoverable" : vigente.transformId === IDENTIDAD_TRANSFORM_ID ? "identity" : "applied",
          transformId: vigente.transformId,
          version: vigente.version,
          recoverable: vigente.handle !== undefined,
          replacementSha256: vigente.replacementSha256,
          tokensAfter: this.contar(vigente.replacement),
          ...(shadowRecorded ? { shadowRecorded } : {}),
        },
      };
    }

    // Sin elección y anterior al último assistant: ya viajó tal cual.
    if (!s.enLaCola) {
      if (grabando) return { segmento: s, decision: identidad("recorded", "born_before") };
      return this.persistir(s, clave, this.eleccionIdentidad(s), identidad("applied", "born_before"));
    }

    if (grabando) {
      const c = this.candidato(s, disponible || this.modo === "record", undefined, true);
      return { segmento: s, decision: { ...c.decision, status: "recorded" } };
    }

    // Lo recuperable: el original al almacén ANTES de que exista la vista previa.
    const bytes = utf8.encode(s.texto);
    if (disponible && !esJsonEstructurado(s.texto) && bytes.length >= this.umbral) {
      if (bytes.length > MAXIMO_POR_SEGMENTO) return this.sinOmision(s, clave, "segment_too_large");
      const almacen = this.o.almacen!;
      const ambitoDeEpoca = { ...this.o.ambito, epoch };
      const g = await almacen.put(ambitoDeEpoca, bytes, {
        policyFingerprint: this.o.politica,
        contentType: "text/plain; charset=utf-8",
        ...(this.lease > 0 ? { pinUntil: this.now() + this.lease } : {}),
      });
      if (!g.ok) return this.sinOmision(s, clave, "store_rejected");
      if (g.sha256 !== sha256DeBytes(bytes) || g.size !== bytes.length) {
        await almacen.delete(ambitoDeEpoca, g.handle);
        return this.sinOmision(s, clave, "store_rejected");
      }
      const previa = vistaPrevia(s.texto, g.handle);
      const tokens = this.contar(previa);
      if (tokens >= antes) {
        await almacen.delete(ambitoDeEpoca, g.handle);
        return this.sinOmision(s, clave, "not_smaller");
      }
      const eleccion: EleccionPersistida = {
        replacement: previa,
        replacementSha256: sha256(previa),
        transformId: VISTA_PREVIA_TRANSFORM_ID,
        version: VISTA_PREVIA_VERSION,
        privacyPolicyHash: this.o.politica,
        handle: g.handle,
        adapterRevision: this.revision,
      };
      const r = await this.o.elecciones.fijar({ ...clave, adapterRevision: this.revision }, eleccion);
      // Perdió la carrera: su objeto sobra, y se manda lo del ganador.
      if (!r.ganadora) await almacen.delete(ambitoDeEpoca, g.handle);
      return this.planDe(s, r.eleccion, r.ganadora ? "applied" : "reused", antes);
    }
    return this.sinOmision(s, clave, disponible ? undefined : this.modo === "recoverable" ? "recovery_unavailable" : undefined);
  }

  /** JSON sin omisiones (D03) o el original; nunca una vista previa. */
  private async sinOmision(s: Segmento, clave: ClaveDeSegmento, motivo?: MotivoDeSegmento): Promise<Plan> {
    const c = this.candidato(s, false);
    const decision = motivo && c.eleccion.transformId === IDENTIDAD_TRANSFORM_ID ? { ...c.decision, reason: motivo } : c.decision;
    return this.persistir(s, clave, c.eleccion, decision);
  }

  private async persistir(
    s: Segmento,
    clave: ClaveDeSegmento,
    eleccion: EleccionPersistida,
    decision: DecisionDeSegmento,
  ): Promise<Plan> {
    const r = await this.o.elecciones.fijar({ ...clave, adapterRevision: this.revision }, eleccion);
    if (!r.ganadora) return this.planDe(s, r.eleccion, "reused", decision.tokensBefore);
    return {
      segmento: s,
      decision,
      reemplazo: r.eleccion.replacement,
      ...(r.eleccion.handle ? { handle: r.eleccion.handle } : {}),
    };
  }

  private planDe(s: Segmento, e: EleccionPersistida, status: EstadoDeSegmento, antes: number): Plan {
    return {
      segmento: s,
      reemplazo: e.replacement,
      ...(e.handle ? { handle: e.handle } : {}),
      decision: {
        segmentId: s.segmentId,
        status,
        reason: e.handle ? "recoverable" : e.transformId === IDENTIDAD_TRANSFORM_ID ? "identity" : "applied",
        transformId: e.transformId,
        version: e.version,
        recoverable: e.handle !== undefined,
        sourceSha256: s.sourceHash,
        replacementSha256: e.replacementSha256,
        tokensBefore: antes,
        tokensAfter: this.contar(e.replacement),
      },
    };
  }

  private eleccionIdentidad(s: Segmento): EleccionPersistida {
    return {
      replacement: s.texto,
      replacementSha256: s.sourceHash,
      transformId: IDENTIDAD_TRANSFORM_ID,
      version: "1",
      privacyPolicyHash: this.o.politica,
      adapterRevision: this.revision,
    };
  }

  /**
   * Lo que se mandaría, sin escribir nada. Con `handle`, la vista previa se
   * construye con ese handle (registro de sombra); con `simular`, con uno
   * ficticio del mismo largo (modo `record`).
   */
  private candidato(
    s: Segmento,
    conRecuperacion: boolean,
    handle?: string,
    simular = false,
  ): { eleccion: EleccionPersistida; decision: DecisionDeSegmento } {
    const antes = this.contar(s.texto);
    const bytes = utf8.encode(s.texto).length;
    if (
      conRecuperacion &&
      (handle !== undefined || simular) &&
      !esJsonEstructurado(s.texto) &&
      bytes >= this.umbral &&
      bytes <= MAXIMO_POR_SEGMENTO
    ) {
      const previa = vistaPrevia(s.texto, handle ?? "bvr1_" + "x".repeat(32));
      const tokens = this.contar(previa);
      if (tokens < antes) {
        return {
          eleccion: {
            replacement: previa,
            replacementSha256: sha256(previa),
            transformId: VISTA_PREVIA_TRANSFORM_ID,
            version: VISTA_PREVIA_VERSION,
            privacyPolicyHash: this.o.politica,
            ...(handle ? { handle } : {}),
            adapterRevision: this.revision,
          },
          decision: {
            segmentId: s.segmentId,
            status: "applied",
            reason: simular ? "would_recover" : "recoverable",
            transformId: VISTA_PREVIA_TRANSFORM_ID,
            version: VISTA_PREVIA_VERSION,
            recoverable: true,
            sourceSha256: s.sourceHash,
            replacementSha256: sha256(previa),
            tokensBefore: antes,
            tokensAfter: tokens,
          },
        };
      }
    }
    const r = compactToolOutput(s.texto, { profile: "lossless-data", minSavedChars: this.minimo }, this.contar);
    const d = r.decision!;
    const texto = r.changed ? r.text : s.texto;
    return {
      eleccion: {
        replacement: texto,
        replacementSha256: sha256(texto),
        transformId: r.changed ? LOSSLESS_JSON_TRANSFORM_ID : IDENTIDAD_TRANSFORM_ID,
        version: r.changed ? LOSSLESS_JSON_VERSION : "1",
        privacyPolicyHash: this.o.politica,
        adapterRevision: this.revision,
      },
      decision: {
        segmentId: s.segmentId,
        status: r.changed ? "applied" : "bypassed",
        reason: d.reason,
        transformId: r.changed ? LOSSLESS_JSON_TRANSFORM_ID : IDENTIDAD_TRANSFORM_ID,
        version: r.changed ? LOSSLESS_JSON_VERSION : "1",
        recoverable: false,
        sourceSha256: s.sourceHash,
        replacementSha256: sha256(texto),
        tokensBefore: antes,
        tokensAfter: d.tokensAfter,
      },
    };
  }

  private informeVacio(reason: string, epoch: number | null): InformeDeProyeccion {
    return {
      mode: this.modo,
      status: "bypassed",
      reason,
      epoch,
      recoveryAvailable: false,
      recoveryToolInjected: false,
      adapterRevision: this.revision,
      segments: [],
      estimate: { basis: "estimated", tokenizer: this.tokenizer, inputBefore: 0, inputAfter: 0, overheadTokens: 0 },
    };
  }
}

/** Los `tool_result` del cuerpo, con lo que los protege (si algo). */
function segmentosDe(cuerpo: Registro): Segmento[] {
  const mensajes = cuerpo.messages as unknown[];
  const nombres = new Map<string, string>();
  let ultimoAssistant = -1;
  mensajes.forEach((m, i) => {
    if (!esRegistro(m) || m.role !== "assistant") return;
    ultimoAssistant = i;
    if (!Array.isArray(m.content)) return;
    for (const b of m.content) {
      if (esRegistro(b) && b.type === "tool_use" && typeof b.id === "string") nombres.set(b.id, String(b.name ?? ""));
    }
  });
  const salida: Segmento[] = [];
  // Un id repetido no tiene clave estable: todos sus bloques van como están.
  const duplicados = segmentosDuplicados(mensajes);
  mensajes.forEach((m, i) => {
    if (!esRegistro(m) || m.role !== "user" || !Array.isArray(m.content)) return;
    m.content.forEach((b, j) => {
      if (!esRegistro(b) || b.type !== "tool_result" || typeof b.tool_use_id !== "string") return;
      if (duplicados.has(b.tool_use_id)) return;
      const base = { segmentId: b.tool_use_id, indiceMensaje: i, indiceBloque: j, enLaCola: i > ultimoAssistant };
      let texto: string | undefined;
      let forma: Segmento["forma"] = "string";
      if (typeof b.content === "string") texto = b.content;
      else if (
        Array.isArray(b.content) &&
        b.content.length === 1 &&
        esRegistro(b.content[0]) &&
        b.content[0].type === "text" &&
        typeof b.content[0].text === "string"
      ) {
        texto = b.content[0].text;
        forma = "bloque";
      }
      if (texto === undefined) {
        salida.push({ ...base, texto: "", sourceHash: sha256(jsonCanonico(b.content ?? null)), forma, protegido: "unsupported_shape" });
        return;
      }
      const s: Segmento = { ...base, texto, sourceHash: sha256(texto), forma };
      if (b.is_error === true) s.protegido = "is_error";
      else if (nombres.get(b.tool_use_id) === HERRAMIENTA_DE_RECUPERACION) s.protegido = "recovery_result";
      salida.push(s);
    });
  });
  return salida;
}

function segmentosDuplicados(mensajes: unknown[]): Set<string> {
  const cuenta = new Map<string, number>();
  for (const m of mensajes) {
    if (!esRegistro(m) || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (esRegistro(b) && b.type === "tool_result" && typeof b.tool_use_id === "string") {
        cuenta.set(b.tool_use_id, (cuenta.get(b.tool_use_id) ?? 0) + 1);
      }
    }
  }
  return new Set([...cuenta].filter(([, n]) => n > 1).map(([id]) => id));
}

function bloqueDe(cuerpo: Registro, s: Segmento): Registro {
  const m = (cuerpo.messages as Registro[])[s.indiceMensaje]!;
  return (m.content as Registro[])[s.indiceBloque]!;
}

function ponerTexto(cuerpo: Registro, s: Segmento, texto: string): void {
  const b = bloqueDe(cuerpo, s);
  if (s.forma === "string") b.content = texto;
  else (b.content as Registro[])[0]!.text = texto;
}

/**
 * La red de seguridad: deshechas las sustituciones y quitada la herramienta
 * añadida, la salida tiene que ser el cuerpo de entrada byte a byte. Si no, es
 * un error de este módulo y no se manda.
 */
function afirmarSoloCambiaLoPermitido(entrada: Registro, salida: Registro, planes: Plan[], inyectada: boolean): void {
  const revertida = structuredClone(salida);
  for (const p of planes) if (p.reemplazo !== undefined) ponerTexto(revertida, p.segmento, p.segmento.texto);
  if (inyectada) {
    const tools = (revertida.tools as unknown[]).slice(0, -1);
    if (Array.isArray(entrada.tools)) revertida.tools = tools;
    else delete revertida.tools;
  }
  if (JSON.stringify(revertida) !== JSON.stringify(entrada)) {
    throw new Error("[bvsala] proyección: la copia cambió algo fuera de los tool_result elegidos; no se manda");
  }
}

// ─── El ejecutor y el bucle ─────────────────────────────────────────────────

/**
 * El ejecutor sobre el almacén recuperable: lee todas las páginas, verifica la
 * sha256 del objeto entero y devuelve el original exacto (o el rango de líneas
 * pedido). Un handle ajeno, caducado o inventado da el mismo `not_found`.
 */
export function crearEjecutorDeRecuperacion(almacen: AlmacenRecuperable): EjecutorDeRecuperacion {
  const error = (code: string): ResultadoDeHerramienta => ({ content: JSON.stringify({ error: code }), is_error: true });
  return {
    async recuperar(ambito, politica, input) {
      if (!esRegistro(input) || typeof input.handle !== "string") return error("invalid_request");
      const desde = input.start_line;
      const hasta = input.end_line;
      const entero = (v: unknown) => v === undefined || (Number.isSafeInteger(v) && (v as number) >= 1);
      if (!entero(desde) || !entero(hasta)) return error("invalid_request");
      const trozos: Uint8Array[] = [];
      let cursor: string | undefined;
      let huella = "";
      let total = 0;
      for (;;) {
        const p = await almacen.get(ambito, input.handle, { policyFingerprint: politica, ...(cursor ? { cursor } : {}) });
        if (!p.ok) return error(p.error);
        trozos.push(p.bytes);
        total += p.bytes.length;
        huella = p.sha256;
        if (p.nextCursor === null) break;
        cursor = p.nextCursor;
      }
      const todo = new Uint8Array(total);
      let o = 0;
      for (const t of trozos) {
        todo.set(t, o);
        o += t.length;
      }
      if (sha256DeBytes(todo) !== huella) return error("integrity_failure");
      let texto: string;
      try {
        texto = new TextDecoder("utf-8", { fatal: true }).decode(todo);
      } catch {
        return error("integrity_failure");
      }
      if (desde === undefined && hasta === undefined) return { content: texto, is_error: false };
      const lineas = texto.split("\n");
      const a = (desde as number | undefined) ?? 1;
      const b = Math.min((hasta as number | undefined) ?? lineas.length, lineas.length);
      if (a > b) return error("invalid_range");
      return { content: lineas.slice(a - 1, b).join("\n"), is_error: false };
    },
  };
}

export interface MensajeDeAnthropic {
  content: unknown[];
  usage?: unknown;
  [k: string]: unknown;
}

export interface ResultadoDelBucle {
  /** La última respuesta del modelo. */
  mensaje: MensajeDeAnthropic;
  /**
   * Los mensajes que el bucle añadió a la historia (las rondas de
   * recuperación y la respuesta final). Guardarlos en el historial es
   * opcional: la época se conserva igual.
   */
  mensajesAnadidos: Registro[];
  /**
   * Si la última respuesta mezcla recuperaciones con herramientas del
   * llamante: los `tool_result` de las recuperaciones, ya ejecutadas, que el
   * llamante tiene que poner junto a los suyos en el siguiente turno `user`.
   */
  resultadosPendientes: Registro[];
  rondas: number;
  recuperaciones: number;
  informes: InformeDeProyeccion[];
  /** El `usage` de cada ronda tal cual (todas cuentan: la recuperación tiene coste). */
  usos: unknown[];
}

export interface OpcionesDelBucle {
  cuerpo: Registro;
  proyector: ProyectorEstable;
  /** La llamada real: `(b) => client.messages.create(b)`. Sin stream. */
  crear: (cuerpo: Registro) => Promise<MensajeDeAnthropic>;
  /** Recuperaciones máximas por llamada lógica (por defecto 8). */
  maxRecuperaciones?: number;
  idempotencyKey?: string;
}

/**
 * El bucle de herramienta del SDK para la ruta piloto: proyecta, llama, y si el
 * modelo pide recuperar, lo ejecuta contra el almacén con el ámbito de la
 * proyección y vuelve a llamar con el original. Devuelve en cuanto la
 * respuesta no pide recuperar nada.
 */
export async function ejecutarConRecuperacion(o: OpcionesDelBucle): Promise<ResultadoDelBucle> {
  const maximo = Math.max(0, Math.floor(o.maxRecuperaciones ?? 8));
  const historia = [...(o.cuerpo.messages as Registro[])];
  const anadidos: Registro[] = [];
  const informes: InformeDeProyeccion[] = [];
  const usos: unknown[] = [];
  let recuperaciones = 0;
  for (let ronda = 0; ; ronda++) {
    if (ronda > maximo + 1) {
      throw new Error("[bvsala] the model kept asking to retrieve past the limit; stopping");
    }
    const p = await o.proyector.proyectar(
      { ...o.cuerpo, messages: historia },
      { interna: ronda > 0, ...(o.idempotencyKey !== undefined ? { idempotencyKey: `${o.idempotencyKey}:${ronda}` } : {}) },
    );
    informes.push(p.informe);
    const mensaje = await o.crear(p.cuerpo);
    usos.push(mensaje.usage);
    const contenido = Array.isArray(mensaje.content) ? mensaje.content : [];
    const usos_ = contenido.filter((b): b is Registro => esRegistro(b) && b.type === "tool_use");
    const deRecuperacion = p.ejecutar ? usos_.filter((b) => b.name === HERRAMIENTA_DE_RECUPERACION) : [];
    const asistente: Registro = { role: "assistant", content: contenido };
    if (deRecuperacion.length === 0) {
      anadidos.push(asistente);
      return { mensaje, mensajesAnadidos: anadidos, resultadosPendientes: [], rondas: ronda + 1, recuperaciones, informes, usos };
    }
    const resultados: Registro[] = [];
    for (const b of deRecuperacion) {
      recuperaciones++;
      const r =
        recuperaciones > maximo
          ? { content: JSON.stringify({ error: "retrieval_limit" }), is_error: true }
          : await p.ejecutar!(b.input);
      resultados.push({ type: "tool_result", tool_use_id: b.id, content: r.content, ...(r.is_error ? { is_error: true } : {}) });
    }
    if (deRecuperacion.length < usos_.length) {
      anadidos.push(asistente);
      return { mensaje, mensajesAnadidos: anadidos, resultadosPendientes: resultados, rondas: ronda + 1, recuperaciones, informes, usos };
    }
    const usuario: Registro = { role: "user", content: resultados };
    historia.push(asistente, usuario);
    anadidos.push(asistente, usuario);
  }
}
