import type { SavingsLayerConfig } from "../pipeline/config.js";
import type { RequestContext, SavingsReport, SavingsToggles } from "./types.js";

// LAS OPCIONES COMUNES A LOS ADAPTADORES DE FRAMEWORKS (`@bivelio/savings-layer/
// ai-sdk`, `/mastra`, `/langchain`, `/anthropic-sdk`).
//
// Viven aquí, en los contratos del núcleo, y no junto a los adaptadores, por una
// razón de empaquetado: los `.d.ts` de los adaptadores importan estos tipos por
// el NOMBRE del paquete, así que tienen que salir de `index.d.ts`. Si vivieran en
// `src/adapters/` y se importaran desde ahí, cada adaptador arrastraría a su
// `.d.ts` una copia de `SavingsReport` y del resto: dos declaraciones del mismo
// contrato que derivan en silencio.
//
// Lo que se puede configurar es un SUBCONJUNTO de `createSavingsLayer`, a
// propósito: licencia, medición de uso, precios, caché exacta y resolvers. Nada
// que reescriba lo que manda el framework (compresión, elisión, selector de
// herramientas, cascada…), porque el adaptador nunca lo reescribe: solo puede
// ahorrarse la llamada entera o medirla. Y nada de `provider`: el proveedor lo
// pone el adaptador, y es la llamada original del framework.

/**
 * Options shared by every framework adapter. Each one has the same meaning as in
 * `createSavingsLayer`; the adapter supplies the provider itself, which is the
 * framework's own model call, forwarded unchanged.
 */
export type SavingsAdapterOptions = Pick<
  SavingsLayerConfig,
  | "licenseKey"
  | "licenseServerUrl"
  | "serviceAccountKey"
  | "licenseRefresh"
  | "licenseRevocation"
  | "licensePollIntervalSeconds"
  | "licenseFetch"
  | "metering"
  | "meteringUrl"
  | "meteringFetch"
  | "costModels"
  | "defaultCostModel"
  | "exactCache"
  | "exactCacheTtlMs"
  | "resolvers"
  | "exactTokenizer"
  | "silenceWarnings"
  | "failOpen"
> & {
  /**
   * Tools without side effects, by name, or a function that says whether a tool
   * has none. Any other tool is treated as having side effects: a request that
   * offers it is never answered from a cache and never shares an answer with an
   * identical request in flight, because the action has to run.
   */
  readOnlyTools?: readonly string[] | ((toolName: string) => boolean);
  /**
   * Switch off, for every call, the levers that answer without calling the
   * model. All three are on by default.
   */
  savings?: SavingsAdapterLevers;
  /**
   * Called once per model call with its report. An error thrown here is caught
   * and never reaches the call.
   */
  onReport?: (report: SavingsReport) => void;
};

/**
 * The levers an adapter can use, all of them answers given without calling the
 * model: an exact repeat, an identical request already in flight, and a
 * computed answer (arithmetic). They can only be switched off.
 */
export type SavingsAdapterLevers = Pick<SavingsToggles, "exactCache" | "singleflight" | "deterministicResolvers">;

/** Per-call options, where the framework has a place to pass them. */
export interface SavingsCallOptions {
  /** Cache identity for this call (tenant, session…). It wins over the adapter's `context` option. */
  context?: RequestContext;
  /** Switch off levers for this call only. */
  savings?: SavingsAdapterLevers;
}
