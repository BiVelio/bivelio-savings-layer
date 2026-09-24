/**
 * Palanca D · EL ESFUERZO POR TURNO — funciones PURAS que bajan el esfuerzo del
 * modelo SIN reiniciar la caché de prefijo.
 *
 * POR QUÉ ESTA Y NO OTRA. Todo lo que hemos medido este mes muere en el mismo
 * sitio: el 95,2 % de los tokens de entrada se leen de caché al precio suelo, así
 * que cualquier palanca que borre algo en mitad del prompt paga la reescritura de
 * todo lo que va detrás, con un castigo de 12,5× a 20×. Cayeron la poda de
 * herramientas (35,7:1 en contra), la elisión (−16,7 %) y el patrón de
 * `context-mode` (−$16,73 netos).
 *
 * La SALIDA es lo único que paga precio de lista: $486,06 de una factura de
 * $3.959,73. Y dentro de ella el bloque mayor es el PENSAMIENTO — el 37,7 %,
 * $183 —, que ninguna palanca de estilo puede tocar porque es interno del modelo.
 * Esta es la primera que sí llega ahí.
 *
 * LO QUE LA HACE POSIBLE, y es la parte que importa. Cambiar `output_config.effort`
 * en la raíz de la petición INVALIDA la caché de mensajes — sería la misma trampa
 * otra vez. Pero existe una escotilla: un mensaje `role: "system"` con contenido
 * vacío y `output_config` dentro de `messages`, detrás de la beta
 * `mid-conversation-output-config-2026-07-01`. Como se AÑADE al final y no
 * modifica nada anterior, el prefijo cacheado sigue casando y los bloques de
 * pensamiento anteriores siguen siendo válidos. Es la única palanca de las
 * cuatro que no paga peaje de caché por diseño.
 *
 * LO QUE NO HACE: adivinar. No intenta decidir qué turno «merece» pensar menos —
 * eso es una apuesta sobre la calidad de la respuesta del cliente y no nos
 * corresponde. Aplica el techo que el operador declara, y lo aplica por la vía
 * barata en vez de la cara. Lo que el cliente podría hacer a mano pagando la
 * caché, aquí sale gratis.
 *
 * Contrato de seguridad (el de gateway/palanca.ts): ante CUALQUIER duda se
 * devuelve null y el cuerpo original viaja intacto — passthrough, jamás error.
 */

import { parsearMensajes } from "./tarifa.js";

/** La beta que habilita el mensaje de esfuerzo por turno. Sin ella es un 400. */
export const BETA_ESFUERZO = "mid-conversation-output-config-2026-07-01";

/** Los niveles que admite `output_config.effort`, de menos a más. */
export const NIVELES = ["low", "medium", "high", "xhigh", "max"] as const;
export type Esfuerzo = (typeof NIVELES)[number];

/**
 * Los modelos que admiten esfuerzo POR TURNO. La lista es exacta y corta a
 * propósito: cualquier otro modelo devuelve
 * «output_config.effort requires a model that supports per-turn effort», y
 * `claude-fable-5` está EXPLÍCITAMENTE fuera pese a ser de la misma familia que
 * uno que sí entra. Verificado contra la referencia de migración el 2026-09-10.
 */
const CON_ESFUERZO_POR_TURNO = new Set(["claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5"]);

/**
 * Si el modelo admite la palanca. Se compara contra el id TAL CUAL lo mandó el
 * cliente: una instantánea con fecha o un prefijo de proveedor no está
 * verificada, y aquí un fallo es un 400 de una petición que sin nosotros
 * funcionaba. Misma disciplina que la palanca C.
 */
export function admiteEsfuerzoPorTurno(model: string): boolean {
  return CON_ESFUERZO_POR_TURNO.has(model);
}

export function esNivel(v: string | undefined): v is Esfuerzo {
  return v !== undefined && (NIVELES as readonly string[]).includes(v);
}

/** El mensaje que lleva el cambio. Sin texto: no es una instrucción, es un dial. */
export function mensajeDeEsfuerzo(nivel: Esfuerzo): Record<string, unknown> {
  return { role: "system", content: [], output_config: { effort: nivel } };
}

