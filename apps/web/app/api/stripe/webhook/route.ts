import { NextResponse } from "next/server";
import type Stripe from "stripe";

import { createAdminClient, type AdminClient } from "@/lib/supabase/admin";
import { getStripe } from "@/lib/stripe/client";
import { STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET } from "@/lib/stripe/env";
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
  email: string | null,
  customerId: string | null,
  plan: string,
) {
  const { data } = await admin.from("organizations").select("id").eq("id", orgId).maybeSingle();
  if (data) {
    await admin
      .from("organizations")
      .update({ stripe_customer_id: customerId, plan, ...(email ? { billing_email: email } : {}) })
      .eq("id", orgId);
  } else {
    await admin.from("organizations").insert({
      id: orgId,
      name: email || "BiVelio account",
      stripe_customer_id: customerId,
      plan,
      billing_email: email,
    });
  }

  // La fila de PERTENENCIA, que faltaba. Sin ella el que acaba de pagar no ve su
  // propio plan: `getOrgContext` resuelve la organización con un join sobre
  // `org_members` (data.ts:74-78), así que `ctx.org` quedaba en null, el panel
  // mostraba "Sin plan activo" y `BillingButtons` le reofrecía comprar — con
  // `checkout` sin guardia, el segundo clic abría una SEGUNDA suscripción real.
  //
  // Se lanza si falla en vez de tragárselo: un cliente que ha pagado y no consta
  // como miembro es exactamente el defecto que esto cierra, así que es preferible
  // devolver 503 y que Stripe reintente. `org_id == user_id` es la convención CP-0
  // y es lo que el checkout mete en los metadatos, así que la FK contra
  // `auth.users` se satisface.
  const { error: memErr } = await admin
    .from("org_members")
    .upsert(
      { org_id: orgId, user_id: orgId, role: "owner" },
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
    .select("id, seats, last_event_at")
    .eq("stripe_subscription_id", sub.id)
    .maybeSingle();
  const prevSeats = (existing as { seats?: number } | null)?.seats ?? null;
  const existingId = (existing as { id?: string } | null)?.id ?? null;

  // GUARDIA DE ORDEN. Stripe no garantiza orden y reintenta durante días lo que
  // respondió 5xx, así que un evento viejo puede reentrar DESPUÉS de uno nuevo.
  // Si el que llega es anterior al último aplicado, no se toca la fila: aplicarlo
  // des-cancelaría una org o revertiría un cambio de asientos. `event.created` es
  // del ORIGEN, inmutable entre reintentos.
  const lastEventAt = (existing as { last_event_at?: string | null } | null)?.last_event_at ?? null;
  if (lastEventAt && eventCreated * 1000 < new Date(lastEventAt).getTime()) {
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
    updated_at: new Date().toISOString(),
  };
  const { data, error } = await admin
    .from("subscriptions")
    .upsert(row, { onConflict: "stripe_subscription_id" })
    .select("id")
    .maybeSingle();
  if (error) throw error;
  return { id: (data as { id?: string } | null)?.id ?? existingId, prevSeats, stale: false };
}

// ---------------------------------------------------------------------------
// Event handlers
// ---------------------------------------------------------------------------

async function handleCheckout(admin: Admin, stripe: Stripe, session: Stripe.Checkout.Session, eventId: string, eventCreated: number) {
  if (session.mode !== "subscription") return;
  const orgId = (session.metadata?.org_id as string | undefined) || session.client_reference_id;
  const email = (session.metadata?.email as string | undefined) || session.customer_email || null;
  const subId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (!orgId || !subId) {
    console.error("[stripe/webhook] checkout missing org_id/subscription", { orgId, subId });
    return;
  }
  const sub = await stripe.subscriptions.retrieve(subId);
  const f = subFacts(sub);
  await ensureOrg(admin, orgId, email, f.customerId, "pro");
  const { id: subRowId } = await upsertSub(admin, sub, orgId, eventCreated);
  const issued = await issueLicense(admin, {
    orgId,
    seats: f.quantity,
    periodEndUnix: f.periodEnd ?? nowUnix() + 31 * 86400,
    subscriptionId: subRowId,
  });
  await audit(admin, orgId, eventId, "checkout", { subId, seats: f.quantity, jti: issued.jti });
}

async function handleSubUpsert(admin: Admin, sub: Stripe.Subscription, eventId: string, isUpdate: boolean, eventCreated: number) {
  const f = subFacts(sub);
  if (!f.orgId) {
    console.error("[stripe/webhook] subscription without org_id metadata", sub.id);
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

  // Re-issue ONLY on a real seat-quantity change (updates fire for many reasons).
  // Compare against the CURRENT LICENSE's seats — not the subscription row we just
  // overwrote — so a retry after a failed issue still re-issues. Never revoke on a
  // change: supersede so a running fleet keeps working until pickup.
  const cur = isUpdate && active ? await currentLicense(admin, f.orgId) : null;
  if (cur && f.quantity !== cur.seats) {
    await supersedeLicense(admin, cur.jti);
    const issued = await issueLicense(admin, {
      orgId: f.orgId,
      seats: f.quantity,
      periodEndUnix: f.periodEnd ?? nowUnix() + 31 * 86400,
      subscriptionId: subRowId,
    });
    await audit(admin, f.orgId, eventId, "reissue", { from: cur.seats, to: f.quantity, jti: issued.jti });
  } else {
    await audit(admin, f.orgId, eventId, "sub_upsert", { status: sub.status, seats: f.quantity });
  }
}

async function handleSubDeleted(admin: Admin, sub: Stripe.Subscription, eventId: string, eventCreated: number) {
  const f = subFacts(sub);
  if (!f.orgId) return;
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

async function handleInvoicePaid(admin: Admin, stripe: Stripe, invoice: Stripe.Invoice, eventId: string, eventCreated: number) {
  // Only renewals — the first invoice (subscription_create) is covered by checkout.
  if (invoice.billing_reason !== "subscription_cycle") return;
  const subId = invoiceSubId(invoice);
  if (!subId) return;
  const sub = await stripe.subscriptions.retrieve(subId);
  const f = subFacts(sub);
  if (!f.orgId) return;
  const { id: subRowId } = await upsertSub(admin, sub, f.orgId, eventCreated);
  // `invoice.paid` retrieve() la suscripción FRESCA de Stripe, así que no reabre
  // una cancelada por un snapshot viejo: solo pasa a pro si de verdad está activa.
  if (planForStatus(sub.status) !== "pro") {
    await audit(admin, f.orgId, eventId, "invoice_paid_not_active", { subId, status: sub.status });
    return;
  }
  await setOrgPlan(admin, f.orgId, "pro");
  const oldJti = await currentLicenseJti(admin, f.orgId);
  if (oldJti) await supersedeLicense(admin, oldJti);
  const invId = typeof invoice.id === "string" ? invoice.id : null;
  const issued = await issueLicense(admin, {
    orgId: f.orgId,
    seats: f.quantity,
    periodEndUnix: f.periodEnd ?? nowUnix() + 31 * 86400,
    subscriptionId: subRowId,
    stripeInvoiceId: invId,
  });
  await audit(admin, f.orgId, eventId, "invoice_paid", { subId, jti: issued.jti });
}

async function handleInvoiceFailed(admin: Admin, invoice: Stripe.Invoice, eventId: string) {
  const subId = invoiceSubId(invoice);
  if (!subId) return;
  // past_due + stamp; NO revoke (14-day dunning grace; a nightly cron downgrades
  // only past-grace).
  const { data } = await admin
    .from("subscriptions")
    .select("id, org_id, past_due_since")
    .eq("stripe_subscription_id", subId)
    .maybeSingle();
  const row = data as { id?: string; org_id?: string; past_due_since?: string | null } | null;
  if (!row?.id) return;
  await admin
    .from("subscriptions")
    .update({
      status: "past_due",
      past_due_since: row.past_due_since ?? new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", row.id);
  await audit(admin, row.org_id ?? null, eventId, "invoice_failed", { subId });
}

// ---------------------------------------------------------------------------

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
    console.error("[stripe/webhook] signature verification failed:", err);
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

  try {
    switch (event.type) {
      case "checkout.session.completed":
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
      case "invoice.paid":
        await handleInvoicePaid(admin, stripe, event.data.object as Stripe.Invoice, event.id, event.created);
        break;
      case "invoice.payment_failed":
        await handleInvoiceFailed(admin, event.data.object as Stripe.Invoice, event.id);
        break;
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
