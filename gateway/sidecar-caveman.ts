import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Agent, request as peticionHttp, type IncomingHttpHeaders } from "node:http";
import { isAbsolute } from "node:path";

import { sha256, sha256DeBytes } from "../src/util/hash.js";
import { recorrerJsonEstricto } from "../src/util/json-estricto.js";
import { BV_SALA_VERSION } from "../src/version.js";
import {
  comprobarPeticion,
  ErrorDePrivacidad,
  ErrorDeRecuperacion,
  resultadoDeBypass,
  utf8Estricto,
  validarPlan,
  type OptimizeRequest,
  type OptimizeResult,
  type Replacement,
  type RetrieveContext,
  type RetrievedPage,
  type SavingsTransformer,
  type Scope,
  type Segment,
} from "../src/transformador/contrato.js";
import { ColaJusta, Cortacircuitos, type EstadoCortacircuitos } from "../src/transformador/guardas.js";

/**
 * EL ADAPTADOR DE SIDECAR (D05): habla con un runtime de Caveman instalado
 * APARTE, en la misma máquina, por el protocolo de middleware 1.1 que el propio
 * Caveman publica (`docs/technical/middleware-protocol.md`, idéntico en v3.2.0 y
 * v4.0.1; ver `docs/especificaciones/CAVEMAN-D05-ENGINE.md`).
 *
 * Por qué ese protocolo y no la CLI `caveman-engine`: la CLI lee stdin y
 * guarda los originales en su propio almacén, pero no tiene ámbito, ni
 * idempotencia, ni límites por petición; el protocolo de middleware sí
 * (scope → autoridad, handles de 192 bits, choices persistidas, 404 sin
 * existencia, `sessions/delete`). Lo sirve el binario `caveman-proxy`
 * (`caveman-proxy serve`), que en esa ruta «no llama a ningún proveedor ni
 * envía telemetría» según su SECURITY.md — algo que un humano tiene que auditar
 * antes de encenderlo (ver el documento).
 *
 * Vive en `gateway/` y no en `src/` porque es Node puro (`node:http`, `node:fs`):
 * `src/` es seguro para navegador por invariante (test/revocation.test.ts). El
 * contrato y las guardas, que no dependen de Node, sí están en
 * `src/transformador/`.
 *
 * Lo que este adaptador GARANTIZA por su lado, pase lo que pase en el sidecar:
 *
 *   · Ni una dependencia nueva: `node:http`, `node:crypto`, `node:fs`.
 *   · Sólo loopback literal (`127.0.0.1` o `[::1]`), sólo `http`, sin seguir
 *     redirecciones, sin proxies de entorno, y comprobando la dirección remota
 *     del socket. Ni DNS: `localhost` se rechaza porque un /etc/hosts lo puede
 *     mandar fuera.
 *   · Antes de la primera petición, la sha256 del binario declarado tiene que
 *     ser la esperada, y el `runtime_build` que anuncia el runtime la versión
 *     fijada. Si no, NINGUNA petición sale (`engine_unverified` /
 *     `version_mismatch`). No descarga ni instala nada, nunca.
 *   · Plazo de 100 ms por defecto: vencido, bypass `deadline`. Cancelación del
 *     llamante: bypass `cancelled`, sin contar como fallo del motor.
 *   · 1 MiB por segmento y 8 MiB por petición: lo que no cabe se OMITE de la
 *     petición al motor (`payload_budget`) y viaja con su original; nunca se
 *     trunca.
 *   · 4 en vuelo + 16 en cola, repartidos por tenant; lo que no cabe, bypass
 *     `capacity`. Retrieve y release tienen su PROPIA cola: un optimizador
 *     saturado no impide recuperar lo ya prometido.
 *   · Cortacircuitos: 5 fallos de infraestructura seguidos lo abren; tras 30 s,
 *     una sola sonda.
 *   · El plan se valida ENTERO —las reglas K5 de Caveman y luego `validarPlan`
 *     del contrato— antes de devolver una sola sustitución. Un plan con una
 *     sustitución mal = bypass `invalid_plan` y un fallo para el cortacircuitos.
 *   · La respuesta se lee en UTF-8 estricto y JSON estricto (claves duplicadas
 *     = respuesta inválida), con tope de 4 MiB.
 *   · No registra nada en ningún log y no envía telemetría: el único destino es
 *     el endpoint declarado. La credencial del runtime vive en un campo privado
 *     y no sale en `JSON.stringify` ni en `inspect`.
 *   · Fallar = devolver un bypass, y quien llama envía el original YA
 *     autorizado. Las únicas excepciones que salen de `optimize` son las que
 *     deben DETENER la petición: Privacy (`ErrorDePrivacidad`) y una petición
 *     mal construida (`PeticionInvalida`).
 */

export interface BinarioFijado {
  /** Ruta ABSOLUTA del ejecutable que el operador instaló (p. ej. `caveman-proxy`). */
  ruta: string;
  /** sha256 hex esperada, obtenida de un build reproducible. Sin ella no se usa el motor. */
  sha256Esperado: string;
  /** Lo que el runtime anuncia como `runtime_build` (lo que imprime `caveman-proxy version`). */
  versionFijada: string;
}

