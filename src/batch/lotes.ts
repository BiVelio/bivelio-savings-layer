import type {
  BatchCounts,
  BatchItemResult,
  BatchJob,
  BatchJobStatus,
  BatchRequest,
  BatchResults,
  BatchSubmitOptions,
  BatchSummary,
  SavingsBatches,
} from "../contracts/batch.js";
import type { ChatMessage, JsonSchema, PriceLeverSaving, SavingsRequest } from "../contracts/types.js";
import { seleccionarCompactables, type ToolOutputCompactionSettings } from "../compression/cola.js";
import { aplicarElision, seleccionarSupersesion } from "../pipeline/elision.js";
import { validateAgainstSchema } from "../constraints/validate.js";
import { topeDeSalida } from "../contracts/tope-de-salida.js";
import { valorarTierServido, type MotivoSinValoracion } from "../economics/tier-diferido.js";
import { BatchSubmitError } from "../pipeline/errors.js";
import { tryParse } from "../pipeline/pipeline.js";
import type { OrigenDeTarifa } from "../pricing/tarifas-de-tier.js";
import { lotesDelProveedor, type CapacidadDeLotes } from "../providers/lotes-del-proveedor.js";
import { cerrarParada } from "../providers/motivo-de-parada.js";
import type { ProviderRequest, ProviderResponse } from "../providers/types.js";
import type { CostModel } from "../tokenizer/accounting.js";

// ═══════════════════════════════════════════════════════════════════════════
// LA SUPERFICIE DE LOTES: `layer.batches`.
// ═══════════════════════════════════════════════════════════════════════════
//
// La Batch API del proveedor —Message Batches de Anthropic, Batch API de OpenAI
// sobre Chat Completions— cobra la mitad a cambio de una espera de horas. No cabe
// en `generate()`, que es petición/respuesta (ver «EL ASÍNCRONO» en
// economics/tier-diferido.ts), así que tiene su propia superficie, y esta es.
//
// LO QUE HACE, EN ORDEN:
//   · `submit` traduce cada petición con el MISMO adaptador que usa generate()
//     (lotes-del-proveedor.ts), la trocea por los límites del proveedor y la
//     envía. No devuelve NINGUNA cifra: el trabajo pendiente no se tarifa.
//   · `status` pregunta al proveedor cómo va cada trozo.
//   · `results` baja los resultados de los trozos que terminaron y valora cada
//     uno con la regla de `valorarTierServido`: el `usage` del proveedor a la
//     tarifa estándar menos el mismo `usage` a la tarifa de lote publicada.
//   · `cancel` pide al proveedor que pare lo que no haya empezado.
//
// LO QUE NO HACE, A PROPÓSITO (primera fase):
//   · Ninguna palanca propia de la capa: ni caché exacta, ni compresión, ni
//     cascada, ni retrieval. Las peticiones viajan como las escribió el cliente.
//     `retrieval` y `structuredData` se RECHAZAN (son trabajo del pipeline, y
//     aceptarlas en silencio mandaría otra petición que la que se pidió).
//   · Nada de metering: el uso de un lote no se emite y su ahorro no se cobra.
//   · Gemini: su endpoint compatible crea lotes pero no sube ni baja ficheros.
//
// Todo gateado por la licencia, igual que generate(): sin eso los lotes serían
// la puerta trasera del pago.

/** Lo que la superficie necesita de la capa que la crea. */
export interface DependenciasDeLotes {
  provider: unknown;
  costModels?: Record<string, CostModel>;
  exigirLicencia: () => void;
  /**
   * Submitting a batch IS a lever (the batch tier bills half): on the free
   * Measure license, which only measures in shadow mode, it is refused. Reading
   * or cancelling a batch already sent is not. Optional so no caller breaks.
   */
  exigirPalancas?: () => void;
  now: () => number;
  /**
   * Layer default for `savings.toolOutputCompaction` on batch items, identical to
   * `generate()`: off unless set, and a request's own toggle always wins. The
   * compaction is the same pure, deterministic, lossless transform the pipeline
   * runs (`seleccionarCompactables`), so a batch item's prompt byte-equals the
   * prompt `generate()` sends for the same request and toggle.
   */
  toolOutputCompaction?: boolean | ToolOutputCompactionSettings;
}

// LÍMITES POR LOTE, de las guías oficiales (leídas el 2026-09-27):
//   · Anthropic: «A Message Batch is limited to either 100,000 Message requests
//     or 256 MB in size, whichever is reached first» (platform.claude.com/docs/
//     en/build-with-claude/batch-processing).
//   · OpenAI: «A single batch may include up to 50,000 requests, and a batch
//     input file can be up to 200 MB in size» y «each input file can only
//     include requests to a single model» (developers.openai.com/api/docs/
//     guides/batch).
// «MB» se toma en DECIMAL (10^6): si el proveedor cuenta en MiB, el trozo sale
// algo más pequeño de lo que podría, nunca rechazado por grande.
const LIMITES: Readonly<Record<"anthropic" | "openai", { peticiones: number; bytes: number }>> = {
  anthropic: { peticiones: 100_000, bytes: 256_000_000 },
  openai: { peticiones: 50_000, bytes: 200_000_000 },
};

// El patrón de `custom_id` de Anthropic (`^[a-zA-Z0-9_-]{1,64}$`). OpenAI no
// publica uno más estricto, así que el de Anthropic vale para los dos y el
// mismo lote se puede mandar a cualquiera sin reescribir ids.
const ID_VALIDO = /^[A-Za-z0-9_-]{1,64}$/;

