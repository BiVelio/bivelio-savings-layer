import type { VerificationCheck, VerificationSettings } from "../contracts/verification.js";

// LOS AJUSTES DE LA VERIFICACIÓN, NORMALIZADOS. Apagada por defecto (D2).
//
// Cada copia es gasto REAL del cliente, así que un valor dudoso APAGA, nunca se
// recorta: un `sampleRate: 50` que quería decir 50 % no puede convertirse en un
// 100 % silencioso, y un "0.1" en texto (un env var sin convertir) tampoco se
// adivina. Ante la duda, no se gasta.

export type AjustesDeVerificacion =
  | {
      activo: true;
      tasa: number;
      tope?: number;
      onCheck?: (check: VerificationCheck) => void;
      waitUntil?: (promise: Promise<void>) => void;
    }
  | { activo: false; motivo: "ausente" | "cero" | "invalido" };

export function normalizarAjustes(v?: VerificationSettings): AjustesDeVerificacion {
  if (v === undefined || v === null) return { activo: false, motivo: "ausente" };
  if (typeof v !== "object") return { activo: false, motivo: "invalido" };
  const tasa = (v as { sampleRate?: unknown }).sampleRate;
  if (typeof tasa !== "number" || !Number.isFinite(tasa) || tasa < 0 || tasa > 1) {
    return { activo: false, motivo: "invalido" };
  }
  const tope = (v as { maxCheckCostUsd?: unknown }).maxCheckCostUsd;
  if (tope !== undefined && (typeof tope !== "number" || !Number.isFinite(tope) || tope <= 0)) {
    return { activo: false, motivo: "invalido" };
  }
  // Cero es un apagado explícito y legítimo (p. ej. un dial por entorno): sin aviso.
  if (tasa === 0) return { activo: false, motivo: "cero" };
  const onCheck = typeof v.onCheck === "function" ? v.onCheck : undefined;
  const waitUntil = typeof v.waitUntil === "function" ? v.waitUntil : undefined;
  return {
    activo: true,
    tasa,
    ...(tope !== undefined ? { tope } : {}),
    ...(onCheck ? { onCheck } : {}),
    ...(waitUntil ? { waitUntil } : {}),
  };
}

/**
 * El porcentaje del aviso: `r·100`; entero → «2%», si no hasta dos decimales sin
 * ceros finales («0.5%»). Nunca notación exponencial.
 */
export function porcentajeDeAviso(tasa: number): string {
  const p = tasa * 100;
  const redondo = Math.round(p * 100) / 100;
  // Una tasa minúscula no se pinta como «0%»: el aviso existe para decir que hay gasto.
  if (redondo === 0) return "<0.01%";
  if (Number.isInteger(redondo)) return `${redondo}%`;
  return `${redondo.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")}%`;
}

/** W1 · el aviso único al arrancar, con lo que cuesta (D3). */
export function avisoDeVerificacionActiva(tasa: number): string {
  const pct = porcentajeDeAviso(tasa);
  return (
    `[bvsala] Verification sampling is ON (sampleRate ${tasa}): about ${pct} of eligible requests ` +
    `are sent a second time, unoptimized, to your own provider — in the background, after your ` +
    `answer is returned — and the second answer is discarded. You pay your provider for those ` +
    `calls: roughly ${pct} of what that traffic would cost without the layer. The pairs appear ` +
    `under Proof › Your bench in your dashboard; they are informational and never enter your ` +
    `statement or any commission.`
  );
}

/** W2 · ajuste inválido: la verificación queda APAGADA. */
export function avisoDeVerificacionInvalida(v: unknown): string {
  let valor: string;
  try {
    const t = (v as { sampleRate?: unknown } | null | undefined)?.sampleRate;
    valor = typeof t === "string" ? JSON.stringify(t) : String(t);
  } catch {
    valor = "an unreadable value";
  }
  return (
    "[bvsala] `verification.sampleRate` must be a number from 0 to 1 and " +
    "`verification.maxCheckCostUsd`, when set, a positive number " +
    `(got sampleRate ${valor}); verification sampling is OFF.`
  );
}

/** W3 · sin destino para los pares: no se envía ninguna copia (D4). */
export const AVISO_VERIFICACION_SIN_DESTINO =
  "[bvsala] Verification sampling is set, but its pairs have nowhere to go: set " +
  "`serviceAccountKey` and `licenseServerUrl` (with metering on) to see them in your " +
  "dashboard, or pass `verification.onCheck` to receive them yourself. No request will be " +
  "sent twice until then.";

/** El aviso de un fallo interno del muestreo: la petición servida no se toca. */
export const AVISO_VERIFICACION_FALLO_INTERNO =
  "[bvsala] verification sampling hit an internal error and skipped a request; your request was not affected.";
