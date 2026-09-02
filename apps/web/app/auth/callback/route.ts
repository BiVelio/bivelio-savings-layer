import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";

import { localeDelNext, safeNextPath } from "../safe-next";
import { routing } from "@/i18n/routing";

// Tipos de OTP de email que acepta supabase.auth.verifyOtp. Se valida el `type`
// del query contra este conjunto antes de usarlo (llega de fuera).
type EmailOtpType = "signup" | "invite" | "magiclink" | "recovery" | "email_change" | "email";
const VALID_OTP: ReadonlySet<string> = new Set<EmailOtpType>([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

// Redirect target after email confirmation / OAuth: exchange the code for a
// session cookie, then send the user to the dashboard.
//
// Dos mecanismos, y NO son intercambiables:
//  - Enlaces de correo (recuperación, confirmación, magic link) → `token_hash` +
//    `type` → verifyOtp. Es el formato que emite la plantilla de correo del
//    proyecto de Supabase compartido (rsxebsvguppssbociwiu, ver lib/supabase/env.ts).
//    Sin esta rama, todo enlace de correo acababa en `?error=auth_callback`.
//  - OAuth iniciado por la app → `code` + code_verifier (cookie) → exchangeCodeForSession.
export async function GET(request: Request) {
  const { searchParams, origin } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  // `next` llega del query string, así que resolverlo sin sanear es una
  // redirección abierta (CWE-601). La comprobación anterior era de cadena
  // (startsWith "/" y no "//") y NO bastaba: el parser de URL borra tabuladores
  // y saltos de línea ANTES de resolver, de modo que "/\t/evil.com" pasaba el
  // filtro y acababa en "//evil.com". Ver safeNextPath.
  const next = safeNextPath(searchParams.get("next"));

  if (tokenHash && type && VALID_OTP.has(type)) {
    const supabase = await createClient();
    const { error } = await supabase.auth.verifyOtp({
      type: type as EmailOtpType,
      token_hash: tokenHash,
    });
    if (!error) {
      // SOLO el registro confirmado pasa por la página exclusiva de éxito —
      // ahí (y solo ahí) se dispara la conversión de Google Ads. La regla del
      // dueño (02-09): «registro enviado ≠ conversión; cuenta verificada =
      // conversión». Un `invite`, `magiclink` o `recovery` no es un registro
      // captado por un anuncio, así que sigue directo a su `next` de siempre.
      // El token_hash es de un solo uso: reentrar por el enlace no re-dispara.
      if (type === "signup") {
        const locale = localeDelNext(next, routing.locales) ?? routing.defaultLocale;
        const exito = new URL(`/${locale}/signup/success`, origin);
        exito.searchParams.set("next", next);
        return NextResponse.redirect(exito);
      }
      return NextResponse.redirect(new URL(next, origin));
    }
    return NextResponse.redirect(`${origin}/login?error=auth_callback`);
  }

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
  }
  return NextResponse.redirect(`${origin}/login?error=auth_callback`);
}