// La ruta que va en cada línea del JSONL de OpenAI: la del endpoint, NO la de la
// base del adaptador (la guía y la de compatibilidad de Gemini usan esta misma).
const RUTA_DE_CHAT = "/v1/chat/completions";

const ESTADOS_FINALES_OPENAI = new Set(["completed", "failed", "expired", "cancelled"]);

/** Crea `layer.batches` sobre el proveedor de la capa. */
export function crearLotes(dep: DependenciasDeLotes): SavingsBatches {
  return {
    submit: (requests, options) => enviarLote(dep, requests, options ?? {}),
    status: (job, options) => estadoDelLote(dep, job, options?.signal),
    results: <T = unknown>(job: BatchJob, options?: { signal?: AbortSignal }) =>
      resultadosDelLote<T>(dep, job, options?.signal),
    cancel: (job, options) => cancelarLote(dep, job, options?.signal),
  };
}

// ── La capacidad del proveedor ───────────────────────────────────────────────

function capacidadDe(dep: DependenciasDeLotes): CapacidadDeLotes {
  const cap = lotesDelProveedor(dep.provider);
  if (!cap) {
    throw new Error(
      "[bvsala] layer.batches needs one of the built-in providers: AnthropicProvider (Message Batches API) " +
        "or OpenAICompatibleProvider (OpenAI's Batch API). This provider has no batch support in the layer.",
    );
  }
  if (cap.origen === "google") {
    throw new Error(
      "[bvsala] Gemini's batch mode is not supported by layer.batches yet: its OpenAI-compatible endpoint " +
        "creates batches but does not upload or download their files (that needs Gemini's own Files API). " +
        "Nothing was sent.",
    );
  }
  return cap;
}

// ── submit ───────────────────────────────────────────────────────────────────

interface Linea {
  customId: string;
  /** La línea tal cual viaja: `{custom_id, params}` o `{custom_id, method, url, body}`. */
  linea: Record<string, unknown>;
  bytes: number;
  /** El modelo del cable, para trocear por modelo en OpenAI. */
  modelo: string;
}

async function enviarLote(
  dep: DependenciasDeLotes,
  requests: BatchRequest[],
  options: BatchSubmitOptions,
): Promise<BatchJob> {
  dep.exigirLicencia();
  dep.exigirPalancas?.();
  const cap = capacidadDe(dep);
  validarPeticiones(requests);
  const tope = topeDePeticiones(options.maxRequestsPerBatch, cap.protocolo);

  // TODA la traducción ANTES de mandar nada: una petición que el adaptador no
  // puede traducir (sin turno de usuario, por ejemplo) falla aquí, con su id, y
  // no a mitad de envío con trozos ya creados.
  const marcarPrefijo = options.cacheSharedPrefix === true && cap.protocolo === "anthropic";
  const codificador = new TextEncoder();
  const lineas: Linea[] = requests.map(({ customId, request }) => {
    // LAS PALANCAS DENTRO DEL LOTE (en el orden del pipeline):
    //   1. elisión por supersesión (default-on, opt-out por `savings.elision:false`)
    //   2. compactación de la cola (opt-in, ver resolverCompactacion)
    // Ambas con las MISMAS funciones puras del pipeline, así que el prompt del
    // ítem es byte a byte el que generate() manda para la misma petición.
    const elididos = request.savings?.elision !== false
      ? aplicarElision(request.messages, seleccionarSupersesion(request.messages).indices)
      : request.messages;
    const ajustes = resolverCompactacion(dep.toolOutputCompaction, request.savings?.toolOutputCompaction);
    const mensajes = ajustes ? compactarSiProcede(elididos, ajustes) : elididos;
    let cuerpo: Record<string, unknown>;
    try {
      cuerpo = cap.cuerpo(aPeticionDeProveedor({ ...request, messages: mensajes }, marcarPrefijo));
    } catch (err) {
      throw new TypeError(`[bvsala] batch request "${customId}": ${mensajeDe(err)}`);
    }
    const linea: Record<string, unknown> =
      cap.protocolo === "anthropic"
        ? { custom_id: customId, params: cuerpo }
        : { custom_id: customId, method: "POST", url: RUTA_DE_CHAT, body: cuerpo };
    const texto = JSON.stringify(linea);
    return {
      customId,
      linea,
      bytes: codificador.encode(texto).length,
      modelo: typeof cuerpo["model"] === "string" ? (cuerpo["model"] as string) : request.model,
    };
  });

  const trozos = trocear(lineas, cap.protocolo, tope);

  const schemas: JsonSchema[] = [];
  const indiceDeEsquema = new Map<string, number>();
  const trozoDe = new Map<string, number>();
  trozos.forEach((t, i) => t.forEach((l) => trozoDe.set(l.customId, i)));
  const peticiones: BatchJob["requests"] = requests.map(({ customId, request }) => {
    const schema = request.response?.schema;
    let indice: number | undefined;
    if (schema) {
      const clave = JSON.stringify(schema);
      indice = indiceDeEsquema.get(clave);
      if (indice === undefined) {
        indice = schemas.length;
        schemas.push(schema);
        indiceDeEsquema.set(clave, indice);
      }
    }
    return {
      customId,
      model: request.model,
      batch: trozoDe.get(customId)!,
      ...(indice !== undefined ? { schema: indice } : {}),
    };
  });

  const job: BatchJob = {
    kind: "bvsala.batch",
    version: 1,
    provider: cap.protocolo,
    endpoint: cap.endpoint,
    batchIds: [],
    submittedAt: new Date(dep.now()).toISOString(),
    requests: peticiones,
    schemas,
  };

  for (let i = 0; i < trozos.length; i++) {
    try {
      const id =
        cap.protocolo === "anthropic"
          ? await crearLoteAnthropic(cap, trozos[i]!, options.signal)
          : await crearLoteOpenAI(cap, trozos[i]!, options.signal);
      job.batchIds.push(id);
    } catch (err) {
      // LO YA CREADO SE FACTURA: no se puede tirar. El error lleva el trabajo
      // parcial —solo los trozos creados— para que el cliente lo lea o lo cancele.
      const creados = job.batchIds.length;
      const parcial: BatchJob = {
        ...job,
        batchIds: [...job.batchIds],
        requests: job.requests.filter((r) => r.batch < creados),
      };
      const pendientes = job.requests.filter((r) => r.batch >= creados).map((r) => r.customId);
      throw new BatchSubmitError(
        creados === 0
          ? `[bvsala] batch submission failed before any provider batch was created: ${mensajeDe(err)}.`
          : `[bvsala] batch submission failed after ${creados} of ${trozos.length} provider batches were created: ` +
            `${mensajeDe(err)}. The created batches run and are billed; error.job holds them.`,
        parcial,
        pendientes,
        { cause: err },
      );
    }
  }
  return job;
}

