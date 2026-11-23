import { useSyncExternalStore } from "react";

import {
  CONSENTIMIENTO_RETIRADO,
  borradosDeCookie,
  cookieDeConsentimiento,
  cookiesDeGoogleAds,
  leerEleccion,
  type Eleccion,
} from "./consentimiento";

/**
 * El consentimiento en el navegador: leerlo, guardarlo y avisar a quien
 * escucha (el aviso, la etiqueta de Google Ads, la conversión del alta). Solo
 * lo importan componentes de cliente.
 */

const EVENTO_CAMBIO = "bv:consentimiento";
/** Lo dispara «Ajustes de cookies» (pie y /privacy) para volver a abrir el aviso. */
export const EVENTO_ABRIR_AVISO = "bv:abrir-aviso-cookies";

/**
 * `pendiente`: en el servidor y durante la hidratación, cuando aún no se ha
 * leído la cookie (ni aviso ni gtag hasta saberlo). `sin-eleccion`: no hay
 * cookie válida, así que se pregunta.
 */
export type EstadoDelConsentimiento = Eleccion | "sin-eleccion" | "pendiente";

function leer(): Eleccion | "sin-eleccion" {
  try {
    return leerEleccion(document.cookie, new Date()) ?? "sin-eleccion";
  } catch {
    return "sin-eleccion";
  }
}

function suscribir(avisar: () => void): () => void {
  window.addEventListener(EVENTO_CAMBIO, avisar);
  return () => window.removeEventListener(EVENTO_CAMBIO, avisar);
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
 * Guarda la elección y avisa. Rechazar (también al retirar un «Aceptar»
 * anterior) manda a gtag, si estaba cargado, el consentimiento denegado y
 * borra las cookies `_gcl_*` de este dominio y sus claves en el almacenamiento
 * local; quien lo llama recarga la página si gtag estaba cargado, para que
 * deje de correr ya.
 */
export function guardarEleccion(eleccion: Eleccion): void {
  document.cookie = cookieDeConsentimiento(eleccion, new Date(), location.protocol === "https:");
  if (eleccion === "denied") retirarGoogleAds();
  window.dispatchEvent(new Event(EVENTO_CAMBIO));
}

function retirarGoogleAds(): void {
  try {
    (window as ConGtag).gtag?.("consent", "update", CONSENTIMIENTO_RETIRADO);
  } catch {
    /* sin gtag no hay nada que avisar */
  }
  for (const nombre of cookiesDeGoogleAds(document.cookie)) {
    for (const borrado of borradosDeCookie(nombre, location.hostname)) document.cookie = borrado;
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
