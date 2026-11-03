import type { CostModel } from "../tokenizer/accounting.js";
import { claveDeCatalogo, precioDeListaPropio } from "./catalogo.js";
import { primaDeEscritura } from "./primas.js";

// LAS TARIFAS DE CADA TIER DE PROCESAMIENTO, POR MODELO Y POR COMPONENTE.
//
// Interno: nadie lo reexporta desde src/index.ts, y por eso los comentarios van
// en `//` y no en JSDoc (un bloque JSDoc se publicaría entero el día que alguien
// lo reexportara).
//
// ── POR QUÉ UNA TABLA Y NO UN FACTOR ────────────────────────────────────────
//
// El ahorro de un tier se acreditaba como `costeEstándar · (1 − 0,5)`. Eso da la
// cifra correcta solo si el tier cobra EXACTAMENTE la mitad de CADA componente, y
// las páginas oficiales dicen que no siempre:
//
//   · Gemini 2.5 Pro, 2.5 Flash y 3.1 Pro Preview cobran la LECTURA DE CACHÉ en
//     Flex al MISMO precio que en estándar («Same as Standard» en la tabla de
//     Batch/Flex de 3.1 Pro). El factor plano acreditaba la mitad de un
//     componente que no se descuenta.
//   · gemini-3.5-flash (0,08 frente a 0,075), gemini-3.5-flash-lite (0,02 frente
//     a 0,015), gpt-5.4 (0,13 frente a 0,125) y o4-mini (0,138 frente a
//     0,1375) cobran la lectura cacheada de Flex POR ENCIMA de la mitad.
//
// Las dos cosas sobre-acreditaban, y la segunda en el tráfico donde la caché de
// OpenAI es automática, o sea el caso normal. Con la tabla, el ahorro es el MISMO
// `usage` que declaró el proveedor tarifado a las dos tarifas publicadas, que es
// lo que trae la factura: esa línea es exactamente ese conteo a esa tarifa.
//
// ── LA REGLA DE ENTRADA ─────────────────────────────────────────────────────
//
// Solo entran modelos con FILA PROPIA en CATALOGO (la regla de
// `precioDeListaPropio`): la tarifa estándar contra la que se resta sale de ahí
// y no de esta tabla, así que un modelo sin fila propia no tendría contra qué
// restar. `test/tarifas-de-tier.test.ts` lo fija.
//
// Cada fila lleva, COMO DATO y no solo como comentario, la página oficial y la
// fecha en que se leyó. Se leyeron el 2026-09-27 así:
//   · OpenAI: https://developers.openai.com/api/docs/pricing — la versión
//     Markdown oficial de la misma página (`…/pricing.md`), tablas «Standard
//     pricing data», «Flex pricing data» y «Batch pricing data», USD por 1M.
//     Cada cifra de abajo está copiada de ahí y dividida entre mil (la unidad de
//     CostModel es 1K). Las filas Batch y las de gpt-6 en Flex se releyeron el
//     2026-09-27 en la versión Markdown descargada tal cual, sin resumidor.
//   · Google: https://ai.google.dev/gemini-api/docs/pricing («Last updated
//     2026-09-24 UTC»), columna «Paid Tier» de los bloques Standard y Flex.
//     OJO al leerla: la columna «Free Tier» dice «Not available» en la caché de
//     gemini-3.5-flash-lite, y la de pago dice $0.03 (estándar) y $0.02 (Flex).
//     El catálogo tiene bien los $0.03.
//   · Anthropic: https://platform.claude.com/docs/en/about-claude/pricing,
//     sección «Batch processing» (entrada y salida por modelo, USD por 1M), leída
//     el 2026-09-27. La lectura y la escritura de caché en lote NO tienen columna
//     propia: salen de dos frases de la misma página —«These multipliers stack
//     with other pricing modifiers, including the Batch API discount» (caché) y
//     «All usage is charged at 50% of the standard API prices» (guía de batch
//     processing)—, o sea el multiplicador de caché del modelo sobre la ENTRADA
//     DE LOTE. Se escriben como número, no se derivan en tiempo de ejecución,
//     para que el test de integridad los vea y los compare con la fila estándar.
//
// ── LO QUE SE QUEDA FUERA, A PROPÓSITO ──────────────────────────────────────
//
//   · gpt-5.1 tiene fila Flex y Batch en OpenAI pero NO fila propia en CATALOGO
//     (sí las tienen sus variantes codex). Sin fila estándar propia no se resta
//     nada. Lo mismo gpt-5.5-pro y gpt-5.4-pro (tienen fila Flex, sin lectura
//     cacheada publicada; además están vetadas en CATALOGO) y, en Gemini,
//     2.5-flash-lite: Flex publicado y ninguna fila propia en CATALOGO. Entran
//     cuando la tengan, no antes.
//   · gpt-4o, gpt-4.1, o1, o3-mini, gpt-5-pro, gpt-5.2-pro, o3-pro y o1-pro no
//     tienen fila Flex: su descuento por diferir solo existe en la Batch API.
//     De ellos tienen fila propia en CATALOGO —y por eso fila Batch aquí—
//     gpt-4o, gpt-4o-mini, la familia gpt-4.1, o3-mini y o3-pro. OJO: no «todas
//     las *-pro»; gpt-5.5-pro y gpt-5.4-pro sí tienen Flex (arriba).
//   · En Batch de OpenAI, la familia gpt-4.1, gpt-4o, gpt-4o-mini, o3, o3-mini,
//     o4-mini y o3-pro NO publican lectura cacheada («-» en la tabla), aunque su
//     fila estándar sí la tenga. Sin precio publicado sus tokens cacheados
//     aportan 0 y la cifra deja de ser `measured`: no se supone la mitad.
//   · `gpt-4o-2024-05-13` tiene fila Batch PROPIA ($2.50 / $7.50) y precio
//     estándar propio ($5 / $15), pero CATALOGO lo resuelve como instantánea de
//     gpt-4o. Valorado con las filas de gpt-4o la diferencia sale 1,25 / 5 por
//     1M frente a la real de 2,50 / 7,50: corta, nunca larga.
//   · Gemini en lote (Batch Mode): la página publica la tabla, pero la capa no
//     tiene superficie de lotes para Gemini (el endpoint compatible con OpenAI no
//     admite subir ni bajar ficheros; ver src/batch/lotes.ts), así que no se
//     tabula lo que ningún camino puede valorar. Y hay una contradicción entre
//     fuentes oficiales que habrá que resolver ANTES: la guía de Batch Mode dice
//     que la caché en lote «is priced the same as for non-batch mode traffic» y
//     la tabla de precios pone la caché de lote de 3.5 Flash a la mitad. Cuando
//     se tabule, gana la que da la diferencia MENOR.
//   · El audio de gemini-2.5-flash cuesta más que el texto ($1.00 estándar,
//     $0.50 Flex; lectura cacheada $0.1 en los dos). El endpoint compatible con
//     OpenAI no desglosa los tokens de audio, así que todo se tarifa a la tarifa
//     de texto: la diferencia de texto (0,15) es MENOR que la de audio (0,50),
//     así que el error va del lado corto, nunca del largo.
//   · Las subidas del 10 % de residencia de datos y FedRAMP de OpenAI son
//     endpoints distintos de `api.openai.com`: una petición a ellos no atestigua
//     origen oficial y nunca sale `measured` (ver `origenOficial` en el
//     adaptador). Y aunque saliera, el 10 % escala las dos tarifas por igual, así
//     que la resta a tarifa sin recargo se queda corta, no larga.
//
// ── CONTEXTO LARGO ──────────────────────────────────────────────────────────
//
// Donde la página publica tarifas de contexto largo se guardan las dos filas
// largas (estándar y tier). No se usan para tarifar: sirven para PROBAR
// (`test/palancas-precio-propiedad.test.ts`, P4) que la diferencia larga es,
// componente a componente, mayor o igual que la corta. O sea que tarifar SIEMPRE
// a tarifa corta —que es lo que se hace, porque el umbral de gpt-5.6 no está
// publicado y no hay forma de saber de qué lado cayó una llamada— solo puede
// quedarse corto. Umbrales publicados: «(<272K context length)» en gpt-5.4 y
// gpt-5.5; «prompts <= 200k tokens» en los Pro de Gemini. En gpt-5.6 la página
// tiene columnas largas y NO dice dónde empiezan.