function validarPeticiones(requests: BatchRequest[]): void {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new TypeError("[bvsala] layer.batches.submit() needs a non-empty array of { customId, request }.");
  }
  const vistos = new Set<string>();
  for (const [i, item] of requests.entries()) {
    const id = (item as Partial<BatchRequest> | undefined)?.customId;
    if (typeof id !== "string" || !ID_VALIDO.test(id)) {
      throw new TypeError(
        `[bvsala] batch request #${i}: customId must be 1 to 64 letters, digits, "_" or "-" (got ${JSON.stringify(id)}).`,
      );
    }
    if (vistos.has(id)) throw new TypeError(`[bvsala] batch request "${id}": customId is repeated; it must be unique.`);
    vistos.add(id);
    const r = item.request as SavingsRequest | undefined;
    if (!r || typeof r.model !== "string" || r.model === "" || !Array.isArray(r.messages) || r.messages.length === 0) {
      throw new TypeError(`[bvsala] batch request "${id}": request needs a model and at least one message.`);
    }
    if (r.retrieval && r.retrieval.mode !== "off") {
      throw new TypeError(
        `[bvsala] batch request "${id}": retrieval runs in the layer's pipeline, which batches skip. Send the ` +
          "retrieved context in the messages instead.",
      );
    }
    if (r.structuredData !== undefined) {
      throw new TypeError(
        `[bvsala] batch request "${id}": structuredData is serialized by the layer's pipeline, which batches ` +
          "skip. Put the payload in the messages instead.",
      );
    }
  }
}

function topeDePeticiones(pedido: number | undefined, protocolo: "anthropic" | "openai"): number {
  const limite = LIMITES[protocolo].peticiones;
  if (pedido === undefined) return limite;
  if (!Number.isInteger(pedido) || pedido < 1) {
    throw new TypeError(`[bvsala] maxRequestsPerBatch must be a positive integer (got ${String(pedido)}).`);
  }
  return Math.min(pedido, limite);
}

// LA COMPACTACIÓN DE LA COLA EN EL LOTE (primer incremento de «palancas dentro
// del lote»): la MISMA transformación pura, determinista y sin pérdida que
// `generate()` aplica a los `role: "tool"` (ver `seleccionarCompactables` en
// compression/cola.ts). Reusar la función —y no una copia— es lo que garantiza
// que el cuerpo de un ítem del lote sea byte a byte el prompt que `generate()`
// manda para la misma petición y el mismo interruptor.
//
// Opt-in, igual que en generate(): sin toggle de la capa ni de la petición no se
// toca nada, y el comportamiento actual («se envía como se escribió») se conserva.
// El perfil `lossless-data` cuenta con el estimador heurístico (el mismo de
// `seleccionarCompactables` sin `contar`), así que no hay dependencia del
// tokenizador cargado en esta superficie.
function resolverCompactacion(
  deLaCapa: boolean | ToolOutputCompactionSettings | undefined,
  deLaPeticion: boolean | undefined,
): ToolOutputCompactionSettings | null {
  if (deLaPeticion === false) return null;
  const ajustes = typeof deLaCapa === "object" && deLaCapa !== null ? deLaCapa : {};
  if (deLaPeticion === true) return ajustes;
  return deLaCapa ? ajustes : null;
}

/** Mensajes con la cola compactada, sin mutar el array del llamante. */
function compactarSiProcede(
  messages: ChatMessage[],
  ajustes: ToolOutputCompactionSettings,
): ChatMessage[] {
  const eleccion = seleccionarCompactables(messages, ajustes);
  if (eleccion.compactados.length === 0) return messages;
  const nuevos = messages.slice();
  for (const c of eleccion.compactados) {
    nuevos[c.indice] = { ...nuevos[c.indice]!, content: c.texto };
  }
  return nuevos;
}

