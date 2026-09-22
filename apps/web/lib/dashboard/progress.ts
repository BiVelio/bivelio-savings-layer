import type { StepState } from "@/app/[locale]/dashboard/data";

/**
 * «PUESTA EN MARCHA · N DE 5» — el bloque de arriba del raíl, decidido aquí y
 * en ningún otro sitio.
 *
 * ESTE MÓDULO ES PURO: recibe los cinco pasos que `activationSteps` ya derivó
 * (cuenta, clave de servicio, licencia, primer informe, medidor vivo) y una
 * cosa más que esa lista NO sabe decir: si la lectura de uso FALLÓ. Los dos
 * últimos pasos salen de esa lectura, y una lectura que no contestó no es un
 * cero — es exactamente el defecto que el resto del panel persigue («lo no
 * medido se pinta "—", nunca 0»). Un bloque que dice «2 de 5» a un cliente
 * desplegado hace un mes porque PostgREST tardó seis segundos le está
 * diciendo que no ha empezado.
 *
 * Así que la regla entera es una:
 *
 *     si `usageFailed`, `readable` es falso y NO HAY BLOQUE.
 *
 * El raíl pinta entonces una frase en `role="status"` en vez de una barra.
 */
export type Progress = {
  /** `false` = la lectura de uso no contestó. No hay «N de 5» que enseñar. */
  readable: boolean;
  /** Los pasos, siempre en el orden del recorrido. Vacío si no se pudo leer. */
  steps: StepState[];
  /** Cuántos están hechos. */
  done: number;
  /** El denominador no encoge porque una fuente calle. */
  total: number;
  /** La etiqueta (ya traducida por `activationSteps`) del primer paso que
   *  falta, para «Falta: …». `null` cuando están todos hechos. */
  firstPending: string | null;
};

export function setupProgress(steps: StepState[], usageFailed: boolean): Progress {
  if (usageFailed) {
    return { readable: false, steps: [], done: 0, total: steps.length, firstPending: null };
  }
  return {
    readable: true,
    steps,
    done: steps.filter((s) => s.status === "done").length,
    total: steps.length,
    firstPending: steps.find((s) => s.status !== "done")?.label ?? null,
  };
}

/** El ancho de la barra, en tanto por ciento. Sin `readable` no hay barra. */
export function progressPercent(progress: Progress): number {
  if (!progress.readable || progress.total === 0) return 0;
  return Math.round((progress.done / progress.total) * 100);
}
