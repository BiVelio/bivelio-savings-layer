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
 * uno que sí entra. Verificado contra la referencia de migración el 2026-09-10;
 * `claude-opus-5-5` entra el 2026-09-27, cuando la página oficial del parámetro
 * (platform.claude.com/docs/en/build-with-claude/effort, «Change effort
 * mid-conversation») la nombra junto a las otras tres.
 */
const CON_ESFUERZO_POR_TURNO = new Set(["claude-fable-5-1", "claude-mythos-5-1", "claude-opus-5-5", "claude-opus-5"]);

/**
 * El esfuerzo que el modelo usa cuando nadie lo pide. Misma página oficial
 * (2026-09-27): «Most Claude models default to high effort […]; Claude Opus 5.5
 * defaults to medium». Un modelo que no está aquí no admite la palanca, así que
 * no hace falta más detalle.
 */
const DEFECTO_POR_MODELO: Readonly<Record<string, Esfuerzo>> = {
  "claude-fable-5-1": "high",
  "claude-mythos-5-1": "high",
  "claude-opus-5-5": "medium",
  "claude-opus-5": "high",
};

/** El nivel por defecto de un modelo con esfuerzo por turno, o undefined si no lo admite. */
export function defectoDeEsfuerzo(model: string): Esfuerzo | undefined {
  return admiteEsfuerzoPorTurno(model) ? DEFECTO_POR_MODELO[model] : undefined;
}

/**
 * ¿Este nivel REBAJA el esfuerzo por defecto del modelo? La palanca es un
 * TECHO: solo existe para pagar menos salida. Un nivel igual al defecto no
 * cambia nada (la página oficial: fijarlo al defecto «produces exactly the same
 * behavior as omitting» el parámetro) y uno por encima SUBE la factura —más
 * pensamiento, a precio de lista—. En ninguno de los dos casos se toca el cuerpo.
 */
export function rebajaElDefecto(model: string, nivel: Esfuerzo): boolean {
  const defecto = defectoDeEsfuerzo(model);
  return defecto !== undefined && NIVELES.indexOf(nivel) < NIVELES.indexOf(defecto);
}

/**
 * Los niveles que rebajan el defecto de AL MENOS un modelo admitido: los únicos
 * que el operador puede poner con sentido. Se deriva de la tabla, no se copia.
 */
export const NIVELES_QUE_REBAJAN: readonly Esfuerzo[] = NIVELES.filter((n) =>
  Object.keys(DEFECTO_POR_MODELO).some((m) => rebajaElDefecto(m, n)),
);

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
 * la palanca, el nivel no rebaja el defecto de ese modelo (`rebajaElDefecto`:
 * hasta el 2026-09-27 un nivel `xhigh` o `max` se aplicaba y SUBÍA la salida),
 * o el cliente ya gobierna su esfuerzo.
 *
 * Va al final por dos razones. Una: el dial surte efecto «desde el siguiente
 * turno de usuario», así que colocarlo al final es lo que declara la referencia.
 * Dos, y es la que importa: añadir al final no modifica NADA de lo anterior, que
 * es exactamente la propiedad por la que el prefijo cacheado sigue casando y los
 * bloques de pensamiento anteriores siguen siendo válidos.
 *
 * SIN VERIFICAR (2026-09-27): la razón «una» es una lectura, no un hecho. La
 * documentación dice que el dial rige «from the next user turn», y detrás del
 * último turno de usuario no hay ninguno: no está documentado que rija la
 * respuesta en curso. `pnpm esfuerzo` (benchmarks/esfuerzo) lo mide comparando
 * este brazo con el esfuerzo en la raíz y con el dial al principio. Hasta
 * entonces, no dar por hecho que la palanca surte efecto.
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
  if (!rebajaElDefecto(json.model, nivel)) return null;
  if (yaGobiernaSuEsfuerzo(json)) return null;
  const msgs = json.messages;
  if (!Array.isArray(msgs)) return null;
  json.messages = [...msgs, mensajeDeEsfuerzo(nivel)];
  return { cuerpo: Buffer.from(JSON.stringify(json), "utf8"), nivel };
}

/**
 * Añade la beta sin pisar las que ya viajaban. La cabecera del cliente se
 * conserva TAL CUAL (espacios y orden incluidos) y la nuestra va al final: lo
 * único que esta palanca declara en las cabeceras es esa añadidura, igual que
 * `conBetaDeElision`. Hasta el 2026-09-27 se re-unía sin espacios.
 */
export function conBetaDeEsfuerzo(betas: string | undefined): string {
  if (betas === undefined || betas.trim() === "") return BETA_ESFUERZO;
  const partes = betas.split(",").map((s) => s.trim());
  if (partes.includes(BETA_ESFUERZO)) return betas;
  return `${betas},${BETA_ESFUERZO}`;
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
      linea: `per-turn effort: OFF (BVSALA_GATEWAY_EFFORT=${NIVELES_QUE_REBAJAN.join("|")} turns it on)`,
      aviso: false,
    };
  }
  if (!esNivel(nivel)) {
    return {
      linea: `per-turn effort: NOT ARMED — "${nivel}" is not a level. Use one of: ${NIVELES_QUE_REBAJAN.join(", ")}`,
      aviso: true,
    };
  }
  // Un nivel que no rebaja el defecto de NINGÚN modelo admitido no haría nada
  // (igual al defecto) o subiría la factura (por encima). Se dice al arrancar
  // en vez de dejar que el operador crea que tiene un techo puesto.
  if (!NIVELES_QUE_REBAJAN.includes(nivel)) {
    return {
      linea:
        `per-turn effort: NOT ARMED — "${nivel}" is not below any supported model's default effort ` +
        `(high; medium on claude-opus-5-5), so it could only leave the bill as it is or raise it. ` +
        `This lever only lowers effort: use ${NIVELES_QUE_REBAJAN.join(" or ")}`,
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
      "Only fable-5-1, mythos-5-1, opus-5-5 and opus-5, and only below the model's default effort " +
      `(high; medium on opus-5-5${nivel === "medium" ? ", so opus-5-5 passes through unchanged at this level" : ""}); ` +
      "every other request passes through unchanged. " +
      "Does NOT reset the prefix cache: the dial is appended at the end and nothing earlier is rewritten. " +
      "Not yet verified against the quality gate",
    aviso: false,
  };
}
