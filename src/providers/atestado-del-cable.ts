import type { ProviderResponse } from "./types.js";

// ═══════════════════════════════════════════════════════════════════════════
// LO QUE UN ADAPTADOR PROPIO ATESTIGUA SOBRE LO QUE PUSO EN EL CABLE.
// ═══════════════════════════════════════════════════════════════════════════
//
// El pipeline no ve el cuerpo HTTP: ve la `ProviderRequest` antes y la
// `ProviderResponse` después. Lo que el ADAPTADOR añade entre medias —un turno
// «(continue)», una instrucción de JSON por prompt, una herramienta de contrato,
// el envoltorio de `response_format`— no está en la cuenta local del prompt, así
// que la regla E2 de la referencia (`pipeline/referencia.ts`) no puede verlo. Y
// el contador del proveedor SÍ lo cuenta: acreditarlo en una repetición sería
// cobrar comisión sobre tokens que la capa puso.
//
// Este módulo es el canal por el que los adaptadores de ESTE paquete lo
// declaran, respuesta a respuesta (la vía nativa puede apagarse a mitad de
// vida de un adaptador: un modelo que rechaza `response_format` degrada al
// prompt y lo recuerda).
//
// WeakMap privado y NO reexportado por ningún barrel, el mismo patrón que
// `demo-brand.ts`: un proveedor de terceros no puede atestiguar nada. Su
// ausencia de atestado es el lado seguro donde importa —un esquema nativo sin
// atestado no deja referencia— y, donde no importa (un proveedor propio sin
// esquema), deja la regla como estaba.

export interface AtestadoDelCable {
  /**
   * El contrato de salida viajó TAL CUAL en el parámetro nativo de formato de
   * respuesta del proveedor (`response_format` de Chat Completions), dentro de
   * un envoltorio fijo —tipo, nombre, `strict`— y sin una sola palabra de la
   * capa en el prompt. Es lo único que permite decir que el contador de esa
   * llamada es el de la petición del cliente con su esquema.
   *
   * `false` para la herramienta de contrato de Anthropic: la descripción y el
   * nombre los escribe el adaptador, y el proveedor cobra además su prompt de
   * uso de herramientas, que una petición nativa del cliente podría no pagar.
   */
  esquemaEnFormatoNativo: boolean;
  /**
   * …y con `strict: true`. Un esquema con un campo opcional no cumple el modo
   * estricto de OpenAI y viaja con `strict: false`: el proveedor lo usa de
   * guía, no lo impone, y la regla de la referencia no lo admite.
   */
  esquemaEstricto: boolean;
  /**
   * El adaptador escribió el esquema en el PROMPT (la instrucción de JSON de un
   * modelo que rechaza `response_format`). No es una pieza de 8 tokens: lleva el
   * esquema entero. La referencia lo rechaza SIEMPRE, sea cual sea el resto.
   */
  esquemaPorPrompt: boolean;
  /**
   * Piezas que el ADAPTADOR añadió al cable y que la petición no traía, cada una
   * cubierta con REFERENCE_MESSAGE_ALLOWANCE tokens: el turno «(continue)» de
   * Anthropic (una) y los parámetros vacíos (`{type: "object", properties: {}}`)
   * que se ponen a cada herramienta que no traía los suyos (dos por herramienta,
   * ver `PIEZAS_POR_HERRAMIENTA_SIN_PARAMETROS`).
   */
  piezasDelAdaptador: number;
  /**
   * El API OFICIAL con el que habló el adaptador, decidido por el host de su
   * `baseUrl` (`api.openai.com` → "openai", `generativelanguage.googleapis.com`
   * → "google"; cualquier otro, `null`). Ausente equivale a `null`. Es la
   * condición M2 del ahorro de tier (`economics/tier-diferido.ts`): sin ella el
   * ahorro queda, como mucho, `estimated`. Un proveedor de terceros no puede
   * poner esto, por construcción.
   */
  origen?: "openai" | "google" | null;
  /** De dónde leyó el adaptador el tier servido: el cuerpo o una cabecera. */
  tierLeidoDe?: "cuerpo" | "cabecera";
  /**
   * Presente solo cuando la llamada salió en modo EXPLÍCITO de caché de prefijo
   * (`prompt_cache_options.mode: "explicit"`), con los puntos de ruptura que el
   * adaptador puso: 0 (ni se escribe ni se lee) o 1 (en la frontera del prefijo
   * estable).
   */
  cacheExplicita?: { puntos: 0 | 1 };
}

/** El atestado de una llamada sin contrato: nada nativo, nada por prompt. */
export function sinContrato(piezasDelAdaptador: number): AtestadoDelCable {
  return { esquemaEnFormatoNativo: false, esquemaEstricto: false, esquemaPorPrompt: false, piezasDelAdaptador };
}

/**
 * Piezas por cada herramienta de la petición que no traía parámetros: el
 * adaptador le pone un esquema vacío que el contador cobra y la cuenta local no
 * ve. DOS piezas por herramienta, no una: la clave entera
 * (`"parameters":{"type":"object","properties":{}}`, o su `input_schema` en
 * Anthropic) mide 11-12 tokens en o200k, más que el margen de una pieza. Lo
 * que el proveedor renderiza de verdad es probablemente menos, pero no está
 * medido, y el lado seguro es descontar la clave entera
 * (`test/referencia-v2.test.ts` lo fija con el tokenizador).
 */