// La petición del cliente en la forma neutra del adaptador, SIN nada del
// pipeline salvo la compactación de la cola opt-in de arriba. Con `marcarPrefijo`,
// la cabecera de mensajes `system` se declara prefijo estable y el adaptador de
// Anthropic pone su `cache_control` al final (ver `marcarCache` en providers/anthropic.ts).
function aPeticionDeProveedor(r: SavingsRequest, marcarPrefijo: boolean): ProviderRequest {
  let cabecera = 0;
  while (cabecera < r.messages.length && r.messages[cabecera]!.role === "system") cabecera += 1;
  return {
    model: r.model,
    messages: r.messages,
    ...(r.tools && r.tools.length > 0 ? { tools: r.tools } : {}),
    ...(r.response?.schema ? { schema: r.response.schema } : {}),
    ...(topeDeSalida(r) != null ? { maxOutputTokens: topeDeSalida(r)! } : {}),
    ...(r.temperature != null ? { temperature: r.temperature } : {}),
    ...(r.seed != null ? { seed: r.seed } : {}),
    ...(r.reasoningEffort != null ? { reasoningEffort: r.reasoningEffort } : {}),
    ...(marcarPrefijo && cabecera > 0 ? { stablePrefixMessages: cabecera } : {}),
  };
}

// Trozos que caben en un lote del proveedor: por número y por bytes y, en
// OpenAI, un solo modelo por fichero. El orden de las peticiones se conserva
// dentro de cada modelo.
function trocear(lineas: Linea[], protocolo: "anthropic" | "openai", tope: number): Linea[][] {
  const limite = LIMITES[protocolo];
  const grupos = new Map<string, Linea[]>();
  for (const l of lineas) {
    const clave = protocolo === "openai" ? l.modelo : "";
    const g = grupos.get(clave);
    if (g) g.push(l);
    else grupos.set(clave, [l]);
  }
  // Lo que ocupa el envoltorio: `{"requests":[` … `]}` y una coma por línea en
  // Anthropic; un salto de línea por línea en el JSONL de OpenAI.
  const fijo = protocolo === "anthropic" ? '{"requests":[]}'.length : 0;
  const trozos: Linea[][] = [];
  for (const g of grupos.values()) {
    let actual: Linea[] = [];
    let bytes = fijo;
    for (const l of g) {
      const extra = l.bytes + 1;
      if (fijo + extra > limite.bytes) {
        throw new TypeError(
          `[bvsala] batch request "${l.customId}" is ${l.bytes} bytes, larger than a whole ${protocolo} batch ` +
            "may be. Send it with generate() instead.",
        );
      }
      if (actual.length > 0 && (actual.length >= tope || bytes + extra > limite.bytes)) {
        trozos.push(actual);
        actual = [];
        bytes = fijo;
      }
      actual.push(l);
      bytes += extra;
    }
    if (actual.length > 0) trozos.push(actual);
  }
  return trozos;
}

async function crearLoteAnthropic(cap: CapacidadDeLotes, trozo: Linea[], signal?: AbortSignal): Promise<string> {
  const json = await pedirJson(cap, "/messages/batches", {
    method: "POST",
    json: { requests: trozo.map((l) => l.linea) },
    ...(signal ? { signal } : {}),
  });
  return idDe(json, "Message Batch");
}

async function crearLoteOpenAI(cap: CapacidadDeLotes, trozo: Linea[], signal?: AbortSignal): Promise<string> {
  const jsonl = trozo.map((l) => JSON.stringify(l.linea)).join("\n") + "\n";
  const form = new FormData();
  form.append("purpose", "batch");
  form.append("file", new Blob([jsonl], { type: "application/jsonl" }), "bvsala-batch.jsonl");
  const fichero = await pedirJson(cap, "/files", { method: "POST", form, ...(signal ? { signal } : {}) });
  const lote = await pedirJson(cap, "/batches", {
    method: "POST",
    json: { input_file_id: idDe(fichero, "file"), endpoint: RUTA_DE_CHAT, completion_window: "24h" },
    ...(signal ? { signal } : {}),
  });
  return idDe(lote, "batch");
}

// ── status ───────────────────────────────────────────────────────────────────

interface EstadoDeTrozo {
  id: string;
  /** El estado tal cual lo dio el proveedor. */
  estado: string;
  terminado: boolean;
  cancelando: boolean;
  cuentas: BatchCounts;
  /** OpenAI: ficheros de salida y de errores, cuando los hay. */
  salida?: string;
  errores?: string;
  /** OpenAI, lote `failed`: los errores de validación del lote entero. */
  fallo?: string;
}

async function estadoDelLote(dep: DependenciasDeLotes, job: BatchJob, signal?: AbortSignal): Promise<BatchJobStatus> {
  dep.exigirLicencia();
  dep.exigirPalancas?.();
  const cap = capacidadDe(dep);
  validarJob(job, cap);
  const trozos = await estadosDeTrozos(cap, job, signal);
  return resumirEstado(job, trozos);
}

async function estadosDeTrozos(cap: CapacidadDeLotes, job: BatchJob, signal?: AbortSignal): Promise<EstadoDeTrozo[]> {
  const estados: EstadoDeTrozo[] = [];
  for (const [i, id] of job.batchIds.entries()) {
    const json = await pedirJson(cap, rutaDeLote(cap, id), { method: "GET", ...(signal ? { signal } : {}) });
    const peticionesDelTrozo = job.requests.filter((r) => r.batch === i).length;
    estados.push(cap.protocolo === "anthropic" ? estadoAnthropic(id, json) : estadoOpenAI(id, json, peticionesDelTrozo));
  }
  return estados;
}

function estadoAnthropic(id: string, json: unknown): EstadoDeTrozo {
  const o = objeto(json);
  const estado = typeof o["processing_status"] === "string" ? (o["processing_status"] as string) : "unknown";
  const c = objeto(o["request_counts"]);
  return {
    id,
    estado,
    terminado: estado === "ended",
    cancelando: estado === "canceling",
    cuentas: {
      processing: entero(c["processing"]),
      succeeded: entero(c["succeeded"]),
      errored: entero(c["errored"]),
      canceled: entero(c["canceled"]),
      expired: entero(c["expired"]),
    },
  };
}