/**
 * ¿El cuerpo ya trae un dial de esfuerzo puesto por el cliente? Si el llamante
 * ya gobierna su esfuerzo —en la raíz o con un mensaje propio— no se toca: su
 * decisión gana, igual que la palanca de diales respeta el `context_management`
 * del cliente.
 */
export function yaGobiernaSuEsfuerzo(json: Record<string, unknown>): boolean {
  if (json.output_config !== undefined && json.output_config !== null) return true;
  const msgs = json.messages;
  if (!Array.isArray(msgs)) return false;
  return msgs.some(
    (m) => typeof m === "object" && m !== null && (m as { output_config?: unknown }).output_config !== undefined,
  );
}

/** Lo que salió de aplicar el techo. */
export interface EsfuerzoAplicado {
  cuerpo: Buffer<ArrayBuffer>;
  nivel: Esfuerzo;
}

/**
 * Añade el dial al FINAL de `messages`. Devuelve null —«no tocar»— si el cuerpo
 * llega comprimido, no parsea, no tiene forma de mensajes, el modelo no admite
 * la palanca, o el cliente ya gobierna su esfuerzo.
 *
 * Va al final por dos razones. Una: el dial surte efecto «desde el siguiente
 * turno de usuario», así que colocarlo al final es lo que declara la referencia.
 * Dos, y es la que importa: añadir al final no modifica NADA de lo anterior, que
 * es exactamente la propiedad por la que el prefijo cacheado sigue casando y los
 * bloques de pensamiento anteriores siguen siendo válidos.
 *
 * Pura y determinista: dos cuerpos byte-iguales dan salidas byte-iguales, que es
 * lo que la coalescencia necesita.
 */
export function aplicarEsfuerzo(
  cuerpo: Buffer,
  nivel: Esfuerzo,
  codificacion?: string,
): EsfuerzoAplicado | null {
  const json = parsearMensajes(cuerpo, codificacion);
  if (json === null) return null;
  if (typeof json.model !== "string" || !admiteEsfuerzoPorTurno(json.model)) return null;
  if (yaGobiernaSuEsfuerzo(json)) return null;
  const msgs = json.messages;
  if (!Array.isArray(msgs)) return null;
  json.messages = [...msgs, mensajeDeEsfuerzo(nivel)];
  return { cuerpo: Buffer.from(JSON.stringify(json), "utf8"), nivel };
}

/** Añade la beta sin pisar las que ya viajaban. */
export function conBetaDeEsfuerzo(betas: string | undefined): string {
  const partes = (betas ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!partes.includes(BETA_ESFUERZO)) partes.push(BETA_ESFUERZO);
  return partes.join(",");
}

/**
 * La línea de arranque, hermana de las de A y C: una palanca que se cree
 * encendida y no lo está es la trampa muda que ya costó un día de A/B.
 */
export function describirEstadoDeEsfuerzo(
  nivel: string | undefined,
  hayClave: boolean,
  canalAbierto: boolean,
): { linea: string; aviso: boolean } {
  if (nivel === undefined || nivel === "") {
    return {
      linea: `per-turn effort: OFF (BVSALA_GATEWAY_ESFUERZO=${NIVELES.join("|")} turns it on)`,
      aviso: false,
    };
  }
  if (!esNivel(nivel)) {
    return {
      linea: `per-turn effort: NOT ARMED — "${nivel}" is not a level. Use one of: ${NIVELES.join(", ")}`,
      aviso: true,
    };
  }
  if (!hayClave) {
    return {
      linea:
        "per-turn effort: NOT ARMED — BIVELIO_SERVICE_KEY is missing (without it there is no org whose licence to check). " +
        "Open a new terminal or export the key and relaunch",
      aviso: true,
    };
  }
  if (!canalAbierto) {
    return {
      linea: "per-turn effort: NOT ARMED - BVSALA_GATEWAY_ELISION=0 turns off the levers",
      aviso: true,
    };
  }
  return {
    linea:
      `per-turn effort: ARMED at "${nivel}" (ON if your licence includes per_turn_effort; fail-closed). ` +
      "Only fable-5-1, mythos-5-1 and opus-5; every other model passes through unchanged. " +
      "Does NOT reset the prefix cache: the dial is appended at the end and nothing earlier is rewritten",
    aviso: false,
  };
}
