import { NextResponse } from "next/server";

import {
  verificarFirma,
  elegirProducto,
  idiomaDe,
  construirEnlace,
  type CargaHook,
} from "@/lib/correo/auth-hook";
import { componerCorreoAuth } from "@/lib/correo/auth-plantillas";
import { alertar } from "@/lib/observabilidad/alerta";

/**
 * EL DESTINO DEL «SEND EMAIL HOOK» DE SUPABASE. Cuando el hook está activado en
 * el proyecto compartido, TODOS los correos de auth de la plataforma (altas,
 * recuperaciones, magic links… de GPOS, privacy y savings) pasan por aquí:
 * Supabase ya no manda nada por su cuenta.
 *
 * FAIL-CLOSED, y es deliberado: si esta ruta no puede mandar el correo,
 * devuelve error y GoTrue le enseña un error a quien se estaba registrando —
 * que puede reintentar. La alternativa (200 sin haber enviado) deja a esa
 * persona esperando para siempre un correo que no existe, que es exactamente
 * la clase de silencio que este producto no se permite.
 *
 * SEGURIDAD. La firma Standard Webhooks con el secreto compartido es la única
 * autenticación, y se verifica ANTES de leer nada del cuerpo. Sin firma válida
 * esta ruta no revela ni que existe una cuenta: 401 seco. El token_hash que
 * llega JAMÁS se registra (un log con token_hash es una cuenta ajena abierta).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  const secreto = process.env.SUPABASE_SEND_EMAIL_HOOK_SECRET;
  if (!secreto) {
    // Sin secreto configurado el hook no debe estar activado; si lo está, mejor
    // un 501 ruidoso que un 401 que parezca un ataque.
    return NextResponse.json({ error: "Hook not configured." }, { status: 501 });
  }

  const cuerpo = await req.text();
  const veredicto = verificarFirma(
    cuerpo,
    {
      id: req.headers.get("webhook-id"),
      timestamp: req.headers.get("webhook-timestamp"),
      signature: req.headers.get("webhook-signature"),
    },
    secreto,
  );
  if (!veredicto.ok) {
    return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  }

  let carga: CargaHook = {};
  try {
    carga = JSON.parse(cuerpo) as CargaHook;
  } catch {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  const destinatario = carga.user?.email ?? "";
  const datos = carga.email_data ?? {};
  const accion = datos.email_action_type ?? "";
  if (!destinatario || !accion) {
    return NextResponse.json({ error: "Invalid payload." }, { status: 400 });
  }

  const producto = elegirProducto(datos.redirect_to || datos.site_url);
  const idioma = idiomaDe(datos.redirect_to);
  // Con token_hash hay enlace; sin él (reauthentication) se muestra el código.
  const enlace = datos.token_hash
    ? construirEnlace(producto, datos.redirect_to, datos.token_hash, accion)
    : "";

  const { asunto, html, texto } = componerCorreoAuth({
    producto,
    accion,
    idioma,
    enlace,
    codigo: enlace ? undefined : datos.token,
    destinatario,
  });

  const clave = process.env.RESEND_API_KEY;
  if (!clave) {
    console.error("[auth/correo] RESEND_API_KEY ausente: no se puede mandar el correo de", accion);
    // Sin proveedor de correo NADIE puede registrarse ni recuperar contraseña:
    // eso es crítico y tiene que sonar, no dormir en un log.
    await alertar({ nivel: "critico", asunto: "auth/correo sin RESEND_API_KEY: correos de auth caídos", detalle: { accion, producto } });
    return NextResponse.json({ error: "Email provider not configured." }, { status: 500 });
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${clave}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: "BiVelio <no-reply@bivelio.com>",
        reply_to: "support@bivelio.com",
        to: [destinatario],
        subject: asunto,
        html,
        text: texto,
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      // Sin destinatario ni token en el log: basta el tipo y el estado para operar.
      console.error(`[auth/correo] Resend devolvió ${res.status} para ${accion} (${producto}/${idioma})`);
      // «Habrá que controlarlo» (dueño, 02-09, tras el día en que el límite de
      // 2 correos/hora dejó registros sin correo EN SILENCIO): un fallo de
      // envío es un cliente que no puede entrar — alerta, no solo log. Un 429
      // de Resend además huele a tope de plan: la alerta lo dice.
      await alertar({
        nivel: res.status === 429 ? "critico" : "aviso",
        asunto: `auth/correo: Resend devolvió ${res.status} (${accion})${res.status === 429 ? " — ¿tope del plan de Resend?" : ""}`,
        detalle: { accion, producto, idioma, status: res.status },
      });
      return NextResponse.json({ error: "Could not send the email." }, { status: 500 });
    }
  } catch (err) {
    console.error("[auth/correo] envío falló:", err instanceof Error ? err.name : err);
    await alertar({
      nivel: "aviso",
      asunto: "auth/correo: envío a Resend falló (red/timeout)",
      detalle: { accion, producto, error: err instanceof Error ? err.name : String(err) },
    });
    return NextResponse.json({ error: "Could not send the email." }, { status: 500 });
  }

  return NextResponse.json({});
}
