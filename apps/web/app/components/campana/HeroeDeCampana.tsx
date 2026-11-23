import type { ReactNode } from "react";

import { MosaicoDeLlamadas } from "./MosaicoDeLlamadas";

/**
 * LA FIRMA DE CAMPAÑA EN EL HÉROE DE UNA PÁGINA PÚBLICA (resultados, precios,
 * cómo funciona, paper, guía de migración): el cielo cian arriba a la derecha
 * —detrás de todo, también de la rejilla de affectUI si la página la lleva— y
 * el mosaico de llamadas a sangre en el borde inferior. Lo de dentro (migas,
 * antetítulo, titular, entradilla, acciones) no cambia: son los `children`.
 *
 * El titular con marcador lo pone cada página: `<PageHeader marca>` o un
 * `<span className="serif-accent heroe-acento"><Marcado … /></span>`.
 *
 * Cada página tiene SU semilla, para que no haya dos franjas iguales, y viven
 * aquí y no en la página: `/pricing` no puede llevar un literal numérico
 * (lib/legal/precios-publicados.test.ts), ni siquiera el de una semilla.
 *
 * Nada de esto es candidato a LCP ni oculta el titular: el cielo es el
 * degradado de un elemento vacío y el mosaico un SVG en línea.
 */
const SEMILLAS = { benchmarks: 83, pricing: 47, howItWorks: 31, paper: 59, migrate: 71, guides: 97 } as const;
const FILAS = 3;

export type PaginaConHeroe = keyof typeof SEMILLAS;

export function HeroeDeCampana({
  pagina,
  como: Caja = "div",
  className,
  children,
}: {
  pagina: PaginaConHeroe;
  como?: "div" | "section";
  className?: string;
  children: ReactNode;
}) {
  return (
    <Caja className={className ? `${className} heroe-campana con-cielo` : "heroe-campana con-cielo"}>
      <div className="cielo" aria-hidden="true" />
      {children}
      <MosaicoDeLlamadas semilla={SEMILLAS[pagina]} filas={FILAS} className="mosaico--sangre heroe-mosaico" />
    </Caja>
  );
}

/** Exportada para la prueba: una semilla distinta por página. */
export const SEMILLAS_DE_HEROE: Readonly<Record<PaginaConHeroe, number>> = SEMILLAS;