export interface OpcionesSidecarCaveman {
  /** `http://127.0.0.1:<puerto>[/prefijo]` o `http://[::1]:<puerto>[/prefijo]`. Nada más. */
  endpoint: string;
  binario: BinarioFijado;
  /**
   * La credencial del RUNTIME (Bearer), nunca una clave de proveedor. Se pide
   * en cada llamada y no se guarda en ningún campo enumerable.
   */
  credencial?: () => string | undefined;
  timeoutMs?: number;
  retrieveTimeoutMs?: number;
  maxBytesSegmento?: number;
  maxBytesPeticion?: number;
  concurrencia?: number;
  cola?: number;
  fallosParaAbrir?: number;
  abiertoMs?: number;
  /** Cuántos handles emitidos recuerda el adaptador (para revalidar la política al recuperar). */
  maxHandles?: number;
  /** Retención de lo apuntado: por defecto 24 h. */
  retencionMs?: number;
  /** Reloj monótono (cortacircuitos, caché de capacidades). */
  ahoraMonotono?: () => number;
  /** Reloj de pared (plazos de `deadlineAtMs`, retención). */
  ahora?: () => number;
}

const MiB = 1024 * 1024;
const MAX_RESPUESTA = 4 * MiB;
const TTL_CAPACIDADES_MS = 300_000;
const RE_TOKEN = /^[A-Za-z0-9._:/-]{1,256}$/;
const RE_HANDLE = /^cmw_[a-f0-9]{48}$/;
const RE_SHA = /^[a-f0-9]{64}$/;
const codificador = new TextEncoder();

/** Lo que el protocolo exige de una cadena de ámbito (§9): tal cual si es token, `h-` + hash si no. */
export function normalizarToken(valor: string): string {
  if (RE_TOKEN.test(valor)) return valor;
  return "h-" + sha256(valor).slice(0, 32);
}

/** Endpoint loopback literal o null. Se valida el TEXTO, antes de que un parser lo reinterprete. */
export function endpointLoopback(endpoint: string): { host: string; port: number; prefijo: string } | null {
  const m = /^http:\/\/(127\.0\.0\.1|\[::1\]):([1-9][0-9]{0,4})((?:\/[A-Za-z0-9._~-]+)*)\/?$/.exec(endpoint);
  if (!m) return null;
  const port = Number(m[2]);
  if (port > 65535) return null;
  const segs = (m[3] ?? "").split("/").filter(Boolean);
  if (segs.some((s) => s === "." || s === "..")) return null;
  return { host: m[1] === "[::1]" ? "::1" : "127.0.0.1", port, prefijo: segs.length ? "/" + segs.join("/") : "" };
}

const esLoopback = (dir: string | undefined): boolean =>
  dir === "127.0.0.1" || dir === "::1" || dir === "::ffff:127.0.0.1";

/** sha256 de un fichero, por streaming. Sólo LEE: nunca ejecuta lo que hashea. */
async function sha256DeFichero(ruta: string): Promise<string> {
  const h = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    createReadStream(ruta)
      .on("data", (c) => h.update(c))
      .on("error", reject)
      .on("end", () => resolve());
  });
  return h.digest("hex");
}

/**
 * Comprueba el binario declarado: ruta absoluta, fichero normal, no escribible
 * por grupo ni otros (alguien podría cambiarlo después de verificarlo), y la
 * sha256 esperada. Devuelve el motivo del rechazo o null.
 */
export async function verificarBinario(b: BinarioFijado): Promise<null | "engine_unverified"> {
  try {
    if (!b || typeof b.ruta !== "string" || !isAbsolute(b.ruta)) return "engine_unverified";
    if (typeof b.sha256Esperado !== "string" || !RE_SHA.test(b.sha256Esperado)) return "engine_unverified";
    if (typeof b.versionFijada !== "string" || b.versionFijada.length === 0) return "engine_unverified";
    const st = await stat(b.ruta);
    if (!st.isFile() || (st.mode & 0o022) !== 0) return "engine_unverified";
    return (await sha256DeFichero(b.ruta)) === b.sha256Esperado ? null : "engine_unverified";
  } catch {
    return "engine_unverified";
  }
}

// ---------------------------------------------------------------------------
// Lectura estricta de las respuestas
// ---------------------------------------------------------------------------

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

/** UTF-8 estricto, JSON estricto (sin claves repetidas a ninguna profundidad) y objeto en la raíz. */
export function parsearRespuesta(cuerpo: Uint8Array): Record<string, Json> | null {
  const texto = utf8Estricto(cuerpo);
  if (texto === null) return null;
  if (!recorrerJsonEstricto(texto).ok) return null;
  const v = JSON.parse(texto) as Json;
  return v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
}

const esEnteroSeguro = (v: unknown, min = 0): v is number => Number.isSafeInteger(v) && (v as number) >= min;

// ---------------------------------------------------------------------------
// Capacidades
// ---------------------------------------------------------------------------

interface Capacidades {
  runtimeBuild: string;
  policyRevision: string;
  /** transform_id → implementation_version, sólo los utilizables (deterministas, exact_ccr, tool_result). */
  transforms: Map<string, string>;
  limites: { requestBytes: number; segmentBytes: number; pageBytes: number; maxSegments: number };
}

