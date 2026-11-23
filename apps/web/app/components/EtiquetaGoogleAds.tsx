"use client";

import { useEffect, useState } from "react";
import Script from "next/script";
import { usePathname } from "next/navigation";

import { ID_GOOGLE_ADS, referenteParaGoogle, ubicacionParaGoogle, urlPermiteGoogleAds } from "@/lib/medicion/google-ads";

type Gtag = (...args: unknown[]) => void;
type ConGtag = Window & { dataLayer?: unknown[]; gtag?: Gtag };

/**
 * Si esta visita (este documento) ya pasó por una URL con token antes de cargar
 * gtag, no se carga en lo que queda de ella. Vive en el módulo: dura lo que el
 * documento, a través de las navegaciones sin recarga.
 */
let vetadaEnEstaVisita = false;

/**
 * Google tag (gtag.js) — seguimiento de conversiones de Google Ads (pedido del
 * dueño, 02-09). Los hosts van declarados en la CSP (next.config.mjs).
 *
 * Antes eran dos <Script> en el layout y gtag recibía la URL entera de cada
 * página: el token de una invitación o un `?code=` acababan en Google. Qué se
 * hace ahora y por qué, en lib/medicion/google-ads.ts: no se carga con una URL
 * con token (ni en el resto de esa visita) y, donde se carga, `page_location` y
 * `page_referrer` van limpios con `set` (vale para todo lo que mande después,
 * la conversión incluida) y en el `config`; en cada navegación se refijan.
 *
 * La inicialización va en un efecto y no en un <Script> en línea: necesita la
 * URL limpia, que se calcula en el navegador. El efecto de este componente,
 * hermano ANTERIOR de la página en el layout, corre antes que los de la página,
 * así que `window.gtag` ya existe cuando ConversionRegistro dispara (la cola
 * `dataLayer` guarda la llamada hasta que llega gtag.js, como antes).
 */
export function EtiquetaGoogleAds() {
  const pathname = usePathname();
  const [cargar, setCargar] = useState(false);

  useEffect(() => {
    const w = window as ConGtag;
    const ubicacion = {
      page_location: ubicacionParaGoogle(location.href),
      page_referrer: referenteParaGoogle(document.referrer, location.origin),
    };
    if (w.gtag) {
      // Ya cargado: lo que mande a partir de ahora, con la URL limpia.
      w.gtag("set", ubicacion);
      return;
    }
    if (!urlPermiteGoogleAds(location.href)) vetadaEnEstaVisita = true;
    if (vetadaEnEstaVisita) return;
    w.dataLayer = w.dataLayer || [];
    // gtag.js exige el objeto `arguments` tal cual, no un array.
    w.gtag = function gtag() {
      w.dataLayer!.push(arguments);
    };
    w.gtag("js", new Date());
    w.gtag("set", ubicacion);
    w.gtag("config", ID_GOOGLE_ADS, ubicacion);
    setCargar(true);
  }, [pathname]);

  return cargar ? <Script src={`https://www.googletagmanager.com/gtag/js?id=${ID_GOOGLE_ADS}`} strategy="afterInteractive" /> : null;
}
