import { hmacSha256, sha256, sha256DeBytes } from "../util/hash.js";

/**
 * Almacén recuperable (D04 del plan Caveman 2026-10-14): donde el modo
 * recuperable dejará el original de lo que saque del prompt, para que el modelo
 * lo pida de vuelta con un handle en vez de perderlo.
 *
 * En este incremento es SOLO local y en memoria: no hay ruta HTTP, ni tabla, ni
 * está cableado al pipeline; el modo recuperable sigue apagado. Lo que sí fija
 * es el contrato que tendrá que cumplir cualquier backend duradero que venga
 * después (de ahí la interfaz, como `ExactCache` o `CacheBreakpointStore`):
 *
 *   · Devuelve el original EXACTO, byte a byte, y cada página lleva la sha256 del
 *     objeto entero para que quien reensambla lo compruebe.
 *   · El handle es aleatorio (192 bits de `crypto.getRandomValues`), no un hash
 *     del contenido ni un UUID: un hash público nunca es autorización, y quien
 *     conoce el contenido no debe poder deducir el handle.
 *   · El ámbito {tenant, proyecto, sesión, rama, época} es parte de la llave: un
 *     handle presentado desde otro ámbito, caducado, borrado o inventado recibe
 *     EL MISMO `not_found` (el mismo objeto congelado), sin revelar si existe.
 *   · Lleno, se NIEGA (`quota_exceeded`); nunca desaloja un objeto vivo o fijado
 *     para hacer sitio, porque eso rompería un handle que el modelo ya tiene.
 *   · Borrar o revocar prevalece sobre una fijación; una sesión revocada deja
 *     lápida, y reintentar el `put` no la resucita.
 *   · Con la política cambiada no se sirven bytes viejos (`policy_changed`): el
 *     llamante reconstruye en una época nueva o deniega.
 *   · Nunca registra contenido, handles ni cursores: este módulo no escribe
 *     nada en ningún log.
 *
 * El ámbito tiene que venir de la identidad autenticada del llamante, nunca del
 * cuerpo de una petición: el almacén confía en él tal cual se lo pasan.
 */

export interface AmbitoRecuperable {
  tenantId: string;
  projectId: string;
  sessionId: string;
  branchId: string;
  /** Entero ≥ 0. Subirlo es la forma de «empezar de cero» sin borrar la sesión. */
  epoch: number;
}

export interface OpcionesDeGuardado {
  /** Huella de la política (privacidad, redacción…) bajo la que se guardó. */
  policyFingerprint: string;
  contentType: string;
  /** Por defecto 24 h; se recorta a `maxTtlMs`. */
  ttlMs?: number;
  /** Epoch ms hasta el que el objeto no caduca; se recorta a ahora + `maxPinMs`. */
  pinUntil?: number;
}

export interface OpcionesDeLectura {
  /** La política vigente AHORA; si no es la del guardado, `policy_changed`. */
  policyFingerprint: string;
  /** El `nextCursor` de la página anterior, tal cual. */
  cursor?: string;
  /** Bytes máximos de la página (mínimo 4, para que quepa un carácter UTF-8). */
  maxBytes?: number;
}

export type CodigoDeFallo =
  | "not_found"
  | "scope_revoked"
  | "policy_changed"
  | "integrity_failure"
  | "invalid_cursor"
  | "quota_exceeded"
  | "object_too_large"
  | "invalid_request";

export interface FalloRecuperable<C extends CodigoDeFallo = CodigoDeFallo> {
  readonly ok: false;
  readonly error: C;
  /** El código HTTP que le tocará cuando haya ruta; aquí solo es informativo. */
  readonly status: number;
}

export type GuardadoRecuperable =
  | {
      ok: true;
      handle: string;
      sha256: string;
      size: number;
      expiresAt: number;
      pinnedUntil: number | null;
    }
  | FalloRecuperable<"quota_exceeded" | "object_too_large" | "scope_revoked" | "invalid_request">;

