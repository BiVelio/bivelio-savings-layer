import { ViajeDeLosDatos } from "./ViajeDeLosDatos";

/**
 * SAVINGS LAYER, EN ACCIÓN — la ilustración de la sección #data de la portada.
 *
 * Es un envoltorio a propósito: la portada pinta `<CapaEnAccion t={…} />` y no
 * sabe qué hay dentro. Hoy es el diagrama estático `ViajeDeLosDatos`; la
 * ilustración animada lo sustituye cambiando SOLO la línea del `return` (y su
 * import), sin tocar la página ni sus textos.
 */
export type TextosDeLaCapa = Parameters<typeof ViajeDeLosDatos>[0]["t"];

export function CapaEnAccion({ t }: { t: TextosDeLaCapa }) {
  return <ViajeDeLosDatos t={t} />;
}
