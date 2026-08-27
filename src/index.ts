/**
 * bivelio-savings-layer (BV-SALA)
 * ---------------------------------------------------------------------------
 * PROPRIETARY AND CONFIDENTIAL. Copyright (c) 2026 BiVelio Inc.
 * All Rights Reserved. Unauthorized copying, distribution, or use of this
 * software, in whole or in part, is strictly prohibited. See LICENSE.
 * ---------------------------------------------------------------------------
 *
 * A provider-neutral LLM execution optimizer. For every request it answers, in
 * order: Can I avoid this call? Can I avoid retrieval? Can I send fewer tools?
 * What context is actually needed? Should I compress it? Which format costs
 * least for this tokenizer? What is the minimal output contract? Is the saving
 * still positive after all infrastructure is counted?
 *
 * It keeps FOUR separate ledgers — avoided_calls, eliminated_tokens,
 * compressed_tokens, provider_cached_tokens — because mixing them produces
 * misleading metrics.
 */

/**
 * The version the SDK reports for itself.
 *
 * Written by hand and deliberately NOT read from package.json: the published
 * bundle does not ship package.json, so a `require` here would fail at runtime
 * on the customer's machine. `test/version-declarada.test.ts` ties this
 * constant to package.json so the two can never drift.
 */
// El catálogo de precios de lista, exportado para que un cliente pueda
// inspeccionarlo, extenderlo o comprobar qué modelos cubre.
export { CATALOGO, precioDeLista, PRECIOS_AL_DIA } from "./pricing/catalogo.js";

export const BV_SALA_VERSION = "0.4.2";

export * from "./util/index.js";
export * from "./contracts/index.js";
export * from "./tokenizer/index.js";
export * from "./canonicalization/index.js";
export * from "./policy/index.js";
export * from "./cache/index.js";
export * from "./resolvers/index.js";
export * from "./router/index.js";
export * from "./retrieval/index.js";
export * from "./memory/index.js";
export * from "./serialization/index.js";
export * from "./constraints/index.js";
export * from "./compression/index.js";
// De la verja económica de la compresión se exportan los DOS TIPOS y nada más.
//
// Los tipos, porque la decisión depende de datos que solo tiene el cliente —el
// mínimo de tramo de SU modelo, la tasa de aciertos de prefijo de SU tráfico— y
// sin poder nombrarlos no puede escribir el objeto que `compressionEconomics`
// acepta ni guardarlo en una constante compartida. No cuestan superficie: la
// configuración ya los arrastra al `.d.ts` publicado.
//
// Y nada más, porque las funciones que deciden se llaman `decidirCompresion`,
// `costeEsperado` o `tramoDeCache`: exportarlas pondría identificadores en
// español en la cara del producto (la verja de `superficie-publica-limpia`), y
// su único llamante legítimo es el pipeline. Un cliente que las invocara a mano
// estaría reimplementando la capa que compró.
export type { CacheTier, CompressionEconomics } from "./economics/index.js";
export * from "./providers/index.js";
export * from "./telemetry/index.js";
export * from "./license/index.js";
export * from "./metering/index.js";
export * from "./pipeline/index.js";