export interface PaginaRecuperable {
  ok: true;
  bytes: Uint8Array;
  /** Posición del primer byte de esta página dentro del objeto. */
  offset: number;
  /** Tamaño del objeto entero. */
  size: number;
  /** sha256 del objeto entero (hex), para verificar el reensamblado. */
  sha256: string;
  contentType: string;
  /** null en la última página. */
  nextCursor: string | null;
}

export type LecturaRecuperable =
  | PaginaRecuperable
  | FalloRecuperable<
      | "not_found"
      | "scope_revoked"
      | "policy_changed"
      | "integrity_failure"
      | "invalid_cursor"
      | "invalid_request"
    >;

export type FijacionRecuperable =
  | { ok: true; pinnedUntil: number | null }
  | FalloRecuperable<"not_found" | "scope_revoked" | "invalid_request">;

/** Hasta dónde llega una revocación de ámbito: la sesión entera, una rama, o una época de una rama. */
export type NivelDeRevocacion = "session" | "branch" | "epoch";

export interface AlmacenRecuperable {
  put(ambito: AmbitoRecuperable, bytes: Uint8Array, opciones: OpcionesDeGuardado): Promise<GuardadoRecuperable>;
  get(ambito: AmbitoRecuperable, handle: string, opciones: OpcionesDeLectura): Promise<LecturaRecuperable>;
  /** Fija (o suelta, con un instante pasado) el objeto. Nunca resucita uno caducado. */
  pin(ambito: AmbitoRecuperable, handle: string, pinUntil: number): Promise<FijacionRecuperable>;
  /**
   * Borra el objeto aunque esté fijado. Responde lo mismo exista o no, sea del
   * ámbito o no: el borrado tampoco sirve para sondear.
   */
  delete(ambito: AmbitoRecuperable, handle: string): Promise<{ ok: true }>;
  /** Revoca el ámbito (deja lápida) y borra lo que contenía, fijado o no. */
  revokeScope(
    ambito: AmbitoRecuperable,
    nivel?: NivelDeRevocacion,
  ): Promise<{ ok: true; removed: number } | FalloRecuperable<"invalid_request">>;
}

/**
 * Dónde viven los bytes, separado de los metadatos. Por defecto un Map; se
 * puede inyectar otro (y los tests lo usan para simular un disco que corrompe).
 */
export interface DepositoDeBytes {
  leer(clave: string): Uint8Array | undefined;
  escribir(clave: string, bytes: Uint8Array): void;
  borrar(clave: string): void;
}

export const CUOTA_POR_SESION_POR_DEFECTO = 256 * 1024 * 1024;
export const OBJETO_MAXIMO_POR_DEFECTO = 1024 * 1024;
export const TTL_POR_DEFECTO_MS = 24 * 60 * 60 * 1000;
export const FIJACION_MAXIMA_POR_DEFECTO_MS = 2 * 60 * 60 * 1000;
export const PAGINA_POR_DEFECTO = 64 * 1024;

const PREFIJO_DEL_HANDLE = "bvr1_";
const BYTES_DEL_HANDLE = 24; // 192 bits
const FORMA_DEL_HANDLE = /^bvr1_[A-Za-z0-9_-]{32}$/;
const FORMA_DEL_CURSOR = /^(\d{1,15})\.([0-9a-f]{64})$/;
const MAXIMO_DE_CAMPO = 256;
// Lo que se hashea cuando el handle no tiene forma: mismo largo, mismo coste, y
// nunca un texto arbitrario (un «handle» de megas no compra trabajo de hash).
const HANDLE_FICTICIO = PREFIJO_DEL_HANDLE + "A".repeat(32);

const fallo = <C extends CodigoDeFallo>(error: C, status: number): FalloRecuperable<C> =>
  Object.freeze({ ok: false as const, error, status });

