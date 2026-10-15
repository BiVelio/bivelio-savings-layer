import { sha256 } from "../util/hash.js";

/**
 * Elecciones persistidas (D06 del plan Caveman 2026-10-14): qué bytes se
 * mandaron en lugar de un tool_result, para volver a mandar EXACTAMENTE esos
 * bytes en cada turno siguiente y que la caché de prefijo del proveedor siga
 * casando.
 *
 * Lo que es función pura del contenido (el JSON sin omisiones de D03) no
 * necesitaría memoria. Lo recuperable sí: la vista previa lleva un handle
 * aleatorio, así que recalcularla en el turno siguiente daría OTROS bytes. Por
 * eso la primera elección se guarda y gana para siempre dentro de su época.
 *
 * La clave es la del plan, p. 5: (tenant, proyecto, sesión, rama, época,
 * segmento, hash de la fuente, revisión del adaptador). La revisión es parte de
 * la clave, pero NO de la búsqueda de la elección vigente: una revisión nueva
 * del adaptador no reescribe la historia viva; lo que propondría queda como
 * registro de sombra al lado, sin servirse.
 *
 * Igual que `CacheBreakpointStore`, es una interfaz para que un backend
 * compartido (KV, Postgres con UNIQUE) la implemente; aquí va la versión en
 * memoria. Nunca guarda el ORIGINAL (eso es del almacén recuperable de D04):
 * guarda los bytes de sustitución que ya vio el modelo, que son los que hay que
 * repetir.
 */

export interface ClaveDeSegmento {
  tenantId: string;
  projectId: string;
  sessionId: string;
  branchId: string;
  epoch: number;
  /** El `tool_use_id` del bloque en Anthropic Messages. */
  segmentId: string;
  /** sha256 (hex) del texto original del segmento. */
  sourceHash: string;
}

export interface ClaveDeEleccion extends ClaveDeSegmento {
  adapterRevision: string;
}

export interface EleccionPersistida {
  /** Texto que se manda en lugar del original (la vista previa, el compacto o el original mismo). */
  replacement: string;
  /** sha256 (hex) de `replacement`. */
  replacementSha256: string;
  /** `identity` cuando se decidió mandar el original. */
  transformId: string;
  version: string;
  /** Huella de la política de privacidad vigente cuando se decidió. */
  privacyPolicyHash: string;
  /** El handle del original en el almacén recuperable, si la sustitución omite algo. */
  handle?: string;
  adapterRevision: string;
}

export type ResultadoDeFijacion = {
  /** La elección que vale para la clave: la propia si se ganó, la del otro si no. */
  eleccion: EleccionPersistida;
  ganadora: boolean;
};

/** Estado de una rama: en qué época va y el manifiesto (hash por mensaje) de lo último visto. */
export interface EstadoDeRama {
  epoch: number;
  manifiesto: readonly string[];
  /** Cuántas veces se abrió época nueva en esta rama (diagnóstico). */
  aperturas: number;
}

export interface ClaveDeRama {
  tenantId: string;
  projectId: string;
  sessionId: string;
  branchId: string;
}

export type ReservaDeIdempotencia = "nueva" | "repetida" | "conflicto";

export interface AlmacenDeElecciones {
  /** La elección vigente del segmento, de la revisión que sea, o undefined. */
  vigente(clave: ClaveDeSegmento): Promise<EleccionPersistida | undefined>;
  /**
   * Compare-and-set: si el segmento no tiene elección vigente, esta pasa a
   * serlo (`ganadora: true`); si ya la tiene, se devuelve ESA, sin tocarla.
   * Dos escritores a la vez convergen en los mismos bytes.
   */
  fijar(clave: ClaveDeEleccion, eleccion: EleccionPersistida): Promise<ResultadoDeFijacion>;
  /** Lo que propondría otra revisión del adaptador. Se guarda para medir; nunca se sirve. */
  sombra(clave: ClaveDeEleccion, eleccion: EleccionPersistida): Promise<void>;
  /** Registros de sombra de un segmento (para auditar una actualización del adaptador). */
  sombras(clave: ClaveDeSegmento): Promise<EleccionPersistida[]>;
  rama(clave: ClaveDeRama): Promise<EstadoDeRama | undefined>;
  /**
   * Compare-and-set del estado de la rama: solo escribe si el estado actual es
   * `esperado` (por época y manifiesto). Devuelve el estado que queda.
   */
  fijarRama(clave: ClaveDeRama, esperado: EstadoDeRama | undefined, nuevo: EstadoDeRama): Promise<{ ok: boolean; estado: EstadoDeRama }>;
  /**
   * Una clave de idempotencia ligada a la huella del cuerpo: la primera vez
   * `nueva`, con la misma huella `repetida`, con otra `conflicto`.
   */
  reservarIdempotencia(ambito: ClaveDeRama, clave: string, huellaDelCuerpo: string): Promise<ReservaDeIdempotencia>;
}

/** Clave canónica (JSON de una tupla: sin ambigüedad de separadores). */
export function claveCanonicaDeSegmento(c: ClaveDeSegmento): string {
  return JSON.stringify([c.tenantId, c.projectId, c.sessionId, c.branchId, c.epoch, c.segmentId, c.sourceHash]);
}

