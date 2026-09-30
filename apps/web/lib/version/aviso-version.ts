/**
 * ¿Hay máquinas con gateway que llevan una semana sin producir un euro MEDIDO?
 * Decisión PURA, con tests.
 *
 * DOCTRINA (refutación 5 del diseño): el aviso se decide por DINERO, y la
 * versión solo EXPLICA. Decidir por versión era falso en los dos sentidos: un
 * gateway 0.4.16 que no declara versión pero mide dinero desde #229/#230 salía
 * «pendiente» al lado de un titular con ahorro > 0; y un proceso 0.4.17 sin la
 * palanca (SDK sin gateway, org sin `cache_ttl_tuning`, BVSALA_GATEWAY_ELISION=0,
 * tráfico Codex) salía «al día» con 0 €. Por eso:
 *
 *   · Solo cuentan asientos NO CI (cada job de CI es un asiento nuevo: hostnames
 *     efímeros), de superficie gateway o sin declarar (un SDK no tiene palanca
 *     de tarifa: no se le puede pedir), vistos en los últimos 7 días.
 *   · Un asiento con ahorro medido > 0 en 7 días NUNCA entra en el aviso, sea
 *     cual sea su versión: jamás un falso positivo sobre un 0.4.16 que mide.
 *     «Medido» incluye lo medido POR REFERENCIA cuando COMISIONAR_REFERENCIA lo
 *     comisiona (0031, `agregarAsientos`): un asiento cuyo ahorro de la semana
 *     son repeticiones valoradas con el contador de la petición idéntica no es
 *     un asiento con «0 € medidos». La decisión de abajo no cambia.
 *   · Entre los que no producen, la versión reparte la explicación:
 *       desactualizada  → versión < mínima: «esta versión no lleva la palanca».
 *       sinDeclarar     → sin versión (gateway anterior al canal) o con algún
 *                         registro sin versión en 7 días (réplica vieja al lado
 *                         de una nueva): «si es < mínima no lleva la palanca»,
 *                         SIN afirmar el 0.
 *       sinPalanca      → ≥ mínima y 0 €. Las causas comprobables (feature
 *                         cache_ttl_tuning en la licencia, BVSALA_GATEWAY_ELISION,
 *                         tipo de tráfico: escritura de caché 1h) son cosa
 *                         NUESTRA: al cliente el panel solo le dice que la
 *                         palanca no ha actuado y a quién escribir (2026-09-12).
 *   · Si todo produce dinero, null: un panel que grita sin motivo enseña a
 *     ignorarlo (misma regla que BillingStateBanner).
 */

import { VERSION_MINIMA_REFERENCIA, admiteReferencia } from "../metering/version";
import { VERSION_MINIMA_PALANCA_TARIFA } from "./minima";
import { compararVersiones, parsearVersion, superficieDe } from "./semver";

export const DIA_MS = 86_400_000;
export const VENTANA_AVISO_DIAS = 7;

export type EstadoVersion = "alDia" | "desactualizada" | "desconocida";

/** Un asiento tal y como lo agrega `agregarAsientos` (seat_activity, 0024). */
export interface AsientoVisto {
  seatId: string;
  isCi: boolean;
  /** Prefijo de la mayor versión declarada; null si nunca declaró. */
  surface: "gateway" | "sdk" | null;
  /** Menor y mayor versión declaradas (orden semver), o null. */
  versionMin: string | null;
  versionMax: string | null;
  /** Algún registro de los últimos 7 días llegó SIN versión. */
  sinVersion7d: boolean;
  /** ISO de la última actividad. */
  lastSeenAt: string;
  /** Σ(measured_baseline_cost − measured_actual_cost) en los últimos 7 días, más la
   *  referencia (Σ reference_baseline_cost − reference_actual_cost) cuando
   *  COMISIONAR_REFERENCIA la comisiona: la misma regla que el titular y el extracto. */
  ahorroMedido7dUsd: number;
  /** Solo la parte medida por referencia de esos 7 días, con el interruptor como esté (0031). */
  ahorroReferencia7dUsd: number;
  /** Alguna fila de los 7 días trae datos del canal (versión o contador de sin-versión). Las
   *  anteriores a 0024 no: sus measured_* son defaults y no dicen que el asiento no ahorre. */
  conDatos7d: boolean;
}

export interface AvisoVersion {
  tipo: "gatewaySinAhorro";
  /** Asientos gateway/sin declarar, no CI, vistos en 7 días. */
  activas: number;
  desactualizadas: number;
  sinDeclarar: number;
  sinPalanca: number;
  minima: string;
}

/** Estado de la versión de UN asiento, para el chip de la tarjeta. No dice nada del dinero. */
export function estadoVersion(a: Pick<AsientoVisto, "versionMin" | "sinVersion7d">, minima = VERSION_MINIMA_PALANCA_TARIFA): EstadoVersion {
  if (a.versionMin === null || a.sinVersion7d) return "desconocida";
  if (!parsearVersion(a.versionMin)) return "desconocida";
  return compararVersiones(a.versionMin, minima) < 0 ? "desactualizada" : "alDia";
}

