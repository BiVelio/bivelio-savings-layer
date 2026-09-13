import { NextRequest } from "next/server";

import { safeNextPath } from "@/app/auth/safe-next";

/**
 * ADÓNDE VOLVER cuando la guardia del panel encuentra la sesión caducada o
 * ausente.
 *
 * La guardia (`app/[locale]/dashboard/layout.tsx`) es un Server Component y no
 * ve la URL que pidió el navegador, así que hasta hoy mandaba SIEMPRE a
 * `/auth/refresh?next=/dashboard`, y la ruta de refresco, sin sesión, mandaba a
 * `/login` a secas. Dos puntos donde se perdía la ruta pedida y su consulta.
 * El síntoma que lo destapó: el enlace de compra con el código pre-aplicado
 * (`/es/dashboard/account?codigo=…`, #274) aterrizaba tras el acceso en el
 * panel, sin el código, en cuanto el probador no tenía la sesión abierta —
 * justo el caso del correo de bienvenida leído desde otro navegador.
 *
 * La ruta pedida viaja en una cabecera de PETICIÓN que pone el middleware:
 * next-intl clona `request.headers` y las reenvía a la página
 * (`NextResponse.next({ request: { headers } })`), así que la guardia la lee
 * con `headers()`. Todo pasa por `safeNextPath`, el mismo guardián de
 * /auth/callback y /auth/refresh: una cabecera es tan manipulable como un
 * `?next=`, y una redirección abierta no se cura cambiando de sitio.
 */
export const CABECERA_DESTINO = "x-bvsala-destino";

/** La petición que ve next-intl, con la ruta y la consulta pedidas en la cabecera. */
export function conDestino(request: NextRequest): NextRequest {
  const headers = new Headers(request.headers);
  headers.set(CABECERA_DESTINO, request.nextUrl.pathname + request.nextUrl.search);
  return new NextRequest(request.url, { headers, method: request.method });
}

/** Lo que pidió el navegador, saneado; sin cabecera (o inválida), el panel. */
export function destinoDeLaPeticion(cabeceras: { get(nombre: string): string | null }): string {
  return safeNextPath(cabeceras.get(CABECERA_DESTINO));
}

/**
 * Sin sesión: al acceso, llevando el destino para volver a él después de
 * entrar. AuthForm lo lee de `?next=` al enviar y hace `location.assign`.
 * El destino por defecto no se arrastra: `/login` a secas, como siempre.
 */
export function rutaDeAccesoSinSesion(destino: string): string {
  const dest = safeNextPath(destino);
  return dest === "/dashboard" ? "/login" : `/login?next=${encodeURIComponent(dest)}`;
}