/** Origen oficial de un proveedor con tabla de tiers aquí. */
export type OrigenDeTarifa = "openai" | "google" | "anthropic" | "deepseek" | "qwen" | "glm";

/** Tarifa plana de un tramo (estándar o tier), en USD por 1K. */
export interface TarifaPlana {
  inputPer1k: number;
  outputPer1k: number;
  cachedInputPer1k?: number;
  cacheWritePer1k?: number;
}

/**
 * La tarifa de UN tier para UN modelo, en USD por 1K.
 *
 * Un componente AUSENTE (`cachedInputPer1k`, `cacheWritePer1k`) significa que la
 * página no publica ese precio para el tier: sus tokens no tienen tarifa de tier
 * y aportan 0 al ahorro, nunca un precio supuesto.
 */
export interface TarifaDeTier extends TarifaPlana {
  /** Filas de contexto largo publicadas, estándar y del tier. Solo como prueba (P4). */
  largo?: { estandar: TarifaPlana; tier: TarifaPlana };
  /** URL oficial de la que sale cada cifra de la fila. */
  fuente: string;
  /** YYYY-MM-DD: cuándo se leyó esa página. */
  consultado: string;
  /**
   * YYYY-MM-DD inclusive: último día en que la página garantiza estas cifras.
   * Pasado ese día la fila deja de existir para la valoración (no se acredita
   * nada) hasta que alguien vuelva a leer la página.
   */
  vigenteHasta?: string;
}

/** Cuándo se leyeron por última vez las páginas de las que sale esta tabla. */
// (2026-09-29: solo se releyó la página de Anthropic, para la fila de Sonnet
// 5.5; su tabla «Batch processing» coincide con todas las filas `an` de abajo.
// OpenAI y Google siguen con la lectura del 2026-09-27, la de su `consultado`.)
export const TARIFAS_DE_TIER_AL_DIA = "2026-09-29";

const OPENAI = "https://developers.openai.com/api/docs/pricing";
const GOOGLE = "https://ai.google.dev/gemini-api/docs/pricing";
const LEIDO = "2026-09-27";