// Un solo objeto para TODOS los «no está»: desconocido, ajeno, caducado, borrado.
// Ni el contenido ni la identidad del objeto devuelto distinguen un caso de otro.
const NO_ENCONTRADO = fallo("not_found", 404);
const AMBITO_REVOCADO = fallo("scope_revoked", 410);
const POLITICA_CAMBIADA = fallo("policy_changed", 409);
const INTEGRIDAD_ROTA = fallo("integrity_failure", 500);
const CURSOR_INVALIDO = fallo("invalid_cursor", 400);
const CUOTA_AGOTADA = fallo("quota_exceeded", 507);
const OBJETO_DEMASIADO_GRANDE = fallo("object_too_large", 413);
const PETICION_INVALIDA = fallo("invalid_request", 400);

interface Objeto {
  claveAmbito: string;
  claveSesion: string;
  claveRama: string;
  huellaPolitica: string;
  contentType: string;
  sha256: string;
  size: number;
  vence: number;
  fijadoHasta: number | null;
}

class DepositoEnMemoria implements DepositoDeBytes {
  private readonly bytes = new Map<string, Uint8Array>();
  leer(clave: string): Uint8Array | undefined {
    return this.bytes.get(clave);
  }
  escribir(clave: string, bytes: Uint8Array): void {
    this.bytes.set(clave, bytes);
  }
  borrar(clave: string): void {
    this.bytes.delete(clave);
  }
}

export interface OpcionesDelAlmacenEnMemoria {
  /** Bytes por sesión (tenant + proyecto + sesión). Por defecto 256 MiB. */
  quotaBytesPerSession?: number;
  /** Bytes por objeto. Por defecto 1 MiB: lo más grande se trocea antes. */
  maxObjectBytes?: number;
  defaultTtlMs?: number;
  maxTtlMs?: number;
  maxPinMs?: number;
  now?: () => number;
  deposito?: DepositoDeBytes;
}

/**
 * {@link AlmacenRecuperable} en memoria del proceso. Para tests y para un solo
 * proceso; lo de varios procesos o lo que sobreviva a un reinicio es otro
 * backend que implemente la misma interfaz.
 *
 * Las lápidas de revocación no caducan mientras viva el proceso: si caducaran,
 * pasado ese plazo un `put` podría resucitar la sesión revocada.
 */
export class AlmacenRecuperableEnMemoria implements AlmacenRecuperable {
  // Llave interna = sha256 del handle: ni en memoria se guarda el handle tal cual.
  private readonly objetos = new Map<string, Objeto>();
  private readonly porSesion = new Map<string, Set<string>>();
  private readonly usoPorSesion = new Map<string, number>();
  private readonly lapidas = new Set<string>();
  private readonly deposito: DepositoDeBytes;
  private readonly secretoDeCursor: Uint8Array;
  private readonly cuota: number;
  private readonly maximoObjeto: number;
  private readonly ttlPorDefecto: number;
  private readonly ttlMaximo: number;
  private readonly fijacionMaxima: number;
  private readonly now: () => number;

  constructor(opts: OpcionesDelAlmacenEnMemoria = {}) {
    this.cuota = enteroPositivo(opts.quotaBytesPerSession, CUOTA_POR_SESION_POR_DEFECTO);
    this.maximoObjeto = enteroPositivo(opts.maxObjectBytes, OBJETO_MAXIMO_POR_DEFECTO);
    this.ttlMaximo = enteroPositivo(opts.maxTtlMs, TTL_POR_DEFECTO_MS);
    this.ttlPorDefecto = Math.min(enteroPositivo(opts.defaultTtlMs, TTL_POR_DEFECTO_MS), this.ttlMaximo);
    this.fijacionMaxima = enteroPositivo(opts.maxPinMs, FIJACION_MAXIMA_POR_DEFECTO_MS);
    this.now = opts.now ?? (() => Date.now());
    this.deposito = opts.deposito ?? new DepositoEnMemoria();
    // Sin RNG seguro no hay almacén: un handle predecible es un handle ajeno legible.
    this.secretoDeCursor = bytesAleatorios(32);
  }

