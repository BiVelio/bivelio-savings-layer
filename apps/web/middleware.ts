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
  // Run on page routes only. Exclude API + auth + the public revocation endpoint
  // (non-localized route handlers), Next/Vercel internals, and any path with a
  // file extension (public assets).
  matcher: ["/((?!api|auth|licenses|_next|_vercel|.*\\..*).*)"],
};