export function claveCanonicaDeRama(c: ClaveDeRama): string {
  return JSON.stringify([c.tenantId, c.projectId, c.sessionId, c.branchId]);
}

function claveCanonicaDeEleccion(c: ClaveDeEleccion): string {
  return JSON.stringify([claveCanonicaDeSegmento(c), c.adapterRevision]);
}

function copia(e: EleccionPersistida): EleccionPersistida {
  return { ...e };
}

function mismoEstado(a: EstadoDeRama | undefined, b: EstadoDeRama | undefined): boolean {
  if (!a || !b) return a === b;
  return a.epoch === b.epoch && a.aperturas === b.aperturas && a.manifiesto.length === b.manifiesto.length &&
    a.manifiesto.every((h, i) => h === b.manifiesto[i]);
}

/**
 * {@link AlmacenDeElecciones} en memoria del proceso. Cada operación es
 * síncrona por dentro (sin `await` entre leer y escribir), así que el
 * compare-and-set es atómico dentro de un proceso. Entre procesos hace falta un
 * backend con escritura condicional.
 */
export class AlmacenDeEleccionesEnMemoria implements AlmacenDeElecciones {
  private readonly vigentes = new Map<string, EleccionPersistida>();
  private readonly porClave = new Map<string, EleccionPersistida>();
  private readonly deSombra = new Map<string, EleccionPersistida[]>();
  private readonly ramas = new Map<string, EstadoDeRama>();
  private readonly idempotencia = new Map<string, string>();

  async vigente(clave: ClaveDeSegmento): Promise<EleccionPersistida | undefined> {
    const e = this.vigentes.get(claveCanonicaDeSegmento(clave));
    return e ? copia(e) : undefined;
  }

  async fijar(clave: ClaveDeEleccion, eleccion: EleccionPersistida): Promise<ResultadoDeFijacion> {
    validarEleccion(eleccion);
    const k = claveCanonicaDeSegmento(clave);
    const previa = this.vigentes.get(k);
    if (previa) return { eleccion: copia(previa), ganadora: false };
    const guardada = { ...eleccion, adapterRevision: clave.adapterRevision };
    this.vigentes.set(k, guardada);
    this.porClave.set(claveCanonicaDeEleccion(clave), guardada);
    return { eleccion: copia(guardada), ganadora: true };
  }

  async sombra(clave: ClaveDeEleccion, eleccion: EleccionPersistida): Promise<void> {
    validarEleccion(eleccion);
    const kc = claveCanonicaDeEleccion(clave);
    // Una por revisión: la sombra de la misma revisión no se apila.
    if (this.porClave.has(kc)) return;
    const guardada = { ...eleccion, adapterRevision: clave.adapterRevision };
    this.porClave.set(kc, guardada);
    const k = claveCanonicaDeSegmento(clave);
    const lista = this.deSombra.get(k) ?? [];
    lista.push(guardada);
    this.deSombra.set(k, lista);
  }

  async sombras(clave: ClaveDeSegmento): Promise<EleccionPersistida[]> {
    return (this.deSombra.get(claveCanonicaDeSegmento(clave)) ?? []).map(copia);
  }

  async rama(clave: ClaveDeRama): Promise<EstadoDeRama | undefined> {
    const e = this.ramas.get(claveCanonicaDeRama(clave));
    return e ? { ...e, manifiesto: [...e.manifiesto] } : undefined;
  }

  async fijarRama(
    clave: ClaveDeRama,
    esperado: EstadoDeRama | undefined,
    nuevo: EstadoDeRama,
  ): Promise<{ ok: boolean; estado: EstadoDeRama }> {
    const k = claveCanonicaDeRama(clave);
    const actual = this.ramas.get(k);
    if (!mismoEstado(actual, esperado)) {
      return { ok: false, estado: actual ? { ...actual, manifiesto: [...actual.manifiesto] } : nuevo };
    }
    const guardado = { ...nuevo, manifiesto: [...nuevo.manifiesto] };
    this.ramas.set(k, guardado);
    return { ok: true, estado: { ...guardado, manifiesto: [...guardado.manifiesto] } };
  }

  async reservarIdempotencia(ambito: ClaveDeRama, clave: string, huellaDelCuerpo: string): Promise<ReservaDeIdempotencia> {
    // La clave de idempotencia vale dentro de su sesión y rama: la misma cadena
    // de otro tenant no choca (ni revela nada).
    const k = sha256(JSON.stringify([claveCanonicaDeRama(ambito), clave]));
    const previa = this.idempotencia.get(k);
    if (previa === undefined) {
      this.idempotencia.set(k, huellaDelCuerpo);
      return "nueva";
    }
    return previa === huellaDelCuerpo ? "repetida" : "conflicto";
  }

  /** Elecciones vigentes guardadas (diagnóstico y tests). */
  get size(): number {
    return this.vigentes.size;
  }
}

function validarEleccion(e: EleccionPersistida): void {
  if (!e || typeof e.replacement !== "string" || typeof e.transformId !== "string" || typeof e.privacyPolicyHash !== "string") {
    throw new TypeError("elección persistida inválida");
  }
  if (sha256(e.replacement) !== e.replacementSha256) {
    // Una elección cuyo hash no es el de sus bytes no se guarda: se serviría
    // en cada turno siguiente.
    throw new TypeError("elección persistida: replacementSha256 no corresponde a replacement");
  }
}
