import { precioDeLista } from "../src/pricing/catalogo.js";
import type { CostModel } from "../src/tokenizer/accounting.js";
import type { SavingsReport } from "../src/contracts/types.js";

/**
 * F1 · EL MEDIDOR — convierte los eventos `usage` del stream SSE de Anthropic
 * en un registro de uso con `basis: "measured"`.
 *
 * Doctrina de la v1 (plan maestro): el gateway TODAVÍA no optimiza nada, así
 * que el baseline ES el coste real — netSavings 0, visibilidad 100%. Cuando en
 * F2 se enciendan palancas, su ahorro se medirá contra este mismo contador.
 * Nada se estima: si el proveedor no emitió usage, el registro no se produce.
 */

/** El `usage` acumulado de una respuesta SSE (message_start ∪ message_delta). */
export interface UsoSse {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

/**
 * Observa un stream SSE SIN tocarlo: se le dan los chunks tal cual pasan y al
 * final entrega el `usage` fusionado (message_delta pisa a message_start, que
 * es el orden en que Anthropic los emite — catálogo F0).
 */
export class ObservadorSse {
  private resto = "";
  private uso: UsoSse | null = null;
  readonly eventos: Record<string, number> = {};

  observar(chunk: Buffer | string): void {
    this.resto += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let idx: number;
    while ((idx = this.resto.indexOf("\n\n")) >= 0) {
      const bloque = this.resto.slice(0, idx);
      this.resto = this.resto.slice(idx + 2);
      const ev = /^event: (.+)$/m.exec(bloque)?.[1];
      if (ev) this.eventos[ev] = (this.eventos[ev] ?? 0) + 1;
      if (ev !== "message_start" && ev !== "message_delta") continue;
      const data = /^data: (.+)$/m.exec(bloque)?.[1];
      if (!data) continue;
      try {
        const d = JSON.parse(data) as { usage?: UsoSse; message?: { usage?: UsoSse } };
        const usage = d.usage ?? d.message?.usage;
        if (usage) this.uso = { ...this.uso, ...usage };
      } catch {
        /* un data ilegible no puede tumbar el passthrough */
      }
    }
  }

  usage(): UsoSse | null {
    return this.uso;
  }
}

/**
 * Prima de ESCRITURA de caché de Anthropic: crear una entrada de prompt cache
 * se factura a 1,25× el precio de entrada (precio público). La LECTURA usa
 * `cachedInputPer1k` del catálogo.
 */
export const PRIMA_ESCRITURA_CACHE = 1.25;

export interface RegistroMedido {
  costeUsd: number;
  precio: CostModel;
  tokens: { entrada: number; salida: number; cacheLeida: number; cacheEscrita: number };
}

/** El coste real de una respuesta, a precio de lista del modelo. */
export function costeMedido(model: string, uso: UsoSse): RegistroMedido | null {
  const precio = precioDeLista(model);
  if (!precio) return null;
  const entrada = uso.input_tokens ?? 0;
  const salida = uso.output_tokens ?? 0;
  const cacheLeida = uso.cache_read_input_tokens ?? 0;
  const cacheEscrita = uso.cache_creation_input_tokens ?? 0;
  const porCacheLeida = precio.cachedInputPer1k ?? precio.inputPer1k;
  const costeUsd =
    (entrada / 1_000) * precio.inputPer1k +
    (cacheLeida / 1_000) * porCacheLeida +
    (cacheEscrita / 1_000) * precio.inputPer1k * PRIMA_ESCRITURA_CACHE +
    (salida / 1_000) * precio.outputPer1k;
  return { costeUsd, precio, tokens: { entrada, salida, cacheLeida, cacheEscrita } };
}

/**
 * El informe con la forma que `UsageEmitter.toWire` lee. La v1 no optimiza:
 * baseline = actual, netSavings = 0, `basis: "measured"` — el contador del
 * propio proveedor es la fuente, no un estimador.
 *
 * Se construye COMPLETO para los campos que viajan; el cast final existe
 * porque `SavingsReport` documenta muchos más campos (los de las palancas) que
 * en un gateway sin palancas no tienen valor que reportar.
 */
export function informeMedido(requestId: string, model: string, medido: RegistroMedido): SavingsReport {
  return construirInforme(requestId, model, medido, false);
}

/**
 * El informe de una GEMELA coalescida: la llamada nunca viajó, así que es una
 * llamada evitada con el coste de su primaria como baseline. `basis` queda en
 * "estimated" a propósito — ver la doctrina en gateway/coalescencia.ts — y por
 * tanto NUNCA entra en la base de la comisión.
 */
export function informeCoalescido(requestId: string, model: string, medidoPrimaria: RegistroMedido): SavingsReport {
  return construirInforme(requestId, model, medidoPrimaria, true);
}

function construirInforme(requestId: string, model: string, medido: RegistroMedido, coalescida: boolean): SavingsReport {
  const entradaTotal = medido.tokens.entrada + medido.tokens.cacheLeida + medido.tokens.cacheEscrita;
  const informe = {
    requestId,
    model,
    calls: coalescida ? { avoidedLlm: 1, actualLlm: 0 } : { avoidedLlm: 0, actualLlm: 1 },
    tokens: {
      baselineInput: entradaTotal,
      actualInput: coalescida ? 0 : entradaTotal,
      eliminatedInput: 0,
      compressedInput: 0,
      baselineOutput: medido.tokens.salida,
      actualOutput: coalescida ? 0 : medido.tokens.salida,
      providerCachedInput: coalescida ? 0 : medido.tokens.cacheLeida,
    },
    cache: { result: coalescida ? ("singleflight" as const) : ("miss" as const) },
    cost: coalescida
      ? {
          baselineEstimate: medido.costeUsd,
          actual: 0,
          netSavings: medido.costeUsd,
          basis: "estimated" as const,
        }
      : {
          baselineEstimate: medido.costeUsd,
          actual: medido.costeUsd,
          netSavings: 0,
          basis: "measured" as const,
        },
  };
  return informe as unknown as SavingsReport;
}
