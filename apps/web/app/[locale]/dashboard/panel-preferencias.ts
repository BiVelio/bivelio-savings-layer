/**
 * Preferencias de DISPOSICIÓN del panel: qué tarjetas se ven y en qué orden.
 *
 * Puras y deterministas. Viven en el navegador de quien mira (localStorage) —
 * no en la base — porque son una comodidad de lectura, no un dato del cliente:
 * el mismo panel en otro equipo vuelve al orden por defecto y no se pierde nada.
 * Si algún día se quieren compartir entre miembros, la función `aplicar` es la
 * misma; solo cambia dónde se guarda el JSON.
 *
 * Lo que NUNCA hace: ocultar los avisos de cobro ni el titular. Esos no entran
 * en la lista de tarjetas, así que ni siquiera se pueden nombrar aquí.
 */
export interface PanelPrefs {
  version: 1;
  /** Ids en el orden elegido. Los ids que no estén se colocan detrás, en orden por defecto. */
  orden: string[];
  /** Ids ocultos. Un id desconocido se ignora sin ruido. */
  ocultas: string[];
}

export const PREFS_VACIAS: PanelPrefs = { version: 1, orden: [], ocultas: [] };
export const CLAVE_ALMACEN = "bvsala.panel.v1";

/**
 * Orden efectivo: primero los ids preferidos que existan, luego los nuevos en
 * su orden por defecto. Así una tarjeta nueva del producto aparece sola, sin
 * que el cliente tenga que «restablecer» para verla.
 */
export function ordenar(porDefecto: readonly string[], prefs: PanelPrefs): string[] {
  const conocidos = new Set(porDefecto);
  const elegidos = prefs.orden.filter((id, i, arr) => conocidos.has(id) && arr.indexOf(id) === i);
  const restantes = porDefecto.filter((id) => !elegidos.includes(id));
  return [...elegidos, ...restantes];
}

export function visibles(porDefecto: readonly string[], prefs: PanelPrefs): string[] {
  const ocultas = new Set(prefs.ocultas);
  return ordenar(porDefecto, prefs).filter((id) => !ocultas.has(id));
}

export function ocultasEfectivas(porDefecto: readonly string[], prefs: PanelPrefs): string[] {
  const ocultas = new Set(prefs.ocultas);
  return ordenar(porDefecto, prefs).filter((id) => ocultas.has(id));
}

export function alternar(porDefecto: readonly string[], prefs: PanelPrefs, id: string): PanelPrefs {
  if (!porDefecto.includes(id)) return prefs;
  const ocultas = prefs.ocultas.includes(id) ? prefs.ocultas.filter((x) => x !== id) : [...prefs.ocultas, id];
  return { ...prefs, ocultas };
}

/**
 * Mueve `id` un puesto arriba (−1) o abajo (+1) ENTRE LAS VISIBLES, saltando las
 * ocultas sin moverlas de sitio: así, al mostrarlas de nuevo, vuelven donde
 * estaban y no al final por sorpresa. En los extremos no hace nada.
 */
export function mover(porDefecto: readonly string[], prefs: PanelPrefs, id: string, delta: -1 | 1): PanelPrefs {
  const todo = ordenar(porDefecto, prefs);
  const ocultas = new Set(prefs.ocultas);
  const i = todo.indexOf(id);
  if (i < 0 || ocultas.has(id)) return prefs;
  let j = i + delta;
  while (j >= 0 && j < todo.length && ocultas.has(todo[j]!)) j += delta;
  if (j < 0 || j >= todo.length) return prefs;
  const nuevo = [...todo];
  [nuevo[i], nuevo[j]] = [nuevo[j]!, nuevo[i]!];
  return { ...prefs, orden: nuevo };
}

export function esPorDefecto(prefs: PanelPrefs): boolean {
  return prefs.orden.length === 0 && prefs.ocultas.length === 0;
}

/** Valida lo leído del almacén: cualquier forma rara vuelve a las prefs vacías. */
export function normalizar(x: unknown): PanelPrefs {
  if (!x || typeof x !== "object") return PREFS_VACIAS;
  const o = x as Record<string, unknown>;
  const lista = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((s): s is string => typeof s === "string").slice(0, 50) : [];
  return { version: 1, orden: lista(o["orden"]), ocultas: lista(o["ocultas"]) };
}

/** Lectura tolerante: sin almacén, sin permiso o con JSON roto → por defecto. */
export function leer(almacen: Pick<Storage, "getItem"> | undefined): PanelPrefs {
  try {
    const crudo = almacen?.getItem(CLAVE_ALMACEN);
    return crudo ? normalizar(JSON.parse(crudo)) : PREFS_VACIAS;
  } catch {
    return PREFS_VACIAS;
  }
}

export function guardar(almacen: Pick<Storage, "setItem" | "removeItem"> | undefined, prefs: PanelPrefs): void {
  try {
    if (esPorDefecto(prefs)) almacen?.removeItem(CLAVE_ALMACEN);
    else almacen?.setItem(CLAVE_ALMACEN, JSON.stringify(prefs));
  } catch {
    /* un navegador que no deja guardar no rompe el panel */
  }
}