const oa = (f: Omit<TarifaDeTier, "fuente" | "consultado">): TarifaDeTier => ({
  ...f,
  fuente: OPENAI,
  consultado: LEIDO,
});
const go = (f: Omit<TarifaDeTier, "fuente" | "consultado">): TarifaDeTier => ({
  ...f,
  fuente: GOOGLE,
  consultado: LEIDO,
});
const ANTHROPIC = "https://platform.claude.com/docs/en/about-claude/pricing";
const an = (f: Omit<TarifaDeTier, "fuente" | "consultado">): TarifaDeTier => ({
  ...f,
  fuente: ANTHROPIC,
  consultado: LEIDO,
});

/**
 * Tier servido TAL CUAL lo nombra el proveedor → clave de CATALOGO → tarifa.
 *
 * La clave de primer nivel es el ORIGEN, no la familia del nombre: una misma
 * cadena de tier puede valer distinto en dos proveedores.
 */
export const TARIFAS_DE_TIER: Readonly<
  Record<OrigenDeTarifa, Readonly<Record<string, Readonly<Record<string, TarifaDeTier>>>>>
> = {
  openai: {
    // «Flex pricing data», USD/1M → /1000. Columnas: entrada, entrada cacheada,
    // escritura de caché, salida (contexto corto). Leído 2026-09-27 en
    // https://developers.openai.com/api/docs/pricing
    flex: {
      // gpt-5: 0.625 / 0.0625 / - / 5.00
      "gpt-5": oa({ inputPer1k: 0.000625, cachedInputPer1k: 0.0000625, outputPer1k: 0.005 }),
      // gpt-5-mini: 0.125 / 0.0125 / - / 1.00
      "gpt-5-mini": oa({ inputPer1k: 0.000125, cachedInputPer1k: 0.0000125, outputPer1k: 0.001 }),
      // gpt-5-nano: 0.025 / 0.0025 / - / 0.20
      "gpt-5-nano": oa({ inputPer1k: 0.000025, cachedInputPer1k: 0.0000025, outputPer1k: 0.0002 }),
      // gpt-5.2: 0.875 / 0.0875 / - / 7.00
      "gpt-5.2": oa({ inputPer1k: 0.000875, cachedInputPer1k: 0.0000875, outputPer1k: 0.007 }),
      // gpt-5.4 (<272K context length): 1.25 / 0.13 / - / 7.50 · largo 2.50 / 0.25 / - / 11.25.
      // Estándar largo: 5.00 / 0.50 / - / 22.50.
      "gpt-5.4": oa({
        inputPer1k: 0.00125, cachedInputPer1k: 0.00013, outputPer1k: 0.0075,
        largo: {
          estandar: { inputPer1k: 0.005, cachedInputPer1k: 0.0005, outputPer1k: 0.0225 },
          tier: { inputPer1k: 0.0025, cachedInputPer1k: 0.00025, outputPer1k: 0.01125 },
        },
      }),
      // gpt-5.4-mini: 0.375 / 0.0375 / - / 2.25
      "gpt-5.4-mini": oa({ inputPer1k: 0.000375, cachedInputPer1k: 0.0000375, outputPer1k: 0.00225 }),
      // gpt-5.4-nano: 0.10 / 0.01 / - / 0.625
      "gpt-5.4-nano": oa({ inputPer1k: 0.0001, cachedInputPer1k: 0.00001, outputPer1k: 0.000625 }),
      // gpt-5.5 (<272K context length): 2.50 / 0.25 / - / 15.00 · largo 5.00 / 0.50 / - / 22.50.
      // Estándar largo: 10.00 / 1.00 / - / 45.00.
      "gpt-5.5": oa({
        inputPer1k: 0.0025, cachedInputPer1k: 0.00025, outputPer1k: 0.015,
        largo: {
          estandar: { inputPer1k: 0.01, cachedInputPer1k: 0.001, outputPer1k: 0.045 },
          tier: { inputPer1k: 0.005, cachedInputPer1k: 0.0005, outputPer1k: 0.0225 },
        },
      }),
      // gpt-5.6-luna: 0.10 / 0.01 / 0.125 / 0.60 · largo 0.20 / 0.02 / 0.25 / 0.90.
      // Estándar largo: 0.40 / 0.04 / 0.50 / 1.80.
      "gpt-5.6-luna": oa({
        inputPer1k: 0.0001, cachedInputPer1k: 0.00001, cacheWritePer1k: 0.000125, outputPer1k: 0.0006,
        largo: {
          estandar: { inputPer1k: 0.0004, cachedInputPer1k: 0.00004, cacheWritePer1k: 0.0005, outputPer1k: 0.0018 },
          tier: { inputPer1k: 0.0002, cachedInputPer1k: 0.00002, cacheWritePer1k: 0.00025, outputPer1k: 0.0009 },
        },
      }),
      // gpt-5.6-sol: 2.00 / 0.20 / 2.50 / 10.00 · largo 4.00 / 0.40 / 5.00 / 15.00.
      // Estándar largo: 8.00 / 0.80 / 10.00 / 30.00. La página: «GPT-5.6 Sol's
      // promotional pricing is available at least through November 21, 2026.»
      // Pasado ese día no se sabe qué cobra, así que la fila caduca ahí.
      "gpt-5.6-sol": oa({
        inputPer1k: 0.002, cachedInputPer1k: 0.0002, cacheWritePer1k: 0.0025, outputPer1k: 0.01,
        largo: {
          estandar: { inputPer1k: 0.008, cachedInputPer1k: 0.0008, cacheWritePer1k: 0.01, outputPer1k: 0.03 },
          tier: { inputPer1k: 0.004, cachedInputPer1k: 0.0004, cacheWritePer1k: 0.005, outputPer1k: 0.015 },
        },
        vigenteHasta: "2026-11-21",
      }),
      // gpt-5.6-terra: 1.00 / 0.10 / 1.25 / 6.00 · largo 2.00 / 0.20 / 2.50 / 9.00.
      // Estándar largo: 4.00 / 0.40 / 5.00 / 18.00.
      "gpt-5.6-terra": oa({
        inputPer1k: 0.001, cachedInputPer1k: 0.0001, cacheWritePer1k: 0.00125, outputPer1k: 0.006,
        largo: {
          estandar: { inputPer1k: 0.004, cachedInputPer1k: 0.0004, cacheWritePer1k: 0.005, outputPer1k: 0.018 },
          tier: { inputPer1k: 0.002, cachedInputPer1k: 0.0002, cacheWritePer1k: 0.0025, outputPer1k: 0.009 },
        },
      }),
      // o3: 1.00 / 0.25 / - / 4.00
      o3: oa({ inputPer1k: 0.001, cachedInputPer1k: 0.00025, outputPer1k: 0.004 }),
      // o4-mini: 0.55 / 0.138 / - / 2.20
      "o4-mini": oa({ inputPer1k: 0.00055, cachedInputPer1k: 0.000138, outputPer1k: 0.0022 }),
      // LA FAMILIA GPT-6, que #332 dejó para «la que se fusione segunda»: su fila
      // estándar ya está en CATALOGO. Leídas el 2026-09-27 en la tabla Flex.
      // gpt-6-astra: 5.00 / 0.50 / 6.25 / 25.00 · largo 10.00 / 1.00 / 12.50 / 37.50.
      // Estándar largo: 20.00 / 2.00 / 25.00 / 75.00.
      "gpt-6-astra": oa({
        inputPer1k: 0.005, cachedInputPer1k: 0.0005, cacheWritePer1k: 0.00625, outputPer1k: 0.025,
        largo: {
          estandar: { inputPer1k: 0.02, cachedInputPer1k: 0.002, cacheWritePer1k: 0.025, outputPer1k: 0.075 },
          tier: { inputPer1k: 0.01, cachedInputPer1k: 0.001, cacheWritePer1k: 0.0125, outputPer1k: 0.0375 },
        },
      }),
      // gpt-6-sol: 1.00 / 0.10 / 1.25 / 5.00 · largo 2.00 / 0.20 / 2.50 / 7.50.
      // Estándar largo: 4.00 / 0.40 / 5.00 / 15.00.
      "gpt-6-sol": oa({
        inputPer1k: 0.001, cachedInputPer1k: 0.0001, cacheWritePer1k: 0.00125, outputPer1k: 0.005,
        largo: {
          estandar: { inputPer1k: 0.004, cachedInputPer1k: 0.0004, cacheWritePer1k: 0.005, outputPer1k: 0.015 },
          tier: { inputPer1k: 0.002, cachedInputPer1k: 0.0002, cacheWritePer1k: 0.0025, outputPer1k: 0.0075 },
        },
      }),
      // gpt-6-luna: 0.05 / 0.005 / 0.0625 / 0.25 · largo 0.10 / 0.01 / 0.125 / 0.375.
      // Estándar largo: 0.20 / 0.02 / 0.25 / 0.75.
      "gpt-6-luna": oa({
        inputPer1k: 0.00005, cachedInputPer1k: 0.000005, cacheWritePer1k: 0.0000625, outputPer1k: 0.00025,
        largo: {
          estandar: { inputPer1k: 0.0002, cachedInputPer1k: 0.00002, cacheWritePer1k: 0.00025, outputPer1k: 0.00075 },
          tier: { inputPer1k: 0.0001, cachedInputPer1k: 0.00001, cacheWritePer1k: 0.000125, outputPer1k: 0.000375 },
        },
      }),
    },
    // «Batch pricing data», USD/1M → /1000, mismas columnas. Leído 2026-09-27 en
    // https://developers.openai.com/api/docs/pricing (versión `.md`, sin
    // resumidor). En todo modelo con fila Flex las cifras de entrada, salida y
    // escritura son IDÉNTICAS a las de Flex; lo que Batch añade son los modelos
    // SIN Flex (gpt-4o, gpt-4.1, o3-mini, o3-pro…). En o3 y o4-mini la tabla
    // Batch NO publica lectura cacheada y Flex sí: aquí se respeta el hueco.
    batch: {
      // gpt-6-astra: 5.00 / 0.50 / 6.25 / 25.00 · largo 10.00 / 1.00 / 12.50 / 37.50.
      "gpt-6-astra": oa({
        inputPer1k: 0.005, cachedInputPer1k: 0.0005, cacheWritePer1k: 0.00625, outputPer1k: 0.025,
        largo: {
          estandar: { inputPer1k: 0.02, cachedInputPer1k: 0.002, cacheWritePer1k: 0.025, outputPer1k: 0.075 },
          tier: { inputPer1k: 0.01, cachedInputPer1k: 0.001, cacheWritePer1k: 0.0125, outputPer1k: 0.0375 },
        },
      }),
      // gpt-6-sol: 1.00 / 0.10 / 1.25 / 5.00 · largo 2.00 / 0.20 / 2.50 / 7.50.
      "gpt-6-sol": oa({
        inputPer1k: 0.001, cachedInputPer1k: 0.0001, cacheWritePer1k: 0.00125, outputPer1k: 0.005,
        largo: {
          estandar: { inputPer1k: 0.004, cachedInputPer1k: 0.0004, cacheWritePer1k: 0.005, outputPer1k: 0.015 },
          tier: { inputPer1k: 0.002, cachedInputPer1k: 0.0002, cacheWritePer1k: 0.0025, outputPer1k: 0.0075 },
        },
      }),
      // gpt-6-luna: 0.05 / 0.005 / 0.0625 / 0.25 · largo 0.10 / 0.01 / 0.125 / 0.375.
      "gpt-6-luna": oa({
        inputPer1k: 0.00005, cachedInputPer1k: 0.000005, cacheWritePer1k: 0.0000625, outputPer1k: 0.00025,
        largo: {
          estandar: { inputPer1k: 0.0002, cachedInputPer1k: 0.00002, cacheWritePer1k: 0.00025, outputPer1k: 0.00075 },
          tier: { inputPer1k: 0.0001, cachedInputPer1k: 0.00001, cacheWritePer1k: 0.000125, outputPer1k: 0.000375 },
        },
      }),
      // gpt-5.6-sol: 2.00 / 0.20 / 2.50 / 10.00 · largo 4.00 / 0.40 / 5.00 / 15.00.
      // Precio promocional «at least through November 21, 2026»: caduca ahí.
      "gpt-5.6-sol": oa({
        inputPer1k: 0.002, cachedInputPer1k: 0.0002, cacheWritePer1k: 0.0025, outputPer1k: 0.01,
        largo: {
          estandar: { inputPer1k: 0.008, cachedInputPer1k: 0.0008, cacheWritePer1k: 0.01, outputPer1k: 0.03 },
          tier: { inputPer1k: 0.004, cachedInputPer1k: 0.0004, cacheWritePer1k: 0.005, outputPer1k: 0.015 },
        },
        vigenteHasta: "2026-11-21",
      }),
      // gpt-5.6-terra: 1.00 / 0.10 / 1.25 / 6.00 · largo 2.00 / 0.20 / 2.50 / 9.00.
      "gpt-5.6-terra": oa({
        inputPer1k: 0.001, cachedInputPer1k: 0.0001, cacheWritePer1k: 0.00125, outputPer1k: 0.006,
        largo: {
          estandar: { inputPer1k: 0.004, cachedInputPer1k: 0.0004, cacheWritePer1k: 0.005, outputPer1k: 0.018 },
          tier: { inputPer1k: 0.002, cachedInputPer1k: 0.0002, cacheWritePer1k: 0.0025, outputPer1k: 0.009 },
        },
      }),
      // gpt-5.6-luna: 0.10 / 0.01 / 0.125 / 0.60 · largo 0.20 / 0.02 / 0.25 / 0.90.
      "gpt-5.6-luna": oa({
        inputPer1k: 0.0001, cachedInputPer1k: 0.00001, cacheWritePer1k: 0.000125, outputPer1k: 0.0006,
        largo: {
          estandar: { inputPer1k: 0.0004, cachedInputPer1k: 0.00004, cacheWritePer1k: 0.0005, outputPer1k: 0.0018 },
          tier: { inputPer1k: 0.0002, cachedInputPer1k: 0.00002, cacheWritePer1k: 0.00025, outputPer1k: 0.0009 },
        },
      }),
      // gpt-5.5 (<272K context length): 2.50 / 0.25 / - / 15.00 · largo 5.00 / 0.50 / - / 22.50.
      "gpt-5.5": oa({
        inputPer1k: 0.0025, cachedInputPer1k: 0.00025, outputPer1k: 0.015,
        largo: {
          estandar: { inputPer1k: 0.01, cachedInputPer1k: 0.001, outputPer1k: 0.045 },
          tier: { inputPer1k: 0.005, cachedInputPer1k: 0.0005, outputPer1k: 0.0225 },
        },
      }),
      // gpt-5.4 (<272K context length): 1.25 / 0.13 / - / 7.50 · largo 2.50 / 0.25 / - / 11.25.
      "gpt-5.4": oa({
        inputPer1k: 0.00125, cachedInputPer1k: 0.00013, outputPer1k: 0.0075,
        largo: {
          estandar: { inputPer1k: 0.005, cachedInputPer1k: 0.0005, outputPer1k: 0.0225 },
          tier: { inputPer1k: 0.0025, cachedInputPer1k: 0.00025, outputPer1k: 0.01125 },
        },
      }),
      // gpt-5.4-mini: 0.375 / 0.0375 / - / 2.25
      "gpt-5.4-mini": oa({ inputPer1k: 0.000375, cachedInputPer1k: 0.0000375, outputPer1k: 0.00225 }),
      // gpt-5.4-nano: 0.10 / 0.01 / - / 0.625
      "gpt-5.4-nano": oa({ inputPer1k: 0.0001, cachedInputPer1k: 0.00001, outputPer1k: 0.000625 }),
      // gpt-5.2: 0.875 / 0.0875 / - / 7.00
      "gpt-5.2": oa({ inputPer1k: 0.000875, cachedInputPer1k: 0.0000875, outputPer1k: 0.007 }),
      // gpt-5: 0.625 / 0.0625 / - / 5.00
      "gpt-5": oa({ inputPer1k: 0.000625, cachedInputPer1k: 0.0000625, outputPer1k: 0.005 }),
      // gpt-5-mini: 0.125 / 0.0125 / - / 1.00
      "gpt-5-mini": oa({ inputPer1k: 0.000125, cachedInputPer1k: 0.0000125, outputPer1k: 0.001 }),
      // gpt-5-nano: 0.025 / 0.0025 / - / 0.20
      "gpt-5-nano": oa({ inputPer1k: 0.000025, cachedInputPer1k: 0.0000025, outputPer1k: 0.0002 }),
      // Sin lectura cacheada publicada en Batch («-»), desde aquí hasta el final.
      // gpt-4.1: 1.00 / - / - / 4.00
      "gpt-4.1": oa({ inputPer1k: 0.001, outputPer1k: 0.004 }),
      // gpt-4.1-mini: 0.20 / - / - / 0.80
      "gpt-4.1-mini": oa({ inputPer1k: 0.0002, outputPer1k: 0.0008 }),
      // gpt-4.1-nano: 0.05 / - / - / 0.20
      "gpt-4.1-nano": oa({ inputPer1k: 0.00005, outputPer1k: 0.0002 }),
      // gpt-4o: 1.25 / - / - / 5.00
      "gpt-4o": oa({ inputPer1k: 0.00125, outputPer1k: 0.005 }),
      // gpt-4o-mini: 0.075 / - / - / 0.30
      "gpt-4o-mini": oa({ inputPer1k: 0.000075, outputPer1k: 0.0003 }),
      // o3: 1.00 / - / - / 4.00
      o3: oa({ inputPer1k: 0.001, outputPer1k: 0.004 }),
      // o4-mini: 0.55 / - / - / 2.20
      "o4-mini": oa({ inputPer1k: 0.00055, outputPer1k: 0.0022 }),
      // o3-mini: 0.55 / - / - / 2.20
      "o3-mini": oa({ inputPer1k: 0.00055, outputPer1k: 0.0022 }),
      // o3-pro: 10.00 / - / - / 40.00
      "o3-pro": oa({ inputPer1k: 0.01, outputPer1k: 0.04 }),
    },
  },
  anthropic: {
    // «Batch processing», USD/1M → /1000: entrada y salida de la tabla; lectura
    // de caché = multiplicador de lectura del modelo × entrada de lote (0,1×;
    // 0,05× en Opus 5.5; 0,025× en Fable 5.1 y Mythos 5.1); escritura de caché =
    // 1,25× la entrada de lote (la de 5 minutos: la de 1 hora, 2×, se tarifa a
    // 1,25× en los DOS lados y la diferencia sale corta, nunca larga). El valor
    // de `usage.service_tier` que pone la respuesta de un lote es "batch".
    // Leído 2026-09-27 en https://platform.claude.com/docs/en/about-claude/pricing
    batch: {
      // Claude Fable 5.1 / Mythos 5.1: $5 / $25; caché 0,025× → $0.125; escritura $6.25.
      "claude-fable-5-1": an({ inputPer1k: 0.005, cachedInputPer1k: 0.000125, cacheWritePer1k: 0.00625, outputPer1k: 0.025 }),
      "claude-mythos-5-1": an({ inputPer1k: 0.005, cachedInputPer1k: 0.000125, cacheWritePer1k: 0.00625, outputPer1k: 0.025 }),
      // Claude Fable 5 / Mythos 5: $5 / $25; caché 0,1× → $0.50; escritura $6.25.
      "claude-fable-5": an({ inputPer1k: 0.005, cachedInputPer1k: 0.0005, cacheWritePer1k: 0.00625, outputPer1k: 0.025 }),
      "claude-mythos-5": an({ inputPer1k: 0.005, cachedInputPer1k: 0.0005, cacheWritePer1k: 0.00625, outputPer1k: 0.025 }),
      // Claude Opus 5.5: $2 / $10; caché 0,05× → $0.10; escritura $2.50.
      "claude-opus-5-5": an({ inputPer1k: 0.002, cachedInputPer1k: 0.0001, cacheWritePer1k: 0.0025, outputPer1k: 0.01 }),
      // Claude Opus 5 y Opus 4.8 / 4.7 / 4.6 / 4.5: $2.50 / $12.50; caché $0.25; escritura $3.125.
      "claude-opus-5": an({ inputPer1k: 0.0025, cachedInputPer1k: 0.00025, cacheWritePer1k: 0.003125, outputPer1k: 0.0125 }),
      "claude-opus-4-8": an({ inputPer1k: 0.0025, cachedInputPer1k: 0.00025, cacheWritePer1k: 0.003125, outputPer1k: 0.0125 }),
      "claude-opus-4-7": an({ inputPer1k: 0.0025, cachedInputPer1k: 0.00025, cacheWritePer1k: 0.003125, outputPer1k: 0.0125 }),
      "claude-opus-4-6": an({ inputPer1k: 0.0025, cachedInputPer1k: 0.00025, cacheWritePer1k: 0.003125, outputPer1k: 0.0125 }),
      "claude-opus-4-5": an({ inputPer1k: 0.0025, cachedInputPer1k: 0.00025, cacheWritePer1k: 0.003125, outputPer1k: 0.0125 }),
      // Claude Opus 4 (retirado salvo en Google Cloud): $7.50 / $37.50; caché $0.75; escritura $9.375.
      "claude-opus-4": an({ inputPer1k: 0.0075, cachedInputPer1k: 0.00075, cacheWritePer1k: 0.009375, outputPer1k: 0.0375 }),
      // Claude Sonnet 5: $1 / $5; caché $0.10; escritura $1.25.
      "claude-sonnet-5": an({ inputPer1k: 0.001, cachedInputPer1k: 0.0001, cacheWritePer1k: 0.00125, outputPer1k: 0.005 }),
      // Claude Sonnet 5.5: $1 / $5 (la misma fila de la tabla «Batch processing»
      // que Sonnet 5); caché $0.10; escritura $1.25. Leída el 2026-09-29.
      "claude-sonnet-5-5": { ...an({ inputPer1k: 0.001, cachedInputPer1k: 0.0001, cacheWritePer1k: 0.00125, outputPer1k: 0.005 }), consultado: "2026-09-29" },
      // Claude Sonnet 4.6 / 4.5 / 4: $1.50 / $7.50; caché $0.15; escritura $1.875.
      "claude-sonnet-4-6": an({ inputPer1k: 0.0015, cachedInputPer1k: 0.00015, cacheWritePer1k: 0.001875, outputPer1k: 0.0075 }),
      "claude-sonnet-4-5": an({ inputPer1k: 0.0015, cachedInputPer1k: 0.00015, cacheWritePer1k: 0.001875, outputPer1k: 0.0075 }),
      "claude-sonnet-4": an({ inputPer1k: 0.0015, cachedInputPer1k: 0.00015, cacheWritePer1k: 0.001875, outputPer1k: 0.0075 }),
      // Claude Haiku 4.5: $0.50 / $2.50; caché $0.05; escritura $0.625.
      "claude-haiku-4-5": an({ inputPer1k: 0.0005, cachedInputPer1k: 0.00005, cacheWritePer1k: 0.000625, outputPer1k: 0.0025 }),
      // Claude Haiku 3.5 (la clave de CATALOGO es claude-3-5-haiku): $0.40 / $2; caché $0.04; escritura $0.50.
      "claude-3-5-haiku": an({ inputPer1k: 0.0004, cachedInputPer1k: 0.00004, cacheWritePer1k: 0.0005, outputPer1k: 0.002 }),
    },
  },
  google: {
    // Bloque «Flex», columna «Paid Tier», USD/1M → /1000. Columnas: entrada
    // (texto/imagen/vídeo), salida (con thinking), caché de contexto. Leído
    // 2026-09-27 en https://ai.google.dev/gemini-api/docs/pricing
    flex: {
      // gemini-3.7-flash: $0.375 / $1.875 / $0.0375 «through December 31, 2026»;
      // desde el 1-ene-2027 la página publica el doble en estándar y en Flex.
      "gemini-3.7-flash": go({
        inputPer1k: 0.000375, outputPer1k: 0.001875, cachedInputPer1k: 0.0000375,
        vigenteHasta: "2026-12-31",
      }),
      // gemini-3.5-flash: $0.75 / $4.50 / $0.08
      "gemini-3.5-flash": go({ inputPer1k: 0.00075, outputPer1k: 0.0045, cachedInputPer1k: 0.00008 }),
      // gemini-3.5-flash-lite: $0.15 / $1.25 / $0.02
      "gemini-3.5-flash-lite": go({ inputPer1k: 0.00015, outputPer1k: 0.00125, cachedInputPer1k: 0.00002 }),
      // gemini-3.1-pro-preview: $1.00 / $6.00 / $0.20 («Same as Standard»), prompts
      // <= 200k · > 200k: $2.00 / $9.00 / $0.40. Estándar > 200k: $4.00 / $18.00 / $0.40.
      "gemini-3.1-pro-preview": go({
        inputPer1k: 0.001, outputPer1k: 0.006, cachedInputPer1k: 0.0002,
        largo: {
          estandar: { inputPer1k: 0.004, outputPer1k: 0.018, cachedInputPer1k: 0.0004 },
          tier: { inputPer1k: 0.002, outputPer1k: 0.009, cachedInputPer1k: 0.0004 },
        },
      }),
      // gemini-2.5-pro: $0.625 / $5.00 / $0.125, prompts <= 200k · > 200k:
      // $1.25 / $7.50 / $0.25. Estándar > 200k: $2.50 / $15.00 / $0.25.
      "gemini-2.5-pro": go({
        inputPer1k: 0.000625, outputPer1k: 0.005, cachedInputPer1k: 0.000125,
        largo: {
          estandar: { inputPer1k: 0.0025, outputPer1k: 0.015, cachedInputPer1k: 0.00025 },
          tier: { inputPer1k: 0.00125, outputPer1k: 0.0075, cachedInputPer1k: 0.00025 },
        },
      }),
      // gemini-2.5-flash: $0.15 / $1.25 / $0.03 (texto/imagen/vídeo)
      "gemini-2.5-flash": go({ inputPer1k: 0.00015, outputPer1k: 0.00125, cachedInputPer1k: 0.00003 }),
      // LOS QUE #332 DEJÓ FUERA POR FALTA DE FILA ESTÁNDAR, que CATALOGO ya
      // tiene. Leídos el 2026-09-27 en el bloque «Flex» de cada modelo.
      // gemini-3.8-flash y gemini-3.6-flash: $0.375 / $1.875 / $0.0375 «through
      // December 31, 2026»; desde el 1-ene-2027, el doble (como 3.7).
      "gemini-3.8-flash": go({
        inputPer1k: 0.000375, outputPer1k: 0.001875, cachedInputPer1k: 0.0000375,
        vigenteHasta: "2026-12-31",
      }),
      "gemini-3.6-flash": go({
        inputPer1k: 0.000375, outputPer1k: 0.001875, cachedInputPer1k: 0.0000375,
        vigenteHasta: "2026-12-31",
      }),
      // gemini-3.1-flash-lite: $0.125 (texto/imagen/vídeo; audio $0.25) / $0.75 /
      // $0.0125 (texto; audio $0.025). Estándar: $0.25 (audio $0.50) / $1.50 /
      // $0.025 (audio $0.05). La diferencia del audio es MAYOR que la del texto:
      // tarifar todo a texto se queda corto.
      "gemini-3.1-flash-lite": go({ inputPer1k: 0.000125, outputPer1k: 0.00075, cachedInputPer1k: 0.0000125 }),
      // gemini-3-flash-preview: $0.25 (audio $0.50) / $1.50 / caché «Same as
      // Standard» $0.05. La lectura cacheada NO se descuenta.
      "gemini-3-flash-preview": go({ inputPer1k: 0.00025, outputPer1k: 0.0015, cachedInputPer1k: 0.00005 }),
    },
  },
  // Los proveedores chinos no publican tiers comparables (flex/batch) hoy:
  // tablas vacías, para que el tipo cierre y el contraste las recorra sin filas.
  deepseek: {},
  qwen: {},
  glm: {},
};

