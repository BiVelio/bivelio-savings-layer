import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

// Redirect target after email confirmation / OAuth: exchange the code for a
// session cookie, then send the user to the dashboard.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  // Only accept a same-origin RELATIVE path — never an attacker-controlled absolute
  // URL or a protocol-relative "//host" (open-redirect / phishing guard). Building
  // the redirect with new URL(next, origin) means `origin` can never be overridden.
  const nextParam = searchParams.get("next") ?? "/dashboard";
  const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
  }
  return NextResponse.redirect(`${origin}/login?error=auth_callback`);
}
