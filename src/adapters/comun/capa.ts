import { createSavingsLayer, LicenseError } from "@bivelio/savings-layer";
import type {
  SavingsAdapterOptions,
  SavingsLayerConfig,
  SavingsReport,
  SavingsRequest,
  SavingsResult,
} from "@bivelio/savings-layer";
import { avisarUnaVez } from "./aviso.js";
import { crearAlmacen, crearPuente, type LlamadaDelMarco } from "./puente.js";

// LA CAPA DE UN ADAPTADOR.
//
// Un adaptador no importa nada de dentro del núcleo: solo `createSavingsLayer`
// del paquete publicado. Por eso NO PUEDE saltarse la licencia ni la medición de
// uso: el único camino hasta el modelo es `layer.generate()`/`generateStream()`,
// que gatea primero (fail-closed: sin licencia, `LicenseError` llega al llamante
// tal cual y el modelo no se llama) y registra después.
//
// Y ni un campo nuevo en el cable hacia BiVelio: el registro de uso es el mismo
// que el de cualquier llamada del SDK.

// Las opciones que se pasan a `createSavingsLayer`, en lista blanca: aunque el
// llamante fuerce el tipo, un `provider`, un `compressor` o una caché semántica
// no llegan a la capa.
const PERMITIDAS = [
  "licenseKey",
  "licenseServerUrl",
  "serviceAccountKey",
  "licenseRefresh",
  "licenseRevocation",
  "licensePollIntervalSeconds",
  "licenseFetch",
  "metering",
  "meteringUrl",
  "meteringFetch",
  "costModels",
  "defaultCostModel",
  "exactCache",
  "exactCacheTtlMs",
  "resolvers",
  "exactTokenizer",
  "silenceWarnings",
  "failOpen",
] as const satisfies readonly (keyof SavingsLayerConfig)[];

/**
 * Cómo acabó una llamada del framework que pasó por la capa.
 * - `vivo`: el modelo se llamó y el resultado del framework es el que se devuelve.
 * - `atajo`: la capa contestó sin llamar al modelo; el adaptador sintetiza.
 * - `sin-informe`: el modelo contestó bien pero la capa falló DESPUÉS; se
 *   devuelve la respuesta del framework, sin informe y sin registro de uso.
 */
export type Desenlace =
  | { tipo: "vivo"; result: SavingsResult }
  | { tipo: "atajo"; result: SavingsResult }
  | { tipo: "sin-informe" };

/** Lo mismo para un stream: en vivo, el informe llega cuando termine. */
export type DesenlaceDeStream =
  | { tipo: "abierto" }
  | { tipo: "entero"; result: SavingsResult }
  | { tipo: "atajo"; result: SavingsResult }
  | { tipo: "sin-informe" };

/** Una llamada en stream: además sabe cuándo el framework abrió su stream y dónde está el resultado. */
export interface LlamadaEnStream extends LlamadaDelMarco {
  /** Se resuelve cuando el framework abrió su stream y el adaptador ya lo observa. */
  abierta: Promise<void>;
  /** El resultado de la capa para esta llamada (lo pone `transmitir` antes de esperar). */
  resultado?: Promise<SavingsResult>;
}

export interface CapaDelAdaptador {
  /** `layer.generate()` dentro del contexto de la llamada, sin interpretar el desenlace. */
  ejecutar(req: SavingsRequest, llamada: LlamadaDelMarco): Promise<SavingsResult>;
  generar(req: SavingsRequest, llamada: LlamadaDelMarco): Promise<Desenlace>;
  transmitir(req: SavingsRequest, llamada: LlamadaEnStream, signal?: AbortSignal): Promise<DesenlaceDeStream>;
  /** Clona el informe, se lo da a `onReport` (sin dejar que un error suyo llegue a la llamada) y lo devuelve. */
  informe(report: SavingsReport): SavingsReport;
  avisar(clave: string, mensaje: string): void;
  close(): void;
}

