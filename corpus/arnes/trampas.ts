/**
 * EL VOCABULARIO DE TRAMPAS, unificado.
 *
 * Los tres corpus se escribieron en paralelo y bautizaron las mismas trampas
 * con nombres distintos: `apostrof` y `apostrofo`, `diacritico` y `diacriticos`,
 * `identificadores-parecidos` y `identificador-casi-igual`. Sin unificarlos, el
 * desglose por trampa parte cada clase en dos filas y las dos salen con la
 * mitad de casos — que es la manera más silenciosa de aparentar cobertura donde
 * no la hay: cuatro casos de apóstrofo repartidos en dos filas de dos parecen
 * dos trampas cubiertas al mínimo y son una sola, mal cubierta.
 *
 * ─── LO QUE NO SE UNIFICA, Y POR QUÉ ────────────────────────────────────────
 *
 * Solo se colapsan variantes ORTOGRÁFICAS y sinónimos exactos. `entidad-casi-igual`
 * (Balears contra Canàries: dos destinos parecidos con plazos distintos) NO se
 * mete con `identificadores-parecidos` (C-2026-118 contra C-2026-1118), porque
 * son dos fallos distintos y fundirlos inventaría una equivalencia que nadie ha
 * comprobado. Un mapa de sinónimos que se pasa de listo hace exactamente el
 * mismo daño que la fragmentación, en la otra dirección.
 */

/** Nombre del fichero de datos → nombre canónico del informe. */
export const ALIAS: Readonly<Record<string, string>> = {
  // Variantes ortográficas puras.
  apostrofo: "apostrof",
  diacriticos: "diacritico",
  "identificador-casi-igual": "identificadores-parecidos",
  // Una versión desactualizada es la derogación escrita con otras palabras: una
  // redacción posterior deja sin efecto a la anterior.
  "version-desactualizada": "derogacion",
  // Las dos son el motivo por el que hay que abstenerse, no una trampa aparte.
  // Los casos que las llevan declaran además `abstencion`, así que colapsarlas
  // no infla el recuento: se cuentan por caso, con un conjunto.
  "contradiccion-sin-desempate": "abstencion",
  "evidencia-insuficiente": "abstencion",
};

/**
 * El vocabulario CERRADO. Son las 16 de `corpus/tipos.ts` más
 * `entidad-casi-igual`, que soporte introdujo y no se puede fundir con ninguna.
 * Que esté cerrado es lo que hace que un nombre nuevo salte en un test en vez
 * de aparecer como una fila de un caso al final de la tabla.
 */
export const TRAMPAS_CANONICAS: readonly string[] = [
  "negacion",
  "excepcion",
  "condicion",
  "importes-parecidos",
  "fechas-parecidas",
  "con-iva-sin-iva",
  "referencia-cruzada",
  "verbo-modal",
  "identificadores-parecidos",
  "derogacion",
  "unidades",
  "abstencion",
  "diacritico",
  "ela-geminada",
  "apostrof",
  "numero-gramatical",
  "entidad-casi-igual",
];

/** El nombre canónico de una trampa. Devuelve el mismo si no es un alias. */
export function canonizar(trampa: string): string {
  return ALIAS[trampa] ?? trampa;
}

/** Las trampas de un caso, canónicas y sin repetir. */
export function trampasCanonicas(trampas: readonly string[]): string[] {
  return [...new Set(trampas.map(canonizar))].sort();
}

/** Nombres que no están en el vocabulario cerrado. Vacío = nadie inventó uno. */
export function trampasDesconocidas(trampas: readonly string[]): string[] {
  return [...new Set(trampas.map(canonizar))].filter((t) => !TRAMPAS_CANONICAS.includes(t)).sort();
}
