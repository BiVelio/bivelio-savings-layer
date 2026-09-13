import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

import { rutaDeAccesoSinSesion } from "@/lib/auth/destino";

import { safeNextPath } from "../safe-next";

/**
 * One-shot session refresh. Server Components can't persist a refreshed auth
 * cookie (setAll is a no-op there), so when the access token has expired the
 * page bounces here: a Route Handler CAN write cookies, so `getUser()` refreshes
 * the token using the long-lived refresh cookie and persists it, then sends the
 * user back. This replaces the Supabase session-refresh middleware, which can't
 * run on this Next 15.5 setup (Edge rejects realtime/ws; Node middleware 500s).
 */
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  // Esta ruta era la más expuesta de las dos: solo comprobaba startsWith("/"),
  // así que /auth/refresh?next=//evil.com redirigía fuera del origen sin más.
  const dest = safeNextPath(searchParams.get("next"));

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Sin sesión, el destino viaja al acceso en ?next= (antes se perdía aquí).
  return NextResponse.redirect(new URL(user ? dest : rutaDeAccesoSinSesion(dest), origin));
}
