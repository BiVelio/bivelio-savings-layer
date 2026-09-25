import { CATALOGO, claveDeCatalogo } from "./catalogo.js";

// ═══════════════════════════════════════════════════════════════════════════
// ¿RAZONA ESTE MODELO? La guarda de salida de la referencia, regla v2.
// ═══════════════════════════════════════════════════════════════════════════
//
// Módulo INTERNO: no se reexporta (el catálogo sí es público; esta tabla no).
//
// Un modelo de razonamiento factura como salida unos tokens que nadie ve y que
// no se repiten: la longitud del razonamiento cambia de una llamada a otra
// aunque la petición sea idéntica. Y casi ninguno respeta `temperature: 0`: la
// familia gpt-5 y la serie o solo aceptan el valor por defecto, y una pasarela
// que lo quite en silencio convierte una petición «determinista» en una
// muestreada. Así que el contador de salida de la llamada que corrió NO dice lo
// que su repetición habría escrito, y la referencia no acredita ni un token de
// salida para estos modelos, diga lo que diga el contador.
//
// La entrada sí se sigue acreditando: el contador de ENTRADA de unos bytes
// idénticos es determinista también aquí, y la tarifa cacheada sigue siendo el
// mínimo que el proveedor cobra por repetirlos. Lo no determinista es solo la
// salida.
//
// POR QUÉ UNA FILA POR CADA MODELO DEL CATÁLOGO, Y NO UN PATRÓN: el test
// `referencia-es-suelo` exige que toda fila de `CATALOGO` tenga aquí su
// respuesta. Quien añada un precio tiene que decidir también esto, y no puede
// olvidarlo: una fila sin clasificar pone el test en rojo.
//
// Claude va en `false` a sabiendas: su razonamiento extendido es opcional, este
// paquete no lo pide nunca, y la API de Anthropic rechaza `temperature` distinto
// de 1 con él puesto, así que una petición con `temperature: 0` no puede haber
// razonado. Si aun así una respuesta trae un bloque de razonamiento, el
// adaptador no declara `reasoningTokens: 0` y la salida tampoco se acredita.
//
// Gemini va entero en `true`: 2.5 y 3.x razonan por defecto (2.5 Pro no se puede
// apagar), y este paquete no manda ningún presupuesto de razonamiento.
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
  // ── Anthropic ──
  "claude-opus-4-5": false,
  "claude-opus-4-6": false,
  "claude-opus-4-7": false,
  "claude-opus-4-8": false,
  "claude-opus-5": false,
  "claude-opus-4": false,
  "claude-sonnet-4-5": false,
  "claude-sonnet-4-6": false,
  "claude-sonnet-5": false,
  "claude-fable-5": false,
  "claude-fable-5-1": false,
  "claude-mythos-5-1": false,
  "claude-mythos-5": false,
  "claude-sonnet-4": false,
  "claude-haiku-4-5": false,
  "claude-3-5-sonnet": false,
  "claude-3-5-haiku": false,
  "claude-3-opus": false,
  "claude-3-haiku": false,
  // ── Google (Gemini) ──
  "gemini-3.7-flash": true,
  "gemini-3.5-flash": true,
  "gemini-3.5-flash-lite": true,
  "gemini-3.1-pro-preview": true,
  "gemini-2.5-pro": true,
  "gemini-2.5-flash": true,
};

/**
 * Nombres que delatan un modelo de razonamiento FUERA del catálogo (el cliente
 * puede ponerle precio con `costModels`), o una variante de una fila que por
 * nombre sí razona (`claude-sonnet-4-5-thinking` hereda la clave de su pariente,
 * que no razona). Se miran sobre el id sin prefijo de proveedor.
 *
 * Es un patrón, no una lista cerrada, y se equivoca a propósito del lado seguro:
 * marcar de más solo cuesta la salida acreditada de una repetición; marcar de
 * menos la cobraría sobre tokens que no se repiten.
 */
const NOMBRE_DE_RAZONAMIENTO: readonly RegExp[] = [
  /^o\d/, //                      o1, o3, o3-mini, o4-mini…
  /^gpt-5/, //                    toda la familia, también los ids fuera del catálogo
  /^gemini-(2\.5|[3-9])/, //      Gemini que razona por defecto
  /reason/, //                    deepseek-reasoner, grok-…-reasoning
  /think/, //                     …-thinking, qwen3-…-thinking
  /(^|[-_.])r\d($|[-_.])/, //     deepseek-r1, …-r2
  /^qwq/,
  /magistral/,
];

/**
 * ¿Razona el modelo? Verdadero si su fila del catálogo lo dice O si su nombre
 * lo delata. Las dos fuentes suman: basta una para que la salida no cuente.
 */
export function esModeloDeRazonamiento(model: string): boolean {
  const barra = model.lastIndexOf("/");
  const desnudo = (barra >= 0 ? model.slice(barra + 1) : model).toLowerCase();
  if (NOMBRE_DE_RAZONAMIENTO.some((re) => re.test(desnudo))) return true;
  const clave = claveDeCatalogo(model);
  return clave !== undefined && RAZONA_POR_FILA[clave] === true;
}

/** Las filas del catálogo que esta tabla no clasifica (el test exige cero). */
export function filasSinClasificar(): string[] {
  return Object.keys(CATALOGO).filter((k) => typeof RAZONA_POR_FILA[k] !== "boolean");
}
