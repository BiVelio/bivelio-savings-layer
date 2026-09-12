import { NextResponse } from "next/server";
import type Stripe from "stripe";

import { selloDeImpago } from "@/lib/billing/dunning";
import { esFacturaDeComision, decisionDeComision } from "@/lib/billing/facturacion";
import { motivoDeReemision } from "@/lib/billing/reemision";
import { alertar } from "@/lib/observabilidad/alerta";
import { atribuirPorPrecio, type Atribucion } from "@/lib/stripe/atribucion";
import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe/client";
import { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } from "@/lib/stripe/env";
import { esStale, condicionEscritura, puedeAplicarImpago, fallbackVencimientoUnix } from "@/lib/stripe/guardia-orden";
import {
  issueLicense,
  supersedeLicense,
  currentLicense,
  currentLicenseJti,
  revokeAllLicenses,
} from "@/lib/license/issue";

/**
 * Stripe webhook — the ONLY path that issues/re-issues/revokes paid licenses.
 * Verifies the raw-body signature, dedupes on the Stripe event id, and writes
 * control-plane state with the service_role client. Locked billing behaviour:
 *   - checkout.session.completed → link org + issue the first license.
 *   - subscription.updated (seat change) → RE-ISSUE, never revoke (a running
 *     fleet keeps working; the old license is only marked superseded).
 *   - invoice.paid (renewal) → re-issue so expiry tracks the new period.
 *   - invoice.payment_failed → past_due, NO revoke (14-day dunning grace).
 *   - subscription.deleted → plan=free + REVOKE the current license.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Admin = AdminClient;

const iso = (unix: number | null | undefined): string | null =>
  unix ? new Date(unix * 1000).toISOString() : null;

const nowUnix = () => Math.floor(Date.now() / 1000);

/** Facts the DB rows + license need. current_period_* live on the subscription
 *  ITEM in recent Stripe API versions, not the subscription top-level. */
function subFacts(sub: Stripe.Subscription) {
  const item = sub.items.data[0];
  const cust = sub.customer;
  return {
    itemId: item?.id ?? null,
    priceId: item?.price?.id ?? null,
    quantity: item?.quantity ?? 1,
    periodStart: item?.current_period_start ?? null,
    periodEnd: item?.current_period_end ?? null,
    customerId: typeof cust === "string" ? cust : (cust?.id ?? null),
    orgId: (sub.metadata?.org_id as string | undefined) || null,
  };
}

/** The subscription id an invoice belongs to (Stripe moved it under
 *  invoice.parent.subscription_details in recent API versions). */
function invoiceSubId(inv: Stripe.Invoice): string | null {
  const parent = inv.parent as
    | { subscription_details?: { subscription?: string | { id?: string } | null } | null }
    | null
    | undefined;
  const sd = parent?.subscription_details?.subscription ?? null;
  const fromParent = typeof sd === "string" ? sd : sd && typeof sd === "object" ? (sd.id ?? null) : null;
  if (fromParent) return fromParent;
  const legacy = (inv as unknown as { subscription?: string | { id?: string } | null }).subscription ?? null;
  return typeof legacy === "string" ? legacy : (legacy?.id ?? null);
}

async function audit(
  admin: Admin,
  orgId: string | null,
  eventId: string,
  kind: string,
  detail: Record<string, unknown>,
) {
  try {
    await admin.from("billing_audit").insert({ org_id: orgId, event_id: eventId, kind, detail });
  } catch (err) {
    console.error("[stripe/webhook] audit insert failed:", err);
  }
}

async function ensureOrg(
  admin: Admin,
  orgId: string,
  /**
   * QUIEN COMPRA. Antes no existía este parámetro: la pertenencia se escribía con
   * `user_id: orgId`, y eso solo se sostiene mientras la organización SEA una
   * persona. Con una organización de id propio, esa fila revienta la clave ajena
   * contra `auth.users`, `throw memErr` devuelve 503, Stripe reintenta 72 h y se
   * rinde — y el cliente se queda pagando sin licencia, para siempre.
   */
  ownerUserId: string,
  email: string | null,
  customerId: string | null,
  plan: string,
) {
  const { data } = await admin.from("organizations").select("id").eq("id", orgId).maybeSingle();
  if (data) {
    // SE COMPRUEBA EL ERROR. Antes se descartaba, y ese silencio era el riesgo nº 2
    // del plan: si esta escritura falla —por ejemplo por el `unique` de
    // `stripe_customer_id`, o porque PostgREST aún no ve una columna nueva— el
    // fallo no aparecía aquí sino una línea después, como violación de clave
    // ajena, y sin ninguna pista de la causa real.
    const { error } = await admin
      .from("organizations")
      .update({
        stripe_customer_id: customerId,
        plan,
        ...(email ? { billing_email: email } : {}),
      })
      .eq("id", orgId);
    if (error) throw error;
    // El dueño se rellena aparte y SOLO si falta, para no pisar una transferencia.
    const { error: ownErr } = await admin
      .from("organizations")
      .update({ owner_user_id: ownerUserId })
      .eq("id", orgId)
      .is("owner_user_id", null);
    if (ownErr) throw ownErr;
  } else {
    const { error } = await admin.from("organizations").insert({
      id: orgId,
      name: email || "BiVelio account",
      stripe_customer_id: customerId,
      plan,
      billing_email: email,
      owner_user_id: ownerUserId,
    });
    if (error) throw error;
  }

  // La fila de PERTENENCIA, que faltaba. Sin ella el que acaba de pagar no ve su
  // propio plan: `getOrgContext` resuelve la organización con un join sobre
  // `org_members` (data.ts:74-78), así que `ctx.org` quedaba en null, el panel
  // mostraba "Sin plan activo" y `BillingButtons` le reofrecía comprar — con
  // `checkout` sin guardia, el segundo clic abría una SEGUNDA suscripción real.
  //
  // Se lanza si falla en vez de tragárselo: un cliente que ha pagado y no consta
  // como miembro es exactamente el defecto que esto cierra, así que es preferible
  // devolver 503 y que Stripe reintente.
  //
  // El `user_id` es el de QUIEN COMPRA, no el de la organización. Antes eran lo
  // mismo por convención; ahora la organización tiene id propio y escribir aquí
  // el `orgId` violaría la clave ajena contra `auth.users`.
  const { error: memErr } = await admin
    .from("org_members")
    .upsert(
      { org_id: orgId, user_id: ownerUserId, role: "owner" },
      { onConflict: "org_id,user_id", ignoreDuplicates: true },
    );
  if (memErr) throw memErr;
}

