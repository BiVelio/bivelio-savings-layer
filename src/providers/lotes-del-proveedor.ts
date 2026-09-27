import type { ProviderRequest, ProviderResponse } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE UN ADAPTADOR PROPIO SABE HACER CON LA BATCH API DE SU PROVEEDOR.
// ═══════════════════════════════════════════════════════════════════════════
//
// La superficie de lotes (`layer.batches`, src/batch/lotes.ts) no traduce
// peticiones por su cuenta: le pide al MISMO adaptador que usa `generate()` el
// cuerpo que habría mandado y la lectura de la respuesta. Dos traducciones de lo
// mismo acabarían derivando —el contrato como herramienta de Anthropic, el
// `response_format` estricto de OpenAI, el turno «(continue)», el id desnudo—,
// y un lote que se comporta distinto que la petición síncrona es un error que
// solo se ve en la factura.
//
// WeakMap privado y NO reexportado por ningún barril, el mismo patrón que
// `atestado-del-cable.ts`: solo lo escriben los adaptadores de ESTE paquete. Un
// proveedor de terceros no tiene lotes aquí, y `layer.batches` lo dice en claro
// en vez de adivinar su protocolo. Y por la misma razón nada de esto aparece en
// los tipos publicados: la clase del adaptador no gana ningún método público.
//
// Módulo INTERNO: los comentarios van en `//`.

/** El dialecto de Batch API que habla el adaptador. */
export type ProtocoloDeLotes = "anthropic" | "openai";

export interface OpcionesDeSolicitud {
  method: "GET" | "POST";
  /** Cuerpo JSON (se serializa y lleva `content-type: application/json`). */
  json?: unknown;
  /** Cuerpo multipart (la subida del JSONL de OpenAI). */
  form?: FormData;
  signal?: AbortSignal;
}

export interface CapacidadDeLotes {
  protocolo: ProtocoloDeLotes;
  /**
   * El API OFICIAL con el que habla el adaptador, decidido por el host de su
   * `baseUrl` y solo por él (https y host exacto), o `null`. Es la condición M2
   * de la valoración: sin él, lo que valga el tier es como mucho `estimated`.
   */
  origen: "anthropic" | "openai" | "google" | null;
  /** La base del adaptador, sin credenciales ni query: va en `BatchJob.endpoint`. */
  endpoint: string;
  /**
   * El cuerpo que `generate()` mandaría para esta petición, sin `stream` y sin
   * pedir tier: en un lote el tier lo pone el canal, no el cuerpo.
   */
  cuerpo(req: ProviderRequest): Record<string, unknown>;
  /**
   * La respuesta de UNA petición del lote en la forma neutra. Nunca lanza por un
   * `usage` incompleto: lo marca (`usage.complete: false`) y el resultado sale
   * sin valorar, porque en un lote el fallo de una línea no puede tumbar las
   * demás.
   */
  leer(json: unknown, req: ProviderRequest): ProviderResponse;
  /**
   * HTTP autenticado contra la base del adaptador. `ruta` es RELATIVA a la base
   * y empieza por `/`: la capa nunca manda la clave a una URL que no construyó
   * ella (por eso no sigue el `results_url` que devuelve Anthropic).
   */
  solicitar(ruta: string, opciones: OpcionesDeSolicitud): Promise<Response>;
}

const capacidades = new WeakMap<object, CapacidadDeLotes>();

/** Declara la capacidad de lotes de un adaptador. Solo lo llaman los adaptadores de este paquete. */
export function registrarLotes(proveedor: object, capacidad: CapacidadDeLotes): void {
  capacidades.set(proveedor, capacidad);
}

/** La capacidad de lotes de un proveedor, o `undefined` (proveedor de terceros o sin lotes). */
export function lotesDelProveedor(proveedor: unknown): CapacidadDeLotes | undefined {
  return typeof proveedor === "object" && proveedor !== null ? capacidades.get(proveedor) : undefined;
}

/**
 * La base de un adaptador sin credenciales, query ni fragmento, y sin la barra
 * final. Si no es una URL, tal cual sin barra final: `BatchJob.endpoint` solo
 * sirve para comparar, nunca se usa para llamar.
 */
export function endpointLimpio(base: string): string {
  try {
    const u = new URL(base);
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString().replace(/\/+$/, "");
  } catch {
    return base.replace(/\/+$/, "");
  }
}

/** Una ruta relativa segura: empieza por `/` y no trae esquema ni host. */
export function rutaRelativa(ruta: string): string {
  if (!ruta.startsWith("/") || ruta.startsWith("//") || /^\/*[a-z][a-z0-9+.-]*:/i.test(ruta)) {
    throw new Error(`[bvsala] internal: a batch request path must be relative to the provider base (got "${ruta}")`);
  }
  return ruta;
}
