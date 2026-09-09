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
 */

import { claveDeCatalogo, precioDeLista } from "../src/pricing/catalogo.js";
import { primaDeEscritura } from "../src/pricing/primas.js";
import { parsearMensajes } from "./tarifa.js";

/**
 * El mapa de hermanos, por CLAVE de catálogo (no por id crudo): así una
 * instantánea con fecha (`claude-fable-5-20260401`) hereda el par por el mismo
 * emparejador que hereda su precio, y `claude-fable-5-1` NUNCA cae aquí
 * (claveDeCatalogo la corta a propósito — ver su cabecera).
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
 *  · ya es el hermano (idempotente) o no tiene par → null;
 *  · el par no pasa la verja de precios → null (el catálogo manda).
 *
 * El prefijo de proveedor (`anthropic/claude-fable-5`) lo desnuda el catálogo,
 * así que SÍ mapea: el upstream recibe la clave de catálogo del hermano.
 */
export function hermanoDe(model: string): CambioDeModelo | null {
  const clave = claveDeCatalogo(model);
  if (clave === undefined) return null;
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
 * tiene hermano, o si la petición trae la beta de contexto 1M.
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
    return { linea: "modelo hermano (C): APAGADO (BVSALA_GATEWAY_MODELO_HERMANO=1 lo arma)", aviso: false };
  }
  if (!hayClave) {
    return {
      linea:
        "modelo hermano (C): NO SE ARMA — falta BIVELIO_SERVICE_KEY (sin clave no hay org que consultar). " +
        "Abre un terminal nuevo o exporta la clave y relanza",
      aviso: true,
    };
  }
  if (!canalAbierto) {
    return {
      linea: "modelo hermano (C): NO SE ARMA — el canal S4a está CERRADO (BVSALA_GATEWAY_ELISION=0 apaga las tres palancas)",
      aviso: true,
    };
  }
  return {
    linea:
      `modelo hermano (C): ARMADO (${par}; activo si la licencia trae sibling_model_routing; fail-closed). ` +
      "Cambia el model que ves en la respuesta; lectura de caché a 0,025× en vez de 0,1× (catálogo). " +
      "Encendido a mitad de un hilo paga una escritura fría del prefijo una vez",
    aviso: false,
  };
}
