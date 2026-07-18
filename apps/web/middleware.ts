import { type NextRequest } from "next/server";

import { updateSession } from "@/lib/supabase/middleware";

// Keeps the Supabase auth session fresh on navigations (Next 15 convention).
// No-op until Supabase env is configured, so the site runs before auth is wired.
export async function middleware(request: NextRequest) {
  return await updateSession(request);
}

export const config = {
  matcher: [
    // Run only on app routes — skip Next internals AND the static landing assets
    // (landing.html, app.js, vendor bundle, fonts, data, images).
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:html|js|mjs|css|json|map|woff2|svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
