import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe/client";
import { billingFullyConfigured } from "@/lib/stripe/env";

/**
 * Open the Stripe Billing Portal so the customer can change seats, update the
 * card or cancel — self-serve, off the org's stored Stripe customer.
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

  let locale = "es";
  try {
    const body = (await req.json()) as { locale?: string };
    if (typeof body.locale === "string" && body.locale.length <= 5) locale = body.locale;
  } catch {
    /* no body — default locale */
  }

  const admin = createAdminClient();
  const { data } = await admin
    .from("organizations")
    .select("stripe_customer_id")
    .eq("id", user.id)
    .maybeSingle();
  const customer = (data as { stripe_customer_id?: string | null } | null)?.stripe_customer_id;
  if (!customer) {
    return NextResponse.json({ error: "No subscription to manage yet." }, { status: 409 });
  }

  const origin = new URL(req.url).origin;
  try {
    // La configuración se pasa EXPLÍCITAMENTE cuando está aprovisionada. Sin
    // ella, Stripe usa la de por defecto de la cuenta —un ajuste de panel que
    // nadie ha versionado y que nadie revisa—, y ahí `subscription_update` viene
    // DESACTIVADO: el cliente que crece no puede cambiar sus asientos, aunque el
    // 409 del checkout le diga que use «Gestionar plan». La crea
    // `scripts/provision-portal.mjs`.
    //
    // Si falta la variable NO se rompe la ruta: abrir el portal por defecto es
    // mucho mejor que no abrir ninguno —ahí es donde el cliente arregla su
    // tarjeta cuando le falla el cobro—, así que se avisa y se sigue.
    const configuration = process.env.STRIPE_PORTAL_CONFIGURATION_ID;
    if (!configuration) {
      console.warn(
        "[stripe/portal] STRIPE_PORTAL_CONFIGURATION_ID sin definir: se usa la configuración por " +
          "defecto de la cuenta. Si en ella no está activado 'subscription_update', un cliente NO " +
          "podrá cambiar sus asientos. Aprovisiónala con scripts/provision-portal.mjs.",
      );
    }
    const session = await getStripe().billingPortal.sessions.create({
      customer,
      ...(configuration ? { configuration } : {}),
      return_url: `${origin}/${locale}/dashboard/account`,
    });
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[stripe/portal] create session failed:", err);
    return NextResponse.json({ error: "Could not open the billing portal." }, { status: 502 });
  }
}