export const PIEZAS_POR_HERRAMIENTA_SIN_PARAMETROS = 2;

/** Las piezas que suman las herramientas sin parámetros de una petición. */
export function herramientasSinParametros(tools: readonly { parameters?: unknown }[] | undefined): number {
  return PIEZAS_POR_HERRAMIENTA_SIN_PARAMETROS * (tools ?? []).filter((t) => t.parameters == null).length;
}

const atestados = new WeakMap<object, AtestadoDelCable>();

/** Ata un atestado a una respuesta. Solo lo llaman los adaptadores de este paquete. */
export function atestiguar<T extends ProviderResponse>(respuesta: T, atestado: AtestadoDelCable): T {
  atestados.set(respuesta, atestado);
  return respuesta;
}

/** El atestado de una respuesta, o `undefined` si ningún adaptador propio la firmó. */
export function atestadoDelCable(respuesta: unknown): AtestadoDelCable | undefined {
  return typeof respuesta === "object" && respuesta !== null ? atestados.get(respuesta) : undefined;
}

// EL ORIGEN DE UN PROVEEDOR, antes de llamarlo. El pipeline decide si una
// petición `standalone` sale en modo explícito ANTES de la llamada, así que no
// puede esperar al atestado de la respuesta. Mismo patrón: WeakMap privado, solo
// lo escriben los adaptadores de este paquete, y un proveedor de terceros
// devuelve `undefined` (no atestigua nada).
const origenes = new WeakMap<object, "openai" | "google" | null>();

/** Declara el origen oficial de un proveedor. Solo lo llaman los adaptadores de este paquete. */
export function declararOrigen(proveedor: object, origen: "openai" | "google" | null): void {
  origenes.set(proveedor, origen);
}

/** El origen que un adaptador propio declaró; `undefined` para un proveedor de terceros. */
export function origenDelProveedor(proveedor: unknown): "openai" | "google" | null | undefined {
  return typeof proveedor === "object" && proveedor !== null ? origenes.get(proveedor) : undefined;
}

/**
 * Copia el atestado de `de` a `a`. Para el pipeline, cuando rehace una respuesta
 * (`{ ...final, text }`): la copia sigue describiendo el mismo cable.
 */
export function heredarAtestado<T extends ProviderResponse>(de: ProviderResponse, a: T): T {
  const atestado = atestados.get(de);
  if (atestado) atestados.set(a, atestado);
  return a;
}

// LA BÚSQUEDA DE HERRAMIENTAS NATIVA, también antes de llamar. El pipeline
// decide en la etapa 6 si el catálogo viaja diferido tras la búsqueda del
// proveedor o si lo poda el selector, así que necesita saber, sin llamar, si el
// adaptador sabe mandarla y contra qué host. Mismo patrón que el origen: un
// WeakMap privado que solo escriben los adaptadores de este paquete. Un
// proveedor de terceros devuelve `undefined` y nunca recibe `toolSearch`.
//
//   · "oficial": habla con la API del propio proveedor (api.anthropic.com).
//   · "compatible": sabe mandarla, pero contra otro host (un proxy, un
//     gateway). Claude Code apaga la búsqueda en ese caso porque el proxy puede
//     no reenviar los bloques; aquí `auto` tampoco la enciende y `always` sí.
const busquedas = new WeakMap<object, "oficial" | "compatible">();

/** Declara que un adaptador propio sabe mandar la búsqueda nativa. Solo lo llaman los adaptadores de este paquete. */
export function declararBusquedaNativa(proveedor: object, capacidad: "oficial" | "compatible"): void {
  busquedas.set(proveedor, capacidad);
}

/** La capacidad que un adaptador propio declaró; `undefined` para un proveedor de terceros. */
export function busquedaNativaDelProveedor(proveedor: unknown): "oficial" | "compatible" | undefined {
  return typeof proveedor === "object" && proveedor !== null ? busquedas.get(proveedor) : undefined;
}

// LOS AVISOS DE UN ADAPTADOR PROPIO, CALLADOS POR LA CAPA. `silenceWarnings`
// calla los avisos del pipeline, pero el adaptador los emite por su cuenta y no
// ve esa configuración: el llamante lo construye aparte y se lo pasa a la capa.
// La capa lo apunta aquí al crearse, y el adaptador lo consulta antes de avisar.
// Mismo patrón que los de arriba: privado, sin barril. Un adaptador compartido
// por dos capas queda callado si una de ellas lo pidió.
const silenciados = new WeakSet<object>();

/** La capa con `silenceWarnings: true` calla los avisos de su proveedor. */
export function silenciarAvisosDelProveedor(proveedor: unknown): void {
  if (typeof proveedor === "object" && proveedor !== null) silenciados.add(proveedor);
}

/** ¿Pidió alguna capa callar los avisos de este proveedor? */
export function avisosDelProveedorSilenciados(proveedor: object): boolean {
  return silenciados.has(proveedor);
}
