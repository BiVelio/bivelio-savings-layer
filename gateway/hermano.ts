/**
 * Palanca C · el MODELO HERMANO — funciones PURAS que sirven una petición que
 * pide `claude-fable-5` con `claude-fable-5-1`.
 *
 * Por qué es una palanca de DINERO y no de tokens (decisión del dueño,
 * 2026-09-09: «haz el C»): las dos generaciones comparten entrada, salida y
 * primas de escritura de caché; lo único que cambia es la LECTURA de caché —
 * 0,001/1K en fable-5 frente a 0,00025/1K en fable-5-1 (src/pricing/catalogo.ts,
 * verificado el 06-09 contra la página oficial de prompt caching). El usage que
 * el proveedor declara es el mismo conteo con dos precios de catálogo, así que
 * el ahorro se MIDE sin contrafactual: cache_read_tokens × (lectura del
 * solicitado − lectura del servido). Sobre el corpus jul-sep (84 % fable-5)
 * valía el 45,1 % ($556,01; docs/POR-QUE-AB-Y-DONDE-ESTA-EL-DINERO.md § 3).
 *
 * Por qué es OPT-IN y no una palanca silenciosa: cambia el modelo que responde
 * (Claude Code enseña `message_start.model`, y ahora dirá fable-5-1). Fable 5.1
 * es el más nuevo de la misma familia, con capacidad ≥ — premisa del dueño, no
 * medida — y por eso lo decide el cliente: bandera local explícita + feature de
 * licencia, exactamente el doble opt-in de S4a y A.
 *
 * Contrato de seguridad (el de gateway/palanca.ts): ante CUALQUIER duda se
 * devuelve null y el cuerpo original viaja intacto — passthrough, jamás error.
 * Ni un byte fuera de `model` se toca.
 *
 * Las tres diferencias de API entre 5 y 5.1 (verificadas el 10-09 contra la
 * referencia de migración, no supuestas):
 *
 *  1. `tool_choice` FORZADO (`any` / `tool`) devuelve 400 en 5.1 — en
 *     /v1/messages, en count_tokens y en lotes. Sin verja, C rompería
 *     peticiones que sin C funcionaban: se dejan pasar intactas.
 *  2. Los bloques de thinking van firmados por el modelo que los produjo, y la
 *     atadura es de UN SOLO SENTIDO: 5.1 SÍ lee los de fable-5 (subir a C no
 *     pierde razonamiento), pero fable-5 NO puede leer los de 5.1. O sea, el
 *     peligro no es encender C, es CAER de C a mitad de hilo — la licencia
 *     caduca, el operador quita la bandera, o una petición cae por la verja de
 *     arriba o por el reintento intacto. En esa petición el proveedor descarta
 *     los bloques de 5.1 (sin cobrarlos, sin error), el modelo replanifica sin
 *     ese razonamiento y el prefijo de caché cambia desde ahí. No rompe nada;
 *     cuesta una escritura fría y algo de calidad en ese turno. Por eso C se
 *     enciende y se apaga entre hilos, no a mitad de uno (runbook).
 *  3. 5.1 no tiene Priority Tier y comparte la cuota de la familia 5.x.
 *
 * Lo que NO cambia, y por eso el ahorro se puede medir sin contrafactual:
 * mismo tokenizador (mismo conteo), mismo precio de entrada y salida, misma
 * superficie de `refusal`, misma ventana de 1M. Solo baja la lectura de caché.
 *
 * El check de «preserved thinking» (editar turnos anteriores invalida los
 * bloques posteriores) NO lo dispara esta palanca: el prefijo atado es
 * `system` + `tools` + `messages`, y `model` queda fuera — igual que los
 * marcadores `cache_control` que mueve la palanca A.
 */

import { claveDeCatalogo, precioDeLista } from "../src/pricing/catalogo.js";
import { primaDeEscritura } from "../src/pricing/primas.js";
import { parsearMensajes } from "./tarifa.js";

/**
 * El mapa de hermanos, por CLAVE de catálogo, y solo se aplica cuando el id
 * crudo ES la clave (ver hermanoDe): una instantánea con fecha
 * (`claude-fable-5-20260401`) es un pin deliberado del cliente y viaja intacta;
 * `claude-fable-5-1` NUNCA cae aquí (claveDeCatalogo la corta a propósito).
 *
 * Solo un par hoy. Añadir otro exige que `esHermanoMasBarato` lo valide contra
 * el catálogo: el test de gateway-hermano.test.ts lo exige y ROMPE si alguna
 * vez los precios dejan de cumplir la premisa.
 */
export const HERMANOS: Readonly<Record<string, string>> = {
  "claude-fable-5": "claude-fable-5-1",
};

/** Lo que la palanca hizo con el modelo de una petición. */
export interface CambioDeModelo {
  /** El id tal cual lo mandó el cliente (el que se «recuerda» y tarifa el baseline). */
  solicitado: string;
  /** La clave de catálogo del hermano que viajó al upstream (la que se pagó). */
  servido: string;
}

/**
 * La verja de precios: el hermano solo vale si cobra LO MISMO en entrada,
 * salida y prima de escritura y MENOS en lectura de caché. Nunca se teclea un
 * precio: todo sale del catálogo, que es la única fuente (la lección del 06-09:
 * un script con fable-5 al precio de Haiku daba un corpus de $279 en vez de
 * $1.232,91).
 */