  async put(
    ambito: AmbitoRecuperable,
    bytes: Uint8Array,
    opciones: OpcionesDeGuardado,
  ): Promise<GuardadoRecuperable> {
    const a = clavesDe(ambito);
    if (!a || !(bytes instanceof Uint8Array) || !opcionesDeGuardadoValidas(opciones)) {
      return PETICION_INVALIDA;
    }
    // La lápida antes que nada: un reintento del put no recrea la sesión revocada.
    if (this.revocado(a)) return AMBITO_REVOCADO;
    if (bytes.length > this.maximoObjeto) return OBJETO_DEMASIADO_GRANDE;

    const ahora = this.now();
    // Solo lo caducado y sin fijar deja sitio; lo vivo no se toca nunca.
    this.purgarSesion(a.sesion, ahora);
    const usado = this.usoPorSesion.get(a.sesion) ?? 0;
    if (usado + bytes.length > this.cuota) return CUOTA_AGOTADA;

    const copia = bytes.slice();
    const huella = sha256DeBytes(copia);
    const handle = PREFIJO_DEL_HANDLE + base64url(bytesAleatorios(BYTES_DEL_HANDLE));
    const clave = sha256(handle);
    const ttl = Math.min(opciones.ttlMs ?? this.ttlPorDefecto, this.ttlMaximo);
    const vence = ahora + ttl;
    const fijadoHasta = this.fijacionRecortada(opciones.pinUntil, ahora);

    this.deposito.escribir(clave, copia);
    this.objetos.set(clave, {
      claveAmbito: a.completa,
      claveSesion: a.sesion,
      claveRama: a.rama,
      huellaPolitica: opciones.policyFingerprint,
      contentType: opciones.contentType,
      sha256: huella,
      size: copia.length,
      vence,
      fijadoHasta,
    });
    let deLaSesion = this.porSesion.get(a.sesion);
    if (!deLaSesion) this.porSesion.set(a.sesion, (deLaSesion = new Set()));
    deLaSesion.add(clave);
    this.usoPorSesion.set(a.sesion, usado + copia.length);

    return { ok: true, handle, sha256: huella, size: copia.length, expiresAt: vence, pinnedUntil: fijadoHasta };
  }

  async get(
    ambito: AmbitoRecuperable,
    handle: string,
    opciones: OpcionesDeLectura,
  ): Promise<LecturaRecuperable> {
    const a = clavesDe(ambito);
    if (!a || typeof opciones?.policyFingerprint !== "string") return PETICION_INVALIDA;
    if (this.revocado(a)) return AMBITO_REVOCADO;

    const ahora = this.now();
    const hallado = this.buscar(a, handle, ahora);
    if (!hallado) return NO_ENCONTRADO;
    const { clave, objeto } = hallado;

    // Hasta aquí solo llega el dueño: lo de abajo ya no revela nada a un ajeno.
    if (objeto.huellaPolitica !== opciones.policyFingerprint) return POLITICA_CAMBIADA;

    let inicio = 0;
    if (opciones.cursor !== undefined) {
      const desde = this.leerCursor(opciones.cursor, handle, a.completa, objeto);
      if (desde === null) return CURSOR_INVALIDO;
      inicio = desde;
    }

    const guardados = this.deposito.leer(clave);
    // Se verifica el objeto entero en cada lectura: una página buena de un objeto
    // corrupto no sirve, porque el reensamblado fallaría igual.
    if (!guardados || guardados.length !== objeto.size || sha256DeBytes(guardados) !== objeto.sha256) {
      return INTEGRIDAD_ROTA;
    }

    const pedido = Math.floor(opciones.maxBytes ?? PAGINA_POR_DEFECTO);
    const tamano = Math.min(Math.max(Number.isFinite(pedido) ? pedido : PAGINA_POR_DEFECTO, 4), this.maximoObjeto);
    const fin = corteUtf8(guardados, inicio, inicio + tamano);

    return {
      ok: true,
      bytes: guardados.slice(inicio, fin),
      offset: inicio,
      size: objeto.size,
      sha256: objeto.sha256,
      contentType: objeto.contentType,
      nextCursor: fin < objeto.size ? this.firmarCursor(handle, a.completa, objeto.sha256, fin) : null,
    };
  }