async function setOrgPlan(admin: Admin, orgId: string, plan: string) {
  await admin.from("organizations").update({ plan }).eq("id", orgId);
}

/** Only genuinely-paid statuses carry the pro label (past_due stays pro through
 *  the dunning grace); incomplete/unpaid/canceled/… are free. */
function planForStatus(status: Stripe.Subscription.Status): "pro" | "free" {
  return status === "active" || status === "trialing" || status === "past_due" ? "pro" : "free";
}

/** Upsert the subscriptions row; returns its id + the seat count BEFORE this
 *  upsert (null when the row is new) so callers can detect a real seat change. */
async function upsertSub(
  admin: Admin,
  sub: Stripe.Subscription,
  orgId: string,
  eventCreated: number,
): Promise<{ id: string | null; prevSeats: number | null; stale: boolean }> {
  const f = subFacts(sub);
  const { data: existing } = await admin
    .from("subscriptions")
    .select("id, seats, last_event_at, past_due_since")
    .eq("stripe_subscription_id", sub.id)
    .maybeSingle();
  const prevSeats = (existing as { seats?: number } | null)?.seats ?? null;
  const existingId = (existing as { id?: string } | null)?.id ?? null;
  const selloPrevio = (existing as { past_due_since?: string | null } | null)?.past_due_since ?? null;

  // GUARDIA DE ORDEN, primera línea. Stripe no garantiza orden y reintenta
  // durante días lo que respondió 5xx, así que un evento viejo puede reentrar
  // DESPUÉS de uno nuevo. Si el que llega es anterior al último aplicado, no se
  // toca la fila. `event.created` es del ORIGEN, inmutable entre reintentos.
  // La segunda línea —contra la RÁFAGA CONCURRENTE que esta lectura no ve—
  // está en el WHERE del UPDATE de abajo (ver lib/stripe/guardia-orden.ts).
  const lastEventAt = (existing as { last_event_at?: string | null } | null)?.last_event_at ?? null;
  if (esStale(eventCreated, lastEventAt)) {
    return { id: existingId, prevSeats, stale: true };
  }

  const row: Record<string, unknown> = {
    org_id: orgId,
    stripe_subscription_id: sub.id,
    stripe_customer_id: f.customerId,
    stripe_item_id: f.itemId,
    price_id: f.priceId,
    status: sub.status,
    seats: f.quantity,
    current_period_start: iso(f.periodStart),
    current_period_end: iso(f.periodEnd),
    cancel_at_period_end: sub.cancel_at_period_end ?? false,
    canceled_at: iso(sub.canceled_at),
    last_event_at: iso(eventCreated),
    // EL SELLO DE IMPAGO SE GESTIONA AQUÍ, y antes no lo gestionaba nadie: se
    // escribía en `invoice.payment_failed` y no se borraba jamás. Al recuperarse
    // el cobro la fila volvía a `active` conservando el sello, y meses después el
    // SIGUIENTE impago se degradaba el día 1 leyendo esa fecha rancia. Ver
    // `selloDeImpago`, que es donde vive la regla y donde la prueban los tests.
    past_due_since: selloDeImpago(sub.status, selloPrevio, new Date().toISOString()),
    updated_at: new Date().toISOString(),
  };
  // Fila NUEVA: insert plano. Si otra entrega concurrente la creó entre nuestra
  // lectura y aquí, el 23505 nos manda al camino del UPDATE guardado — un upsert
  // ciego aquí PISARÍA lo que esa entrega escribió, saltándose la guardia.
  if (!existingId) {
    const { data, error } = await admin.from("subscriptions").insert(row).select("id").maybeSingle();
    if (!error) return { id: (data as { id?: string } | null)?.id ?? null, prevSeats: null, stale: false };
    if ((error as { code?: string }).code !== "23505") throw error;
  }

  // Fila EXISTENTE (o carrera de inserts): comparar-y-escribir en la MISMA
  // instrucción. La condición de frescura viaja en el WHERE; perder la carrera
  // afecta 0 filas y se reporta stale, en vez de pisar al ganador (el caso
  // `past_due` sobre una fila ya `canceled` del banco de pruebas del 27-08).
  const { data: escrito, error: errorUpdate } = await admin
    .from("subscriptions")
    .update(row)
    .eq("stripe_subscription_id", sub.id)
    .or(condicionEscritura(iso(eventCreated)!))
    .select("id");
  if (errorUpdate) throw errorUpdate;
  const filas = (escrito ?? []) as { id?: string }[];
  if (filas.length === 0) return { id: existingId, prevSeats, stale: true };
  return { id: filas[0]?.id ?? existingId, prevSeats, stale: false };
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

/**
 * Red de seguridad de la PRIMERA licencia: si la org esta en estado de pago y NO
 * tiene ninguna licencia viva, se emite aqui.
 *
 * Existe porque `checkout.session.completed` era el UNICO camino que minaba la
 * primera licencia, y eso lo hacia fatalmente fragil: cualquier motivo por el que
 * ese handler no llegara a emitir dejaba al cliente cobrado y sin licencia PARA
 * SIEMPRE (ningun otro handler mina una primera; handleSubUpsert solo re-emite
 * comparando contra una licencia que no existe, e invoice.paid solo atiende
 * `subscription_cycle`). Dos formas reales de que pase, las dos reproducidas:
 *
 *   - FUERA DE ORDEN. Stripe no garantiza orden. Si `customer.subscription.updated`
 *     entra antes que el checkout, adelanta `last_event_at` y el checkout llega
 *     `stale`. Peor: el reintento tras un 503 —que es el mecanismo de recuperacion
 *     DISEnADO (ensureOrg lanza a proposito para que Stripe reintente)— es stale si
 *     cualquier `updated` cayo durante el backoff, responde 200 y Stripe deja de
 *     reintentar: perdida silenciosa y permanente.
 *   - PAGO ASINCRONO. Con SEPA (lo habitual en EUR/Espana, y el checkout no fija
 *     `payment_method_types`) el `retrieve` fresco del checkout devuelve
 *     `incomplete`, asi que no se emite; cuando el adeudo liquida dias despues no
 *     hay ningun handler que mine la primera.
 *
 * Es idempotente y no puede resucitar nada: solo emite si NO hay licencia viva, y
 * quien la llama ya ha comprobado que el estado de la suscripcion es de pago.
 */
async function ensurePrimeraLicencia(
  admin: Admin,
  orgId: string,
  f: ReturnType<typeof subFacts>,
  subRowId: string | null,
  eventId: string,
  motivo: string,
): Promise<boolean> {
  const cur = await currentLicense(admin, orgId);
  if (cur) return false;
  const issued = await issueLicense(admin, {
    orgId,
    seats: f.quantity,
    periodEndUnix: f.periodEnd ?? fallbackVencimientoUnix(nowUnix()),
    subscriptionId: subRowId,
  });
  await audit(admin, orgId, eventId, "primera_licencia", { motivo, seats: f.quantity, jti: issued.jti });
  return true;
}

async function handleCheckout(admin: Admin, stripe: Stripe, session: Stripe.Checkout.Session, eventId: string, eventCreated: number) {
  if (session.mode !== "subscription") return;
  const orgId = (session.metadata?.org_id as string | undefined) || session.client_reference_id;
  const email = (session.metadata?.email as string | undefined) || session.customer_email || null;
  // QUIÉN COMPRA. `metadata.user_id` lo empezará a poner el checkout en la fase 6;
  // `client_reference_id` ya se pone en TODAS las sesiones (checkout:137) y
  // siempre es el id del usuario, así que cubre las que se crearon con el código
  // viejo y puedan estar todavía en vuelo — un adeudo SEPA tarda días.
  const compradorId = (session.metadata?.user_id as string | undefined) || session.client_reference_id || null;
  const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (!orgId || !subId) {
    console.error("[stripe/webhook] checkout missing org_id/subscription", { orgId, subId });
    return;
  }
  const sub = await stripe.subscriptions.retrieve(subId);
  // La MISMA guardia que handleInvoicePaid, que aquí faltaba: el retrieve es
  // FRESCO, así que si la suscripción ya no está en estado de pago este evento
  // es un reintento tardío (Stripe reintenta hasta 72 h lo que respondió 5xx) y
  // entre medias se procesó un `deleted`. Sin esto, el reintento ejecutaba
  // ensureOrg('pro') + issueLicense incondicionalmente: la org cancelada volvía
  // a pro con un token vivo y sin revocar hasta period_end + gracia — ingest y
  // SDK reabiertos sin cobro. Va ANTES de ensureOrg para no tocar ni el plan.
  if (planForStatus(sub.status) !== "pro") {
    await audit(admin, orgId, eventId, "checkout_not_active_ignored", { subId, status: sub.status });
    return;
  }
  const f = subFacts(sub);
  if (!compradorId) {
    // Sin saber QUIÉN compra no se puede escribir la pertenencia, y sin ella el
    // que acaba de pagar ve "Sin plan activo" y se le reofrece comprar. Antes esto
    // no podía pasar porque el comprador ERA la organización; ahora sí, así que
    // se falla ruidoso en vez de escribir una fila inventada.
    await alertar({
      nivel: "critico",
      asunto: "Checkout sin poder identificar al comprador: no se ha creado la pertenencia",
      detalle: { orgId, subId, eventId },
    });
    return;
  }
  await ensureOrg(admin, orgId, compradorId, email, f.customerId, "pro");
  // COMPRA A 0 € CON CUPÓN → EXENTA DE COMISIÓN. Un probador con el cupón del
  // 100 % no tiene tarjeta: la factura de comisión del día 1 fallaría y a los
  // 14 días de gracia se le revocaría la licencia por probar. La marca la pone
  // el propio cobro, sin que nadie tenga que acordarse; el dueño la puede
  // quitar (o poner a mano para una cortesía). Ver migración 0028.
  const descuento = session.total_details?.amount_discount ?? 0;
  if (session.amount_total === 0 && descuento > 0) {
    const { error: errExenta } = await admin
      .from("organizations")
      .update({
        comision_exenta: true,
        exencion_nota: `compra a 0 € con cupón · ${session.id} · ${new Date(eventCreated * 1000).toISOString().slice(0, 10)}`,
      })
      .eq("id", orgId);
    if (errExenta) {
      // No tumba el webhook (la licencia es lo primero), pero no se calla.
      await alertar({
        nivel: "critico",
        asunto: "Compra a 0 € sin poder marcar la exención de comisión",
        detalle: { orgId, sessionId: session.id, eventId, motivo: errExenta.message },
      });
    } else {
      await audit(admin, orgId, eventId, "comision_exenta_por_cupon", { sessionId: session.id, descuento });
    }
  }
  const { id: subRowId, stale } = await upsertSub(admin, sub, orgId, eventCreated);
  // Fuera de orden (la fila ya refleja un evento más nuevo): no se emite OTRA
  // licencia — la que corresponde al estado actual ya la emitió el evento nuevo.
  //
  // PERO este es el único handler que mina la PRIMERA, así que "no re-emitir" no
  // puede significar "no emitir nunca": si la org no tiene ninguna licencia viva,
  // saltarse la emisión aquí deja al que ha pagado sin producto de forma
  // permanente. La red de seguridad emite solo en ese caso.
  if (stale) {
    const emitida = await ensurePrimeraLicencia(admin, orgId, f, subRowId, eventId, "checkout_stale");
    await audit(admin, orgId, eventId, "checkout_stale_ignored", {
      subId,
      created: eventCreated,
      primeraLicenciaEmitida: emitida,
    });
    return;
  }
  const issued = await issueLicense(admin, {
    orgId,
    seats: f.quantity,
    periodEndUnix: f.periodEnd ?? fallbackVencimientoUnix(nowUnix()),
    subscriptionId: subRowId,
  });
  await audit(admin, orgId, eventId, "checkout", { subId, seats: f.quantity, jti: issued.jti });
}

async function handleSubUpsert(admin: Admin, sub: Stripe.Subscription, eventId: string, isUpdate: boolean, eventCreated: number) {
  const f = subFacts(sub);
  if (!f.orgId) {
    // Se responde 200, asi que Stripe NO reintenta y el evento queda marcado como
    // visto: el desajuste es PERMANENTE. Quien acaba de subir de 5 a 20 asientos
    // ya paga 20 en Stripe y su licencia firmada sigue diciendo 5.
    await alertar({
      nivel: "critico",
      asunto: "Cambio de suscripcion SIN org_id: ni asientos ni periodo se han aplicado",
      detalle: { subId: sub.id, status: sub.status, seats: f.quantity, eventId, esActualizacion: isUpdate },
    });
    return;
  }
  const { id: subRowId, stale } = await upsertSub(admin, sub, f.orgId, eventCreated);
  // Evento fuera de orden: la fila ya refleja uno más nuevo. NO se toca el plan ni
  // se reemite — aplicarlo des-cancelaría la org o revertiría un cambio de asientos.
  if (stale) {
    await audit(admin, f.orgId, eventId, "sub_upsert_stale_ignored", { status: sub.status, created: eventCreated });
    return;
  }
  const active = sub.status === "active" || sub.status === "trialing";
  await setOrgPlan(admin, f.orgId, planForStatus(sub.status));

  // Red de seguridad de la primera licencia. Este es el handler que ve la
  // transición `incomplete -> active` de un pago asíncrono (SEPA), que es justo
  // cuando el checkout ya decidió no emitir. Si acaba de emitirla, lleva los
  // asientos correctos y no hay nada más que hacer.
  if (
    planForStatus(sub.status) === "pro" &&
    (await ensurePrimeraLicencia(admin, f.orgId, f, subRowId, eventId, `sub_${sub.status}`))
  ) {
    return;
  }

  // SE RE-EMITE CUANDO LA LICENCIA DEJA DE REFLEJAR LO PAGADO, no solo cuando
  // cambian los asientos. La condición anterior (`f.quantity !== cur.seats`) tenía
  // un agujero de dinero: un cliente que pasa de mensual a anual con los MISMOS
  // asientos no cambia la cantidad, así que nadie re-emitía y su licencia
  // conservaba la caducidad mensual — pagaba doce meses y el SDK se le paraba
  // hacia el día 51. (`handleInvoicePaid` tampoco lo cubre: ignora toda factura
  // que no sea `subscription_cycle`.) Ver `motivoDeReemision`.
  //
  // Se compara contra la CURRENT LICENSE, no contra la fila de la suscripción que
  // acabamos de sobrescribir, para que un reintento tras una emisión fallida
  // vuelva a intentarlo. Y NUNCA se revoca al cambiar: se supersede, así la flota
  // en marcha sigue funcionando hasta que recoja la nueva.
  const cur = isUpdate && active ? await currentLicense(admin, f.orgId) : null;
  const motivo = motivoDeReemision({
    asientosNuevos: f.quantity,
    finDePeriodoUnix: f.periodEnd,
    licencia: cur,
  });
  if (cur && motivo) {
    await supersedeLicense(admin, cur.jti);
    const issued = await issueLicense(admin, {
      orgId: f.orgId,
      seats: f.quantity,
      periodEndUnix: f.periodEnd ?? fallbackVencimientoUnix(nowUnix()),
      subscriptionId: subRowId,
    });
    await audit(admin, f.orgId, eventId, "reissue", {
      motivo,
      from: cur.seats,
      to: f.quantity,
      caducidadAnterior: cur.expiresAt,
      jti: issued.jti,
    });
  } else {
    await audit(admin, f.orgId, eventId, "sub_upsert", { status: sub.status, seats: f.quantity });
  }
}

async function handleSubDeleted(admin: Admin, sub: Stripe.Subscription, eventId: string, eventCreated: number) {
  const f = subFacts(sub);
  if (!f.orgId) {
    // Mudo hasta ahora. Aqui el error va en la direccion contraria a los otros
    // dos —nadie se queda sin producto— pero seguimos sirviendo a quien ya no
    // paga, y sin rastro de que ha pasado.
    await alertar({
      nivel: "aviso",
      asunto: "Cancelacion SIN org_id: no se ha revocado ninguna licencia",
      detalle: { subId: sub.id, eventId },
    });
    return;
  }
  const { stale } = await upsertSub(admin, sub, f.orgId, eventCreated);
  // Un `deleted` viejo que reentra tras un evento más nuevo no debe revocar: la
  // suscripción podría haberse recreado. La guardia de orden lo frena.
  if (stale) {
    await audit(admin, f.orgId, eventId, "sub_deleted_stale_ignored", { subId: sub.id, created: eventCreated });
    return;
  }
  await setOrgPlan(admin, f.orgId, "free");
  // Revoke EVERY live token (re-issues leave superseded predecessors unrevoked),
  // not just the newest — else a canceled org keeps PRO on an older license.
  const revoked = await revokeAllLicenses(admin, f.orgId, "subscription canceled");
  await audit(admin, f.orgId, eventId, "sub_deleted", { subId: sub.id, revokedJtis: revoked });
}

/**
 * El ciclo de vida del cargo de comisión (bvsala.cargos). A diferencia de la
 * suscripción de asientos, aquí NO hay licencia que emitir ni plan que tocar:
 * solo el estado del cobro. Un fallo de pago alerta — la comisión es dinero ya
 * ganado por el cliente (su ahorro), y un impago aquí es rarísimo y grave.
 */
async function handleComisionResuelta(
  admin: Admin,
  invoice: Stripe.Invoice,
  eventId: string,
  estado: "pagado" | "fallido",
) {
  const orgId = invoice.metadata?.["bvsala_org_id"] ?? null;
  const periodo = invoice.metadata?.["bvsala_periodo"] ?? null;
  if (!orgId || !periodo) {
    await alertar({
      nivel: "aviso",
      asunto: "Factura de comisión sin (org, período) en metadata",
      detalle: { invoiceId: invoice.id, eventId, estado },
    });
    return;
  }
  // GUARDIA DE ORDEN: `pagado` es PEGAJOSO. Stripe reentrega eventos durante días
  // y sin orden, así que un `payment_failed` reentregado tarde puede llegar
  // DESPUÉS de un `invoice.paid` ya aplicado; sin esta verja pisaría `pagado` con
  // `fallido` y dispararía una alerta crítica de cobro fallido por un cargo que
  // SÍ se cobró. Una factura pagada es terminal para ese cobro (un retry que
  // prospera emite `paid`), así que `pagado` gana: el `fallido` solo se aplica si
  // el cargo no está ya pagado. El `paid` se aplica siempre.
  let q = admin
    .from("cargos")
    .update({ estado, detalle: { eventId, invoiceId: invoice.id }, actualizado_en: new Date().toISOString() })
    .eq("org_id", orgId)
    .eq("periodo", periodo);
  if (estado === "fallido") q = q.neq("estado", "pagado");
  // `.select()` para saber si el update REALMENTE se aplicó: un `fallido`
  // frenado por la verja (el cargo ya estaba pagado) devuelve 0 filas, y en ese
  // caso NO se alerta de cobro fallido — lo estaría por un cobro que sí entró.
  const { data, error } = await q.select("org_id");
  if (error) {
    await alertar({
      nivel: "critico",
      asunto: "El estado del cargo de comisión no se pudo actualizar",
      detalle: { orgId, periodo, estado, invoiceId: invoice.id, motivo: error.message },
    });
    return;
  }
  const aplicado = ((data ?? []) as unknown[]).length > 0;
  const decision = decisionDeComision(estado, aplicado);
  if (decision.alertarFallo) {
    await alertar({
      nivel: "critico",
      asunto: "Cobro de la comisión FALLIDO",
      detalle: { orgId, periodo, invoiceId: invoice.id },
    });
  }
  await audit(admin, orgId, eventId, decision.auditKind, { periodo, invoiceId: invoice.id });
}

async function handleInvoicePaid(admin: Admin, stripe: Stripe, invoice: Stripe.Invoice, eventId: string, eventCreated: number) {
  const subId = invoiceSubId(invoice);
  if (!subId) return;
  const sub = await stripe.subscriptions.retrieve(subId);
  const f = subFacts(sub);
  if (!f.orgId) {
    // ERA UN `return` MUDO: ni log, ni auditoría, ni nada. Y es el peor sitio
    // donde callar, porque `invoice.paid` es el ÚNICO camino que re-emite la
    // licencia con el periodo nuevo: si se sale por aquí, el cliente PAGA el mes
    // siguiente y su token conserva la caducidad del anterior. Se responde 200,
    // así que Stripe no reintenta y ningún otro handler lo recoge — el SDK se le
    // para al agotar la gracia, semanas después, sin que nadie lo haya visto.
    await alertar({
      nivel: "critico",
      asunto: "Renovación cobrada SIN org_id: la licencia NO se ha re-emitido",
      detalle: { subId, invoiceId: invoice.id, eventId, billingReason: invoice.billing_reason },
    });
    return;
  }
  const { id: subRowId } = await upsertSub(admin, sub, f.orgId, eventCreated);
  // `invoice.paid` retrieve() la suscripción FRESCA de Stripe, así que no reabre
  // una cancelada por un snapshot viejo: solo pasa a pro si de verdad está activa.
  if (planForStatus(sub.status) !== "pro") {
    await audit(admin, f.orgId, eventId, "invoice_paid_not_active", { subId, status: sub.status });
    return;
  }
  await setOrgPlan(admin, f.orgId, "pro");

  // La primera factura (`subscription_create`) no renueva nada, así que no
  // supersede ni re-emite. Pero SÍ es la confirmación de cobro de un pago
  // asíncrono, y para entonces el checkout puede haber decidido no emitir por
  // `incomplete`: la red de seguridad cubre ese caso y no hace nada si ya hay
  // licencia. Antes esta rama salía en la primera línea del handler y ese
  // camino no lo recogía nadie.
  if (invoice.billing_reason !== "subscription_cycle") {
    const emitida = await ensurePrimeraLicencia(
      admin, f.orgId, f, subRowId, eventId, `invoice_${invoice.billing_reason ?? "sin_motivo"}`,
    );
    if (!emitida) {
      await audit(admin, f.orgId, eventId, "invoice_paid_no_cycle", { subId, reason: invoice.billing_reason });
    }
    return;
  }

  const oldJti = await currentLicenseJti(admin, f.orgId);
  if (oldJti) await supersedeLicense(admin, oldJti);
  const invId = typeof invoice.id === "string" ? invoice.id : null;
  const issued = await issueLicense(admin, {
    orgId: f.orgId,
    seats: f.quantity,
    periodEndUnix: f.periodEnd ?? fallbackVencimientoUnix(nowUnix()),
    subscriptionId: subRowId,
    stripeInvoiceId: invId,
  });
  await audit(admin, f.orgId, eventId, "invoice_paid", { subId, jti: issued.jti });
}

async function handleInvoiceFailed(admin: Admin, invoice: Stripe.Invoice, eventId: string, eventCreated: number) {
  const subId = invoiceSubId(invoice);
  if (!subId) return;
  // past_due + sello; NO se revoca. La gracia la cuenta el barrido diario
  // `/api/cron/dunning` (apps/web/vercel.json), que degrada el plan solo a los
  // que la han pasado. Ese cron NO existía cuando este comentario lo prometía:
  // `past_due_since` se sellaba aquí y no se leía en ningún sitio, así que una
  // org en impago conservaba "pro" indefinidamente y el panel se lo pintaba con
  // toda normalidad. Los días de gracia salen de `lib/billing/gracia.ts`.
  const { data } = await admin
    .from("subscriptions")
    .select("id, org_id, status, last_event_at, past_due_since")
    .eq("stripe_subscription_id", subId)
    .maybeSingle();
  const row = data as {
    id?: string;
    org_id?: string;
    status?: string | null;
    last_event_at?: string | null;
    past_due_since?: string | null;
  } | null;
  if (!row?.id) return;
  // Este handler era el ÚNICO que escribía estado sin la guardia de orden: un
  // `payment_failed` reentregado tras el `deleted` resucitaba la fila a
  // `past_due` y reabría ingest y reconcile de una org cancelada (hallazgo VIVO
  // de la re-verificación del 02-09). `canceled` es terminal para esa
  // suscripción; la regla vive en puedeAplicarImpago (primera línea, en
  // memoria) y en el WHERE del UPDATE (segunda línea, contra la ráfaga).
  if (!puedeAplicarImpago(row.status ?? null, row.last_event_at ?? null, eventCreated)) {
    await audit(admin, row.org_id ?? null, eventId, "invoice_failed_ignorado", {
      subId,
      status: row.status ?? null,
      created: eventCreated,
    });
    return;
  }
  const { data: escrito } = await admin
    .from("subscriptions")
    .update({
      status: "past_due",
      past_due_since: row.past_due_since ?? new Date().toISOString(),
      last_event_at: iso(eventCreated),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .neq("status", "canceled")
    .or(condicionEscritura(iso(eventCreated)!))
    .select("id");
  const aplicado = ((escrito ?? []) as { id?: string }[]).length > 0;
  await audit(admin, row.org_id ?? null, eventId, aplicado ? "invoice_failed" : "invoice_failed_ignorado", {
    subId,
    ...(aplicado ? {} : { status: "carrera", created: eventCreated }),
  });
}

// ---------------------------------------------------------------------------

/**
 * De qué producto es este evento. Se resuelve SIEMPRE desde el objeto
 * Subscription: sus items llevan un `price` completo en todas las versiones del
 * SDK, mientras que las líneas de factura no (`invoice.lines.data[*].price` no
 * existe en stripe 22.x — es `pricing.price_details.price`).
 */
async function atribuirEvento(stripe: Stripe, event: Stripe.Event): Promise<Atribucion> {
  let sub: Stripe.Subscription | null = null;
  try {
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        sub = event.data.object as Stripe.Subscription;
        break;
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded": {
        const ses = event.data.object as Stripe.Checkout.Session;
        const id = typeof ses.subscription === "string" ? ses.subscription : ses.subscription?.id;
        if (id) sub = await stripe.subscriptions.retrieve(id);
        break;
      }
      case "invoice.paid":
      case "invoice.payment_failed": {
        const id = invoiceSubId(event.data.object as Stripe.Invoice);
        if (id) sub = await stripe.subscriptions.retrieve(id);
        break;
      }
      default:
        return "nuestro"; // los que no manejamos caen en el `default` del switch
    }
  } catch (err) {
    // Si no se puede resolver la suscripción NO se descarta: sin señal se
    // procesa y se avisa. Descartar ante un fallo de red sería tirar un cobro.
    console.error("[stripe/webhook] no se pudo atribuir el evento:", err);
    return "sin_senal";
  }
  const item = sub?.items.data[0];
  const producto = typeof item?.price?.product === "string" ? item.price.product : item?.price?.product?.id;
  return atribuirPorPrecio(item?.price?.id ?? null, producto ?? null);
}

export async function POST(req: Request): Promise<NextResponse> {
  if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: "Billing webhook isn't configured." }, { status: 501 });
  }

  const body = await req.text(); // RAW body — required for signature verification
  const sig = req.headers.get("stripe-signature") ?? "";
  const stripe = getStripe();

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    // Una firma suelta es un escaneo de internet y no significa nada. Un RITMO
    // sostenido significa que `STRIPE_WEBHOOK_SECRET` esta mal o se roto sin
    // redesplegar — y entonces la tuberia ENTERA esta muerta: ningun checkout
    // mina licencia, ninguna renovacion re-emite, ninguna cancelacion revoca.
    // Stripe reintenta unos tres dias y despues DESHABILITA el endpoint; pasado
    // ese plazo los eventos se pierden para siempre. De ahi que se avise aunque
    // el caso benigno sea comun: el coste de callar es toda la cartera a la vez.
    console.error("[stripe/webhook] signature verification failed:", err);
    await alertar({
      nivel: "critico",
      asunto: "Webhook de Stripe con firma invalida: revisa STRIPE_WEBHOOK_SECRET",
      detalle: { motivo: err instanceof Error ? err.message : String(err) },
    });
    return NextResponse.json({ error: "invalid signature" }, { status: 400 });
  }

  const admin = createAdminClient();

  // Idempotency (at-least-once): skip an event we've already fully recorded, so a
  // normal Stripe redelivery is a no-op. We record AFTER the handler succeeds (see
  // below) so a crash/timeout mid-handler leaves NO record → Stripe retries →
  // reprocess. Dropping a paid checkout would be far worse than the alternative:
  // a rare CONCURRENT duplicate may process twice → at most two valid licenses,
  // and revokeAllLicenses ledgers both on cancel, so the duplicate is benign.
  try {
    const { data: seen } = await admin
      .from("stripe_events")
      .select("id")
      .eq("id", event.id)
      .maybeSingle();
    if (seen) return NextResponse.json({ received: true, duplicate: true });
  } catch (err) {
    console.error("[stripe/webhook] idempotency check failed:", err);
    return NextResponse.json({ error: "store unavailable" }, { status: 503 });
  }

  // ───────────────────────────────────────────────────────────────────────────
  // LA VERJA DE PRODUCTO. BV-SALA y BV-PRGA comparten la MISMA cuenta de Stripe,
  // y Stripe entrega por TIPO de evento, no por producto: este endpoint recibe
  // también los del otro. Los dos usan la clave `metadata.org_id`, con uuids de
  // esquemas distintos, así que un evento ajeno llegaba hasta el insert y la
  // clave ajena contra `bvsala.organizations` lo reventaba → 503 → Stripe
  // reintenta durante ~3 días y después DESHABILITA el endpoint. Ahí se cae el
  // cobro entero, y sin dar la cara.
  //
  // ⚠️ UN EVENTO DESCARTADO NO SE REGISTRA EN `stripe_events`, Y ESO ES EL PUNTO.
  // La comprobación de duplicados de más arriba corta ANTES del manejador, así
  // que un evento registrado ya no se puede reprocesar ni reenviándolo desde
  // Stripe. Si algún día esta regla se equivoca y descarta algo NUESTRO, no
  // registrarlo es lo único que deja el error reparable: se corrige la regla, se
  // reenvía el evento y se procesa. Registrarlo lo haría irreversible.
  const veredicto = await atribuirEvento(stripe, event);
  if (veredicto === "ajeno") {
    // 200 para que Stripe deje de reintentar. Sin alerta: las ventas del otro
    // producto son constantes y esto sería una alarma diaria que enseñaría a
    // ignorar el canal.
    return NextResponse.json({ received: true, ignored: "otro producto" });
  }
  if (veredicto === "sin_senal") {
    // NO se descarta: se procesa Y se avisa. Aquí puede haber un evento NUESTRO
    // con el catálogo mal configurado o el metadato roto, y ése es justo el fallo
    // que no se puede silenciar.
    await alertar({
      nivel: "aviso",
      asunto: "Evento de Stripe que no se ha podido atribuir: se procesa igual",
      detalle: { eventId: event.id, tipo: event.type },
    });
  }

  try {
    switch (event.type) {
      // `async_payment_succeeded` es la liquidación de un pago diferido (SEPA, y
      // el checkout no fija `payment_method_types`, así que en EUR/España es un
      // camino normal). Lleva el mismo objeto de sesión y handleCheckout ya hace
      // `retrieve` fresco, de modo que ahora sí llega a emitir cuando el adeudo
      // se confirma días después.
      case "checkout.session.completed":
      case "checkout.session.async_payment_succeeded":
        await handleCheckout(admin, stripe, event.data.object as Stripe.Checkout.Session, event.id, event.created);
        break;
      case "customer.subscription.created":
        await handleSubUpsert(admin, event.data.object as Stripe.Subscription, event.id, false, event.created);
        break;
      case "customer.subscription.updated":
        await handleSubUpsert(admin, event.data.object as Stripe.Subscription, event.id, true, event.created);
        break;
      case "customer.subscription.deleted":
        await handleSubDeleted(admin, event.data.object as Stripe.Subscription, event.id, event.created);
        break;
      case "invoice.paid": {
        const inv = event.data.object as Stripe.Invoice;
        // Las facturas de la COMISIÓN no llevan suscripción: sin esta rama caían
        // en el `return` mudo de subId nulo y el cargo se quedaba en "facturado"
        // para siempre, pagado o no.
        if (esFacturaDeComision(inv.metadata)) await handleComisionResuelta(admin, inv, event.id, "pagado");
        else await handleInvoicePaid(admin, stripe, inv, event.id, event.created);
        break;
      }
      case "invoice.payment_failed": {
        const inv = event.data.object as Stripe.Invoice;
        if (esFacturaDeComision(inv.metadata)) await handleComisionResuelta(admin, inv, event.id, "fallido");
        else await handleInvoiceFailed(admin, inv, event.id, event.created);
        break;
      }
      default:
        break; // ignore other event types
    }
  } catch (err) {
    console.error(`[stripe/webhook] handler failed for ${event.type}:`, err);
    return NextResponse.json({ error: "handler failed" }, { status: 503 });
  }

  // Record ONLY after success: a failed/crashed handler stays unrecorded and is
  // retried by Stripe; a normal redelivery is deduped by the check above.
  try {
    await admin.from("stripe_events").insert({ id: event.id, type: event.type });
  } catch {
    /* concurrent duplicate raced us — benign (dup licenses are revoked on cancel) */
  }
  return NextResponse.json({ received: true });
}