function estadoOpenAI(id: string, json: unknown, peticionesDelTrozo: number): EstadoDeTrozo {
  const o = objeto(json);
  const estado = typeof o["status"] === "string" ? (o["status"] as string) : "unknown";
  const c = objeto(o["request_counts"]);
  const total = entero(c["total"]) || peticionesDelTrozo;
  const hechas = entero(c["completed"]);
  const fallidas = entero(c["failed"]);
  const resto = Math.max(0, total - hechas - fallidas);
  const terminado = ESTADOS_FINALES_OPENAI.has(estado);
  // Mientras corre, OpenAI solo cuenta completadas y fallidas. Al terminar, lo
  // que no llegó a correr es caducado o cancelado según el estado del lote; un
  // lote `failed` no corrió nada.
  const cuentas: BatchCounts =
    estado === "failed"
      ? { processing: 0, succeeded: 0, errored: total, canceled: 0, expired: 0 }
      : {
          processing: terminado ? 0 : resto,
          succeeded: hechas,
          errored: fallidas + (estado === "completed" ? resto : 0),
          canceled: estado === "cancelled" ? resto : 0,
          expired: estado === "expired" ? resto : 0,
        };
  const errores = Array.isArray(objeto(o["errors"])["data"])
    ? (objeto(o["errors"])["data"] as unknown[])
        .map((e) => objeto(e)["message"])
        .filter((m): m is string => typeof m === "string")
    : [];
  return {
    id,
    estado,
    terminado,
    cancelando: estado === "cancelling",
    cuentas,
    ...(typeof o["output_file_id"] === "string" && o["output_file_id"] !== "" ? { salida: o["output_file_id"] as string } : {}),
    ...(typeof o["error_file_id"] === "string" && o["error_file_id"] !== "" ? { errores: o["error_file_id"] as string } : {}),
    ...(estado === "failed" ? { fallo: errores.length > 0 ? errores.join("; ") : "the provider rejected the batch" } : {}),
  };
}

function resumirEstado(job: BatchJob, trozos: EstadoDeTrozo[]): BatchJobStatus {
  const counts: BatchCounts = { processing: 0, succeeded: 0, errored: 0, canceled: 0, expired: 0 };
  for (const t of trozos) {
    counts.processing += t.cuentas.processing;
    counts.succeeded += t.cuentas.succeeded;
    counts.errored += t.cuentas.errored;
    counts.canceled += t.cuentas.canceled;
    counts.expired += t.cuentas.expired;
  }
  const state: BatchJobStatus["state"] = trozos.every((t) => t.terminado)
    ? "ended"
    : trozos.some((t) => t.cancelando)
      ? "canceling"
      : "in_progress";
  return {
    state,
    requestCount: job.requests.length,
    counts,
    batches: trozos.map((t) => ({ id: t.id, status: t.estado })),
  };
}

// ── cancel ───────────────────────────────────────────────────────────────────

async function cancelarLote(dep: DependenciasDeLotes, job: BatchJob, signal?: AbortSignal): Promise<BatchJobStatus> {
  dep.exigirLicencia();
  dep.exigirPalancas?.();
  const cap = capacidadDe(dep);
  validarJob(job, cap);
  const antes = await estadosDeTrozos(cap, job, signal);
  for (const t of antes) {
    if (t.terminado || t.cancelando) continue;
    await pedirJson(cap, `${rutaDeLote(cap, t.id)}/cancel`, { method: "POST", ...(signal ? { signal } : {}) });
  }
  return resumirEstado(job, await estadosDeTrozos(cap, job, signal));
}

// ── results ──────────────────────────────────────────────────────────────────

/** Una línea de resultados, ya en la forma común a los dos proveedores. */
type LineaDeResultado =
  | { tipo: "ok"; cuerpo: unknown }
  | { tipo: "errored"; error: { type: string; message: string } }
  | { tipo: "canceled" }
  | { tipo: "expired" };

async function resultadosDelLote<T>(
  dep: DependenciasDeLotes,
  job: BatchJob,
  signal?: AbortSignal,
): Promise<BatchResults<T>> {
  dep.exigirLicencia();
  dep.exigirPalancas?.();
  const cap = capacidadDe(dep);
  validarJob(job, cap);
  const trozos = await estadosDeTrozos(cap, job, signal);

  const lineas = new Map<string, LineaDeResultado>();
  for (const t of trozos) {
    if (!t.terminado) continue;
    if (cap.protocolo === "anthropic") {
      const respuesta = await pedir(cap, `${rutaDeLote(cap, t.id)}/results`, { method: "GET", ...(signal ? { signal } : {}) });
      for await (const l of lineasJsonl(respuesta)) anotarAnthropic(lineas, l);
    } else {
      for (const fichero of [t.salida, t.errores]) {
        if (!fichero) continue;
        const respuesta = await pedir(cap, `/files/${encodeURIComponent(fichero)}/content`, {
          method: "GET",
          ...(signal ? { signal } : {}),
        });
        for await (const l of lineasJsonl(respuesta)) anotarOpenAI(lineas, l);
      }
    }
  }

  const ahoraMs = Math.max(dep.now(), Date.parse(job.submittedAt) || 0);
  const items: BatchItemResult<T>[] = [];
  let pendientes = 0;
  for (const r of job.requests) {
    const trozo = trozos[r.batch]!;
    if (!trozo.terminado) {
      pendientes += 1;
      continue;
    }
    const schema = r.schema !== undefined ? job.schemas[r.schema] : undefined;
    items.push(resultadoDe<T>(dep, cap, r, schema, lineas.get(r.customId), trozo, ahoraMs));
  }
  return {
    ended: trozos.every((t) => t.terminado),
    items,
    summary: resumir(job, items, pendientes),
  };
}