function leerCapacidades(doc: Record<string, Json>): Capacidades | "invalid" {
  if (doc["schema_version"] !== 1) return "invalid";
  const proto = doc["protocol"];
  if (proto && typeof proto === "object" && !Array.isArray(proto)) {
    const min = proto["min"];
    const max = proto["max"];
    if (esEnteroSeguro(min, 1) && esEnteroSeguro(max, 1) && !(min <= 1 && 1 <= max)) return "invalid";
  }
  const build = doc["runtime_build"];
  const rev = doc["policy_revision"];
  const ts = doc["transforms"];
  const lim = doc["limits"];
  if (typeof build !== "string" || typeof rev !== "string" || !RE_TOKEN.test(rev) || !Array.isArray(ts)) return "invalid";
  if (!lim || typeof lim !== "object" || Array.isArray(lim)) return "invalid";
  for (const k of ["deadline_ms", "request_bytes", "segment_bytes", "page_bytes"]) {
    if (!esEnteroSeguro(lim[k], 1)) return "invalid";
  }
  const transforms = new Map<string, string>();
  for (const t of ts) {
    if (!t || typeof t !== "object" || Array.isArray(t)) continue;
    const id = t["transform_id"];
    const ver = t["implementation_version"];
    const kinds = t["eligible_segment_kinds"];
    if (typeof id !== "string" || !RE_TOKEN.test(id) || typeof ver !== "string" || !RE_TOKEN.test(ver)) continue;
    if (t["deterministic"] !== true || t["recovery"] !== "exact_ccr") continue;
    if (!Array.isArray(kinds) || !kinds.includes("tool_result")) continue;
    if (!transforms.has(id)) transforms.set(id, ver);
  }
  const maxSeg = lim["max_segments"];
  return {
    runtimeBuild: build,
    policyRevision: rev,
    transforms,
    limites: {
      requestBytes: lim["request_bytes"] as number,
      segmentBytes: lim["segment_bytes"] as number,
      pageBytes: lim["page_bytes"] as number,
      maxSegments: esEnteroSeguro(maxSeg, 1) ? maxSeg : 256,
    },
  };
}

// ---------------------------------------------------------------------------
// Transporte
// ---------------------------------------------------------------------------

type Respuesta =
  | { ok: true; status: number; cabeceras: IncomingHttpHeaders; cuerpo: Uint8Array }
  | { ok: false; motivo: "runtime_unavailable" | "redirect_refused" | "payload_limit" | "aborted" };

/** Clasificación de un error del runtime (§6), reducida a lo que este lado necesita. */
interface Clasificacion {
  motivo: string;
  cortacircuitos: boolean;
  limpiarCapacidades: boolean;
  retryAfterMs: number | null;
}

function clasificarError(status: number, cuerpo: Uint8Array, cabeceras: IncomingHttpHeaders): Clasificacion {
  let codigo: string | null = null;
  try {
    const t = new TextDecoder("utf-8").decode(cuerpo);
    const v = JSON.parse(t) as { error?: { code?: unknown } };
    const c = v?.error?.code;
    if (typeof c === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(c)) codigo = c;
  } catch {
    codigo = null;
  }
  const ra = cabeceras["retry-after"];
  const raNum = typeof ra === "string" && /^\d+$/.test(ra) ? Math.min(Number(ra) * 1000, 30_000) : null;
  const retryAfterMs = status === 429 || status === 503 ? raNum : null;
  if (codigo === null) return { motivo: "runtime_unavailable", cortacircuitos: true, limpiarCapacidades: true, retryAfterMs };
  switch (codigo) {
    case "unauthorized":
    case "forbidden_origin":
    case "forbidden_namespace":
      return { motivo: "runtime_unauthorized", cortacircuitos: false, limpiarCapacidades: false, retryAfterMs: null };
    case "capacity":
    case "quota_exceeded":
      return { motivo: "capacity", cortacircuitos: false, limpiarCapacidades: false, retryAfterMs };
    case "unknown_capability":
    case "unsupported_version":
      return { motivo: "unknown_capability", cortacircuitos: false, limpiarCapacidades: true, retryAfterMs: null };
    case "deleted":
    case "expired":
      return { motivo: "scope_revoked", cortacircuitos: false, limpiarCapacidades: false, retryAfterMs: null };
    case "deadline":
    case "request_timeout":
      return { motivo: "deadline", cortacircuitos: true, limpiarCapacidades: false, retryAfterMs };
    case "payload_limit":
      return { motivo: "payload_limit", cortacircuitos: false, limpiarCapacidades: false, retryAfterMs: null };
    default:
      return status >= 500
        ? { motivo: "runtime_unavailable", cortacircuitos: true, limpiarCapacidades: true, retryAfterMs }
        : { motivo: "runtime_rejected", cortacircuitos: false, limpiarCapacidades: false, retryAfterMs: null };
  }
}

/** Una señal que se aborta cuando lo hace cualquiera de las dadas. Devuelve también cómo soltarla. */
function combinarSenales(...senales: (AbortSignal | undefined)[]): { signal: AbortSignal; soltar: () => void } {
  const ac = new AbortController();
  const quitar: (() => void)[] = [];
  for (const s of senales) {
    if (!s) continue;
    if (s.aborted) {
      ac.abort();
      break;
    }
    const f = () => ac.abort();
    s.addEventListener("abort", f, { once: true });
    quitar.push(() => s.removeEventListener("abort", f));
  }
  return { signal: ac.signal, soltar: () => quitar.forEach((q) => q()) };
}

// ---------------------------------------------------------------------------
// El registro de handles emitidos
// ---------------------------------------------------------------------------

interface Apunte {
  clave: string;
  privacyPolicyHash: string;
  originalSha256: string;
  hasta: number;
}

/** Clave de ámbito: los cinco campos, sin ambigüedad de separadores. */
export const claveDeAmbito = (s: Scope): string =>
  JSON.stringify([s.tenantId, s.projectId, s.sessionId, s.branchId, s.epoch]);

// ---------------------------------------------------------------------------

const RESPUESTA_A_TOOL = "caveman_retrieve";

export class SidecarCaveman implements SavingsTransformer {
  readonly #credencial: (() => string | undefined) | undefined;
  readonly #opc: Required<
    Omit<OpcionesSidecarCaveman, "credencial" | "binario" | "endpoint" | "ahoraMonotono" | "ahora">
  >;
  readonly #binario: BinarioFijado;
  readonly #destino: { host: string; port: number; prefijo: string } | null;
  readonly #ahoraMono: () => number;
  readonly #ahora: () => number;
  readonly #cortacircuitos: Cortacircuitos;
  readonly #colaOptimizar: ColaJusta;
  readonly #colaRecuperar: ColaJusta;
  readonly #agente: Agent;
  readonly #apuntes = new Map<string, Apunte>();
  #verificacion: Promise<null | "engine_unverified"> | null = null;
  #capacidades: { valor: Capacidades; desde: number } | null = null;
  #capacidadesEnVuelo: Promise<Capacidades | Clasificacion> | null = null;
  #silencioHasta = 0;

