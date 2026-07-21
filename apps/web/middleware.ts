import createMiddleware from "next-intl/middleware";

import { routing } from "./i18n/routing";

// next-intl locale negotiation + bare→/es redirects. This middleware imports NO
// Supabase code, so it stays Edge-safe (the reason the app previously shipped
// without middleware was @supabase/ssr pulling realtime-js/ws into the Edge
// bundle — not a problem here).
export default createMiddleware(routing);

export const config = {
  // Run on page routes only. Exclude API + auth + the public revocation endpoint
  // (non-localized route handlers), Next/Vercel internals, and any path with a
  // file extension (public assets).
  matcher: ["/((?!api|auth|licenses|_next|_vercel|.*\\..*).*)"],
};
