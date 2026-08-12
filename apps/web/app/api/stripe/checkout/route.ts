import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe/client";
import { billingFullyConfigured, priceIdFor, type BillingPeriod } from "@/lib/stripe/env";
import { MAX_ASIENTOS, normalizarAsientos } from "@/lib/billing/asientos";
import { resolverOrgDelUsuario } from "@/lib/org/resolver";

/**
 * Start a Stripe Checkout for the per-seat PRO plan (monthly or yearly). Auth'd
 * by the cookie session. La organización se RESUELVE (creándola si hace falta) y
 * su id viaja en la metadata de la sesión y de la suscripción junto al `user_id`
 * de quien compra — dos datos distintos que hasta ahora eran el mismo. Returns the
 * hosted Checkout URL; the client redirects.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request): Promise<NextResponse> {
  if (!billingFullyConfigured) {
    return NextResponse.json({ error: "Billing isn't configured yet." }, { status: 501 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Sign in first." }, { status: 401 });

  // Optional body: period (monthly|yearly), seats, locale. Empty body is fine.
  let period: BillingPeriod = "monthly";
  let seats = 1;
  let locale = "es";
  try {
    const body = (await req.json()) as { period?: string; seats?: number; locale?: string };
    if (body.period === "yearly") period = "yearly";
    // MISMA función que el campo del panel, no una copia del criterio. Y el tope
    // se aplica AQUÍ además de allí porque el cliente no es fuente de verdad:
    // este cuerpo lo puede mandar cualquiera con una sesión y un `curl`, y sin
    // tope un `seats: 1e9` crea una sesión de Checkout por un importe absurdo —
    // que si alguien completa, es un cobro REAL que hay que reembolsar a mano.
    if (body.seats != null) seats = normalizarAsientos(body.seats);
    if (typeof body.locale === "string" && body.locale.length <= 5) locale = body.locale;
  } catch {
    /* no body — use defaults */
  }

  const price = priceIdFor(period);
  if (!price) {
    return NextResponse.json({ error: `No Stripe price configured for ${period}.` }, { status: 501 });
  }

  // GUARDIA ANTI-DOBLE-COBRO. No existía: nada impedía que quien ya paga abriera
  // una segunda suscripción real, y el panel EMPUJABA a hacerlo — sin la fila de
  // `org_members` que el webhook no creaba, la cuenta figuraba como "Sin plan
  // activo" y se le volvían a ofrecer los botones de compra.
  //
  // Falla CERRADA a propósito: si no se puede comprobar el estado, se rechaza. Un
  // cobro duplicado exige reembolso y quema la confianza; una compra bloqueada se
  // reintenta en diez segundos.
  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "Billing isn't configured yet." }, { status: 501 });
  }

  // LA ORGANIZACIÓN, ANTES DE LA GUARDIA. Y en este orden a propósito: la guardia
  // anti-doble-cobro pregunta «¿esta ORGANIZACIÓN ya paga?», así que con el id
  // equivocado no protege de nada. Se crea si no existe —el id tiene que quedar
  // fijado ANTES de mandar a nadie a Stripe, porque viaja en la metadata y es lo
  // que el webhook usará para casar el cobro— y así un carrito abandonado y
  // reintentado media hora después resuelve la MISMA organización, en vez de
  // acuñar una por intento.
  //
  // Falla CERRADA, igual que la guardia: sin organización no se abre checkout.
  let orgId: string;
  try {
    orgId = (await resolverOrgDelUsuario(admin, user.id, user.email ?? null)).orgId;
  } catch (err) {
    console.error("[stripe/checkout] org resolve failed:", err);
    return NextResponse.json(
      { error: "Could not verify your current plan. Try again in a moment." },
      { status: 503 },
    );
  }

  // `incomplete` VA EN LA LISTA, y es el estado que faltaba. Es donde Stripe deja
  // una suscripción cuyo PRIMER cobro aún no ha liquidado. Con tarjeta dura
  // segundos, pero el checkout no fija `payment_method_types`, así que en euros
  // Stripe ofrece SEPA — y un adeudo SEPA tarda DÍAS en confirmarse.
  //
  // Durante esos días la suscripción existe, el dinero está en camino, y hasta
  // ahora esta guardia no la veía: el panel seguía mostrando "Sin plan activo"
  // (planForStatus manda `incomplete` a free) y el botón de comprar seguía vivo.
  // El comprador, que no ve nada de lo que pagó, vuelve a pulsar — y se abre una
  // SEGUNDA suscripción real. Cuando los dos adeudos liquidan, se le cobra dos
  // veces. No hace falta ninguna carrera ni concurrencia: es el camino normal de
  // la interfaz para cualquiera que pague por domiciliación.
  //
  // `unpaid` se deja FUERA a propósito: ahí Stripe ya agotó los reintentos y no
  // hay dinero en vuelo, así que bloquear una compra nueva dejaría al cliente sin
  // ninguna salida desde la web.
  const { data: activa, error: subErr } = await admin
    .from("subscriptions")
    .select("id, status")
    .eq("org_id", orgId)
    .in("status", ["active", "trialing", "past_due", "incomplete"])
    .limit(1)
    .maybeSingle();
  if (subErr) {
    console.error("[stripe/checkout] subscription lookup failed:", subErr);
    return NextResponse.json(
      { error: "Could not verify your current plan. Try again in a moment." },
      { status: 503 },
    );
  }
  if (activa) {
    // El mensaje se separa por estado: mandar a "Manage plan" a quien tiene un
    // adeudo en vuelo no le sirve de nada — ahí no hay nada que gestionar
    // todavía. Lo que necesita es saber que su pago se está procesando y que NO
    // tiene que volver a comprar.
    const pendiente = (activa as { status?: string }).status === "incomplete";
    return NextResponse.json(
      {
        error: pendiente
          ? "Your payment is still being processed — bank debits can take a few days to clear. You'll get access as soon as it settles. Please don't start a second subscription."
          : "This account already has an active subscription. Use “Manage plan” to change seats or billing.",
      },
      { status: 409 },
    );
  }

  // Reuse the org's existing Stripe customer if we've recorded one (no duplicates).
  let customer: string | undefined;
  try {
    const { data } = await admin
      .from("organizations")
      .select("stripe_customer_id")
      .eq("id", orgId)
      .maybeSingle();
    customer = (data as { stripe_customer_id?: string | null } | null)?.stripe_customer_id ?? undefined;
  } catch {
    /* org row may not exist yet — Stripe creates the customer at checkout */
  }

  const origin = new URL(req.url).origin;
  try {
    const session = await getStripe().checkout.sessions.create({
      mode: "subscription",
      // `maximum` explicito: por defecto Stripe lo deja en 99, asi que un cliente
      // con 150 maquinas veia el selector del panel aceptar 150 y la pantalla de
      // Stripe recortarlo a 99 sin decir nada. Los dos topes son ahora el mismo.
      line_items: [
        { price, quantity: seats, adjustable_quantity: { enabled: true, minimum: 1, maximum: MAX_ASIENTOS } },
      ],
      ...(customer ? { customer } : { customer_email: user.email ?? undefined }),
      client_reference_id: user.id,
      // DOS IDS DISTINTOS, y hasta ahora eran el mismo. `org_id` es a quién se le
      // cobra; `user_id` es QUIÉN compra, y es el que va a la fila de pertenencia y
      // a `owner_user_id`. Escribir el org id donde va el user id revienta la clave
      // ajena contra `auth.users`, el webhook devuelve 503, Stripe reintenta 72 h y
      // se rinde: el cliente se queda pagando sin licencia, para siempre.
      //
      // `user_id` es el que el webhook prefiere (`webhook:281`) y `client_reference_id`
      // su respaldo, que cubre las sesiones creadas con el código viejo y todavía en
      // vuelo — un adeudo SEPA tarda días en liquidar.
      metadata: { org_id: orgId, user_id: user.id, email: user.email ?? "" },
      subscription_data: { metadata: { org_id: orgId, user_id: user.id } },
      allow_promotion_codes: true,
      success_url: `${origin}/${locale}/dashboard/account?checkout=success`,
      cancel_url: `${origin}/${locale}/dashboard/account?checkout=cancelled`,
    });
    if (!session.url) throw new Error("no session url returned");
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[stripe/checkout] create session failed:", err);
    return NextResponse.json({ error: "Could not start checkout." }, { status: 502 });
  }
}
