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

// El catálogo de precios de lista, exportado para que un cliente pueda
// inspeccionarlo, extenderlo o comprobar qué modelos cubre.
//
// Camino a la 0.5 (docs/MIGRAR-A-0.5.md): los nombres ingleses son los que se
// congelan; los españoles quedan como alias @deprecated hasta la 0.5. Se
// declaran AQUÍ y no en pricing/catalogo.ts para que el `@deprecated` viaje en
// el `.d.ts` sin tocar el fichero del catálogo (que cambia con cada precio).
import {
  CATALOGO as catalogoDePrecios,
  precioDeLista as precioDeListaDelCatalogo,
  PRECIOS_AL_DIA as preciosAlDia,
} from "./pricing/catalogo.js";

/**
 * The list-price catalogue: model id (without vendor prefix) → USD per 1K
 * tokens. `costModels` on the layer config always wins over it.
 */
export const PRICE_CATALOG: typeof catalogoDePrecios = catalogoDePrecios;
/**
 * The list price for a model on the day of the request, or `undefined` when the
 * catalogue has no price for it in force that day.
 */
export const listPrice: typeof precioDeListaDelCatalogo = precioDeListaDelCatalogo;
/** When the catalogue prices were last checked against the providers' public rates (YYYY-MM-DD). */
export const PRICES_AS_OF: typeof preciosAlDia = preciosAlDia;

/** @deprecated Spanish name, removed in 0.5. Use {@link PRICE_CATALOG}. */
export const CATALOGO: typeof catalogoDePrecios = catalogoDePrecios;
/** @deprecated Spanish name, removed in 0.5. Use {@link listPrice}. */
export const precioDeLista: typeof precioDeListaDelCatalogo = precioDeListaDelCatalogo;
/** @deprecated Spanish name, removed in 0.5. Use {@link PRICES_AS_OF}. */
export const PRECIOS_AL_DIA: typeof preciosAlDia = preciosAlDia;

// La versión vive en src/version.ts junto a las constantes INTERNAS del canal
// de versión (cabecera y mínima de la palanca), que NO se reexportan: nada
// nuevo sale a la superficie pública por aquí.
export { BV_SALA_VERSION } from "./version.js";

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
// Los exportadores: los libros hacia OpenTelemetry, Langfuse, Datadog y FOCUS,
// desde el proceso del cliente y sin enviar nada a BiVelio. NO importan
// `@opentelemetry/api`: sus tipos son estructurales (como `gpt-tokenizer` en
// tokenizer/exact.ts), porque un `import type` del peer opcional acabaría en el
// `.d.ts` y rompería el typecheck de quien no lo tenga instalado, y porque
// `bv-sala.js` (la web) se construye con este mismo fichero. El peer opcional
// de package.json solo documenta el rango probado.
export * from "./exporters/index.js";