export function esHermanoMasBarato(solicitado: string, servido: string): boolean {
  const a = precioDeLista(solicitado);
  const b = precioDeLista(servido);
  if (a === undefined || b === undefined) return false;
  if (a.inputPer1k !== b.inputPer1k || a.outputPer1k !== b.outputPer1k) return false;
  if (primaDeEscritura(solicitado) !== primaDeEscritura(servido)) return false;
  const lecturaA = a.cachedInputPer1k ?? a.inputPer1k;
  const lecturaB = b.cachedInputPer1k ?? b.inputPer1k;
  return lecturaB < lecturaA;
}

/**
 * El hermano de un modelo, o null si no hay nada que sustituir:
 *  · sin clave de catálogo (ids con `[1m]`, desconocidos, vacíos) → null;
 *  · el id crudo NO es exactamente la clave → null: una instantánea con fecha
 *    es un pin deliberado, y un prefijo de proveedor (`anthropic/…`) se
 *    perdería en la reescritura (el upstream recibiría un id sin prefijo);
 *  · ya es el hermano (idempotente) o no tiene par → null;
 *  · el par no pasa la verja de precios → null (el catálogo manda).
 */
export function hermanoDe(model: string): CambioDeModelo | null {
  const clave = claveDeCatalogo(model);
  if (clave === undefined || clave !== model) return null;
  const servido = HERMANOS[clave];
  if (servido === undefined || servido === clave) return null;
  if (!esHermanoMasBarato(clave, servido)) return null;
  return { solicitado: model, servido };
}

/**
 * La beta de contexto 1M no está validada en mano con fable-5-1: si el upstream
 * la rechazara, C habría roto una petición que sin C funcionaba, y una vez
 * salido el cuerpo no hay passthrough posible. Hasta probarla, se excluye —
 * conservador a propósito, y se levanta con un test cuando se valide.
 */
const BETA_CONTEXTO_1M = /(^|,)\s*context-1m/i;

/**
 * `tool_choice: {type: "any" | "tool"}` — el modo forzado — devuelve 400 en
 * fable-5-1: «tool_choice: type "tool" and "any" are not supported for this
 * model». `auto` y `none` siguen valiendo. Con C esa petición habría fallado
 * donde sin C funcionaba, así que se deja pasar intacta (ver cabecera § 1).
 */
function fuerzaHerramienta(json: Record<string, unknown>): boolean {
  const tc = json.tool_choice;
  if (tc === null || typeof tc !== "object") return false;
  const tipo = (tc as { type?: unknown }).type;
  return tipo === "any" || tipo === "tool";
}

/** Lo que salió de la reescritura. */
export interface ReescrituraDeModelo {
  /** El cuerpo con `model` sustituido, listo para el upstream (JSON plano). */
  cuerpo: Buffer<ArrayBuffer>;
  cambio: CambioDeModelo;
}

/**
 * Reescribe SOLO `model` en un cuerpo /v1/messages o /v1/messages/count_tokens.
 *
 * Devuelve null — «no tocar, reenviar intacto» — si el cuerpo llega comprimido,
 * no es JSON, no tiene forma de mensajes (parsearMensajes), si el modelo no
 * tiene hermano, si la petición trae la beta de contexto 1M, o si fuerza una
 * herramienta (`tool_choice` any/tool, que 5.1 rechaza).
 *
 * Es pura y determinista: dos cuerpos byte-iguales dan salidas byte-iguales,
 * que es lo que la coalescencia (clave sobre el cuerpo ORIGINAL) necesita.
 */
export function reescribirModelo(
  cuerpo: Buffer,
  codificacion?: string,
  opciones: { betas?: string | undefined } = {},
): ReescrituraDeModelo | null {
  if (opciones.betas !== undefined && BETA_CONTEXTO_1M.test(opciones.betas)) return null;
  const json = parsearMensajes(cuerpo, codificacion);
  if (json === null) return null;
  if (fuerzaHerramienta(json)) return null;
  const cambio = hermanoDe(json.model as string);
  if (cambio === null) return null;
  json.model = cambio.servido;
  return { cuerpo: Buffer.from(JSON.stringify(json), "utf8"), cambio };
}

/**
 * La línea de arranque que dice si C está ARMADA y por qué — hermana de
 * `describirEstadoDeElision`: una palanca que se cree encendida y no lo está
 * es la trampa muda que ya costó un día de A/B. Pura; `aviso` marca los casos
 * en que la intención del operador no se cumple.
 */
export function describirEstadoDeHermano(
  bandera: string | undefined,
  hayClave: boolean,
  canalAbierto: boolean,
): { linea: string; aviso: boolean } {
  const par = Object.entries(HERMANOS)
    .map(([a, b]) => `${a}→${b}`)
    .join(", ");
  if (bandera !== "1") {
    return { linea: "sibling model routing: OFF (BVSALA_GATEWAY_MODELO_HERMANO=1 turns it on)", aviso: false };
  }
  if (!hayClave) {
    return {
      linea:
        "sibling model routing: NOT ARMED — BIVELIO_SERVICE_KEY is missing (without it there is no org whose licence to check). " +
        "Open a new terminal or export the key and relaunch",
      aviso: true,
    };
  }
  if (!canalAbierto) {
    return {
      linea: "sibling model routing: NOT ARMED - BVSALA_GATEWAY_ELISION=0 turns off the levers",
      aviso: true,
    };
  }
  return {
    linea:
      `sibling model routing: ARMED (${par}; ON if your licence includes sibling_model_routing; fail-closed). ` +
      "Changes the model you see in the response; cache reads cost 0.025× instead of 0.1× (list price). " +
      "Turning it on mid-conversation pays one cold prefix write, once. " +
      "If the provider rejects the rewritten request (400), it is re-sent unchanged once",
    aviso: false,
  };
}