/** El id sin prefijo de proveedor: `openai/gpt-5-mini` → `gpt-5-mini`. */
export function idDesnudo(model: string): string {
  const barra = model.lastIndexOf("/");
  return barra >= 0 ? model.slice(barra + 1) : model;
}

/**
 * La familia de tabla de un modelo por su NOMBRE, para cuando el origen no está
 * atestiguado (un proxy, una pasarela, un proveedor propio). Sirve para elegir
 * contra qué filas estimar, nunca para afirmar que se habló con ese proveedor.
 */
export function familiaDeTarifa(model: string): OrigenDeTarifa | null {
  const m = model.toLowerCase();
  const barra = m.indexOf("/");
  const vendor = barra > 0 ? m.slice(0, barra) : "";
  const desnudo = idDesnudo(m);
  if (vendor === "openai" || vendor === "azure-openai") return "openai";
  if (vendor === "google" || vendor === "google-vertex") return "google";
  if (vendor === "anthropic") return "anthropic";
  if (vendor === "deepseek") return "deepseek";
  if (vendor === "qwen" || vendor === "dashscope") return "qwen";
  if (vendor === "glm" || vendor === "zhipu") return "glm";
  if (/^(gpt-|o[1-9](-|$))/.test(desnudo)) return "openai";
  if (desnudo.startsWith("gemini")) return "google";
  if (desnudo.startsWith("claude-")) return "anthropic";
  if (desnudo.startsWith("deepseek-")) return "deepseek";
  if (desnudo.startsWith("qwen")) return "qwen";
  if (desnudo.startsWith("glm-")) return "glm";
  return null;
}

