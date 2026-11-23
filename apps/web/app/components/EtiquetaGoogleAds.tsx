"use client";

import { useEffect, useState } from "react";
import Script from "next/script";
import { usePathname } from "next/navigation";

import { CONSENTIMIENTO_CONCEDIDO, CONSENTIMIENTO_POR_DEFECTO } from "@/lib/consentimiento/consentimiento";
import { useConsentimiento } from "@/lib/consentimiento/navegador";
import {
  ID_GOOGLE_ADS,
  referenteParaGoogle,
  ubicacionParaGoogle,
  urlPermiteGoogleAds,
  urlSinParametrosSobrantes,
  urlVetaLaVisita,
} from "@/lib/medicion/google-ads";

type Gtag = (...args: unknown[]) => void;
type ConGtag = Window & { dataLayer?: unknown[]; gtag?: Gtag };

/**
 * EL VETO DE LA VISITA: si esta pestaña pasó por una URL con token o código, o
 * por un 404, gtag no se carga en lo que queda de ella. Se guarda en
 * sessionStorage (dura lo que la pestaña, sin datos: solo «1») y, por si está
 * bloqueado, también en el módulo (dura lo que el documento).
 */
const CLAVE_DEL_VETO = "bv_gads_veto";
let vetadaEnEsteDocumento = false;

function vetarVisita(): void {
  vetadaEnEsteDocumento = true;
  try {
    sessionStorage.setItem(CLAVE_DEL_VETO, "1");
  } catch {
    /* sin sessionStorage, vale el del documento */
  }
}

function visitaVetada(): boolean {
  if (vetadaEnEsteDocumento) return true;
  try {
    return sessionStorage.getItem(CLAVE_DEL_VETO) === "1";
  } catch {
    return false;
  }
}

/**
 * Google tag (gtag.js) — seguimiento de conversiones de Google Ads (pedido del
 * dueño, 02-09). Los hosts van declarados en la CSP (next.config.mjs). Dónde
 * corre, qué se le da y por qué: lib/medicion/google-ads.ts.
 *
 *  - SOLO CON CONSENTIMIENTO (modo básico, decisión del dueño del 23-11): hasta
 *    que quien visita acepta en el aviso (AvisoCookies), y si rechaza, gtag no
 *    se carga: ni peticiones a Google ni cookies `_gcl_*`. Al aceptar se carga
 *    con el consentimiento por defecto DENEGADO y enseguida concedido para la
 *    publicidad, las dos órdenes antes que cualquier otra (lib/consentimiento).
 *    El veto por token corre igual sin consentimiento: una visita que pasó por
 *    una invitación sigue vetada aunque acepte después.
 *  - Solo con una URL permitida (páginas públicas sin formularios y la
 *    confirmación del alta) y sin el veto de la visita.
 *  - Antes de cargarlo, la barra se queda solo con los parámetros que la web
 *    usa (`history.replaceState`), porque el contenedor manda la URL entera en
 *    cada navegación sin recarga.
 *  - Con gtag ya cargado, un enlace del sitio hacia una página donde no puede
 *    correr (el alta, el acceso, el panel…) se abre con una carga nueva, sin
 *    gtag; si se llega a ella de otro modo, se recarga.
 *  - La página limpia va en `set`, nunca en `config` (el de `config` manda
 *    sobre `set` y se quedaba pegado a la primera página), y se refija en
 *    cada navegación.
 *  - Nada de esto puede tirar la página: todo va en try/catch.
 *
 * La inicialización va en un efecto y no en un <Script> en línea: necesita la
 * URL limpia, que se calcula en el navegador. El efecto de este componente,
 * hermano ANTERIOR de la página en el layout, corre antes que los de la página,
 * así que `window.gtag` ya existe cuando ConversionRegistro dispara (la cola
 * `dataLayer` guarda la llamada hasta que llega gtag.js, como antes).
 */
export function EtiquetaGoogleAds() {
  const pathname = usePathname();
  const consentimiento = useConsentimiento();
  const [cargar, setCargar] = useState(false);

  useEffect(() => {
    try {
      const w = window as ConGtag;
      if (urlVetaLaVisita(location.href)) vetarVisita();
      if (w.gtag) {
        if (!urlPermiteGoogleAds(location.href)) {
          // Se llegó sin recarga a una página donde gtag no puede correr: se recarga sin él.
          location.reload();
          return;
        }
        const ubicacion = {
          page_location: ubicacionParaGoogle(location.href),
          page_referrer: referenteParaGoogle(document.referrer, location.origin),
        };
        w.gtag("set", ubicacion);
        return;
      }
      if (consentimiento !== "granted" || visitaVetada() || !urlPermiteGoogleAds(location.href)) return;
      const limpia = urlSinParametrosSobrantes(location.href);
      if (limpia) history.replaceState(history.state, "", limpia);
      const ubicacion = {
        page_location: ubicacionParaGoogle(location.href),
        page_referrer: referenteParaGoogle(document.referrer, location.origin),
      };
      w.dataLayer = w.dataLayer || [];
      // gtag.js exige el objeto `arguments` tal cual, no un array.
      w.gtag = function gtag() {
        w.dataLayer!.push(arguments);
      };
      w.gtag("consent", "default", CONSENTIMIENTO_POR_DEFECTO);
      w.gtag("consent", "update", CONSENTIMIENTO_CONCEDIDO);
      w.gtag("js", new Date());
      // La página va SOLO en `set`: un `page_location` dado en `config` manda
      // sobre `set` y se quedaría pegado a la primera página del documento.
      w.gtag("set", ubicacion);
      w.gtag("config", ID_GOOGLE_ADS);
      setCargar(true);
    } catch {
      /* medir nunca rompe la página */
    }
  }, [pathname, consentimiento]);

  // Con gtag cargado, los enlaces del sitio hacia páginas donde no puede correr
  // se abren con una carga nueva: así gtag no llega a verlas (ni sus formularios).
  useEffect(() => {
    if (!cargar) return;
    const alClic = (e: MouseEvent) => {
      try {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
        const enlace = e.target instanceof Element ? e.target.closest("a[href]") : null;
        if (!(enlace instanceof HTMLAnchorElement) || (enlace.target && enlace.target !== "_self") || enlace.hasAttribute("download")) return;
        const destino = new URL(enlace.href, location.href);
        if (destino.origin !== location.origin || urlPermiteGoogleAds(destino.href)) return;
        if (destino.pathname === location.pathname && destino.search === location.search) return; // un ancla de esta misma página
        e.preventDefault();
        e.stopPropagation();
        location.assign(destino.href);
      } catch {
        /* ante la duda, el enlace sigue su curso */
      }
    };
    document.addEventListener("click", alClic, true);
    return () => document.removeEventListener("click", alClic, true);
  }, [cargar]);

  return cargar ? <Script src={`https://www.googletagmanager.com/gtag/js?id=${ID_GOOGLE_ADS}`} strategy="afterInteractive" /> : null;
}
