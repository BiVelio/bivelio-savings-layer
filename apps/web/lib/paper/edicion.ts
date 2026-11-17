/**
 * LA EDICIÓN VIGENTE DEL ARTÍCULO — fuente única.
 *
 * Todo enlace del sitio al artículo de investigación (la tarjeta de /benchmarks,
 * el enlace del método en el banco público y los botones de /paper) sale de
 * aquí. El TEXTO del artículo vive en `docs/PAPER.md` y llega a la web por
 * `app/[locale]/paper/contenido.ts`; `edicion.test.ts` exige que la versión y
 * el DOI de esta constante cuadren con los de ese contenido y que el PDF exista
 * en `public/`.
 *
 * Publicar una edición nueva: dejar el PDF en `public/papers/`, cambiar esta
 * constante y regenerar el contenido (`pnpm paper:contenido`). Los PDF de
 * ediciones anteriores se conservan en `public/papers/` (puede haber enlaces
 * externos), pero el sitio ya no los enlaza.
 */
const DOI = "10.5281/zenodo.24278852";
/** El «concept DOI» de Zenodo: resuelve siempre a la última versión y lista todas. */
const DOI_CONCEPTO = "10.5281/zenodo.24278851";

export const EDICION_PAPER = {
  /** Como la cita el artículo: «Preprint v2.3-r1». */
  version: "v2.3-r1",
  /** Fecha de la edición (ISO, UTC). */
  fecha: "2026-11-15",
  paginas: 15,
  /** Ruta servida desde `public/`. */
  pdf: "/papers/bv-sala-savings-layer-v2.3-r1.pdf",
  doi: DOI,
  urlDoi: `https://doi.org/${DOI}`,
  urlZenodo: "https://zenodo.org/records/24278852",
  doiConcepto: DOI_CONCEPTO,
  /** Todas las versiones. */
  urlTodasLasVersiones: `https://doi.org/${DOI_CONCEPTO}`,
  /** Identificador SPDX y cómo se escribe para quien lee. */
  licencia: "CC-BY-4.0",
  licenciaEtiqueta: "CC BY 4.0",
} as const;
