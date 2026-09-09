/**
 * Anillo 2 · enrolamiento del A/B **independiente del shell**.
 *
 * El encadenado al espía vivía SOLO en una función de `~/.zshrc`
 * (scripts/anillo2-ab.zsh, #224). Funciona — pero solo si la sesión nace de una
 * zsh interactiva que haya leído ese fichero. Cualquier otro camino de arranque
 * (la app, el IDE, `command bvsala claude`, una ventana que se saltó el rc) se
 * MIDE igual pero NO entra en el corpus, y el A/B se queda sin datos sin que
 * nada falle a la vista.
 *
 * Medido el 2026-09-06: las dos sesiones vivas —una en `bivelio-privacy-gateway`
 * y otra en el propio repo— iban sin encadenar (petición de prueba: 0 bytes
 * nuevos en la captura), y el informe del 5-09 dejó 1453 de 2282 turnos y
 * $498,2491 de $624,1437 fuera del A/B. Ocho días de brazo control, cero de
 * palanca: no porque la palanca no funcione, sino porque su tráfico nunca llegó
 * al corpus.
 *
 * Aquí el enrolamiento es un FICHERO local (`~/.bvsala/anillo2.json`), así que
 * lo hereda cualquier camino de arranque. Solo la casa lo tiene: sin ese fichero
 * esto no cambia absolutamente nada, de modo que el tráfico de un cliente jamás
 * se encadena a nada.
 */

export type Enrolamiento = {
  /** Falso = enrolado pero en pausa; el fichero se queda para no perder el puerto. */
  activo: boolean;
  /** Puerto del espía en local (scripts/espia-anthropic.mjs). */
  espia: number;
};

export type Brazo = "control" | "palanca";

/**
 * El brazo del día, EXACTAMENTE igual que `bvsala-ab-brazo` del .zshrc: día del
 * mes par = palanca. Los dos caminos tienen que decir lo mismo o el A/B mezcla
 * brazos dentro de un mismo día.
 */
export function brazoDelDia(diaUtcIso: string): Brazo {
  const dd = Number.parseInt(diaUtcIso.slice(8, 10), 10);
  return Number.isFinite(dd) && dd % 2 === 0 ? "palanca" : "control";
}

/**
 * Lee y valida el enrolamiento. Cualquier cosa rara (no existe, no es JSON, le
 * falta el puerto) devuelve `null` = no enrolado: el fichero es una comodidad de
 * la casa, nunca un motivo para que el terminal de nadie deje de arrancar.
 */
export function leerEnrolamiento(leer: () => string): Enrolamiento | null {
  let crudo: unknown;
  try {
    crudo = JSON.parse(leer());
  } catch {
    return null;
  }
  if (typeof crudo !== "object" || crudo === null) return null;
  const obj = crudo as Record<string, unknown>;
  const espia = obj.espia;
  if (typeof espia !== "number" || !Number.isInteger(espia) || espia < 1 || espia > 65535) return null;
  return { activo: obj.activo !== false, espia };
}

export type PlanAnillo2 = {
  /** Upstream a imponer, o `undefined` para no tocar el que ya había. */
  upstream?: string;
  /** Valor a imponer en BVSALA_GATEWAY_ELISION, o `undefined` para no tocarlo. */
  elision?: "0" | "1";
  brazo?: Brazo;
  /** Una línea para el arranque. Vacía = no decir nada (no hay enrolamiento). */
  linea: string;
  /** La línea va por stderr y en tono de aviso. */
  aviso: boolean;
};

/**
 * Decide qué hace el enrolamiento en ESTE arranque.
 *
 * Reglas, por orden de mando:
 *  1. Sin enrolamiento activo → no toca nada y no dice nada.
 *  2. Lo explícito del entorno manda: un `BVSALA_GATEWAY_UPSTREAM` o un
 *     `BVSALA_GATEWAY_ELISION` puestos a mano (los que pone el .zshrc) se
 *     respetan tal cual. Los dos caminos conviven sin pelearse.
 *  3. Si el espía NO está escuchando, NO se encadena: encadenar a un puerto
 *     muerto convierte cada petición en un 502 y deja al dueño sin terminal por
 *     un fichero olvidado. Se avisa y se sigue de largo — y en ese caso tampoco
 *     se fuerza el brazo, porque un brazo que no se captura es un día perdido
 *     contado como bueno.
 */
export function planDeAnillo2(args: {
  enrolamiento: Enrolamiento | null;
  espiaVivo: boolean;
  upstreamEnv: string | undefined;
  elisionEnv: string | undefined;
  hoyUtcIso: string;
}): PlanAnillo2 {
  const { enrolamiento, espiaVivo, upstreamEnv, elisionEnv, hoyUtcIso } = args;
  if (!enrolamiento) return { linea: "", aviso: false };
  if (!enrolamiento.activo) return { linea: "anillo 2: enrolamiento en pausa (activo:false)", aviso: false };

  if (!espiaVivo) {
    return {
      linea:
        `anillo 2: enrolado pero el espía NO escucha en :${enrolamiento.espia} — NO encadeno ` +
        "(el tráfico de hoy no entra en el corpus). Arráncalo con `pnpm anillo2:espia`.",
      aviso: true,
    };
  }

  const brazo = brazoDelDia(hoyUtcIso);
  const upstreamEspia = `http://127.0.0.1:${enrolamiento.espia}`;
  const upstreamYaPuesto = upstreamEnv !== undefined && upstreamEnv !== "";
  const elisionYaPuesta = elisionEnv !== undefined && elisionEnv !== "";

  const partes: string[] = [];
  partes.push(`anillo 2: ${hoyUtcIso} UTC → brazo ${brazo.toUpperCase()}`);
  partes.push(upstreamYaPuesto ? `upstream respetado del entorno (${upstreamEnv})` : `encadenado a :${enrolamiento.espia}`);
  if (elisionYaPuesta) partes.push(`elisión respetada del entorno (=${elisionEnv})`);
  partes.push("diales de elisión APAGADOS (2026-09-09): el brazo ya no los arma");

  return {
    ...(upstreamYaPuesto ? {} : { upstream: upstreamEspia }),
    // 2026-09-09 · el brazo YA NO toca esta bandera. Hasta hoy devolvía "0" en
    // los días de control, y ese "0" no apagaba solo los diales: apagaba el
    // CANAL de entitlements entero, y con él la rebaja de TTL — la única
    // palanca con dinero medido. O sea que el brazo "control" del A/B de B
    // estaba apagando A media semana. Los diales tienen ahora bandera propia
    // (BVSALA_GATEWAY_DIALES_ELISION) y nacen apagados, así que el A/B de B se
    // rearma explícitamente cuando se rediseñe por SESIÓN y no por día.
    brazo,
    linea: partes.join(", "),
    aviso: false,
  };
}
