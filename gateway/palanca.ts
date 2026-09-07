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

import { BETA_CONTEXT_MANAGEMENT, TRIGGER_POR_DEFECTO_DE_LA_API, configDeDiales } from "./diales.js";

/**
 * Ajusta el cuerpo de una petición /v1/messages: fusiona nuestros diales en su
 * `context_management` (o lo crea si no lo trae) — ver fusionarDiales.
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
/** Lo que la palanca hizo con una petición. */
export interface AjusteDeDiales {
  /** El cuerpo con nuestros diales fusionados, listo para el upstream. */
  cuerpo: Buffer<ArrayBuffer>;
  /**
   * B2 · true si el `clear_tool_uses` que sale NO es el que traía el cliente.
   * Solo entonces un borrado que el proveedor declare en esta respuesta es
   * ATRIBUIBLE a nuestros diales y su suelo se acredita (regla del delta, plan
   * S4 § 2.4). Si el cliente ya mandaba exactamente nuestro edit, el borrado
   * era suyo: se CUENTA (el contador es del proveedor) pero no se acredita.
   */
  nuestros: boolean;
  /**
   * B2 · la segunda mitad de la regla del delta: el trigger EFECTIVO del
   * `clear_tool_uses` que traía el cliente (el suyo, o el de la API si no lo
   * declaraba), o null si no traía ninguno. El servidor lo compara con la
   * entrada del prompt ORIGINAL (entrada medida + tokens borrados): si sus
   * diales habrían disparado igual, el borrado es suyo y no se acredita.
   */
  triggerDelCliente: number | null;
}

export function ajustarDiales(cuerpo: Buffer, codificacion?: string): AjusteDeDiales | null {
  if (codificacion !== undefined && codificacion !== "" && codificacion !== "identity") return null;
  try {
    const json = JSON.parse(cuerpo.toString("utf8")) as Record<string, unknown>;
    if (json === null || typeof json !== "object" || Array.isArray(json)) return null;
    if (typeof json.model !== "string" || !Array.isArray(json.messages)) return null;
    // La atribución se decide ANTES de fusionar: compara lo que traía el
    // cliente con lo que va a salir.
    const nuestros = dialesSonNuestros(json.context_management);
    const trigger = triggerDelCliente(json.context_management);
    // Se FUSIONA con la config del cliente (fusionarDiales): su estrategia de
    // tool_uses se sustituye por la nuestra (el anillo 0 midió exactamente ese
    // cambio) y sus OTRAS estrategias se conservan tal cual.
    json.context_management = fusionarDiales(json.context_management);
    return { cuerpo: Buffer.from(JSON.stringify(json), "utf8"), nuestros, triggerDelCliente: trigger };
  } catch {
    return null;
  }
}

/**
 * B2 · ¿El `clear_tool_uses` que va a salir DIFIERE del que traía el cliente?
 * Es la regla del delta del plan (§ 2.4): el borrado del proveedor se acredita
 * SOLO en las peticiones donde nuestros diales cambian algo. Compara en forma
 * canónica (claves ordenadas): un cliente que copie nuestro edit con las claves
 * en otro orden manda LO MISMO, y ante la duda no se acredita.
 *
 * Sin `clear_tool_uses` del cliente (lo normal) o con el de fábrica → true.
 * Con exactamente el nuestro (p. ej. un cuerpo ya ajustado por otro gateway en
 * cadena, o un cliente que lo copió) → false.
 */
export function dialesSonNuestros(cm: unknown): boolean {
  const edits = cm !== null && typeof cm === "object" && !Array.isArray(cm) ? (cm as { edits?: unknown }).edits : undefined;
  const delCliente = (Array.isArray(edits) ? edits : []).filter(
    (e) => e !== null && typeof e === "object" && !Array.isArray(e) && (e as { type?: unknown }).type === ESTRATEGIA_TOOL_USES,
  );
  return canonico(delCliente) !== canonico([configDeDiales().edits[0]]);
}

/**
 * B2 · El trigger efectivo de los `clear_tool_uses` que TRAÍA el cliente: el
 * menor de los que declaren (`trigger: {type:"input_tokens", value}`), con el
 * de la API para los que no lo declaren (el de fábrica de Claude Code). Null
 * si no traía ninguno. Ante una forma rara (valor no numérico, otro tipo de
 * trigger) se asume el de la API: mejor no acreditar que acreditar de más.
 */