  async pin(ambito: AmbitoRecuperable, handle: string, pinUntil: number): Promise<FijacionRecuperable> {
    const a = clavesDe(ambito);
    if (!a || typeof pinUntil !== "number" || Number.isNaN(pinUntil)) return PETICION_INVALIDA;
    if (this.revocado(a)) return AMBITO_REVOCADO;
    const ahora = this.now();
    const hallado = this.buscar(a, handle, ahora);
    if (!hallado) return NO_ENCONTRADO;
    hallado.objeto.fijadoHasta = this.fijacionRecortada(pinUntil, ahora);
    return { ok: true, pinnedUntil: hallado.objeto.fijadoHasta };
  }

  async delete(ambito: AmbitoRecuperable, handle: string): Promise<{ ok: true }> {
    const a = clavesDe(ambito);
    if (a && typeof handle === "string" && FORMA_DEL_HANDLE.test(handle)) {
      const clave = sha256(handle);
      const objeto = this.objetos.get(clave);
      // La fijación no protege del borrado: el borrado prevalece.
      if (objeto && igualesEnTiempo(objeto.claveAmbito, a.completa)) this.quitar(clave, objeto);
    }
    return { ok: true };
  }

  async revokeScope(
    ambito: AmbitoRecuperable,
    nivel: NivelDeRevocacion = "session",
  ): Promise<{ ok: true; removed: number } | FalloRecuperable<"invalid_request">> {
    const a = clavesDe(ambito);
    if (!a || (nivel !== "session" && nivel !== "branch" && nivel !== "epoch")) return PETICION_INVALIDA;
    const lapida = nivel === "session" ? a.lapidaSesion : nivel === "branch" ? a.lapidaRama : a.lapidaEpoca;
    this.lapidas.add(lapida);
    let removed = 0;
    for (const clave of [...(this.porSesion.get(a.sesion) ?? [])]) {
      const objeto = this.objetos.get(clave);
      if (!objeto) continue;
      const cae =
        nivel === "session" ||
        (nivel === "branch" && objeto.claveRama === a.rama) ||
        (nivel === "epoch" && objeto.claveAmbito === a.completa);
      if (cae) {
        this.quitar(clave, objeto);
        removed++;
      }
    }
    return { ok: true, removed };
  }

  /** Barre lo caducado y sin fijar de todas las sesiones. Devuelve cuántos objetos quitó. */
  purgar(): number {
    const ahora = this.now();
    let quitados = 0;
    for (const sesion of [...this.porSesion.keys()]) quitados += this.purgarSesion(sesion, ahora);
    return quitados;
  }

  /** Bytes que ocupa ahora la sesión del ámbito (lo que cuenta contra la cuota). */
  bytesEnUso(ambito: AmbitoRecuperable): number {
    const a = clavesDe(ambito);
    return a ? (this.usoPorSesion.get(a.sesion) ?? 0) : 0;
  }

  /** Objetos guardados en todo el almacén (vivos o aún sin barrer). */
  get size(): number {
    return this.objetos.size;
  }

