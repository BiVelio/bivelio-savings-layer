import { CATALOGO, claveDeCatalogo } from "./catalogo.js";

// ═══════════════════════════════════════════════════════════════════════════
// ¿SE PUEDE REPETIR LA SALIDA DE ESTE MODELO? La guarda de salida de la
// referencia, regla v2.
// ═══════════════════════════════════════════════════════════════════════════
//
// Módulo INTERNO: no se reexporta (el catálogo sí es público; esta tabla no).
//
// Un modelo de razonamiento factura como salida unos tokens que nadie ve y que
// no se repiten: la longitud del razonamiento cambia de una llamada a otra
// aunque la petición sea idéntica. Y casi ninguno respeta `temperature: 0`: la
// familia gpt-5 y la serie o solo aceptan el valor por defecto, la API de
// Anthropic devuelve 400 a `temperature` en Opus 4.7 y posteriores, y una
// pasarela que lo quite en silencio (OpenRouter ignora por defecto lo que un
// modelo no admite) convierte una petición «determinista» en una muestreada.
// Así que el contador de salida de la llamada que corrió NO dice lo que su
// repetición habría escrito, y la referencia no acredita ni un token de salida
// para estos modelos, diga lo que diga el contador.
//
// La entrada sí se sigue acreditando: el contador de ENTRADA de unos bytes
// idénticos es determinista también aquí, y la tarifa cacheada sigue siendo el
// mínimo que el proveedor cobra por repetirlos. Lo no determinista es solo la
// salida.
//
// POR QUÉ UNA FILA POR CADA MODELO DEL CATÁLOGO, Y NO UN PATRÓN: el test
// `referencia-es-suelo` exige que toda fila de `CATALOGO` tenga aquí su
// respuesta. Quien añada un precio tiene que decidir también esto, y no puede
// olvidarlo: una fila sin clasificar pone el test en rojo. Y un id que NO es
// fila del catálogo (el cliente le pone precio con `costModels`) no está
// clasificado por nadie: su salida NO se acredita (`unclassified-model`).
//
// Claude, según la referencia de la API de Anthropic (septiembre de 2026):
//   · Opus 5 y 5.5, Sonnet 5 y 5.5, Fable 5 y 5.1, Mythos 5 y 5.1 RAZONAN sin que
//     nadie lo pida: con `thinking` omitido corren el
//     razonamiento adaptativo, o lo llevan siempre puesto, y además rechazan
//     `temperature` con un 400. En `true`.
//   · Opus 4.7 y 4.8 no razonan si no se pide, pero tampoco admiten
//     `temperature` (400): una llamada con `temperature: 0` que tuvo éxito es
//     una a la que alguien le quitó el parámetro por el camino, o sea muestreada.
//     En `false` aquí y en `IGNORA_TEMPERATURA` abajo: la salida no cuenta.
//   · Opus 4.6, Sonnet 4.6, Haiku 4.5 y anteriores: el razonamiento es
//     opcional, este paquete no lo pide nunca y `temperature` se respeta. En
//     `false`. Si aun así una respuesta trae un bloque de razonamiento, el
//     adaptador no declara `reasoningTokens: 0` y la salida tampoco se acredita.
//
// Gemini va entero en `true`: 2.5 y 3.x razonan por defecto (2.5 Pro no se puede
// apagar), y este paquete no manda ningún presupuesto de razonamiento.
//
// La familia gpt-6 va entera en `true`. La página del modelo gpt-6-luna
// (https://developers.openai.com/api/docs/models/gpt-6-luna, consultada el
// 2026-09-27) declara «Reasoning token support» con `reasoning.effort` en
// `medium` por defecto, y el changelog (2026-09-03) dice de gpt-6-astra que no
// admite el esfuerzo `none` ni un `temperature` propio. Sol se lanzó con Luna
// (2026-09-22) en la misma familia: ante la duda, su salida no se acredita.
export const RAZONA_POR_FILA: Readonly<Record<string, boolean>> = {
  // ── OpenAI ──
  "gpt-4.1": false,
  "gpt-4.1-mini": false,
  "gpt-4.1-nano": false,
  "gpt-4o": false,
  "gpt-4o-mini": false,
  "gpt-4-turbo": false,
  "gpt-4": false,
  "gpt-3.5-turbo": false,
  "gpt-5": true,
  "gpt-5-codex": true,
  "gpt-5-mini": true,
  "gpt-5-nano": true,
  "gpt-5.1-codex": true,
  "gpt-5.1-codex-max": true,
  "gpt-5.1-codex-mini": true,
  "gpt-5.1-thinking": true,
  "gpt-5.2": true,
  "gpt-5.2-codex": true,
  "gpt-5.3-codex": true,
  "gpt-5.4": true,
  "gpt-5.4-mini": true,
  "gpt-5.4-nano": true,
  "gpt-5.5": true,
  "gpt-5.6-luna": true,
  "gpt-5.6-sol": true,
  "gpt-5.6-terra": true,
  "gpt-6-astra": true,
  "gpt-6-sol": true,
  "gpt-6-luna": true,
  // La serie o (filas del catálogo desde la Parte G del gateway): razonan
  // siempre y solo aceptan el `temperature` por defecto. Su salida no se
  // acredita nunca por referencia.
  "o3": true,
  "o3-mini": true,
  "o3-pro": true,
  "o4-mini": true,
  // ── Anthropic ──
  "claude-opus-4-5": false,
  "claude-opus-4-6": false,
  "claude-opus-4-7": false,
  "claude-opus-4-8": false,
  "claude-opus-5": true,
  "claude-opus-5-5": true,
  "claude-opus-4": false,
  "claude-sonnet-4-5": false,
  "claude-sonnet-4-6": false,
  "claude-sonnet-5": true,
  // Sonnet 5.5: «Adaptive thinking is on by default» y «Setting `temperature`,
  // `top_p`, or `top_k` to a non-default value returns a 400 error»
  // (https://platform.claude.com/docs/en/models/sonnet-5-5/overview, 2026-09-29).
  "claude-sonnet-5-5": true,
  "claude-fable-5": true,
  "claude-fable-5-1": true,
  "claude-mythos-5-1": true,
  "claude-mythos-5": true,
  "claude-sonnet-4": false,
  "claude-haiku-4-5": false,
  "claude-3-5-sonnet": false,
  "claude-3-5-haiku": false,
  "claude-3-opus": false,
  // ── Google (Gemini) ──
  "gemini-3.8-flash": true,
  "gemini-3.7-flash": true,
  "gemini-3.6-flash": true,
  "gemini-3.1-flash-lite": true,
  "gemini-3-flash-preview": true,
  "gemini-3.5-flash": true,
  "gemini-3.5-flash-lite": true,
  "gemini-3.1-pro-preview": true,
  "gemini-2.5-pro": true,
  "gemini-2.5-flash": true,
  // ── Proveedores chinos ──
  // DeepSeek Flash (V4.1-Flash) no razona por defecto y honra temperature: su
  // salida bajo `temperature: 0` se puede repetir y acreditar por referencia.
  // (deepseek-v4-pro sí razona; su nombre no lo delata, así que la fila lo dice.)
  "deepseek-flash": false,
  "deepseek-v4-pro": true,
  "qwen-flash": false,
  "qwen-plus": false,
};