function anotarAnthropic(lineas: Map<string, LineaDeResultado>, l: unknown): void {
  const o = objeto(l);
  const id = o["custom_id"];
  if (typeof id !== "string" || lineas.has(id)) return;
  const res = objeto(o["result"]);
  switch (res["type"]) {
    case "succeeded":
      lineas.set(id, { tipo: "ok", cuerpo: res["message"] });
      return;
    case "errored": {
      // `result.error` es un ErrorResponse: `{type: "error", error: {type, message}}`.
      const e = objeto(objeto(res["error"])["error"]);
      lineas.set(id, {
        tipo: "errored",
        error: {
          type: typeof e["type"] === "string" ? (e["type"] as string) : "error",
          message: typeof e["message"] === "string" ? (e["message"] as string) : "the provider reported an error",
        },
      });
      return;
    }
    case "canceled":
      lineas.set(id, { tipo: "canceled" });
      return;
    case "expired":
      lineas.set(id, { tipo: "expired" });
      return;
    default:
      // Un tipo que no conocemos: la línea no se usa y la petición sale «missing»
      // en vez de inventarle un desenlace.
      return;
  }
}

function anotarOpenAI(lineas: Map<string, LineaDeResultado>, l: unknown): void {
  const o = objeto(l);
  const id = o["custom_id"];
  if (typeof id !== "string" || lineas.has(id)) return;
  const error = o["error"];
  if (error !== null && error !== undefined) {
    const e = objeto(error);
    const code = typeof e["code"] === "string" ? (e["code"] as string) : "error";
    if (code === "batch_expired") {
      lineas.set(id, { tipo: "expired" });
      return;
    }
    if (code === "batch_cancelled" || code === "batch_canceled") {
      lineas.set(id, { tipo: "canceled" });
      return;
    }
    lineas.set(id, {
      tipo: "errored",
      error: { type: code, message: typeof e["message"] === "string" ? (e["message"] as string) : "the provider reported an error" },
    });
    return;
  }
  const resp = objeto(o["response"]);
  const estado = resp["status_code"];
  const cuerpo = resp["body"];
  if (typeof estado === "number" && estado >= 200 && estado < 300 && cuerpo !== undefined) {
    lineas.set(id, { tipo: "ok", cuerpo });
    return;
  }
  const e = objeto(objeto(cuerpo)["error"]);
  lineas.set(id, {
    tipo: "errored",
    error: {
      type: typeof e["type"] === "string" ? (e["type"] as string) : `http_${typeof estado === "number" ? estado : "error"}`,
      message: typeof e["message"] === "string" ? (e["message"] as string) : "the provider reported an error",
    },
  });
}

