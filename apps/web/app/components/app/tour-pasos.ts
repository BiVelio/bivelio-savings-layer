/**
 * LOS PASOS DEL TOUR Y SU MARCA DE «YA VISTO» — la parte pura de `TourGuide`,
 * aparte para poder leerla (y probarla) sin navegador.
 *
 * Cada paso lleva una lista de DESTINOS en orden de preferencia; se usa el
 * primero que exista Y se vea. Si ninguno, el paso no sale: nunca se apunta a
 * un elemento que esta cuenta, este rol o este ancho no tienen. Una lista
 * vacía es un paso centrado, sin destino (la bienvenida).
 *
 * Los destinos son atributos `data-tour` aditivos, puestos en elementos que
 * existen en todos los estados de la cuenta (mapa del panel, §4). Ningún test
 * los lee y `clases-que-existen` los ignora.
 */
export type PasoDelTour = {
  id: "welcome" | "nav" | "setup" | "verdict" | "range" | "customize" | "explorer" | "proof" | "team" | "account" | "finish";
  destinos: readonly string[];
  /**
   * Dónde se ancla el diálogo cuando no conviene pegarlo al destino entero:
   * junto a una tarjeta más alta que la ventana no cabe en ningún lado. Se
   * resalta el destino y el diálogo sale junto al ancla. Si no se ve, se omite.
   */
  ancla?: string;
};

export const PASOS_DEL_TOUR: readonly PasoDelTour[] = [
  { id: "welcome", destinos: [] },
  { id: "nav", destinos: ['[data-tour="nav"]'] },
  // La tarjeta de puesta en marcha es de owner/admin y de escritorio; para el
  // resto, la entrada «Primeros pasos», que está siempre.
  { id: "setup", destinos: ['[data-tour="setup"]', '[data-tour="nav-install"]'] },
  { id: "verdict", destinos: ['[data-tour="verdict"]'] },
  { id: "range", destinos: ['[data-tour="range"]'] },
  { id: "customize", destinos: ['[data-tour="customize"]'] },
  { id: "explorer", destinos: ['[data-tour="explorer"]'], ancla: '[data-tour="explorer"] .ux-seg' },
  { id: "proof", destinos: ['[data-tour="nav-proof"]'] },
  // Solo quien puede gestionar miembros tiene la entrada. Su texto cubre
  // también la cuenta, así que con este paso el de Cuenta a solas no sale.
  { id: "team", destinos: ['[data-tour="nav-team"]'] },
  { id: "account", destinos: ['[data-tour="nav-account"]'] },
  { id: "finish", destinos: ['[data-tour="tour-launch"]'] },
];

/** El primer selector cuyo elemento existe y ocupa sitio en pantalla. */
export function primerVisible(selectores: readonly string[], raiz: Pick<Document, "querySelector"> = document): string | null {
  for (const selector of selectores) {
    const el = raiz.querySelector(selector);
    if (el && el.getClientRects().length > 0) return selector;
  }
  return null;
}

/** La librería pinta con `innerHTML`: ningún texto entra sin escapar. */
export function escaparHtml(texto: string): string {
  return texto.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] ?? c);
}

/**
 * La marca de «ya visto», en el navegador de quien mira: misma familia de
 * claves que `bvsala.panel.v1` y la misma regla que `panel-preferencias.ts` —
 * un navegador sin almacén, o que no deja escribir, no rompe nada. Sin poder
 * leerla se responde «visto»: mejor no ofrecer el tour que ofrecerlo en cada
 * carga a quien navega en privado.
 */
export const CLAVE_DEL_TOUR = "bvsala.tour.v1";

export function tourVisto(almacen: Pick<Storage, "getItem"> | undefined): boolean {
  try {
    return almacen ? almacen.getItem(CLAVE_DEL_TOUR) !== null : true;
  } catch {
    return true;
  }
}

export function marcarVisto(almacen: Pick<Storage, "setItem"> | undefined): void {
  try {
    almacen?.setItem(CLAVE_DEL_TOUR, "1");
  } catch {
    /* un navegador que no deja guardar no rompe el panel */
  }
}
