import createMiddleware from "next-intl/middleware";
import type { NextRequest } from "next/server";

import { routing } from "./i18n/routing";
import { conDestino } from "./lib/auth/destino";

// next-intl locale negotiation + bare→/es redirects. This middleware imports NO
// Supabase code, so it stays Edge-safe (the reason the app previously shipped
// without middleware was @supabase/ssr pulling realtime-js/ws into the Edge
// bundle — not a problem here).
const intl = createMiddleware(routing);

// La guardia del panel no ve la URL pedida: se la damos en una cabecera de
// petición (lib/auth/destino.ts), que next-intl reenvía a la página. Así, sin
// sesión, el usuario vuelve tras el acceso a la URL exacta —con su consulta— y
// no a /dashboard a secas.
export default function middleware(request: NextRequest) {
  return intl(conDestino(request));
}

export const config = {
  // Corre en TODA ruta salvo las que no son páginas: los route handlers sin
  // idioma (api/, auth/, licenses/, y benchmarks/data/, que sirve los informes
  // `.json` del banco), lo interno de Next y Vercel, las carpetas
  // y ficheros de `public/` y los ficheros de metadatos de la raíz.
  //
  // POR QUÉ NO «cualquier ruta con un punto», que era la regla anterior (la que
  // recomienda next-intl): una URL con punto que NO es un fichero —`/foo.png`,
  // `/favicon.ico`, `/migrate-to-0.5`— se saltaba el middleware, nadie le
  // negociaba idioma y `[locale]` la recibía como si «foo.png» fuera un idioma.
  // El layout llama a `notFound()`, pero la página se pinta a la vez y
  // `Intl.NumberFormat("foo.png")` revienta: 500 en vez de 404. Lo mismo con
  // los prefijos sin barra (`/authors` caía en `auth`, `/apiary` en `api`).
  //
  // Ahora se enumera lo que de verdad es un fichero. Todo lo demás pasa por
  // next-intl, que lo lleva a `/<idioma>/…` y allí lo atrapa la 404 propia.
  // Si se añade algo a la raíz de `public/`, hay que añadirlo aquí:
  // middleware-matcher.test.ts lo comprueba leyendo la carpeta.
  matcher: [
    "/((?!(?:api|auth|licenses|benchmarks/data|_next|_vercel|brand|correo|data|fonts|measure|vendor|videos)/|(?:robots\\.txt|sitemap\\.xml|logo-bivelio\\.png|nvidia-inception-program\\.svg)$).*)",
  ],
};
