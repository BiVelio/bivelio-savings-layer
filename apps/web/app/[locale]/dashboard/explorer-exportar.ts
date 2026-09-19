import type { Ranura } from "./explorer-estadisticas";

/**
 * Exportación de la serie VISIBLE del explorador a CSV. Pura: recibe lo que el
 * gráfico pinta y devuelve texto. Lo que se lleva el cliente es exactamente lo
 * que ve, con la procedencia escrita en la cabecera, para que un número copiado
 * a una hoja de cálculo siga sabiendo de dónde salió.
 *
 * Reglas:
 * · Un día sin fila sale con valor vacío y `measured=no`, NUNCA con un 0: el
 *   cero del gráfico es una marca visual, no un dato (doctrina «no disponible ≠ 0»).
 * · Punto decimal y coma separadora, sin locale: es un fichero para máquinas.
 * · Las celdas que puedan llevar coma, comillas o salto de línea van entrecomilladas.
 */
export interface MetaExportacion {
  /** Nombre de la métrica tal y como se pidió (clave estable, no la traducción). */
  metrica: string;
  /** Periodo en días. */
  periodoDias: number;
  /** `dia` o `acumulado`. */
  modo: "dia" | "acumulado";
  /** Tabla de origen, p. ej. `bvsala.usage_daily`. */
  origen: string;
  /** Fecha ISO de la exportación (inyectable para tests). */
  generadoEn: string;
}

const celda = (v: string | number): string => {
  const s = typeof v === "number" ? String(v) : v;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function aCsv(ranuras: readonly Ranura[], serie: readonly number[], meta: MetaExportacion): string {
  const lineas: string[] = [
    `# metric=${meta.metrica}`,
    `# period_days=${meta.periodoDias}`,
    `# mode=${meta.modo}`,
    `# source=${meta.origen}`,
    `# generated_at=${meta.generadoEn}`,
    "day,value,measured",
  ];
  ranuras.forEach((r, i) => {
    const valor = r.conDatos ? celda(serie[i] ?? 0) : "";
    lineas.push(`${celda(r.day)},${valor},${r.conDatos ? "yes" : "no"}`);
  });
  return lineas.join("\n") + "\n";
}

/** Nombre de fichero determinista: `bvsala-<metrica>-<primer día>_<último día>.csv`. */
export function nombreDeFichero(ranuras: readonly Ranura[], metrica: string): string {
  const primero = ranuras[0]?.day ?? "sin-datos";
  const ultimo = ranuras[ranuras.length - 1]?.day ?? primero;
  return `bvsala-${metrica}-${primero}_${ultimo}.csv`;
}
