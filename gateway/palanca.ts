/**
 * S4a · la palanca de diales: funciones PURAS que ajustan una petición
 * /v1/messages para que el borrado server-side del proveedor
 * (`clear_tool_uses_20250919`) se dispare con NUESTROS diales.
 *
 * Superficie mínima (decisión ToS del dueño, 2026-09-04): se ajusta SOLO el
 * bloque `context_management` del cuerpo y se añade la beta correspondiente.
 * El contenido del cliente — mensajes, system, tools — no se toca jamás; el
 * borrado lo ejecuta el proveedor con su mecanismo oficial y su contador
 * (`applied_edits` / `cleared_input_tokens`) lo certifica.
 *
 * Contrato de seguridad (§2.3 del plan): ante CUALQUIER duda se devuelve null
 * y el cuerpo original viaja intacto — passthrough, jamás error.
 */

import { BETA_CONTEXT_MANAGEMENT, configDeDiales } from "./diales.js";

/**
 * Ajusta el cuerpo de una petición /v1/messages: sustituye (o añade) su
 * `context_management` por el de nuestros diales.
 *
 * Devuelve `null` — «no ajustar, reenviar intacto» — si:
 *  · el cuerpo llega comprimido (S4a no construye el camino de recompresión;
 *    el tráfico Anthropic de Claude Code viaja sin comprimir),
 *  · no parsea como JSON,
 *  · no tiene la forma de /v1/messages (model + messages).
 *
 * Es pura y determinista: el mismo cuerpo produce el mismo ajuste, así que la
 * coalescencia (cuya clave usa el cuerpo ORIGINAL) sigue siendo válida — dos
 * gemelas byte-iguales producen el mismo cuerpo ajustado.
 */
export function ajustarDiales(cuerpo: Buffer, codificacion?: string): Buffer<ArrayBuffer> | null {
  if (codificacion !== undefined && codificacion !== "" && codificacion !== "identity") return null;
  try {
    const json = JSON.parse(cuerpo.toString("utf8")) as Record<string, unknown>;
    if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
    if (typeof json.model !== "string" || !Array.isArray(json.messages)) return null;
    // Se SUSTITUYE la config del cliente: el anillo 0 midió exactamente ese
    // cambio (las muestras traían la config de fábrica, que borró CERO en
    // 1.952 peticiones reales) — todo el 22,9 % es atribuible a los diales.
    json.context_management = configDeDiales();
    return Buffer.from(JSON.stringify(json), "utf8");
  } catch {
    return null;
  }
}

/**
 * Añade la beta de context management a una cabecera `anthropic-beta` sin
 * pisar las existentes (Claude Code manda varias: oauth, extended-cache-ttl —
 * esta última la usa el medidor para tarifar la escritura 1h).
 */
export function conBetaDeElision(actual: string | undefined): string {
  if (actual === undefined || actual.trim() === "") return BETA_CONTEXT_MANAGEMENT;
  const partes = actual.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  if (partes.includes(BETA_CONTEXT_MANAGEMENT)) return actual;
  return `${actual},${BETA_CONTEXT_MANAGEMENT}`;
}
