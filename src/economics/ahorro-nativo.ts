import type { NativeSavingsReport } from "../contracts/types.js";
import { primaDeEscritura, primaDeEscritura1h } from "../pricing/primas.js";
import { familiaDeTarifa } from "../pricing/tarifas-de-tier.js";
import type { CostModel } from "../tokenizer/accounting.js";

// EL AHORRO NATIVO — la caché de prefijo DEL PROVEEDOR, en su carril propio.
//
// Desde #260 `estimateCost` tarifa los tokens leídos de caché a la tarifa
// cacheada EN LOS DOS LADOS: el descuento es del proveedor y la capa no lo
// acredita (las cuatro razones están en `accounting.ts`). Eso sigue igual. Pero
// con Anthropic ese descuento es la mayor parte del ahorro real —GSM8K con
// Sonnet 5: 75 % medido, ~0,13 $ de 0,24 $ del prefijo, mientras el informe
// declaraba −0,0009 $— y el cliente veía menos de lo que tenía y un informe que
// no cuadraba con su factura.
//
// DECISIÓN DEL DUEÑO: «mostrar el ahorro de la caché de prefijo del proveedor
// aparte, sin comisión». Así que aquí se calcula, con el contador del
// proveedor y dos precios de lista, lo que su caché le quitó a la factura:
//
//     lectura   = leídos / 1000 × (entrada − lectura cacheada)
//     prima     = escritos(5m) / 1000 × entrada × (prima − 1)
//               + escritos(1h) / 1000 × entrada × (prima1h − 1)
//     neto      = lectura − prima          (puede ser negativo: escritura en frío)
//
// y se publica en `report.nativeSavings`, FUERA de `cost`. No toca
// `baselineEstimate`, ni `actual`, ni `netSavings`, ni `basis`: la comisión no
// se mueve ni un céntimo (test/ahorro-nativo.test.ts lo afirma con el mismo
// informe con y sin caché).
//
// Solo la llamada que produjo LO SERVIDO: el intento descartado de una cascada
// lo facturó otro modelo a otro precio y vive en `report.modelCascade`; la
// reparación es un prompt nuevo que no comparte prefijo.

/** Lo que el pipeline sabe de la llamada servida. */
export interface ContadorDeCacheNativa {
  /** Tokens leídos de la caché del proveedor (facturados; sin los de una negativa no cobrada). */
  leidos: number;
  /** Tokens escritos en la caché del proveedor (todos los TTL). */
  escritos: number;
  /** La parte de `escritos` con TTL de una hora. */
  escritos1h: number;
  /** Si la capa puso el punto de ruptura en la llamada servida; `undefined` si no lo sabe. */
  marcadoPorLaCapa?: boolean;
  /** false cuando el contador del proveedor llegó incompleto. */
  contadorCompleto: boolean;
}

const MECANISMO: Record<NativeSavingsReport["provider"], NativeSavingsReport["mechanism"]> = {
  anthropic: "explicit",
  openai: "automatic",
  google: "implicit",
  unknown: "unknown",
};

function redondear(n: number): number {
  return Math.round(n * 1e10) / 1e10;
}

/**
 * El bloque `nativeSavings` de una llamada que corrió, o `undefined` si el
 * proveedor no leyó ni escribió nada de su caché.
 */
export function ahorroNativo(
  modelo: string,
  precio: CostModel,
  c: ContadorDeCacheNativa,
): NativeSavingsReport | undefined {
  const leidos = Math.max(0, c.leidos);
  const escritos = Math.max(0, c.escritos);
  const escritos1h = Math.min(escritos, Math.max(0, c.escritos1h));
  if (leidos === 0 && escritos === 0) return undefined;

  const familia = familiaDeTarifa(modelo);
  const provider: NativeSavingsReport["provider"] = familia ?? "unknown";
  const mult = primaDeEscritura(modelo);
  const mult1h = primaDeEscritura1h(modelo);
  const lectura = precio.cachedInputPer1k;
  // Sin contador completo o sin tarifa de lectura no hay nada que afirmar: el
  // bloque sale con los conteos y los dólares a 0, como `unmeasured` en `cost`.
  const medible = c.contadorCompleto && lectura !== undefined && Number.isFinite(lectura);
  const cachedInputPer1k = lectura ?? precio.inputPer1k;

  const readDiscountUsd = medible
    ? (leidos / 1000) * Math.max(0, precio.inputPer1k - cachedInputPer1k)
    : 0;
  const writePremiumUsd = medible
    ? ((escritos - escritos1h) / 1000) * precio.inputPer1k * Math.max(0, mult - 1) +
      (escritos1h / 1000) * precio.inputPer1k * Math.max(0, mult1h - 1)
    : 0;

  return {
    provider,
    mechanism: MECANISMO[provider],
    ...(c.marcadoPorLaCapa !== undefined ? { layerMarked: c.marcadoPorLaCapa } : {}),
    cacheReadTokens: leidos,
    cacheWriteTokens: escritos,
    cacheWrite1hTokens: escritos1h,
    inputPer1k: precio.inputPer1k,
    cachedInputPer1k,
    writeMultiplier: mult,
    write1hMultiplier: mult1h,
    readDiscountUsd: redondear(readDiscountUsd),
    writePremiumUsd: redondear(writePremiumUsd),
    netUsd: redondear(readDiscountUsd - writePremiumUsd),
    basis: medible ? "measured" : "unmeasured",
  };
}
