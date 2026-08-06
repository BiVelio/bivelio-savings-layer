import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

import { safeNextPath } from "../safe-next";

// Redirect target after email confirmation / OAuth: exchange the code for a
// session cookie, then send the user to the dashboard.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // `next` llega del query string, así que resolverlo sin sanear es una
  // redirección abierta (CWE-601). La comprobación anterior era de cadena
  // (startsWith "/" y no "//") y NO bastaba: el parser de URL borra tabuladores
  // y saltos de línea ANTES de resolver, de modo que "/\t/evil.com" pasaba el
  // filtro y acababa en "//evil.com". Ver safeNextPath.
  const next = safeNextPath(searchParams.get("next"));

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
  }
  return NextResponse.redirect(`${origin}/login?error=auth_callback`);
}
