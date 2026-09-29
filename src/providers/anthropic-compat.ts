// LO QUE CADA MODELO DE CLAUDE RECHAZA DEL CUERPO QUE ESTE PAQUETE ARMA.
//
// Módulo INTERNO: no lo reexporta ningún barril (el de proveedores reexporta
// `anthropic.ts` entero hacia los tipos publicados; esto no debe ir detrás).
// Los comentarios van en `//` por la misma razón que en el resto de la carpeta.
//
// Dos tablas, las dos leídas de la documentación oficial y comprobadas en vivo
// contra `claude-sonnet-5-5` el 2026-09-29 (seis peticiones, ≈0,01 $):
//
// 1. `tool_choice` FORZADO (`{type: "any"}` y `{type: "tool", name}`).
//    https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools#forcing-tool-use
//    (leída 2026-09-29): «Claude Opus 5.5, Claude Sonnet 5.5, Claude Fable 5.1,
//    and Claude Mythos 5.1 — `any` and `tool` return a 400 error», y en la misma
//    tabla: «Adaptive thinking itself doesn't block forced tool use (Claude Opus
//    5 supports it with thinking on); the models in the next row reject forced
//    tool use regardless of thinking settings». O sea: NO es el pensamiento
//    adaptativo lo que lo prohíbe, es el MODELO. Apagar el pensamiento no lo
//    arregla (y en Sonnet 5.5 `thinking: {type: "disabled"}` es otro 400, «whose
//    message points to `between_tools`»:
//    https://platform.claude.com/docs/en/models/sonnet-5-5/whats-new-sonnet-5-5).
//    El 400 medido: «tool_choice: type "tool" and "any" are not supported for
//    this model.» Lo que la documentación recomienda en su lugar: `auto` con
//    `strict: true`, o salidas estructuradas (`output_config.format`).
//
// 2. MUESTREO no por defecto (`temperature`, `top_p`, `top_k`).
//    https://platform.claude.com/docs/en/models/sonnet-5-5/overview («Setting
//    `temperature`, `top_p`, or `top_k` to a non-default value returns a 400
//    error»), y la tabla de pensamiento de la referencia (Opus 4.7 y 4.8, Opus 5
//    y 5.5, Sonnet 5 y 5.5, Fable 5 y 5.1, Mythos 5 y 5.1: «Removed - 400»). El
//    400 medido: «`temperature` is deprecated for this model.»; con
//    `temperature: 1` (el valor por defecto) la misma petición dio 200. Es la
//    misma lista que `IGNORA_TEMPERATURA` + `RAZONA_POR_FILA` de
//    `pricing/razonamiento.ts` usa para NO acreditar la salida de estos modelos.
//
// El emparejamiento es por FAMILIA (el id exacto o el id seguido de `-`, que
// cubre la instantánea con fecha y el sufijo de Bedrock `-v1:0`), y se hace
// sobre la parte `claude-…` del id, para que `anthropic/claude-sonnet-5-5`,
// `anthropic.claude-sonnet-5-5` y `us.anthropic.claude-sonnet-5-5-v1:0` caigan
// en la misma fila. Un modelo que no esté aquí y resulte rechazarlo se aprende
// por su 400 (ver `esToolChoiceForzadoNoSoportado` y `esMuestreoNoSoportado`).

const SIN_TOOL_CHOICE_FORZADO: readonly string[] = [
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-fable-5-1",
  "claude-mythos-5-1",
];

// `claude-opus-5` cubre `claude-opus-5-5`, `claude-sonnet-5` cubre
// `claude-sonnet-5-5`, etc.: aquí la herencia es la correcta (los dos lo rechazan).
const SIN_MUESTREO: readonly string[] = [
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
  "claude-sonnet-5",
  "claude-fable-5",
  "claude-mythos-5",
];

/** El valor por defecto de `temperature` en la API de Mensajes: el único que esos modelos aceptan. */
export const TEMPERATURA_POR_DEFECTO = 1;

function idDeClaude(modelo: string): string | undefined {
  return /claude-[a-z]+-\d[a-z0-9-]*/.exec(modelo.toLowerCase())?.[0];
}

function deLaFamilia(modelo: string, familias: readonly string[]): boolean {
  const id = idDeClaude(modelo);
  if (id === undefined) return false;
  return familias.some((f) => id === f || id.startsWith(`${f}-`));
}

/** ¿La documentación dice que este modelo devuelve 400 a `tool_choice` `any`/`tool`? */
export function rechazaToolChoiceForzado(modelo: string): boolean {
  return deLaFamilia(modelo, SIN_TOOL_CHOICE_FORZADO);
}

/** ¿La documentación dice que este modelo devuelve 400 a un `temperature` no por defecto? */
export function rechazaMuestreo(modelo: string): boolean {
  return deLaFamilia(modelo, SIN_MUESTREO);
}

// El 400 de un modelo que no admite `tool_choice` forzado. Se exige que el
// mensaje nombre `tool_choice` Y diga que no se admite: un 400 por un
// `tool_choice` mal formado (un nombre de herramienta que no existe) es un error
// de quien llama y no se degrada.
export function esToolChoiceForzadoNoSoportado(detalle: string): boolean {
  return /tool_choice/i.test(detalle) && /not supported|unsupported|not available/i.test(detalle);
}

// El 400 de un modelo que no admite un parámetro de muestreo. Mismo criterio:
// el nombre del parámetro y la negativa, no cualquier 400 que lo mencione.
export function esMuestreoNoSoportado(detalle: string): boolean {
  return (
    /\b(temperature|top_p|top_k)\b/i.test(detalle) &&
    /deprecated|not supported|unsupported|non-default|not allowed/i.test(detalle)
  );
}