export function triggerDelCliente(cm: unknown): number | null {
  const edits = cm !== null && typeof cm === "object" && !Array.isArray(cm) ? (cm as { edits?: unknown }).edits : undefined;
  const delCliente = (Array.isArray(edits) ? edits : []).filter(
    (e): e is Record<string, unknown> =>
      e !== null && typeof e === "object" && !Array.isArray(e) && (e as { type?: unknown }).type === ESTRATEGIA_TOOL_USES,
  );
  if (delCliente.length === 0) return null;
  let minimo = Number.POSITIVE_INFINITY;
  for (const e of delCliente) {
    const t = e.trigger as { type?: unknown; value?: unknown } | undefined;
    const v =
      t !== null && typeof t === "object" && t.type === "input_tokens" && typeof t.value === "number" && Number.isFinite(t.value) && t.value > 0
        ? t.value
        : TRIGGER_POR_DEFECTO_DE_LA_API;
    if (v < minimo) minimo = v;
  }
  return minimo;
}

/** JSON con las claves de cada objeto ordenadas: igualdad estructural, no textual. */
function canonico(v: unknown): string {
  return JSON.stringify(v, (_k, val: unknown) =>
    val !== null && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
          Object.keys(val as Record<string, unknown>)
            .sort()
            .map((k) => [k, (val as Record<string, unknown>)[k]]),
        )
      : val,
  );
}

/** La estrategia que la palanca sustituye. */
const ESTRATEGIA_TOOL_USES = "clear_tool_uses_20250919";
/** La estrategia que la API exige en PRIMERA posición de `edits` cuando se
 *  combina con otras (doc oficial de context editing). */
const ESTRATEGIA_THINKING = "clear_thinking_20251015";

/**
 * Fusiona nuestros diales con el `context_management` del cliente en vez de
 * pisarlo entero (regla del plan § 2.1: «si trae una estrategia que no
 * conocemos, NO se toca»):
 *
 *  · sus edits `clear_tool_uses_20250919` (los de fábrica, que no disparan
 *    jamás) se SUSTITUYEN por el nuestro — es el único cambio que la palanca
 *    hace y el único que el anillo 0 midió;
 *  · `clear_thinking_20251015` del cliente se CONSERVA y va en posición 0,
 *    como exige la API. Claude Code lo manda de fábrica con keep:"all"
 *    (corpus 09-2026, claude-cli ≥ 2.1.252); borrarlo cambiaría el thinking
 *    retenido — y con él la caché — en los modelos cuyo default no es «todo»;
 *  · cualquier otra estrategia del cliente se conserva en su orden relativo;
 *  · las claves del bloque distintas de `edits` se conservan.
 *
 * Idempotente: aplicarla sobre un cuerpo ya ajustado devuelve lo mismo (la
 * firma de brazo del anillo 2 sigue siendo «lleva nuestro edit exacto»).
 */
export function fusionarDiales(cm: unknown): { edits: unknown[] } & Record<string, unknown> {
  const nuestro = configDeDiales().edits[0]!;
  const base: Record<string, unknown> =
    cm !== null && typeof cm === "object" && !Array.isArray(cm) ? { ...(cm as Record<string, unknown>) } : {};
  const ajenos = (Array.isArray(base.edits) ? base.edits : []).filter(
    (e): e is Record<string, unknown> =>
      e !== null && typeof e === "object" && !Array.isArray(e) && (e as { type?: unknown }).type !== ESTRATEGIA_TOOL_USES,
  );
  const thinking = ajenos.filter((e) => e.type === ESTRATEGIA_THINKING);
  const otros = ajenos.filter((e) => e.type !== ESTRATEGIA_THINKING);
  return { ...base, edits: [...thinking, ...otros, nuestro] };
}

/**
 * La línea de arranque que dice en qué BRAZO está este proceso y por qué —
 * el A/B del anillo 2 se operó un día entero con la bandera puesta en un
 * terminal SIN clave de servicio, y sin clave la palanca ni se arma (no hay
 * org que consultar): el brazo «palanca» fue control en silencio. Pura;
 * `aviso` marca los casos que merecen stderr (la intención del operador no
 * se cumple).
 */
export function describirEstadoDeElision(bandera: string | undefined, hayClave: boolean): { linea: string; aviso: boolean } {
  const cola = " (se enciende solo si la licencia de la org trae context_elision; fail-closed)";
  if (bandera === "0") return { linea: "elisión S4a: APAGADA (BVSALA_GATEWAY_ELISION=0) — brazo CONTROL", aviso: false };
  if (!hayClave) {
    return {
      linea:
        "elisión S4a: NO SE ARMA — falta BIVELIO_SERVICE_KEY (sin clave no hay org que consultar); este proceso es brazo CONTROL" +
        (bandera === "1" ? " AUNQUE la bandera diga =1. Abre un terminal nuevo o exporta la clave y relanza" : ""),
      aviso: bandera === "1",
    };
  }
  return bandera === "1"
    ? { linea: "elisión S4a: ARMADA (BVSALA_GATEWAY_ELISION=1) — brazo PALANCA" + cola, aviso: false }
    : { linea: "elisión S4a: ARMADA por defecto (sin bandera; =0 la apaga) — brazo PALANCA" + cola, aviso: false };
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
