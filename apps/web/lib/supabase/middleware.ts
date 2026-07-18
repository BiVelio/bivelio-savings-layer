import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { SUPABASE_ANON_KEY, SUPABASE_URL, authConfigured } from "./env";

/**
 * Refreshes the Supabase auth session on every app-route request and keeps the
 * cookies in sync. A no-op when Supabase env is not configured, so the site
 * still runs before auth is wired.
 */
export async function updateSession(request: NextRequest) {
  const response = NextResponse.next({ request });
  if (!authConfigured) return response;

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  // IMPORTANT: touch getUser() so the session is validated and refreshed.
  await supabase.auth.getUser();
  return response;
}
