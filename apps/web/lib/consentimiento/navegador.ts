import { useSyncExternalStore } from "react";

import {
  CONSENTIMIENTO_RETIRADO,
  COOKIE_CONSENTIMIENTO,
  borradosDeCookie,
  cookieDeConsentimiento,
  cookiesDeGoogleAds,
  eleccionVigente,
  leerEleccion,
  valorDeConsentimiento,
  type Eleccion,
} from "./consentimiento";

/**
 * El consentimiento en el navegador: leerlo, guardarlo y avisar a quien
 * escucha (el aviso, la etiqueta de Google Ads, la conversión del alta) en
 * ESTA pestaña y en las demás. Solo lo importan componentes de cliente.
 *
 * Dónde se guarda: en la cookie `bv_consent`. Si el navegador bloquea las
 * cookies del sitio, en sessionStorage (dura la pestaña) y, si también está
 * bloqueado, en la memoria del documento: el aviso se puede cerrar igual, y sin
 * «Aceptar» gtag sigue sin cargarse.
 *
 * Cuándo se vuelve a mirar: al cambiar en esta pestaña, al llegar el aviso de
 * otra (BroadcastChannel), al volver una página de la caché atrás/adelante
 * (`pageshow` con `persisted`), al volver a la pestaña (`visibilitychange`) y
 * al recibir el foco. Así retirar el consentimiento en una pestaña para gtag
 * en las demás (EtiquetaGoogleAds recarga la página que lo tenía).
 */

const EVENTO_CAMBIO = "bv:consentimiento";
const CANAL = "bv-consentimiento";
/** Lo dispara «Ajustes de cookies» (pie y /privacy) para volver a abrir el aviso. */
export const EVENTO_ABRIR_AVISO = "bv:abrir-aviso-cookies";

/**
 * `pendiente`: en el servidor y durante la hidratación, cuando aún no se ha
 * leído la elección (ni aviso propio ni gtag hasta saberlo). `sin-eleccion`: no
 * hay elección válida, así que se pregunta.
 */
export type EstadoDelConsentimiento = Eleccion | "sin-eleccion" | "pendiente";

let enMemoria: Eleccion | null = null;

function leerSesion(): string | null {
  try {
    return sessionStorage.getItem(COOKIE_CONSENTIMIENTO);
  } catch {
    return null;
  }
}

function leerCookies(): string {
  try {
    return document.cookie;
  } catch {
    return "";
  }
}

/** La elección vigente, leída ahora mismo (síncrona: vale dentro de un clic o un popstate). */
export function eleccionActual(): Eleccion | null {
  return eleccionVigente({ cookies: leerCookies(), sesion: leerSesion(), memoria: enMemoria }, new Date());
}

function leer(): Eleccion | "sin-eleccion" {
  return eleccionActual() ?? "sin-eleccion";
}

let canal: BroadcastChannel | null | undefined;
function elCanal(): BroadcastChannel | null {
  if (canal === undefined) {
    try {
      canal = typeof BroadcastChannel === "function" ? new BroadcastChannel(CANAL) : null;
    } catch {
      canal = null;
    }
  }
  return canal;
}

function suscribir(avisar: () => void): () => void {
  const alVolver = (e: PageTransitionEvent) => {
    if (e.persisted) avisar();
  };
  const alVerse = () => {
    if (document.visibilityState === "visible") avisar();
  };
  const c = elCanal();
  window.addEventListener(EVENTO_CAMBIO, avisar);
  window.addEventListener("pageshow", alVolver);
  window.addEventListener("focus", avisar);
  document.addEventListener("visibilitychange", alVerse);
  c?.addEventListener("message", avisar);
  return () => {
    window.removeEventListener(EVENTO_CAMBIO, avisar);
    window.removeEventListener("pageshow", alVolver);
    window.removeEventListener("focus", avisar);
    document.removeEventListener("visibilitychange", alVerse);
    c?.removeEventListener("message", avisar);
  };
}

export function useConsentimiento(): EstadoDelConsentimiento {
  return useSyncExternalStore(suscribir, leer, () => "pendiente");
}

type ConGtag = Window & { gtag?: (...args: unknown[]) => void };

/** ¿Está gtag cargado en este documento? */
export function gtagCargado(): boolean {
  return typeof (window as ConGtag).gtag === "function";
}

/**
 * Guarda la elección (cookie; si no se queda, sesión; si tampoco, memoria) y
 * avisa a esta pestaña y a las demás. Rechazar (también al retirar un
 * «Aceptar» anterior) manda a gtag, si estaba cargado, el consentimiento
 * denegado y borra las cookies `_gcl_*` de este dominio y sus claves en el
 * almacenamiento local; EtiquetaGoogleAds recarga la página que lo tenía.
 */
export function guardarEleccion(eleccion: Eleccion): void {
  const ahora = new Date();
  try {
    document.cookie = cookieDeConsentimiento(eleccion, ahora, location.protocol === "https:");
  } catch {
    /* cookies bloqueadas: se prueba la sesión */
  }
  enMemoria = null;
  if (leerEleccion(leerCookies(), ahora) !== eleccion) {
    let enSesion = false;
    try {
      sessionStorage.setItem(COOKIE_CONSENTIMIENTO, valorDeConsentimiento(eleccion, ahora));
      enSesion = sessionStorage.getItem(COOKIE_CONSENTIMIENTO) !== null;
    } catch {
      enSesion = false;
    }
    if (!enSesion) enMemoria = eleccion;
  } else {
    try {
      sessionStorage.removeItem(COOKIE_CONSENTIMIENTO);
    } catch {
      /* nada que quitar */
    }
  }
  if (eleccion === "denied") retirarGoogleAds();
  window.dispatchEvent(new Event(EVENTO_CAMBIO));
  try {
    elCanal()?.postMessage(eleccion);
  } catch {
    /* sin canal, las demás pestañas lo ven al volver a ellas */
  }
}

function retirarGoogleAds(): void {
  try {
    (window as ConGtag).gtag?.("consent", "update", CONSENTIMIENTO_RETIRADO);
  } catch {
    /* sin gtag no hay nada que avisar */
  }
  for (const nombre of cookiesDeGoogleAds(leerCookies())) {
    for (const borrado of borradosDeCookie(nombre, location.hostname)) {
      try {
        document.cookie = borrado;
      } catch {
        /* cookies bloqueadas: no hay nada que borrar */
      }
    }
  }
  for (const almacen of [() => localStorage, () => sessionStorage]) {
    try {
      const a = almacen();
      for (const clave of Object.keys(a)) if (/^_gcl_/.test(clave)) a.removeItem(clave);
    } catch {
      /* almacenamiento bloqueado: no hay nada que borrar */
    }
  }
}

/** Vuelve a abrir el aviso (el botón «Ajustes de cookies»). */
export function abrirAvisoDeCookies(): void {
  window.dispatchEvent(new Event(EVENTO_ABRIR_AVISO));
}