  constructor(o: OpcionesSidecarCaveman) {
    this.#credencial = o.credencial;
    this.#binario = { ...o.binario };
    this.#destino = endpointLoopback(o.endpoint);
    this.#ahoraMono =
      o.ahoraMonotono ??
      (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
    this.#ahora = o.ahora ?? Date.now;
    this.#opc = {
      timeoutMs: o.timeoutMs ?? 100,
      retrieveTimeoutMs: o.retrieveTimeoutMs ?? 5000,
      maxBytesSegmento: o.maxBytesSegmento ?? 1 * MiB,
      maxBytesPeticion: o.maxBytesPeticion ?? 8 * MiB,
      concurrencia: o.concurrencia ?? 4,
      cola: o.cola ?? 16,
      fallosParaAbrir: o.fallosParaAbrir ?? 5,
      abiertoMs: o.abiertoMs ?? 30_000,
      maxHandles: o.maxHandles ?? 65_536,
      retencionMs: o.retencionMs ?? 24 * 3600_000,
    };
    this.#cortacircuitos = new Cortacircuitos({
      fallosSeguidos: this.#opc.fallosParaAbrir,
      abiertoMs: this.#opc.abiertoMs,
      ahora: this.#ahoraMono,
    });
    this.#colaOptimizar = new ColaJusta({ concurrencia: this.#opc.concurrencia, cola: this.#opc.cola });
    this.#colaRecuperar = new ColaJusta({ concurrencia: this.#opc.concurrencia, cola: this.#opc.cola });
    this.#agente = new Agent({ keepAlive: true, maxSockets: this.#opc.concurrencia * 2 });
  }

  /** Para métricas y readiness: el estado del cortacircuitos, sin E/S. */
  get estadoCortacircuitos(): EstadoCortacircuitos {
    return this.#cortacircuitos.estado;
  }

  /** La versión que se exige al runtime. */
  get versionFijada(): string {
    return this.#binario.versionFijada;
  }

  /** Nada sensible en `JSON.stringify(sidecar)`. */
  toJSON(): Record<string, unknown> {
    return { tipo: "SidecarCaveman", versionFijada: this.#binario.versionFijada, endpointValido: this.#destino !== null };
  }

  /** Cierra las conexiones vivas. */
  cerrar(): void {
    this.#agente.destroy();
  }

  /**
   * Readiness: endpoint válido, binario verificado y capacidades con la versión
   * fijada. Pide `capabilities` (no hace inferencia ni optimiza nada).
   */
  async listo(signal?: AbortSignal): Promise<{ listo: boolean; motivo: string; runtimeBuild?: string }> {
    if (!this.#destino) return { listo: false, motivo: "invalid_endpoint" };
    const v = await this.#verificar();
    if (v) return { listo: false, motivo: v };
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.#opc.retrieveTimeoutMs);
    const { signal: s, soltar } = combinarSenales(signal, ac.signal);
    try {
      const caps = await this.#pedirCapacidades(s);
      if ("motivo" in caps) return { listo: false, motivo: caps.motivo };
      return { listo: true, motivo: "ready", runtimeBuild: caps.runtimeBuild };
    } finally {
      clearTimeout(t);
      soltar();
    }
  }

  async optimize(req: OptimizeRequest, signal: AbortSignal): Promise<OptimizeResult> {
    // Lo que DETIENE va primero y lanza: Privacy y una petición mal hecha.
    comprobarPeticion(req);

    if (req.mode === "off") return resultadoDeBypass(req, "off");
    if (!this.#destino) return resultadoDeBypass(req, "invalid_endpoint");
    if (
      req.endpoint.provider !== "anthropic" ||
      req.endpoint.route !== "/v1/messages" ||
      req.endpoint.streaming ||
      req.endpoint.providerState !== "none"
    ) {
      // Piloto: Anthropic Messages SIN streaming (decisión provisional).
      return resultadoDeBypass(req, "unsupported_route");
    }
    // Las transformaciones de Caveman OMITEN y recuperan (exact_ccr): no hay
    // ninguna sin pérdida que podamos pedirle, así que `lossless` no le toca.
    if (req.mode === "lossless") return resultadoDeBypass(req, "unknown_capability");
    if (req.mode === "recoverable" && !req.recoveryBinding) return resultadoDeBypass(req, "recovery_unbound");
    if (signal.aborted) return resultadoDeBypass(req, "cancelled");

    // Candidatos (filtros locales, sin E/S).
    const skipped: { id: string; reason: string }[] = [];
    const candidatos: { seg: Segment; texto: string }[] = [];
    for (const s of req.segments) {
      if (s.protected) {
        skipped.push({ id: s.id, reason: "protected" });
        continue;
      }
      const texto = utf8Estricto(s.utf8);
      if (texto === null || !RE_TOKEN.test(s.id) || !RE_TOKEN.test(s.sourceId)) {
        skipped.push({ id: s.id, reason: "unsupported_shape" });
        continue;
      }
      if (s.utf8.length > this.#opc.maxBytesSegmento) {
        skipped.push({ id: s.id, reason: "payload_budget" });
        continue;
      }
      candidatos.push({ seg: s, texto });
    }
    if (candidatos.length === 0) {
      const motivo = skipped.some((x) => x.reason === "payload_budget")
        ? "payload_budget"
        : skipped.some((x) => x.reason === "unsupported_shape")
          ? "unsupported_shape"
          : "no_candidate";
      return resultadoDeBypass(req, motivo, { skipped });
    }

    // El binario, antes de la primera E/S de red.
    const v = await this.#verificar();
    if (v) return resultadoDeBypass(req, v);
    if (this.#ahoraMono() < this.#silencioHasta) return resultadoDeBypass(req, "capacity");

    // Plazo: el menor entre el del llamante y nuestro timeout.
    const plazo = Math.min(req.deadlineAtMs, this.#ahora() + this.#opc.timeoutMs);
    const restante = plazo - this.#ahora();
    if (restante <= 0) return resultadoDeBypass(req, "deadline");
    const reloj = new AbortController();
    const temporizador = setTimeout(() => reloj.abort(), restante);
    const { signal: s, soltar } = combinarSenales(signal, reloj.signal);
    const motivoDeAborto = () => (signal.aborted ? "cancelled" : "deadline");

    try {
      const turno = await this.#colaOptimizar.turno(req.scope.tenantId, s);
      if (!turno.ok) return resultadoDeBypass(req, s.aborted ? motivoDeAborto() : "capacity");
      try {
        const adm = this.#cortacircuitos.admitir();
        if (!adm.ok) return resultadoDeBypass(req, "circuit_open");
        let registrado = false;
        const registrar = (r: "exito" | "fallo") => {
          registrado = true;
          this.#cortacircuitos.registrar(r, adm.sonda);
        };
        try {
          return await this.#optimizarConTurno(req, candidatos, skipped, s, motivoDeAborto, registrar);
        } finally {
          if (!registrado) this.#cortacircuitos.liberar(adm.sonda);
        }
      } finally {
        turno.liberar();
      }
    } finally {
      clearTimeout(temporizador);
      soltar();
    }
  }

  async #optimizarConTurno(
    req: OptimizeRequest,
    candidatos: { seg: Segment; texto: string }[],
    skipped: { id: string; reason: string }[],
    s: AbortSignal,
    motivoDeAborto: () => string,
    registrar: (r: "exito" | "fallo") => void,
  ): Promise<OptimizeResult> {
    const fallo = (c: Clasificacion | { motivo: string; cortacircuitos: boolean }): OptimizeResult => {
      if (c.motivo === "aborted") {
        const m = motivoDeAborto();
        if (m === "deadline") registrar("fallo");
        return resultadoDeBypass(req, m);
      }
      registrar(c.cortacircuitos ? "fallo" : "exito");
      if ("retryAfterMs" in c && c.retryAfterMs) this.#silencioHasta = this.#ahoraMono() + c.retryAfterMs;
      if ("limpiarCapacidades" in c && c.limpiarCapacidades) this.#capacidades = null;
      return resultadoDeBypass(req, c.motivo);
    };

    const caps = await this.#capacidadesVigentes(s);
    if ("motivo" in caps) return fallo(caps);

    const politica = req.allowedTransforms.filter((t) => caps.transforms.has(t));
    if (politica.length === 0) {
      registrar("exito");
      return resultadoDeBypass(req, "unknown_capability", { runtimeBuild: caps.runtimeBuild });
    }

    // Presupuesto (§11): sobre de la petición + cada segmento, sin truncar nada.
    const maxSeg = Math.min(this.#opc.maxBytesSegmento, caps.limites.segmentBytes);
    const maxPet = Math.min(this.#opc.maxBytesPeticion, caps.limites.requestBytes);
    const cuerpoBase = this.#cuerpoOptimizar(req, politica, caps.policyRevision, []);
    const sobre = Buffer.byteLength(JSON.stringify(cuerpoBase));
    let usado = 0;
    const enviados: { seg: Segment; wire: Record<string, Json> }[] = [];
    for (const c of candidatos) {
      if (c.seg.utf8.length > maxSeg) {
        skipped.push({ id: c.seg.id, reason: "payload_budget" });
        continue;
      }
      const wire: Record<string, Json> = {
        id: c.seg.id,
        kind: "tool_result",
        cache_region: "live_zone",
        content: c.texto,
        sha256: c.seg.sha256,
        source_id: c.seg.sourceId,
        protected: false,
        opaque: false,
      };
      const bytes = Buffer.byteLength(JSON.stringify(wire)) + 1;
      if (enviados.length >= caps.limites.maxSegments || sobre + usado + bytes > maxPet) {
        skipped.push({ id: c.seg.id, reason: "payload_budget" });
        continue;
      }
      usado += bytes;
      enviados.push({ seg: c.seg, wire });
    }
    if (enviados.length === 0) {
      registrar("exito");
      return resultadoDeBypass(req, "payload_budget", { skipped, runtimeBuild: caps.runtimeBuild });
    }

    const cuerpo = this.#cuerpoOptimizar(
      req,
      politica,
      caps.policyRevision,
      enviados.map((e) => e.wire),
    );
    const r = await this.#http("POST", "optimize", cuerpo, s);
    if (!r.ok) {
      return fallo({ motivo: r.motivo === "aborted" ? "aborted" : r.motivo, cortacircuitos: true });
    }
    if (r.status !== 200) return fallo(clasificarError(r.status, r.cuerpo, r.cabeceras));
    const plan = parsearRespuesta(r.cuerpo);
    if (!plan) return fallo({ motivo: "runtime_unavailable", cortacircuitos: true });

    const traducido = this.#traducirPlan(req, plan, enviados, politica, caps, skipped);
    if (traducido === "invalid") {
      this.#capacidades = null;
      return fallo({ motivo: "invalid_plan", cortacircuitos: true });
    }
    // Defensa en profundidad: el contrato vuelve a validar el plan traducido.
    if (!validarPlan(req, traducido).ok) {
      return fallo({ motivo: "invalid_plan", cortacircuitos: true });
    }
    // Sin apuntar el handle no hay recuperación comprobada: no se emite omisión.
    if (traducido.replacements.length > 0 && !this.#apuntar(req, traducido.replacements)) {
      registrar("exito");
      return resultadoDeBypass(req, "capacity", { runtimeBuild: caps.runtimeBuild });
    }
    registrar("exito");
    return traducido;
  }

  #cuerpoOptimizar(
    req: OptimizeRequest,
    politica: string[],
    revision: string,
    segmentos: Record<string, Json>[],
  ): Record<string, Json> {
    const manifiesto =
      req.historyManifest && req.historyManifest.length > 0
        ? req.historyManifest.slice(0, 4096).map((m) => ({ id: normalizarToken(m.id), sha256: m.sha256 }))
        : [{ id: "history", sha256: req.historyManifestHash }];
    const compress = req.mode === "recoverable";
    return {
      schema_version: 1,
      request_id: normalizarToken(req.requestId),
      logical_call_id: normalizarToken(req.requestId),
      attempt_id: normalizarToken(req.idempotencyKey),
      idempotency_key: normalizarToken(req.idempotencyKey),
      scope: this.#ambitoWire(req.scope),
      sequence: req.sequence,
      adapter: {
        id: "bivelio-savings-layer",
        version: normalizarToken(BV_SALA_VERSION),
        framework_version: "anthropic-messages",
        serialization_revision: "1",
      },
      model: {
        provider: normalizarToken(req.endpoint.provider),
        id: normalizarToken(req.endpoint.model),
        protocol: "anthropic-messages",
      },
      mode: compress ? "compress" : "record",
      policy: { revision, transforms: politica },
      segments: segmentos,
      context_manifest: manifiesto,
      recovery_binding:
        compress && req.recoveryBinding
          ? {
              id: normalizarToken(req.recoveryBinding.executorId),
              kind: "host_tool",
              tool_name: RESPUESTA_A_TOOL,
              overhead_text: req.recoveryBinding.overheadText ?? "",
            }
          : null,
    };
  }

  #ambitoWire(s: Scope): Record<string, Json> {
    return {
      namespace: normalizarToken(`${s.tenantId}:${s.projectId}`),
      session_id: normalizarToken(s.sessionId),
      branch_id: normalizarToken(s.branchId),
      cache_epoch: normalizarToken(s.epoch),
    };
  }

  /**
   * Las reglas K5 del protocolo de Caveman, más las nuestras. Cualquier
   * violación invalida el plan ENTERO.
   */
  #traducirPlan(
    req: OptimizeRequest,
    plan: Record<string, Json>,
    enviados: { seg: Segment; wire: Record<string, Json> }[],
    politica: string[],
    caps: Capacidades,
    skippedLocales: { id: string; reason: string }[],
  ): OptimizeResult | "invalid" {
    if (plan["schema_version"] !== 1) return "invalid";
    if (plan["request_id"] !== normalizarToken(req.requestId)) return "invalid";
    const status = plan["status"];
    if (status !== "optimized" && status !== "bypassed" && status !== "record") return "invalid";
    const reason = plan["reason"];
    if (typeof reason !== "string" || !RE_TOKEN.test(reason)) return "invalid";
    const reps = plan["replacements"];
    const skips = plan["skipped"];
    if (!Array.isArray(reps) || !Array.isArray(skips)) return "invalid";
    if (status !== "optimized" && reps.length > 0) return "invalid";
    if (req.mode !== "recoverable" && reps.length > 0) return "invalid";

    const porId = new Map(enviados.map((e) => [e.seg.id, e.seg] as const));
    const permitidos = new Set(politica);
    const vistos = new Set<string>();
    const replacements: Replacement[] = [];
    for (const x of reps) {
      if (!x || typeof x !== "object" || Array.isArray(x)) return "invalid";
      const segId = x["segment_id"];
      const seg = typeof segId === "string" ? porId.get(segId) : undefined;
      // Sólo los segmentos ENVIADOS: ni uno no declarado, ni uno protegido (no se mandan).
      if (!seg || vistos.has(seg.id)) return "invalid";
      vistos.add(seg.id);
      const tid = x["transform_id"];
      const tver = x["transform_version"];
      const handle = x["recovery_handle"];
      const text = x["text"];
      const sha = x["sha256"];
      if (typeof tid !== "string" || !permitidos.has(tid) || !caps.transforms.has(tid)) return "invalid";
      if (typeof tver !== "string" || !RE_TOKEN.test(tver)) return "invalid";
      if (typeof handle !== "string" || !RE_HANDLE.test(handle)) return "invalid";
      if (typeof text !== "string") return "invalid";
      if (!text.startsWith(`[caveman: shortened; exact original via caveman_retrieve handle=${handle}]\n`)) {
        return "invalid";
      }
      if (x["original_sha256"] !== seg.sha256 || x["source_id"] !== seg.sourceId) return "invalid";
      const utf8 = codificador.encode(text);
      if (utf8.length >= seg.utf8.length) return "invalid";
      if (typeof sha !== "string" || sha !== sha256DeBytes(utf8)) return "invalid";
      replacements.push({
        segmentId: seg.id,
        originalSha256: seg.sha256,
        utf8,
        replacementSha256: sha,
        transformId: tid,
        version: tver,
        handle,
      });
    }
    const skipped = [...skippedLocales];
    for (const k of skips) {
      if (!k || typeof k !== "object" || Array.isArray(k)) return "invalid";
      const id = k["segment_id"];
      const r = k["reason"];
      if (typeof id !== "string" || !porId.has(id) || vistos.has(id)) return "invalid";
      if (typeof r !== "string" || !RE_TOKEN.test(r)) return "invalid";
      skipped.push({ id, reason: r });
    }
    const med = plan["measurement"];
    const m = med && typeof med === "object" && !Array.isArray(med) ? med : {};
    const aplicado = replacements.length > 0;
    return {
      status: aplicado ? "applied" : "bypassed",
      reason: aplicado ? "applied" : status === "record" ? "record" : reason,
      replacements,
      skipped,
      estimate: {
        ...(esEnteroSeguro(m["tokens_before"]) ? { inputBefore: m["tokens_before"] } : {}),
        ...(esEnteroSeguro(m["tokens_after"]) ? { inputAfter: m["tokens_after"] } : {}),
        tokenizer: typeof m["tokenizer"] === "string" ? m["tokenizer"] : "unknown",
        basis: "estimated",
        overheadTokens: esEnteroSeguro(m["recovery_overhead_tokens"]) ? m["recovery_overhead_tokens"] : 0,
      },
      runtimeBuild: caps.runtimeBuild,
      policyVersion: req.policyVersion,
      decisionId: typeof plan["replacement_set_id"] === "string" ? plan["replacement_set_id"] : "none",
    };
  }

  /** Apunta los handles emitidos; false si no caben (y entonces no se emite ninguno). */
  #apuntar(req: OptimizeRequest, reps: Replacement[]): boolean {
    const ahora = this.#ahora();
    for (const [h, a] of this.#apuntes) if (a.hasta <= ahora) this.#apuntes.delete(h);
    const nuevos = reps.filter((r) => r.handle && !this.#apuntes.has(r.handle)).length;
    if (this.#apuntes.size + nuevos > this.#opc.maxHandles) return false;
    const clave = claveDeAmbito(req.scope);
    const porId = new Map(req.segments.map((s) => [s.id, s] as const));
    for (const r of reps) {
      if (!r.handle) continue;
      this.#apuntes.set(r.handle, {
        clave,
        privacyPolicyHash: porId.get(r.segmentId)!.privacyPolicyHash,
        originalSha256: r.originalSha256,
        hasta: ahora + this.#opc.retencionMs,
      });
    }
    return true;
  }

  async retrieve(scope: Scope, handle: string, cursor?: string, context?: RetrieveContext): Promise<RetrievedPage> {
    if (!context || typeof context.privacyPolicyHash !== "string" || context.privacyPolicyHash.length === 0) {
      throw new ErrorDePrivacidad("policy_unverified", "recuperar exige la huella de la política vigente");
    }
    const a = this.#apuntes.get(handle);
    // Desconocido, ajeno o caducado: el MISMO error, y sin E/S.
    if (!a || a.clave !== claveDeAmbito(scope) || a.hasta <= this.#ahora()) {
      throw new ErrorDeRecuperacion("not_found");
    }
    if (a.privacyPolicyHash !== context.privacyPolicyHash) {
      throw new ErrorDePrivacidad(
        "policy_changed",
        "la política cambió desde que se emitió el handle: reconstruir en una época nueva o denegar",
      );
    }
    let offset = 0;
    if (cursor !== undefined) {
      if (!/^(0|[1-9][0-9]{0,14})$/.test(cursor)) throw new ErrorDeRecuperacion("invalid_cursor");
      offset = Number(cursor);
    }
    const r = await this.#conColaDeRecuperacion(scope, context.signal, (s) =>
      this.#http(
        "POST",
        "retrieve",
        {
          schema_version: 1,
          scope: this.#ambitoWire(scope),
          handle,
          offset,
          limit: this.#capacidades?.valor.limites.pageBytes ?? 262_144,
          query: "",
        },
        s,
      ),
    );
    if (!r.ok) throw new ErrorDeRecuperacion(r.motivo === "aborted" ? "cancelled" : "recovery_unavailable");
    if (r.status !== 200) {
      const c = clasificarError(r.status, r.cuerpo, r.cabeceras);
      throw new ErrorDeRecuperacion(
        r.status === 404 ? "not_found" : r.status === 410 ? "scope_revoked" : c.motivo === "runtime_unauthorized" ? c.motivo : "recovery_unavailable",
      );
    }
    const p = parsearRespuesta(r.cuerpo);
    if (!p || p["schema_version"] !== 1 || p["handle"] !== handle) throw new ErrorDeRecuperacion("recovery_unavailable");
    // Un extracto no es el original: sólo páginas del original exacto.
    if (p["kind"] !== "original_page" || p["offset"] !== offset) throw new ErrorDeRecuperacion("recovery_unavailable");
    if (p["original_sha256"] !== a.originalSha256) throw new ErrorDeRecuperacion("integrity_failure");
    const text = p["text"];
    const next = p["next_offset"];
    if (typeof text !== "string") throw new ErrorDeRecuperacion("recovery_unavailable");
    if (next !== null && !(esEnteroSeguro(next) && next > offset)) throw new ErrorDeRecuperacion("recovery_unavailable");
    return {
      utf8: codificador.encode(text),
      sha256: a.originalSha256,
      ...(next === null ? {} : { nextCursor: String(next) }),
    };
  }

  async release(scope: Scope): Promise<{ revoked: boolean }> {
    // Primero lo local: aunque el runtime falle, este adaptador ya no sirve esos handles.
    const clave = claveDeAmbito(scope);
    for (const [h, a] of this.#apuntes) if (a.clave === clave) this.#apuntes.delete(h);
    if (!this.#destino) return { revoked: false };
    const r = await this.#conColaDeRecuperacion(scope, undefined, (s) =>
      this.#http("POST", "sessions/delete", { schema_version: 1, scope: this.#ambitoWire(scope) }, s),
    );
    if (!r.ok || r.status !== 200) return { revoked: false };
    const p = parsearRespuesta(r.cuerpo);
    return { revoked: !!p && p["status"] === "revoked" };
  }

  async #conColaDeRecuperacion(
    scope: Scope,
    signal: AbortSignal | undefined,
    f: (s: AbortSignal) => Promise<Respuesta>,
  ): Promise<Respuesta> {
    if (!this.#destino) return { ok: false, motivo: "runtime_unavailable" };
    const reloj = new AbortController();
    const t = setTimeout(() => reloj.abort(), this.#opc.retrieveTimeoutMs);
    const { signal: s, soltar } = combinarSenales(signal, reloj.signal);
    try {
      const turno = await this.#colaRecuperar.turno(scope.tenantId, s);
      if (!turno.ok) return { ok: false, motivo: turno.motivo === "cancelled" ? "aborted" : "runtime_unavailable" };
      try {
        return await f(s);
      } finally {
        turno.liberar();
      }
    } finally {
      clearTimeout(t);
      soltar();
    }
  }

  #verificar(): Promise<null | "engine_unverified"> {
    this.#verificacion ??= verificarBinario(this.#binario);
    return this.#verificacion;
  }

  async #capacidadesVigentes(s: AbortSignal): Promise<Capacidades | Clasificacion> {
    const c = this.#capacidades;
    if (c && this.#ahoraMono() - c.desde < TTL_CAPACIDADES_MS) return c.valor;
    return this.#pedirCapacidades(s);
  }

  /** Una sola petición de capacidades a la vez (single-flight). */
  #pedirCapacidades(s: AbortSignal): Promise<Capacidades | Clasificacion> {
    if (!this.#capacidadesEnVuelo) {
      this.#capacidadesEnVuelo = (async (): Promise<Capacidades | Clasificacion> => {
        const r = await this.#http("GET", "capabilities", null, s);
        if (!r.ok) {
          return { motivo: r.motivo === "aborted" ? "aborted" : r.motivo, cortacircuitos: true, limpiarCapacidades: true, retryAfterMs: null };
        }
        if (r.status !== 200) return clasificarError(r.status, r.cuerpo, r.cabeceras);
        const doc = parsearRespuesta(r.cuerpo);
        const caps = doc ? leerCapacidades(doc) : "invalid";
        if (caps === "invalid") return { motivo: "runtime_unavailable", cortacircuitos: true, limpiarCapacidades: true, retryAfterMs: null };
        // La versión fijada, o nada: un runtime distinto del verificado no se usa.
        if (caps.runtimeBuild !== this.#binario.versionFijada) {
          return { motivo: "version_mismatch", cortacircuitos: false, limpiarCapacidades: true, retryAfterMs: null };
        }
        this.#capacidades = { valor: caps, desde: this.#ahoraMono() };
        return caps;
      })().finally(() => {
        this.#capacidadesEnVuelo = null;
      });
    }
    return this.#capacidadesEnVuelo;
  }

  #http(metodo: "GET" | "POST", ruta: string, cuerpo: Record<string, Json> | null, signal: AbortSignal): Promise<Respuesta> {
    const d = this.#destino!;
    const datos = cuerpo === null ? null : Buffer.from(JSON.stringify(cuerpo), "utf8");
    const cabeceras: Record<string, string> = {
      "caveman-middleware-features": "http_status_v2, revision_tolerant",
      "caveman-middleware-client": `bivelio-savings-layer/${BV_SALA_VERSION}`,
      accept: "application/json",
    };
    const token = this.#credencial?.();
    if (token) cabeceras["authorization"] = `Bearer ${token}`;
    if (datos) {
      cabeceras["content-type"] = "application/json";
      cabeceras["content-length"] = String(datos.length);
    }
    return new Promise<Respuesta>((resolve) => {
      if (signal.aborted) return resolve({ ok: false, motivo: "aborted" });
      let terminado = false;
      const fin = (r: Respuesta) => {
        if (terminado) return;
        terminado = true;
        signal.removeEventListener("abort", alAbortar);
        resolve(r);
      };
      const req = peticionHttp({
        host: d.host,
        port: d.port,
        family: d.host === "::1" ? 6 : 4,
        method: metodo,
        path: `${d.prefijo}/caveman/v1/middleware/${ruta}`,
        headers: cabeceras,
        agent: this.#agente,
      });
      const alAbortar = () => {
        req.destroy();
        fin({ ok: false, motivo: "aborted" });
      };
      signal.addEventListener("abort", alAbortar, { once: true });
      req.on("error", () => fin({ ok: false, motivo: signal.aborted ? "aborted" : "runtime_unavailable" }));
      req.on("response", (res) => {
        if (!esLoopback(res.socket?.remoteAddress)) {
          req.destroy();
          return fin({ ok: false, motivo: "runtime_unavailable" });
        }
        const st = res.statusCode ?? 0;
        if (st >= 300 && st < 400) {
          res.resume();
          return fin({ ok: false, motivo: "redirect_refused" });
        }
        const trozos: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          total += c.length;
          if (total > MAX_RESPUESTA) {
            req.destroy();
            return fin({ ok: false, motivo: "payload_limit" });
          }
          trozos.push(c);
        });
        res.on("error", () => fin({ ok: false, motivo: signal.aborted ? "aborted" : "runtime_unavailable" }));
        res.on("end", () => {
          if (!res.complete) return fin({ ok: false, motivo: "runtime_unavailable" });
          fin({ ok: true, status: st, cabeceras: res.headers, cuerpo: new Uint8Array(Buffer.concat(trozos)) });
        });
      });
      req.end(datos ?? undefined);
    });
  }
}
