"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";

import { ArrowRightIcon, CloseIcon } from "./icons";

/**
 * La franja negra sobre el nav — misma pieza que abre bivelio.com. Aquí lleva
 * de vuelta a la web corporativa, para que savings.bivelio.com se lea como una
 * superficie más del mismo sitio y no como otro producto.
 *
 * Arranca VISIBLE y sin persistencia, exactamente como el <AnnouncementBar> del
 * origen. Una versión anterior decidía en un useEffect leyendo localStorage: el
 * servidor devolvía null, el documento pintaba con el nav pegado arriba y al
 * hidratar se insertaban 38px que empujaban la página entera. Recordar el
 * cierre cuesta un salto de layout en cada carga, y no lo vale.
 */
export function AnnouncementBar() {
  const t = useTranslations("nav");
  const locale = useLocale();
  const [visible, setVisible] = useState(true);

  if (!visible) return null;

  return (
    <div className="announce">
      <a href={`https://bivelio.com/${locale}`} target="_blank" rel="noopener noreferrer">
        {t("announce")} <ArrowRightIcon />
      </a>
      <button type="button" className="announce-close" aria-label={t("announceClose")} onClick={() => setVisible(false)}>
        <CloseIcon />
      </button>
    </div>
  );
}
