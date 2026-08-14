/**
 * LOS MUTANTES. Selectores rotos a propósito, cuyo único trabajo es hacer que
 * la verja FALLE.
 *
 * ─── POR QUÉ ESTÁN EN EL CÓDIGO Y NO SOLO EN UNA SESIÓN ─────────────────────
 *
 * Un test que hoy pasa no demuestra que vaya a suspender el día que haga falta.
 * `mandarloTodo` conserva todo por construcción, así que la verja verde de hoy
 * es compatible con un arnés que no comprueba absolutamente nada — y esa es
 * exactamente la clase de test que se escribe sin querer.
 *
 * La comprobación de que la verja tiene dientes es romperla y ver que suspende.
 * Hecho una vez a mano, eso caduca en el primer refactor. Escrito aquí, cada
 * `pnpm test` lo repite: si alguien afloja `puntuarCaso`, no falla un test de
 * los buenos, falla el que exige que los malos suspendan, y ese es mucho más
 * difícil de racionalizar.
 *
 * Estos NO son `Selector`: reciben el caso entero, con la chuleta. Un mutante
 * tiene que saber qué unidad duele para tirarla — un mutante que tira al azar
 * fallaría a veces y ese test no serviría de nada.
 */

import type { CasoDelArnes } from "./cargar.js";
import type { SelectorConChuleta } from "./selectores.js";

const todas = (caso: CasoDelArnes): string[] => caso.unidades.map((u) => u.id);

/**
 * Tira UNA cita obligatoria, la primera. Es el fallo que el cliente ve: la
 * respuesta se queda sin la evidencia que la sostiene.
 *
 * Determinista: siempre la misma, para que el test no dependa de una tirada.
 */
export const tiraUnaCita: SelectorConChuleta = (caso) => {
  const victima = [...caso.citas].sort()[0];
  return todas(caso).filter((id) => id !== victima);
};

/**
 * Tira una unidad `necesaria`. Sin ella la respuesta correcta es imposible por
 * construcción, da igual lo bien que redacte el modelo.
 */
export const tiraUnaNecesaria: SelectorConChuleta = (caso) => {
  const victima = [...caso.necesarias].sort()[0];
  return todas(caso).filter((id) => id !== victima);
};

/**
 * ⚠️ EL PELIGROSO. Deja un solo lado de la contradicción en los casos cuya
 * respuesta correcta es ABSTENERSE, y no toca nada más.
 *
 * No pierde información visible: el caso queda perfectamente respondible, con
 * una unidad coherente y citable. El modelo contestará con seguridad, bien
 * redactado y con la cita en su sitio, algo que el corpus dice que es
 * incorrecto — y no habrá quedado ni rastro de que había otra cláusula que
 * decía lo contrario.
 *
 * Un fallo por quedarse sin contexto lo ve el cliente. Este no lo ve nadie.
 */
export const respondeUnaAbstencion: SelectorConChuleta = (caso) => {
  if (!caso.abstencion) return todas(caso);
  const contradictorias = caso.unidades.filter((u) => u.papel === "contradictoria");
  if (contradictorias.length < 2) return todas(caso);
  const sacrificada = [...contradictorias].sort((a, b) => a.id.localeCompare(b.id))[0]!.id;
  return todas(caso).filter((id) => id !== sacrificada);
};

/**
 * Devuelve ids que no existen. Un selector puede equivocarse de índice o
 * devolver los del caso anterior, y el arnés no puede contarlo como una
 * selección vacía y correcta.
 */
export const inventaIds: SelectorConChuleta = (caso) => [...todas(caso), `${caso.id}-fantasma`];

/**
 * No tira nada de lo obligatorio y tira TODO lo demás. Es el oráculo, y está
 * aquí como control del control: si el arnés suspendiera a este, el problema no
 * sería del selector.
 */
export const oraculo: SelectorConChuleta = (caso) => [
  ...new Set([...caso.necesarias, ...caso.citas]),
];

export const MUTANTES: ReadonlyArray<{
  nombre: string;
  selector: SelectorConChuleta;
  /** Qué invariante tiene que romper. El test exige que rompa ESE y no otro. */
  rompe: "citas" | "necesarias" | "abstencion" | "ids";
}> = [
  { nombre: "tira-una-cita", selector: tiraUnaCita, rompe: "citas" },
  { nombre: "tira-una-necesaria", selector: tiraUnaNecesaria, rompe: "necesarias" },
  { nombre: "responde-una-abstencion", selector: respondeUnaAbstencion, rompe: "abstencion" },
  { nombre: "inventa-ids", selector: inventaIds, rompe: "ids" },
];
