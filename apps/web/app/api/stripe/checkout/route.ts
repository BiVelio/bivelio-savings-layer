import { NextResponse } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe/client";
import { billingFullyConfigured, priceIdFor, type BillingPeriod } from "@/lib/stripe/env";
import type Stripe from "stripe";
import { MAX_ASIENTOS, normalizarAsientos } from "@/lib/billing/asientos";
import { resolverOrgDelUsuario } from "@/lib/org/resolver";
import { puede, NO_AUTORIZADO } from "@/lib/org/permisos";
import { alertar } from "@/lib/observabilidad/alerta";

/**
 * Start a Stripe Checkout for the per-seat PRO plan (monthly or yearly). Auth'd
 * by the cookie session. La organización se RESUELVE (creándola si hace falta) y
 * su id viaja en la metadata de la sesión y de la suscripción junto al `user_id`
 * de quien compra — dos datos distintos que hasta ahora eran el mismo. Returns the
 * hosted Checkout URL; the client redirects.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Estados de suscripción con los que NO se abre otro checkout. La MISMA lista
 * para nuestra tabla y para Stripe: si un día divergen, una de las dos guardias
 * deja pasar lo que la otra bloquea. (`unpaid` fuera a propósito: ver abajo.)
 */
const ESTADOS_QUE_BLOQUEAN: ReadonlySet<string> = new Set(["active", "trialing", "past_due", "incomplete"]);
const MENSAJE_PAGO_EN_CURSO =
  "Your payment is still being processed — bank debits can take a few days to clear. You'll get access as soon as it settles. Please don't start a second subscription.";