/**
 * Filas que NO razonan por defecto pero NO honran `temperature`: la API del
 * proveedor rechaza el parámetro (Anthropic, Opus 4.7 y 4.8: 400), así que una
 * llamada con `temperature: 0` que llegó a contestar es una a la que una
 * pasarela le quitó el parámetro. Su salida fue muestreada aunque la petición
 * pidiera lo contrario, y la referencia no la acredita. Los modelos que razonan
 * no hace falta listarlos aquí: ya se excluyen por `RAZONA_POR_FILA`.
 */
export const IGNORA_TEMPERATURA: ReadonlySet<string> = new Set(["claude-opus-4-7", "claude-opus-4-8"]);

/**
 * Nombres que delatan un modelo de razonamiento aunque su clave de catálogo sea
 * la de un pariente que no razona (`claude-sonnet-4-5-thinking` hereda la clave
 * de `claude-sonnet-4-5`). Se miran sobre el id sin prefijo de proveedor.
 *
 * Fuera del catálogo ya no hace falta adivinar: un id sin fila no acredita
 * salida (`unclassified-model`). El patrón queda para que la traza diga el
 * motivo verdadero cuando el nombre lo delata.
 */
export const NOMBRE_DE_RAZONAMIENTO: readonly RegExp[] = [
  /^o\d/, //                      o1, o3, o3-mini, o4-mini…
  /^gpt-5/, //                    toda la familia, también los ids fuera del catálogo
  /^gpt-([6-9]|\d{2})/, //        gpt-6 en adelante: razonan por defecto
  /^gpt-oss/, //                  razona siempre
  /^gemini-(2\.5|[3-9])/, //      Gemini que razona por defecto
  /^claude-[a-z]+-([5-9]|\d{2})/, // la generación 5 de Claude y posteriores razonan por defecto
  /^grok-(3-mini|[4-9])/, //      grok-3-mini, grok-4…
  /reason/, //                    deepseek-reasoner, grok-…-reasoning
  /think/, //                     …-thinking, qwen3-…-thinking, `:thinking`
  /(^|[-_.])r\d($|[-_.])/, //     deepseek-r1, …-r2
  /^qwq/,
  /^qwen3/, //                    qwen3 híbrido: razona salvo que se apague
  /^glm-(4\.[5-9]|[5-9])/, //     glm-4.5 y posteriores
  /magistral/,
];

/**
 * Por qué la salida de un modelo NO se puede repetir, o `undefined` si se
 * puede. ASCII inglés: va a la traza (`outputNotCredited`).
 *   · `reasoning-model`     — razona (su fila o su nombre lo dicen);
 *   · `temperature-ignored` — no razona, pero no honra `temperature: 0`;
 *   · `unclassified-model`  — no es fila del catálogo: nadie decidió si razona,
 *                             y ante la duda la salida no cuenta.
 */
export type SalidaNoRepetible = "reasoning-model" | "temperature-ignored" | "unclassified-model";

/** El veredicto de la guarda de salida para un modelo. Ver `SalidaNoRepetible`. */
export function salidaNoRepetible(model: string): SalidaNoRepetible | undefined {
  const barra = model.lastIndexOf("/");
  const desnudo = (barra >= 0 ? model.slice(barra + 1) : model).toLowerCase();
  if (NOMBRE_DE_RAZONAMIENTO.some((re) => re.test(desnudo))) return "reasoning-model";
  const clave = claveDeCatalogo(model);
  if (clave === undefined) return "unclassified-model";
  const razona = RAZONA_POR_FILA[clave];
  if (razona === true) return "reasoning-model";
  if (razona !== false) return "unclassified-model";
  if (IGNORA_TEMPERATURA.has(clave)) return "temperature-ignored";
  return undefined;
}

/** ¿Razona el modelo? Su fila del catálogo o su nombre lo dicen. */
export function esModeloDeRazonamiento(model: string): boolean {
  return salidaNoRepetible(model) === "reasoning-model";
}

/** Las filas del catálogo que esta tabla no clasifica (el test exige cero). */
export function filasSinClasificar(): string[] {
  return Object.keys(CATALOGO).filter((k) => typeof RAZONA_POR_FILA[k] !== "boolean");
}