// «YYYY-MM-DD inclusive» → el último milisegundo UTC de ese día.
function finDelDia(fecha: string): number {
  return Date.parse(`${fecha}T23:59:59.999Z`);
}

/**
 * La fila del tier SERVIDO para un modelo, o `undefined`.
 *
 * `undefined` en cuatro casos, y los cuatro significan «no se acredita»: el
 * modelo no tiene fila propia en CATALOGO (un sufijo de letra, una versión que
 * no está, un id vetado), el origen no tiene tabla para ese tier, el modelo no
 * tiene fila en él, o la fila caducó (`vigenteHasta`).
 */
export function tarifaDeTier(
  origen: OrigenDeTarifa,
  tier: string,
  model: string,
  ahoraMs: number = Date.now(),
): TarifaDeTier | undefined {
  if (precioDeListaPropio(model) === undefined) return undefined;
  const clave = claveDeCatalogo(model);
  if (clave === undefined) return undefined;
  const porTier = TARIFAS_DE_TIER[origen]?.[tier];
  const fila = porTier ? porTier[clave] : undefined;
  if (!fila) return undefined;
  if (fila.vigenteHasta && ahoraMs > finDelDia(fila.vigenteHasta)) return undefined;
  return fila;
}

/**
 * La tarifa ESTÁNDAR de un modelo, por componente: la fila propia de CATALOGO, y
 * la escritura de caché a `entrada · primaDeEscritura` (el único domicilio de la
 * prima). `undefined` sin fila propia.
 */
export function tarifaEstandar(model: string): (CostModel & { cacheWritePer1k: number }) | undefined {
  const fila = precioDeListaPropio(model);
  if (!fila) return undefined;
  return { ...fila, cacheWritePer1k: fila.inputPer1k * primaDeEscritura(idDesnudo(model)) };
}