const MENSAJE_YA_SUSCRITO =
  "This account already has an active subscription. Use “Manage plan” to change seats or billing.";

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
  // Código de promoción PRE-APLICADO (enlace de los probadores, 2026-09-12).
  // Tecleado en la página de Stripe, un código puede rechazarse; puesto aquí,
  // el descuento ya viene en la sesión y el probador solo ve el total a 0 €.
  // `allow_promotion_codes` y `discounts` son excluyentes en Checkout.
  let codigo: string | null = null;
  try {
    const body = (await req.json()) as { period?: string; seats?: number; locale?: string; codigo?: string };
    // Mismo alfabeto que account/page.tsx: un código con guion bajo pasaba la
    // página de cuenta y aquí se descartaba en silencio (sin 400).
    if (typeof body.codigo === "string" && /^[A-Za-z0-9_-]{2,40}$/.test(body.codigo)) codigo = body.codigo.toUpperCase();
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
    const org = await resolverOrgDelUsuario(admin, user.id, user.email ?? null);
    // Abrir un checkout mueve DINERO REAL de la empresa. Un `member` no compra.
    if (!puede(org.role, "comprar")) {
      return NextResponse.json({ error: NO_AUTORIZADO }, { status: 403 });
    }
    orgId = org.orgId;
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
    .in("status", [...ESTADOS_QUE_BLOQUEAN])
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
    // `code` es lo que el panel traduce; `error` es el respaldo en inglés para
    // quien llame a la ruta a mano.
    return NextResponse.json(
      {
        code: pendiente ? "pago_en_curso" : "ya_suscrito",
        error: pendiente ? MENSAJE_PAGO_EN_CURSO : MENSAJE_YA_SUSCRITO,
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

  // GUARDIA CONTRA EL WEBHOOK MUERTO (2026-09-12). La guardia de arriba mira
  // NUESTRA tabla `subscriptions`, y esa tabla la escribe el webhook. Si el
  // webhook no llega —secreto rotado, endpoint caído, un 503 por una clave
  // ajena— el cliente ha pagado, Stripe lo sabe, y aquí figura «Sin plan
  // activo» con los botones de comprar delante. La cadena de cobro no se ha
  // ejercitado nunca en producción, así que este es exactamente el fallo que
  // más probable es el primer día con probadores.
  //
  // Así que se le pregunta también a Stripe, que es quien cobra: por el cliente
  // que tenemos apuntado (si lo tenemos) y por el correo del comprador (que es
  // lo único que sobrevive a un webhook muerto, porque `customer_email` viaja
  // en la sesión). Falla CERRADA como la otra: si Stripe no contesta, no se
  // abre checkout. Y avisa en crítico, porque «Stripe cobra y la tabla no lo
  // sabe» es la alerta más importante que puede dar esta ruta.
  try {
    const stripe = getStripe();
    const clientes = new Set<string>();
    if (customer) clientes.add(customer);
    if (user.email) {
      const porCorreo = await stripe.customers.list({ email: user.email, limit: 5 });
      for (const c of porCorreo.data) clientes.add(c.id);
    }
    // Solo cuentan las suscripciones de ESTE producto: la cuenta de Stripe puede
    // compartirse con otros productos de la casa, y una suscripción viva de otro
    // no es motivo para negarle a nadie la compra de este.
    const nuestrosPrecios = new Set([priceIdFor("monthly"), priceIdFor("yearly")].filter(Boolean));
    const esNuestra = (sub: Stripe.Subscription): boolean =>
      Boolean(sub.metadata?.org_id) || sub.items.data.some((it) => nuestrosPrecios.has(it.price.id));
    for (const id of clientes) {
      let subs: Stripe.ApiList<Stripe.Subscription>;
      try {
        subs = await stripe.subscriptions.list({ customer: id, status: "all", limit: 10 });
      } catch (err) {
        // Un `stripe_customer_id` apuntado en la organización que Stripe ya no
        // conoce (otra cuenta, otro modo, borrado) no puede dejar el checkout en
        // un 503 «temporal» para siempre: se salta ese id y se sigue por el correo.
        if ((err as { code?: string }).code === "resource_missing") continue;
        throw err;
      }
      const viva = subs.data.find((sub) => ESTADOS_QUE_BLOQUEAN.has(sub.status) && esNuestra(sub));
      if (!viva) continue;
      // ¿Nuestra tabla ya la conoce (bajo otra organización, p. ej.)? Entonces no
      // es un webhook muerto: es «ya estás suscrito», sin alerta crítica.
      const { data: conocida } = await admin
        .from("subscriptions")
        .select("org_id")
        .eq("stripe_subscription_id", viva.id)
        .maybeSingle();
      const pendiente = viva.status === "incomplete";
      if (conocida) {
        return NextResponse.json(
          {
            code: pendiente ? "pago_en_curso" : "ya_suscrito",
            error: pendiente ? MENSAJE_PAGO_EN_CURSO : MENSAJE_YA_SUSCRITO,
          },
          { status: 409 },
        );
      }
      // `await`, no `void`: Vercel puede congelar la función en cuanto sale la
      // respuesta, y esta es la alerta más importante que puede dar esta ruta.
      // `alertar` nunca lanza y tiene sus propios cortes de tiempo.
      await alertar({
        nivel: "critico",
        asunto: "checkout: Stripe tiene una suscripción viva que nuestra tabla no conoce",
        detalle: { org_id: orgId, user_id: user.id, customer: id, subscription: viva.id, status: viva.status },
      });
      return NextResponse.json(
        {
          code: pendiente ? "pago_en_curso" : "suscripcion_en_stripe",
          error: pendiente
            ? MENSAJE_PAGO_EN_CURSO
            : "Stripe already has a subscription for this account, but it hasn't been activated here yet. Please don't buy again — write to support@bivelio.com and we'll activate it by hand.",
        },
        { status: 409 },
      );
    }
  } catch (err) {
    console.error("[stripe/checkout] stripe-side subscription lookup failed:", err);
    return NextResponse.json(
      { error: "Could not verify your current plan. Try again in a moment." },
      { status: 503 },
    );
  }

  // El código, resuelto ANTES de crear la sesión: uno inexistente o apagado es
  // un 400 con su propio `code`, no una sesión sin descuento que sorprenda al
  // probador con 4 € en la pantalla de pago.
  let promotionCodeId: string | null = null;
  if (codigo) {
    try {
      const stripe = getStripe();
      // La cuenta de Stripe es compartida con otros productos de la casa: un
      // código de OTRO producto no puede descontar asientos de este. Solo vale
      // un código cuyo cupón esté acotado (`applies_to.products`) al producto
      // del precio que se va a comprar; y nunca uno restringido a otro cliente.
      const encontrados = await stripe.promotionCodes.list({ code: codigo, active: true, limit: 5 });
      const candidato = encontrados.data.find((pc) => {
        const dueno = typeof pc.customer === "string" ? pc.customer : pc.customer?.id ?? null;
        return dueno == null || dueno === customer;
      });
      if (candidato) {
        const cuponRef = candidato.promotion?.coupon ?? null;
        const cuponId = typeof cuponRef === "string" ? cuponRef : cuponRef?.id ?? null;
        const [cupon, precio] = await Promise.all([
          cuponId ? stripe.coupons.retrieve(cuponId) : Promise.resolve(null),
          stripe.prices.retrieve(price),
        ]);
        const producto = typeof precio.product === "string" ? precio.product : precio.product.id;
        if (cupon?.applies_to?.products?.includes(producto)) promotionCodeId = candidato.id;
      }
    } catch (err) {
      console.error("[stripe/checkout] promotion code lookup failed:", err);
      return NextResponse.json(
        { error: "Could not verify the promotion code. Try again in a moment." },
        { status: 503 },
      );
    }
    if (!promotionCodeId) {
      return NextResponse.json(
        { code: "codigo_invalido", error: "That promotion code does not exist, is no longer active, or is not for this product." },
        { status: 400 },
      );
    }
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
      // LA FACTURA TIENE QUE SERVIRLE A SU CONTABLE, o no es una venta B2B: es un
      // cargo que el cliente no puede justificar. Sin estas dos líneas, la factura
      // que emite Stripe sale sin dirección fiscal y sin NIF-IVA del comprador, y
      // eso en España —y en media Europa— es una factura que no se puede deducir.
      // El coste es un campo más en la pantalla de pago; el beneficio es que el
      // primer cliente no tenga que escribirnos para pedir una factura correcta.
      billing_address_collection: "required",
      // Opcional para el comprador: un autónomo o una empresa sin NIF intracomunitario
      // puede seguir comprando. Quien lo ponga, lo verá impreso en su factura — y es
      // además el dato que hará falta el día que se encienda el cálculo de impuestos,
      // porque es lo que activa la inversión del sujeto pasivo en una venta B2B.
      tax_id_collection: { enabled: true },
      // ⚠️ IMPRESCINDIBLE CUANDO SE REUTILIZA UN `customer`. Sin esto Stripe pide los
      // datos, los enseña en la pantalla… y NO los guarda en el cliente existente:
      // se quedan solo en esa sesión. La segunda factura volvería a salir sin
      // dirección, y nadie entendería por qué. Con `customer_email` (cliente nuevo)
      // Stripe lo guarda solo, pero pasarlo siempre no molesta y evita que el día
      // que alguien reordene este objeto reaparezca el fallo.
      customer_update: customer ? { address: "auto", name: "auto" } : undefined,
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
      ...(promotionCodeId ? { discounts: [{ promotion_code: promotionCodeId }] } : { allow_promotion_codes: true }),
      // SIN TARJETA CUANDO NO HACE FALTA. Con un código del 100 % (los
      // probadores, 2026-09-12) el total es 0 y Stripe, por defecto, sigue
      // pidiendo una tarjeta para una suscripción. `if_required` no la pide
      // cuando el total de la sesión es 0. Por eso el cupón de los probadores
      // es «para siempre»: con uno de un solo mes la suscripción quedaría sin
      // tarjeta y la factura del segundo mes fallaría.
      payment_method_collection: "if_required",
      success_url: `${origin}/${locale}/dashboard/account?checkout=success`,
      cancel_url: `${origin}/${locale}/dashboard/account?checkout=cancelled`,
    });
    if (!session.url) throw new Error("no session url returned");
    return NextResponse.json({ url: session.url });
  } catch (err) {
    console.error("[stripe/checkout] create session failed:", err);
    // Un cliente ha pulsado «comprar» y no ha podido pagar. Es la venta que se
    // pierde en silencio: hasta hoy, solo el log lo sabía.
    await alertar({
      nivel: "critico",
      asunto: "No se pudo crear la sesión de Checkout: un cliente no ha podido comprar",
      detalle: { orgId, seats, period, motivo: err instanceof Error ? err.message : String(err) },
    });
    return NextResponse.json({ error: "Could not start checkout." }, { status: 502 });
  }
}