function resultadoDe<T>(
  dep: DependenciasDeLotes,
  cap: CapacidadDeLotes,
  r: BatchJob["requests"][number],
  schema: JsonSchema | undefined,
  linea: LineaDeResultado | undefined,
  trozo: EstadoDeTrozo,
  ahoraMs: number,
): BatchItemResult<T> {
  const base = { customId: r.customId, model: r.model };
  const anthropic = cap.protocolo === "anthropic";

  if (!linea) {
    // Sin línea en un lote que terminó. En OpenAI es lo normal de un lote que
    // caducó, se canceló o no pasó la validación: se dice por el estado del lote.
    if (trozo.estado === "failed") {
      return {
        ...base,
        outcome: "errored",
        reason: `the provider rejected the whole batch before running it: ${trozo.fallo ?? "no reason given"}`,
        error: { type: "batch_failed", message: trozo.fallo ?? "the provider rejected the batch" },
      };
    }
    if (trozo.estado === "expired") {
      return { ...base, outcome: "expired", reason: "the batch expired before this request ran: no answer and no usage" };
    }
    if (trozo.estado === "cancelled") {
      return { ...base, outcome: "canceled", reason: "the batch was canceled before this request ran: no answer and no usage" };
    }
    return {
      ...base,
      outcome: "missing",
      reason: "the provider returned no result line for this request; nothing is assumed about it",
    };
  }

  switch (linea.tipo) {
    case "errored":
      return {
        ...base,
        outcome: "errored",
        reason:
          `the provider could not run this request (${linea.error.type}: ${linea.error.message})` +
          (anthropic ? "; Anthropic documents that errored requests are not billed" : ""),
        error: linea.error,
      };
    case "canceled":
      return {
        ...base,
        outcome: "canceled",
        reason: anthropic
          ? "canceled before it was sent to the model; Anthropic documents that it is not billed"
          : "canceled before it ran: no answer and no usage",
      };
    case "expired":
      return {
        ...base,
        outcome: "expired",
        reason: anthropic
          ? "the batch reached its 24-hour expiration before this request was sent to the model; Anthropic " +
            "documents that it is not billed"
          : "not executed before the batch's completion window expired: no answer and no usage",
      };
    case "ok":
      break;
  }

  // Un resultado correcto: facturado por el proveedor. Se lee con el MISMO
  // adaptador que generate(); una línea ilegible no tumba las demás.
  const minima: ProviderRequest = { model: r.model, messages: [], ...(schema ? { schema } : {}) };
  let resp: ProviderResponse;
  try {
    resp = cap.leer(linea.cuerpo, minima);
  } catch (err) {
    return {
      ...base,
      outcome: "succeeded",
      reason: `the provider ran this request but its answer could not be read (${mensajeDe(err)}): nothing is credited`,
    };
  }

  const contrato = contratoDe<T>(resp, schema);
  // EL TIER LEÍDO DEL PROVEEDOR, nunca supuesto. Anthropic lo pone en el
  // `usage` de cada resultado; OpenAI no tiene ese valor en el cuerpo y el tier
  // es el del canal: la línea viene del fichero de salida de un lote de su
  // Batch API (ver «EL ASÍNCRONO» en economics/tier-diferido.ts).
  const servido = anthropic ? resp.servedServiceTier : "batch";
  const origen: OrigenDeTarifa | null =
    cap.origen === "anthropic" || cap.origen === "openai" ? cap.origen : null;
  const cliente = precioDelCliente(dep.costModels, r.model);
  const v = valorarTierServido({
    modelo: r.model,
    uso: resp.usage,
    tierServido: servido,
    origen,
    tierLeidoDe: anthropic ? "cuerpo" : "lote",
    ...(cliente ? { precioDelCliente: cliente } : {}),
    ahoraMs,
  });

  const comun = {
    ...base,
    outcome: "succeeded" as const,
    text: resp.text,
    ...contrato,
    ...(resp.toolCalls && resp.toolCalls.length > 0 ? { toolCalls: resp.toolCalls } : {}),
    // El motivo de parada, CERRADO como en `SavingsResult` (0.5): el lector del
    // adaptador ya lo cierra, y `cerrarParada` es idempotente sobre lo cerrado;
    // pasar por ella deja una sola regla y el detalle del proveedor a su lado.
    ...cerrarParada(resp.finishReason, resp.finishReasonDetail),
    usage: resp.usage,
    ...(servido ? { servedTier: servido } : {}),
  };
  if (!v.ok) return { ...comun, reason: motivoSinCredito(v.motivo, servido) };

  const tierSaving: PriceLeverSaving = {
    amount: v.importe,
    basis: v.basis,
    standardCost: roundUsd(v.costeEstandar),
    appliedCost: roundUsd(v.costeAplicado),
    pricesCheckedOn: v.consultado,
    basisReason: v.motivoBasis,
  };
  return {
    ...comun,
    tierSaving,
    reason:
      `billed at the "${servido}" tier; this request's usage was priced at the standard and at the batch ` +
      `published rate cards, component by component (${(v.factorEfectivo * 100).toFixed(1)}% of standard)`,
  };
}

function contratoDe<T>(resp: ProviderResponse, schema: JsonSchema | undefined): { data?: T; contract?: "met" | "missed" } {
  if (!schema || (resp.toolCalls?.length ?? 0) > 0) return {};
  const parsed = tryParse(typeof resp.text === "string" ? resp.text : "");
  if (!parsed.ok) return { contract: "missed" };
  return validateAgainstSchema(parsed.value, schema).valid
    ? { data: parsed.value as T, contract: "met" }
    : { contract: "missed" };
}

function motivoSinCredito(motivo: MotivoSinValoracion, servido: string | undefined): string {
  switch (motivo) {
    case "no-served-tier":
      return "the provider reported no service tier for this result, so the rate it was billed at cannot be known: nothing is credited";
    case "unknown-tier":
      return `the provider reports the "${servido}" tier for this result, a tier this layer has no published rate for: nothing is credited`;
    case "standard-rate-tier":
      return `the provider reports the "${servido}" tier for this result, which is not billed below the standard rate: nothing is credited`;
    case "no-tier-price":
      return "there is no published batch price for this model from this provider (or it has expired): nothing is credited";
    case "no-standard-price":
      return "this model has no list price of its own here, so there is no standard rate card to price the difference against: nothing is credited";
    case "incomplete-usage":
      return "the provider's usage for this result is incomplete, so the difference cannot be priced: nothing is credited";
    case "no-difference":
      return "this result's usage costs the same at both published rate cards: nothing is credited";
  }
}

// La suma se hace en UNIDADES ENTERAS de 1e-10 (la resolución de cada importe,
// que ya viene redondeado hacia abajo): sumar los decimales en coma flotante
// podría dejar el total una pizca POR ENCIMA de la suma de las diferencias reales.
const GRANO = 1e10;