  private buscar(
    a: ClavesDeAmbito,
    handle: string,
    ahora: number,
  ): { clave: string; objeto: Objeto } | null {
    // Desconocido, mal formado, ajeno o caducado: todos acaban en el mismo null.
    // La llave se calcula siempre, aunque la forma no valga, para que el coste
    // del camino no dependa de qué falló.
    const forma = typeof handle === "string" && FORMA_DEL_HANDLE.test(handle);
    const clave = sha256(forma ? handle : HANDLE_FICTICIO);
    const objeto = forma ? this.objetos.get(clave) : undefined;
    const delAmbito = igualesEnTiempo(objeto?.claveAmbito ?? "", a.completa);
    if (!objeto || !delAmbito) return null;
    if (caducado(objeto, ahora)) {
      this.quitar(clave, objeto);
      return null;
    }
    return { clave, objeto };
  }

  private revocado(a: ClavesDeAmbito): boolean {
    return this.lapidas.has(a.lapidaSesion) || this.lapidas.has(a.lapidaRama) || this.lapidas.has(a.lapidaEpoca);
  }

  private fijacionRecortada(pinUntil: number | undefined, ahora: number): number | null {
    if (pinUntil === undefined || pinUntil <= ahora) return null;
    return Math.min(pinUntil, ahora + this.fijacionMaxima);
  }

  private purgarSesion(sesion: string, ahora: number): number {
    let quitados = 0;
    for (const clave of [...(this.porSesion.get(sesion) ?? [])]) {
      const objeto = this.objetos.get(clave);
      if (objeto && caducado(objeto, ahora)) {
        this.quitar(clave, objeto);
        quitados++;
      }
    }
    return quitados;
  }

  private quitar(clave: string, objeto: Objeto): void {
    this.objetos.delete(clave);
    this.deposito.borrar(clave);
    const deLaSesion = this.porSesion.get(objeto.claveSesion);
    deLaSesion?.delete(clave);
    if (deLaSesion && deLaSesion.size === 0) this.porSesion.delete(objeto.claveSesion);
    const resto = (this.usoPorSesion.get(objeto.claveSesion) ?? 0) - objeto.size;
    if (resto > 0) this.usoPorSesion.set(objeto.claveSesion, resto);
    else this.usoPorSesion.delete(objeto.claveSesion);
  }

  // El cursor va firmado con un secreto del almacén y atado a (handle, ámbito,
  // contenido, posición): uno manipulado, de otro handle o de otro ámbito no
  // verifica. No caduca por sí mismo: caduca con el objeto.
  private firmarCursor(handle: string, ambito: string, huella: string, desde: number): string {
    return `${desde}.${this.macDelCursor(handle, ambito, huella, desde)}`;
  }

  private leerCursor(cursor: string, handle: string, ambito: string, objeto: Objeto): number | null {
    if (typeof cursor !== "string") return null;
    const m = FORMA_DEL_CURSOR.exec(cursor);
    if (!m) return null;
    const desde = Number(m[1]);
    const esperado = this.macDelCursor(handle, ambito, objeto.sha256, desde);
    if (!igualesEnTiempo(m[2]!, esperado)) return null;
    if (!Number.isSafeInteger(desde) || desde <= 0 || desde >= objeto.size) return null;
    return desde;
  }

  private macDelCursor(handle: string, ambito: string, huella: string, desde: number): string {
    const mensaje = new TextEncoder().encode(
      ["bvsala/recuperable/cursor/v1", handle, ambito, huella, String(desde)].join("\u0000"),
    );
    return hmacSha256(this.secretoDeCursor, mensaje);
  }
}

interface ClavesDeAmbito {
  completa: string;
  sesion: string;
  rama: string;
  lapidaSesion: string;
  lapidaRama: string;
  lapidaEpoca: string;
}