export function decidirAvisoVersion(
  asientos: readonly AsientoVisto[],
  nowMs: number,
  minima = VERSION_MINIMA_PALANCA_TARIFA,
): AvisoVersion | null {
  const activas = asientos.filter((a) => {
    if (a.isCi) return false;
    if (a.surface === "sdk") return false;
    const visto = Date.parse(a.lastSeenAt);
    if (Number.isNaN(visto)) return false;
    const hace = nowMs - visto;
    return hace >= 0 && hace <= VENTANA_AVISO_DIAS * DIA_MS;
  });
  // `> 0` y no `>= 0`: un NaN o un negativo (no debería, pero la BD manda) cae
  // del lado de «no produce», que es el lado que avisa.
  // Un asiento cuyas filas de 7 días son todas anteriores a 0024 no tiene medida:
  // no cuenta como «no produce» (falso positivo el día de la migración).
  const sinEuro = activas.filter((a) => a.conDatos7d && !(a.ahorroMedido7dUsd > 0));
  if (sinEuro.length === 0) return null;

  let desactualizadas = 0;
  let sinDeclarar = 0;
  let sinPalanca = 0;
  for (const a of sinEuro) {
    switch (estadoVersion(a, minima)) {
      case "desconocida":
        sinDeclarar++;
        break;
      case "desactualizada":
        desactualizadas++;
        break;
      case "alDia":
        sinPalanca++;
        break;
    }
  }
  return { tipo: "gatewaySinAhorro", activas: activas.length, desactualizadas, sinDeclarar, sinPalanca, minima };
}

/**
 * ¿Hay máquinas con un SDK que ya no puede cobrar por referencia? Decisión
 * PURA, hermana de `decidirAvisoVersion` e independiente de ella: aquella mira
 * gateways sin dinero medido y excluye los SDK; esta solo mira SDK. Los dos
 * avisos pueden salir a la vez sin pisarse.
 *
 * Desde la mínima 0.4.29 (decisión del dueño, BITACORA-2026-09-26 §8), luego
 * 0.4.31 (2026-09-28), 0.4.32 (2026-09-29) y hoy 0.4.33 (decisión del dueño,
 * 2026-09-29), el ingest degrada a `estimated` toda
 * referencia de un SDK anterior a `VERSION_MINIMA_REFERENCIA`
 * (lib/metering/version.ts, el espejo de src/version.ts; nunca una copia aquí):
 * de la 0.4.24 a la 0.4.28 el SDK podía repetir una negativa del proveedor como
 * referencia, hasta la 0.4.30 la que el modelo escribe como texto (#384),
 * hasta la 0.4.31 el `content_filter: OTHER` de Gemini, las que #384 no veía y
 * las respuestas a temas sensibles (#393, #401, #402), y hasta la 0.4.32 las
 * negativas parciales y la carencia tras una disculpa (#422).
 * Las repeticiones de esas máquinas siguen en los totales, pero fuera de la
 * base, hasta que actualicen.
 *
 * Mismo campo que el chip de versión (`versionMin`, que prefiere la ventana de
 * 7 días) y la MISMA verja que el ingest (`admiteReferencia`), no una
 * comparación propia: así una preliminar de la mínima (`sdk/0.4.33-rc.1`), que
 * el ingest degrada, también avisa.
 *   · Solo asientos NO CI vistos en 7 días, como el aviso del gateway.
 *   · Solo SDK: `surface` (la mayor versión) y `versionMin` declaran `sdk/`.
 *     El gateway no emite referencias comisionables a ninguna versión, así que
 *     avisarle de esto sería falso; un asiento que mezcla gateway y SDK no se
 *     puede atribuir y no entra (lado de no avisar en falso).
 *   · Sin versión (nunca declaró, o algún registro sin versión en 7 días):
 *     `estadoVersion` dice «desconocida» y no entra. No se afirma lo que no se
 *     sabe; el ingest ya trata esas referencias como `estimated` igualmente.
 *   · Se decide por VERSIÓN, no por dinero: el dinero que se pierde está en
 *     `estimated`, que no se reparte por asiento como referencia.
 */
export interface AvisoReferencia {
  tipo: "sdkSinReferencia";
  /** Asientos SDK, no CI, vistos en 7 días, con versión declarada por debajo de la mínima. */
  desactualizadas: number;
  /** La menor versión que declaran esos asientos (para el texto). */
  versionMasAntigua: string;
  minima: string;
}

export function decidirAvisoReferencia(asientos: readonly AsientoVisto[], nowMs: number): AvisoReferencia | null {
  let desactualizadas = 0;
  let versionMasAntigua: string | null = null;
  for (const a of asientos) {
    if (a.isCi) continue;
    if (a.surface !== "sdk" || superficieDe(a.versionMin) !== "sdk") continue;
    const visto = Date.parse(a.lastSeenAt);
    if (Number.isNaN(visto)) continue;
    const hace = nowMs - visto;
    if (hace < 0 || hace > VENTANA_AVISO_DIAS * DIA_MS) continue;
    if (estadoVersion(a) === "desconocida") continue;
    if (admiteReferencia(a.versionMin)) continue;
    desactualizadas++;
    if (versionMasAntigua === null || compararVersiones(a.versionMin!, versionMasAntigua) < 0) {
      versionMasAntigua = a.versionMin!;
    }
  }
  if (desactualizadas === 0) return null;
  return {
    tipo: "sdkSinReferencia",
    desactualizadas,
    versionMasAntigua: versionMasAntigua!,
    minima: VERSION_MINIMA_REFERENCIA,
  };
}
