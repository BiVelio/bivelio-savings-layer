import { NextResponse } from "next/server";

import { RateLimiter, ipDe } from "@/lib/rate-limit";

/**
 * Petición de llamada de 15 minutos desde la landing.
 *
 * NO guarda nada en base de datos a propósito: un correo a support@ es un buzón
 * que ya existe, que alguien ya mira y del que no hay que borrar datos cuando
 * quien escribió cambie de opinión. Una tabla nueva para esto sería datos
 * personales con ciclo de vida propio y política de retención propia por una
 * dirección de correo.
 *
 * Y NUNCA devuelve 500 aunque el correo falle: quien rellena el formulario no
 * puede hacer nada con ese error, y un fallo de nuestro proveedor de correo no
 * es culpa suya. Se registra para que el fallo no sea invisible y se le contesta
 * con el camino alternativo, que es escribir directamente.
 */
const DESTINO = "support@bivelio.com";
const REMITENTE = "BiVelio <no-reply@bivelio.com>";
const MAX = 200;

/** Un salto de línea en una cabecera de correo permite inyectar cabeceras. */
const limpio = (s: string): string => s.replace(/[\r\n]/g, " ").slice(0, MAX).trim();

/** Suficiente para descartar un dedazo, sin pretender validar el RFC entero. */
const pareceCorreo = (s: string): boolean => /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(s);

// LÍMITE, para que este endpoint público no agote la cuota de Resend que
// comparte con los correos de auth (fail-closed). Ventana de 10 min: 3 por IP y
// 60 en total — un abusador no pasa de 3, y pase lo que pase este formulario no
// consume más de 60 correos por ventana, dejando el resto para lo esencial.
const LIMITE = new RateLimiter(10 * 60_000, 3, 60);

export async function POST(req: Request): Promise<NextResponse> {
  const permiso = LIMITE.permitir(ipDe(req));
  if (!permiso.ok) {
    return NextResponse.json({ ok: false, error: "rate_limited" }, { status: 429 });
  }

  let cuerpo: unknown;
  try {
    cuerpo = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const d = cuerpo as { email?: unknown; note?: unknown };
  const email = typeof d.email === "string" ? limpio(d.email) : "";
  const nota = typeof d.note === "string" ? limpio(d.note) : "";

  if (!pareceCorreo(email)) {
    return NextResponse.json({ ok: false, error: "bad_email" }, { status: 400 });
  }

  const clave = process.env.RESEND_API_KEY;
  if (!clave) {
    // Sin proveedor de correo no se puede prometer contacto. Se dice, en vez de
    // enseñar un «gracias» que no lleva a ninguna parte.
    console.warn("[contacto] RESEND_API_KEY no está configurada: la petición no se ha enviado");
    return NextResponse.json({ ok: false, error: "unavailable" }, { status: 503 });
  }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${clave}`, "content-type": "application/json" },
      body: JSON.stringify({
        from: REMITENTE,
        reply_to: email,
        to: [DESTINO],
        subject: `Llamada de 15 min — ${email}`,
        text: [`Correo: ${email}`, nota ? `Nota: ${nota}` : "", "", "Desde la landing de savings.bivelio.com"]
          .filter(Boolean)
          .join("\n"),
      }),
      signal: AbortSignal.timeout(8_000),
    });
    if (!res.ok) {
      console.warn(`[contacto] Resend respondió ${res.status}: la petición de ${email} NO ha salido`);
      return NextResponse.json({ ok: false, error: "send_failed" }, { status: 502 });
    }
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.warn("[contacto] no se pudo contactar con Resend:", err instanceof Error ? err.name : "desconocido");
    return NextResponse.json({ ok: false, error: "send_failed" }, { status: 502 });
  }
}