/** Claves canónicas del ámbito (JSON de una tupla: sin ambigüedad de separadores), o null si no vale. */
function clavesDe(ambito: AmbitoRecuperable): ClavesDeAmbito | null {
  if (!ambito || typeof ambito !== "object") return null;
  const { tenantId, projectId, sessionId, branchId, epoch } = ambito;
  for (const campo of [tenantId, projectId, sessionId, branchId]) {
    if (typeof campo !== "string" || campo.length === 0 || campo.length > MAXIMO_DE_CAMPO) return null;
  }
  if (!Number.isSafeInteger(epoch) || epoch < 0) return null;
  const sesion = JSON.stringify([tenantId, projectId, sessionId]);
  const rama = JSON.stringify([tenantId, projectId, sessionId, branchId]);
  const completa = JSON.stringify([tenantId, projectId, sessionId, branchId, epoch]);
  return {
    completa,
    sesion,
    rama,
    lapidaSesion: `s:${sesion}`,
    lapidaRama: `b:${rama}`,
    lapidaEpoca: `e:${completa}`,
  };
}

function opcionesDeGuardadoValidas(o: OpcionesDeGuardado): boolean {
  if (!o || typeof o !== "object") return false;
  if (typeof o.policyFingerprint !== "string" || o.policyFingerprint.length === 0) return false;
  if (typeof o.contentType !== "string" || o.contentType.length === 0) return false;
  if (o.ttlMs !== undefined && !(typeof o.ttlMs === "number" && Number.isFinite(o.ttlMs) && o.ttlMs > 0)) return false;
  if (o.pinUntil !== undefined && !(typeof o.pinUntil === "number" && Number.isFinite(o.pinUntil))) return false;
  return true;
}

function caducado(objeto: Objeto, ahora: number): boolean {
  if (objeto.fijadoHasta !== null && ahora <= objeto.fijadoHasta) return false;
  return ahora > objeto.vence;
}

/**
 * Fin de página que no parte un carácter UTF-8: si el corte cae sobre un byte
 * de continuación (10xxxxxx), retrocede hasta el byte inicial (como mucho 3).
 * Con bytes que no son UTF-8 válido no encuentra inicial y corta donde le
 * pidieron: la página nunca queda vacía y el reensamblado sigue siendo exacto.
 */
export function corteUtf8(bytes: Uint8Array, inicio: number, finPedido: number): number {
  if (finPedido >= bytes.length) return bytes.length;
  let j = finPedido;
  while (j > finPedido - 3 && j > inicio && (bytes[j]! & 0xc0) === 0x80) j--;
  const inicial = bytes[j]!;
  if (j < finPedido && j > inicio && inicial >= 0xc0 && inicial <= 0xf7) return j;
  return finPedido;
}

function bytesAleatorios(n: number): Uint8Array {
  const cryptoRef = (globalThis as { crypto?: { getRandomValues?: <T extends ArrayBufferView>(a: T) => T } })
    .crypto;
  if (!cryptoRef?.getRandomValues) {
    throw new Error("almacén recuperable: no hay crypto.getRandomValues en este runtime; sin él no se emiten handles");
  }
  return cryptoRef.getRandomValues(new Uint8Array(n));
}

const ALFABETO_B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

function base64url(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += ALFABETO_B64URL[(n >>> 18) & 63]! + ALFABETO_B64URL[(n >>> 12) & 63]! + ALFABETO_B64URL[(n >>> 6) & 63]! + ALFABETO_B64URL[n & 63]!;
  }
  // 24 bytes es múltiplo de 3, pero el resto queda cubierto por si cambia.
  if (i < bytes.length) {
    const n = (bytes[i]! << 16) | ((bytes[i + 1] ?? 0) << 8);
    out += ALFABETO_B64URL[(n >>> 18) & 63]! + ALFABETO_B64URL[(n >>> 12) & 63]!;
    if (i + 1 < bytes.length) out += ALFABETO_B64URL[(n >>> 6) & 63]!;
  }
  return out;
}

/** Comparación sin salida temprana (el largo sí se nota, y no es secreto). */
function igualesEnTiempo(a: string, b: string): boolean {
  let diferencia = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diferencia |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diferencia === 0;
}

function enteroPositivo(valor: number | undefined, porDefecto: number): number {
  return typeof valor === "number" && Number.isFinite(valor) && valor > 0 ? Math.floor(valor) : porDefecto;
}
