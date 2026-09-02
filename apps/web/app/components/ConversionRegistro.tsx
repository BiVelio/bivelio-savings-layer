"use client";

import { useEffect } from "react";

/**
 * El disparo de la conversión de Google Ads («Registro»), y SOLO aquí: en la
 * página exclusiva de confirmación a la que el callback redirige cuando el
 * verifyOtp de un `signup` ha ido bien. La regla del dueño (02-09): «registro
 * enviado ≠ conversión; cuenta verificada = conversión».
 *
 * Conteo limpio por tres capas:
 *  - `transaction_id` = id del usuario: Google Ads DEDUPLICA conversiones con
 *    el mismo transaction_id, así que una recarga o una revisita de la página
 *    no cuenta dos veces al mismo registrado.
 *  - sessionStorage evita el re-disparo en navegación de vuelta dentro de la
 *    misma pestaña sin gastar red.
 *  - `window.gtag` puede no existir (adblock, CSP de empresa): se comprueba y
 *    la página funciona igual — perder un ping de marketing jamás rompe UX.
 */
export function ConversionRegistro({ idTransaccion }: { idTransaccion: string }) {
  useEffect(() => {
    try {
      const marca = `bv_conv_registro_${idTransaccion}`;
      if (sessionStorage.getItem(marca)) return;
      sessionStorage.setItem(marca, "1");
    } catch {
      // sessionStorage bloqueado: seguimos — transaction_id ya deduplica.
    }
    const w = window as { gtag?: (...args: unknown[]) => void };
    w.gtag?.("event", "conversion", {
      send_to: "AW-18425303387/EoOQCI6C4OwcENui79FE",
      value: 1.0,
      currency: "USD",
      transaction_id: idTransaccion,
    });
  }, [idTransaccion]);
  return null;
}
