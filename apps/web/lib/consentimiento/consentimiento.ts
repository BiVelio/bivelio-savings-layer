/**
 * EL CONSENTIMIENTO DE COOKIES DE PUBLICIDAD — la parte pura (sin DOM).
 *
 * Decisión del dueño (23-11): la etiqueta de Google Ads solo con consentimiento,
 * en modo BÁSICO. Hasta que quien visita elige, y si rechaza, gtag no se carga:
 * ni una petición a Google, ni una cookie `_gcl_*`. Si acepta, se carga con el
 * consentimiento por defecto denegado y, acto seguido, concedido para la
 * publicidad (Consent Mode v2). Vercel Web Analytics queda fuera: no usa cookies.
 *
 * La elección se guarda en una cookie propia y estrictamente necesaria,
 * `bv_consent`, con SOLO la elección y su fecha (`granted.2026-11-23`), durante
 * seis meses; pasado ese plazo, o si el valor no se entiende, se vuelve a
 * preguntar. Lo fija consentimiento.test.ts.
 */

export const COOKIE_CONSENTIMIENTO = "bv_consent";

/** Seis meses: lo que dura la elección antes de volver a preguntar. */
export const DIAS_DE_VALIDEZ = 182;

export type Eleccion = "granted" | "denied";

/** Lo que guarda la cookie: la elección y la fecha (UTC), nada más. */
export function valorDeConsentimiento(eleccion: Eleccion, ahora: Date): string {
  return `${eleccion}.${ahora.toISOString().slice(0, 10)}`;
}

/**
 * La elección vigente en una cabecera `Cookie` (o `document.cookie`), o `null`
 * si no hay, no se entiende, tiene fecha futura o pasó de DIAS_DE_VALIDEZ.
 */
export function leerEleccion(cookies: string, ahora: Date): Eleccion | null {
  for (const trozo of cookies.split(";")) {
    const igual = trozo.indexOf("=");
    if (igual < 0 || trozo.slice(0, igual).trim() !== COOKIE_CONSENTIMIENTO) continue;
    const m = /^(granted|denied)\.(\d{4}-\d{2}-\d{2})$/.exec(trozo.slice(igual + 1).trim());
    if (!m) return null;
    const fecha = Date.parse(`${m[2]}T00:00:00Z`);
    if (!Number.isFinite(fecha)) return null;
    const dias = (ahora.getTime() - fecha) / 86_400_000;
    if (dias < -1 || dias > DIAS_DE_VALIDEZ) return null;
    return m[1] as Eleccion;
  }
  return null;
}

/** El `document.cookie =` que guarda la elección: propia, de todo el sitio, seis meses. */
export function cookieDeConsentimiento(eleccion: Eleccion, ahora: Date, segura: boolean): string {
  return [
    `${COOKIE_CONSENTIMIENTO}=${valorDeConsentimiento(eleccion, ahora)}`,
    "Path=/",
    `Max-Age=${DIAS_DE_VALIDEZ * 86_400}`,
    "SameSite=Lax",
    ...(segura ? ["Secure"] : []),
  ].join("; ");
}

/** Las cookies de Google Ads (`_gcl_au`, `_gcl_aw`, `_gcl_ls`…) presentes en `cookies`. */
export function cookiesDeGoogleAds(cookies: string): string[] {
  return cookies
    .split(";")
    .map((t) => t.slice(0, t.indexOf("=") < 0 ? undefined : t.indexOf("=")).trim())
    .filter((nombre) => /^_gcl_/.test(nombre));
}

/**
 * Los `document.cookie =` que borran `nombre` en este host y en sus dominios
 * padre: gtag guarda `_gcl_au` en el dominio registrable (`.bivelio.com`), no
 * en `savings.bivelio.com`. Las de los dominios de Google no se pueden borrar
 * desde aquí.
 */
export function borradosDeCookie(nombre: string, host: string): string[] {
  const partes = host.split(".");
  const dominios: (string | null)[] = [null];
  if (partes.length >= 2 && !/^\d+$/.test(partes[partes.length - 1]!)) {
    for (let i = 0; i <= partes.length - 2; i++) dominios.push(partes.slice(i).join("."));
  }
  return dominios.map((d) => `${nombre}=; Path=/; Max-Age=0${d ? `; Domain=${d}` : ""}`);
}

/** Consent Mode: el estado por defecto, antes de cualquier otra orden a gtag. */
export const CONSENTIMIENTO_POR_DEFECTO = {
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
  analytics_storage: "denied",
} as const;

/**
 * Lo que concede «Aceptar»: la publicidad. `analytics_storage` sigue denegado:
 * la web no usa Google Analytics.
 */
export const CONSENTIMIENTO_CONCEDIDO = {
  ad_storage: "granted",
  ad_user_data: "granted",
  ad_personalization: "granted",
} as const;

/** Lo que manda «Rechazar» si gtag ya estaba cargado (retirar el consentimiento). */
export const CONSENTIMIENTO_RETIRADO = {
  ad_storage: "denied",
  ad_user_data: "denied",
  ad_personalization: "denied",
} as const;
