import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import { orgsPagandoSinLicencia, type SubscriptionParaInvariante } from "@/lib/billing/invariantes";
import { alertar } from "@/lib/observabilidad/alerta";
import type { LicenseRow } from "@/lib/metering/entitlement";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * EL INVARIANTE: ¿hay alguien pagando y sin producto?
 *
 * Todas las redes que existen —`ensurePrimeraLicencia`, la guardia de orden, el
 * barrido de impago— son REACTIVAS: actúan cuando llega un evento de Stripe. Si
 * el evento no llega, o llega y su handler sale por un `return` mudo (los hay:
 * `handleInvoicePaid` abandona sin log si a la suscripción le falta el
 * `metadata.org_id`), nadie mira nunca. Esto es lo que mira.
 *
 * NO REPARA, DETECTA. Un invariante que se arregla solo esconde la causa, y la
 * causa es lo que hay que arreglar: emitir una licencia por detrás dejaría el
 * agujero abierto y sin rastro de que existió.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function autorizado(req: Request): boolean {
  const secreto = process.env.CRON_SECRET;
  if (!secreto) return false;
  const cabecera = req.headers.get("authorization") ?? "";
  const presentado = cabecera.startsWith("Bearer ") ? cabecera.slice(7).trim() : "";
  if (presentado.length === 0) return false;
  return timingSafeEqual(
    createHash("sha256").update(presentado).digest(),
    createHash("sha256").update(secreto).digest(),
  );
}

const PAGINA = 500;

export async function GET(req: Request): Promise<NextResponse> {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json({ error: "Cron isn't configured (CRON_SECRET unset)." }, { status: 501 });
  }
  if (!autorizado(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return NextResponse.json({ error: "store unavailable" }, { status: 503 });
  }

  // Se pagina: PostgREST corta en 1000 filas y no avisa. Un invariante que solo
  // mira las primeras mil orgs es un invariante que miente en cuanto creces.
  const subs: SubscriptionParaInvariante[] = [];
  for (let desde = 0; ; desde += PAGINA) {
    const { data, error } = await admin
      .from("subscriptions")
      .select("org_id, status, stripe_subscription_id")
      .order("org_id", { ascending: true })
      .range(desde, desde + PAGINA - 1);
    if (error) {
      console.error("[cron/invariantes] lectura de subscriptions falló:", error);
      return NextResponse.json({ error: "store unavailable" }, { status: 503 });
    }
    const lote = (data ?? []) as SubscriptionParaInvariante[];
    subs.push(...lote);
    if (lote.length < PAGINA) break;
  }

  // Las licencias de las orgs que interesan, en UNA consulta y no una por org.
  const orgsDeInteres = [...new Set(subs.map((s) => s.org_id))];
  const licenciasPorOrg = new Map<string, LicenseRow[]>();
  for (let i = 0; i < orgsDeInteres.length; i += 200) {
    const trozo = orgsDeInteres.slice(i, i + 200);
    const { data, error } = await admin
      .from("licenses")
      .select("org_id, revoked, expires_at, grace_days")
      .in("org_id", trozo);
    if (error) {
      console.error("[cron/invariantes] lectura de licenses falló:", error);
      return NextResponse.json({ error: "store unavailable" }, { status: 503 });
    }
    for (const fila of (data ?? []) as (LicenseRow & { org_id: string })[]) {
      licenciasPorOrg.set(fila.org_id, [...(licenciasPorOrg.get(fila.org_id) ?? []), fila]);
    }
  }

  const descubiertas = orgsPagandoSinLicencia(subs, licenciasPorOrg, Date.now());

  if (descubiertas.length > 0) {
    await alertar({
      nivel: "critico",
      asunto: `${descubiertas.length} organización(es) PAGANDO sin licencia viva`,
      detalle: {
        // Solo ids y estado: nada de tokens ni de datos personales.
        orgs: descubiertas.slice(0, 20).map((d) => ({
          org: d.orgId,
          status: d.status,
          sub: d.subId,
          // El diagnóstico empieza aquí: "nunca tuvo" apunta al camino de alta,
          // "las tuvo y las perdió" a una revocación indebida o a una renovación
          // que no se entregó.
          caso: d.tuvoYPerdio ? "tuvo licencias y las perdió" : "nunca se le emitió ninguna",
        })),
        deMas: Math.max(0, descubiertas.length - 20),
      },
    });
    try {
      await admin.from("billing_audit").insert(
        descubiertas.map((d) => ({
          org_id: d.orgId,
          event_id: `invariante_${Date.now()}`,
          kind: "invariante_pagando_sin_licencia",
          detail: { status: d.status, subId: d.subId, licencias: d.licencias, tuvoYPerdio: d.tuvoYPerdio },
        })),
      );
    } catch (err) {
      console.error("[cron/invariantes] no se pudo dejar rastro:", err);
    }
  }

  return NextResponse.json(
    {
      suscripciones: subs.length,
      descubiertas: descubiertas.length,
      // El 503 hace que Vercel marque el cron en rojo, que es una segunda vía de
      // aviso además del webhook — por si el webhook es justo lo que está roto.
      ok: descubiertas.length === 0,
    },
    { status: descubiertas.length === 0 ? 200 : 503 },
  );
}
