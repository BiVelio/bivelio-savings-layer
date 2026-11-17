import { getTranslations } from "next-intl/server";

/** El `id` del destino del salto. Lo llevan el ancla que el layout público
 *  pinta tras la cabecera y el `<main>` del panel; nunca los dos a la vez. */
export const ID_DEL_CONTENIDO = "contenido";

/**
 * «Saltar al contenido» — el primer elemento enfocable de la página (WCAG
 * 2.4.1). Sin él, quien navega con teclado cruza el anuncio, la cabecera y el
 * selector de idioma en cada página antes de llegar a lo que vino a leer; en el
 * panel, además, el raíl entero.
 *
 * Es un enlace a un ancla, sin JavaScript: el navegador mueve el foco al
 * destino porque este lleva `tabIndex={-1}`. Vive fuera de pantalla hasta que
 * recibe el foco (`.skip-link` en globals.css).
 */
export async function SkipLink() {
  const t = await getTranslations("nav");
  return (
    <a className="skip-link" href={`#${ID_DEL_CONTENIDO}`}>
      {t("skipToContent")}
    </a>
  );
}

/** El destino del salto en las páginas públicas: un ancla vacía justo después
 *  de la cabecera, antes del contenido de la página. */
export function SkipTarget() {
  return <span id={ID_DEL_CONTENIDO} className="skip-target" tabIndex={-1} />;
}
