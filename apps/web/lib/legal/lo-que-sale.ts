import {
  DIAS_DE_RETENCION,
  DIAS_DE_RETENCION_REFERENCIAS,
  DIAS_DE_RETENCION_VERIFICACION,
} from "@/lib/metering/retencion";

/**
 * LO QUE SALE DE LA INFRAESTRUCTURA DEL CLIENTE HACIA BiVelio — la lista que
 * publica `/[locale]/privacy` y a la que remite la LICENSE §5.
 *
 * Esta lista se escribe A MANO a propósito, y NO se deriva de las listas
 * blancas: si se derivara, un campo nuevo aparecería en la página sin frase
 * que lo explique y nadie tendría que mirarlo. Lo que la ata al código es
 * `lo-que-sale.test.ts`, que exige, en las dos direcciones:
 *   · registro de uso: los campos de estos grupos = la lista blanca del ingest
 *     (`CAMPOS_DEL_REGISTRO_DE_USO`, lib/metering/usage.ts), y todo campo de
 *     `UsageWire` (src/metering/emitter.ts: lo que mandan el SDK y el gateway,
 *     que emite por el mismo `toWire`) está aquí;
 *   · verificación opcional (#324): los campos = la lista blanca del cable
 *     (`CAMPOS_DEL_CABLE_DE_VERIFICACION`, lib/verificacion/wire.ts), y todo
 *     campo de `MuestraEnElCable` (src/verification/emisor.ts) está aquí;
 *   · retención: las tablas con plazo = las que purga el cron de retención, y
 *     toda tabla que escriben las dos funciones de ingesta está clasificada.
 * Un campo nuevo en el cable sin su línea en la página pone la suite en rojo.
 *
 * Los textos viven en los mensajes (`privacyPage.*`, 12 idiomas, sin dígitos):
 * la `clave` de cada grupo es la de su título y su cuerpo.
 */

export interface GrupoDeCampos {
  clave: string;
  campos: readonly string[];
}

/** El registro de uso (SDK y gateway): `POST /api/metering/usage`. */
export const GRUPOS_DEL_REGISTRO_DE_USO: readonly GrupoDeCampos[] = [
  {
    clave: "ids",
    campos: ["requestId", "referenceRequestId", "referenceAt", "seatId", "sessionId", "agentId", "orgId", "ci"],
  },
  { clave: "model", campos: ["model", "at"] },
  {
    clave: "counts",
    campos: [
      "avoidedLlm",
      "actualLlm",
      "baselineInputTokens",
      "actualInputTokens",
      "eliminatedInputTokens",
      "compressedInputTokens",
      "baselineOutputTokens",
      "actualOutputTokens",
      "providerCachedInputTokens",
      "cacheResult",
    ],
  },
  {
    clave: "cost",
    campos: [
      "baselineCost",
      "actualCost",
      "netSavings",
      "basis",
      "eliminatedInputFloorCost",
      "nativeCacheReadSavings",
      "nativeCacheWritePremium",
    ],
  },
];

/** La verificación A/B opcional del SDK (#324): `POST /api/metering/verification`, su canal propio. */
export const GRUPOS_DE_LA_VERIFICACION: readonly GrupoDeCampos[] = [
  {
    clave: "sample",
    campos: [
      "basis",
      "requestId",
      "at",
      "requestedModel",
      "servedModel",
      "cacheResult",
      "stratum",
      "outcome",
      "optimizedInputTokens",
      "optimizedCachedInputTokens",
      "optimizedOutputTokens",
      "optimizedCost",
      "naiveInputTokens",
      "naiveCachedInputTokens",
      "naiveOutputTokens",
      "naiveCost",
      "naiveFinishReason",
      "naiveContract",
      "inputPer1k",
      "cachedInputPer1k",
      "outputPer1k",
    ],
  },
  { clave: "counts", campos: ["day", "category", "requests"] },
  { clave: "batch", campos: ["batchId", "samples", "counts"] },
];

export interface PlazoDeRetencion {
  clave: string;
  /** Las tablas de `bvsala` que cubre la frase. */
  tablas: readonly string[];
  dias: number;
}

/**
 * Lo que se guarda por petición (o por lote) y el cron `/api/cron/retencion`
 * borra al cumplir su plazo. Los días salen de lib/metering/retencion.ts, los
 * mismos que usa el cron; la página los recibe por parámetro.
 */
export const PLAZOS_DE_RETENCION: readonly PlazoDeRetencion[] = [
  { clave: "seen", tablas: ["usage_ingest_seen"], dias: DIAS_DE_RETENCION },
  { clave: "reference", tablas: ["reference_hits"], dias: DIAS_DE_RETENCION_REFERENCIAS },
  {
    clave: "verificationSamples",
    tablas: ["verification_samples", "verification_daily"],
    dias: DIAS_DE_RETENCION_VERIFICACION,
  },
  // Los ids de lote siguen el corte de 30 días de `fechaDeCorte` (el cron los
  // purga con `corte`, no con el de la verificación).
  { clave: "verificationBatches", tablas: ["verification_batches_seen"], dias: DIAS_DE_RETENCION },
];

/**
 * Lo que hoy NO tiene borrado automático: los totales diarios que alimentan el
 * panel y el cierre, la actividad por asiento y los extractos sellados. La
 * página lo dice tal cual («no automatic deletion schedule today»).
 */
export const SIN_BORRADO_AUTOMATICO: readonly string[] = [
  "usage_daily",
  "usage_daily_by_model",
  "usage_sessions",
  "seat_activity",
  "extractos",
];

/** Todos los nombres de campo de una lista de grupos, en orden. */
export function camposDe(grupos: readonly GrupoDeCampos[]): string[] {
  return grupos.flatMap((g) => [...g.campos]);
}