function resumir(job: BatchJob, items: BatchItemResult[], pendientes: number): BatchSummary {
  let exito = 0;
  let errores = 0;
  let canceladas = 0;
  let caducadas = 0;
  let perdidas = 0;
  let acreditadas = 0;
  let medidas = 0;
  let unidades = 0n;
  let estandar = 0;
  let aplicado = 0;
  let consultado: string | undefined;
  for (const it of items) {
    if (it.outcome === "succeeded") exito += 1;
    else if (it.outcome === "errored") errores += 1;
    else if (it.outcome === "canceled") canceladas += 1;
    else if (it.outcome === "expired") caducadas += 1;
    else perdidas += 1;
    const t = it.tierSaving;
    if (!t) continue;
    acreditadas += 1;
    if (t.basis === "measured") medidas += 1;
    // Cada importe ES k·1e-10 (redondeado hacia abajo en `valorarTierServido`):
    // `round` recupera k exacto; `floor` perdería una unidad cuando el producto en
    // coma flotante cae una pizca por debajo (1,2345678901 · 1e10 = …0,999998).
    unidades += BigInt(Math.round(t.amount * GRANO));
    estandar += t.standardCost;
    aplicado += t.appliedCost;
    if (!consultado || t.pricesCheckedOn < consultado) consultado = t.pricesCheckedOn;
  }
  const basis: BatchSummary["basis"] = acreditadas === 0 ? "none" : medidas === acreditadas ? "measured" : "estimated";
  const reason =
    `${exito} of ${job.requests.length} requests succeeded` +
    (pendientes > 0 ? ` (${pendientes} still running)` : "") +
    `; ${acreditadas} were valued at the provider's standard and batch published rate cards` +
    (basis === "none" ? "" : ` (${basis})`) +
    ". Reported only: batch requests are not metered and this saving is never billed. The layer's own " +
    "per-request savings do not run on batches.";
  return {
    requestCount: job.requests.length,
    succeeded: exito,
    errored: errores,
    canceled: canceladas,
    expired: caducadas,
    missing: perdidas,
    pending: pendientes,
    credited: acreditadas,
    tierSaving: Number(unidades) / GRANO,
    standardCost: roundUsd(estandar),
    appliedCost: roundUsd(aplicado),
    basis,
    ...(consultado ? { pricesCheckedOn: consultado } : {}),
    creditedLedger: "none",
    reason,
  };
}

// ── utilidades ───────────────────────────────────────────────────────────────

function validarJob(job: BatchJob, cap: CapacidadDeLotes): void {
  const j = job as Partial<BatchJob> | undefined;
  if (
    !j ||
    j.kind !== "bvsala.batch" ||
    j.version !== 1 ||
    !Array.isArray(j.batchIds) ||
    !Array.isArray(j.requests) ||
    !Array.isArray(j.schemas) ||
    j.requests.some((r) => !Number.isInteger(r?.batch) || r.batch < 0 || r.batch >= j.batchIds!.length)
  ) {
    throw new TypeError("[bvsala] not a batch job returned by layer.batches.submit().");
  }
  if (j.provider !== cap.protocolo || j.endpoint !== cap.endpoint) {
    throw new TypeError(
      `[bvsala] this job was submitted to ${j.provider} at ${j.endpoint}; this layer's provider is ` +
        `${cap.protocolo} at ${cap.endpoint}. Read it with a layer configured like the one that submitted it.`,
    );
  }
}

function rutaDeLote(cap: CapacidadDeLotes, id: string): string {
  return cap.protocolo === "anthropic"
    ? `/messages/batches/${encodeURIComponent(id)}`
    : `/batches/${encodeURIComponent(id)}`;
}

async function pedir(
  cap: CapacidadDeLotes,
  ruta: string,
  opciones: Parameters<CapacidadDeLotes["solicitar"]>[1],
): Promise<Response> {
  const respuesta = await cap.solicitar(ruta, opciones);
  if (!respuesta.ok) {
    let detalle = "";
    try {
      detalle = await respuesta.text();
    } catch {
      detalle = "";
    }
    throw new Error(`provider ${respuesta.status}: ${detalle}`);
  }
  return respuesta;
}

async function pedirJson(
  cap: CapacidadDeLotes,
  ruta: string,
  opciones: Parameters<CapacidadDeLotes["solicitar"]>[1],
): Promise<unknown> {
  return await (await pedir(cap, ruta, opciones)).json();
}

function idDe(json: unknown, que: string): string {
  const id = objeto(json)["id"];
  if (typeof id !== "string" || id === "") throw new Error(`the provider returned no ${que} id`);
  return id;
}

// Las líneas de un JSONL, sin cargar el fichero entero en una cadena cuando el
// cuerpo es un stream (un lote de Anthropic puede pesar cientos de MB). Una
// línea que no es JSON se salta: su petición saldrá «missing», que es decir que
// no se sabe, en vez de inventarle un desenlace.
async function* lineasJsonl(respuesta: Response): AsyncGenerator<unknown> {
  const cuerpo = respuesta.body as (ReadableStream<Uint8Array> & { getReader?: unknown }) | null | undefined;
  if (!cuerpo || typeof cuerpo.getReader !== "function") {
    for (const l of (await respuesta.text()).split("\n")) {
      const v = parsearLinea(l);
      if (v !== undefined) yield v;
    }
    return;
  }
  const lector = cuerpo.getReader();
  const decodificador = new TextDecoder();
  let resto = "";
  for (;;) {
    const { done, value } = await lector.read();
    if (done) break;
    resto += decodificador.decode(value, { stream: true });
    let corte = resto.indexOf("\n");
    while (corte >= 0) {
      const v = parsearLinea(resto.slice(0, corte));
      if (v !== undefined) yield v;
      resto = resto.slice(corte + 1);
      corte = resto.indexOf("\n");
    }
  }
  resto += decodificador.decode();
  const v = parsearLinea(resto);
  if (v !== undefined) yield v;
}

function parsearLinea(l: string): unknown {
  const t = l.trim();
  if (t === "") return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

function precioDelCliente(costModels: Record<string, CostModel> | undefined, model: string): CostModel | undefined {
  if (!costModels) return undefined;
  const exacto = costModels[model];
  if (exacto) return exacto;
  const barra = model.indexOf("/");
  return barra >= 0 ? costModels[model.slice(barra + 1)] : undefined;
}

function objeto(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function entero(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function mensajeDe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Importes publicables, con la misma resolución que el ledger (y sin `-0`). */
function roundUsd(n: number): number {
  const r = Math.round(n * 1e10) / 1e10;
  return r === 0 ? 0 : r;
}
