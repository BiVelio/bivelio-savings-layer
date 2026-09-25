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
  /** Mensajes que el ADAPTADOR añadió al cable y que la petición no traía. */
  mensajesDelAdaptador: number;
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

/**
 * Copia el atestado de `de` a `a`. Para el pipeline, cuando rehace una respuesta
 * (`{ ...final, text }`): la copia sigue describiendo el mismo cable.
 */
export function heredarAtestado<T extends ProviderResponse>(de: ProviderResponse, a: T): T {
  const atestado = atestados.get(de);
  if (atestado) atestados.set(a, atestado);
  return a;
}
