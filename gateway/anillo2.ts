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
 * El brazo del día: día del mes UTC par = palanca. **SUPERADO por
 * `brazoDeSesion` el 2026-09-10**; se conserva porque el corpus de agosto y
 * septiembre se recogió bajo este protocolo y auditarlo exige poder reproducir
 * lo que se esperaba entonces.
 *
 * Por qué se retira: la unidad de asignación era el DÍA pero la unidad de
 * arranque es la SESIÓN, y una sesión que cruza la medianoche arrastra el brazo
 * del día anterior. No es teórico: el 09-09 era día de control y el informe
 * contó 1.431 turnos de control contra 5.350 de palanca. Con la unidad rota, el
 * veredicto que estaba previsto para el 13 no podía salir limpio.
 */
export function brazoDelDia(diaUtcIso: string): Brazo {
  const dd = Number.parseInt(diaUtcIso.slice(8, 10), 10);
  return Number.isFinite(dd) && dd % 2 === 0 ? "palanca" : "control";
}

/**
 * EL BRAZO DE UNA SESIÓN — la asignación vigente desde el 2026-09-10.
 *
 * Una sesión es atómica: nace, vive y muere entera dentro de un brazo, así que
 * la medianoche deja de existir como problema. Y el número de unidades sube de
 * «un día» a «una sesión», que es lo que el veredicto necesita para tener
 * potencia sin esperar semanas.
 *
 * Es un hash determinista (FNV-1a de 32 bits, con la mezcla final de murmur3)
 * del identificador de sesión: la misma sesión cae siempre en el mismo brazo,
 * en el gateway y en el auditor, sin estado compartido, sin reloj y sin sorteo
 * que reproducir. Medido sobre cinco formas de identificador — UUID real,
 * secuencial, solo dígitos, prefijo común y sufijo común — reparte entre 48,6 %
 * y 50,0 %.
 */
/**
 * La mezcla final de murmur3 (fmix32). NO es adorno: sin ella, el bit 0 de
 * FNV-1a es degenerado. Su último paso multiplica por un primo impar, así que
 * el bit 0 del resultado es solo el XOR de los bits bajos de los caracteres —
 * con identificadores secuenciales o con sufijo común reparte 0 % / 100 % en
 * vez de mitad y mitad. Lo cazó el test de reparto antes de salir de aquí.
 */
function mezclar(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

export function brazoDeSesion(sessionId: string): Brazo {
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (mezclar(h) & 1) === 0 ? "palanca" : "control";
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
  /** De dónde salió `upstreamEnv`: `--upstream` o la variable (por defecto). Solo cambia la línea. */
  upstreamOrigen?: "flag" | "env";
  elisionEnv: string | undefined;
  hoyUtcIso: string;
}): PlanAnillo2 {
  const { enrolamiento, espiaVivo, upstreamEnv, elisionEnv, hoyUtcIso } = args;
  if (!enrolamiento) return { linea: "", aviso: false };
  if (!enrolamiento.activo) return { linea: "A/B plan: enrolment paused (activo:false)", aviso: false };

  if (!espiaVivo) {
    return {
      linea:
        `A/B plan: enrolled but the capture proxy is NOT listening on :${enrolamiento.espia} — NOT chaining ` +
        "(today's traffic will not enter the corpus). Start it with `pnpm anillo2:espia`.",
      aviso: true,
    };
  }

  // El brazo del día ya no asigna nada (ver brazoDeSesion); se sigue calculando
  // solo para que la línea de arranque diga bajo qué protocolo nació la sesión.
  const brazo = brazoDelDia(hoyUtcIso);
  const upstreamEspia = `http://127.0.0.1:${enrolamiento.espia}`;
  const upstreamYaPuesto = upstreamEnv !== undefined && upstreamEnv !== "";
  const elisionYaPuesta = elisionEnv !== undefined && elisionEnv !== "";

  const partes: string[] = [];
  partes.push(`A/B plan: ${hoyUtcIso} UTC → arm ${brazo.toUpperCase()}`);
  const deDonde = args.upstreamOrigen === "flag" ? "--upstream" : "the environment";
  partes.push(upstreamYaPuesto ? `upstream kept from ${deDonde} (${upstreamEnv})` : `chained to :${enrolamiento.espia}`);
  if (elisionYaPuesta) partes.push(`elision flag kept from the environment (=${elisionEnv})`);
  partes.push("context elision dials OFF (2026-09-09): the arm no longer turns them on");
  partes.push("assignment PER SESSION since 2026-09-10 (brazoDeSesion), not by day parity");

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