// Un error que lanzó el framework (el proveedor falló, un 4xx…) vuelve al
// llamante tal cual. Uno de licencia, también. Cualquier otro que llegue
// DESPUÉS de una llamada al framework que terminó bien es de la capa, y la
// respuesta ya está pagada: se devuelve sin informe antes que tirarla.
function esDeLaCapaTrasPagar(llamada: LlamadaDelMarco, err: unknown): boolean {
  if (err instanceof LicenseError) return false;
  if (llamada.errorDelMarco && llamada.errorDelMarco.error === err) return false;
  return llamada.invocada && llamada.completada;
}

const AVISO_SIN_INFORME =
  "[bvsala] the model answered, but the savings layer failed while accounting for it; the answer is " +
  "returned unchanged, without a savings report and without a usage record.";

export function crearCapaDelAdaptador(marco: string, opciones: SavingsAdapterOptions): CapaDelAdaptador {
  // Una capa por adaptador creado: su caché exacta, sus resolvers y su medición.
  const als = crearAlmacen();
  const config: Partial<SavingsLayerConfig> = {};
  for (const k of PERMITIDAS) {
    if (opciones[k] !== undefined) (config as Record<string, unknown>)[k] = opciones[k];
  }
  const layer = createSavingsLayer({ ...config, provider: crearPuente(marco, als) });
  const avisar = (clave: string, mensaje: string): void =>
    avisarUnaVez(opciones.silenceWarnings, `${marco}:${clave}`, mensaje);

  return {
    ejecutar(req, llamada) {
      return als.run(llamada, () => layer.generate(req));
    },

    async generar(req, llamada) {
      try {
        const result = await als.run(llamada, () => layer.generate(req));
        return llamada.invocada ? { tipo: "vivo", result } : { tipo: "atajo", result };
      } catch (err) {
        if (esDeLaCapaTrasPagar(llamada, err)) {
          avisar("sin-informe", AVISO_SIN_INFORME);
          return { tipo: "sin-informe" };
        }
        throw err;
      }
    },

    async transmitir(req, llamada, signal) {
      const handle = als.run(llamada, () => layer.generateStream(req, signal ? { signal } : {}));
      const resultado = handle.result;
      llamada.resultado = resultado;
      // Nadie itera el handle: el texto ya lo entrega el framework. Un rechazo
      // que nadie espere no puede acabar como `unhandledRejection`.
      resultado.catch(() => {});
      let gano: "abierta" | "resuelta";
      try {
        gano = await Promise.race([
          llamada.abierta.then(() => "abierta" as const),
          resultado.then(() => "resuelta" as const),
        ]);
      } catch (err) {
        if (esDeLaCapaTrasPagar(llamada, err)) {
          avisar("sin-informe", AVISO_SIN_INFORME);
          return { tipo: "sin-informe" };
        }
        throw err;
      }
      if (gano === "abierta") return { tipo: "abierto" };
      const result = await resultado;
      // Resuelto sin que el framework abriera su stream: o un atajo, o el camino
      // de último recurso del núcleo, que llama al proveedor ENTERO (generate).
      return llamada.invocada ? { tipo: "entero", result } : { tipo: "atajo", result };
    },

    informe(report) {
      // Una copia en JSON: el llamante puede guardarla, mutarla o serializarla
      // sin tocar lo que la capa ya registró.
      const copia = JSON.parse(JSON.stringify(report)) as SavingsReport;
      if (opciones.onReport) {
        try {
          opciones.onReport(copia);
        } catch {
          avisar(
            "onreport",
            "[bvsala] `onReport` threw; the error was caught and the model call was not affected.",
          );
        }
      }
      return copia;
    },

    avisar,

    close() {
      layer.close();
    },
  };
}

/** Una llamada en stream con su promesa `abierta` y la función que la resuelve. */
export function promesaDeApertura(): { abierta: Promise<void>; abrir: () => void } {
  let abrir!: () => void;
  const abierta = new Promise<void>((r) => {
    abrir = r;
  });
  return { abierta, abrir };
}
