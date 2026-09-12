import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

import {
  claveIdempotencia,
  decidirCargo,
  descripcionDeLinea,
  metadataDeFactura,
  type ExtractoFacturable,
} from "@/lib/billing/facturacion";
import { alertar } from "@/lib/observabilidad/alerta";
import { getStripe } from "@/lib/stripe/client";
import { billingConfigured } from "@/lib/stripe/env";
import { createAdminClient } from "@/lib/supabase/admin";
import { leerTodo } from "@/lib/supabase/leer-todo";

/**
 * Facturación de la comisión (día 1, una hora después del cierre — ver
 * apps/web/vercel.json): convierte en factura de Stripe el `cargo_eur` de cada
 * extracto cerrado del período. La factura se GENERA desde el extracto (línea,
 * importe y metadata salen de él); Stripe pone numeración, PDF, impuestos y el
 * cobro automático al medio de pago de la suscripción de asientos.
 *
 * IDEMPOTENTE POR DOS CANDADOS: la fila (org, período) de bvsala.cargos —
 * quien ya la tiene no se refactura — y las claves de idempotencia de Stripe,
 * que impiden la doble factura aunque esta tabla y este proceso fallen a la
 * vez. Relanzable a mano con el mismo Bearer y `?periodo=YYYY-MM`.
 *
 * FALLA CERRADO: sin CRON_SECRET o sin Stripe configurado, 501 y no toca nada.
 * Un fallo con UNA org no bloquea a las demás: se alerta y se sigue.
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

/** El período anterior al actual (el que cerró el cron de las 5:00). */
function periodoAnterior(ahora: Date): string {
  return new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!process.env.CRON_SECRET) {
    // FALLO CERRADO, PERO NO SILENCIOSO (2026-09-12).
    await alertar({ nivel: "critico", asunto: "cron facturar-extractos no ha corrido: CRON_SECRET sin definir", detalle: { ruta: "/api/cron/facturar-extractos" } });
    return NextResponse.json({ error: "cron sin configurar" }, { status: 501 });
  }
  if (!autorizado(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!billingConfigured) return NextResponse.json({ error: "stripe sin configurar" }, { status: 501 });

  const supabase = createAdminClient();
  const stripe = getStripe();
  const pedido = new URL(req.url).searchParams.get("periodo");
  const periodo = pedido && /^\d{4}-\d{2}$/.test(pedido) ? pedido : periodoAnterior(new Date());

  // Los extractos del período. Se leen TODOS los de cargo > 0 aunque luego se
  // omitan: la omisión con causa también se registra. PAGINADO: con >1000
  // extractos con cargo, un select a secas se dejaría orgs SIN facturar en
  // silencio (PostgREST corta a 1000). Igual para cargos, abajo.
  let extractos: ExtractoFacturable[];
  try {
    extractos = await leerTodo<ExtractoFacturable>(() =>
      supabase
        .schema("bvsala")
        .from("extractos")
        .select("org_id, periodo, es_calibracion, cargo_eur, ahorro_medido_eur, base_medida_eur, ratio")
        .eq("periodo", periodo)
        .gt("cargo_eur", 0)
        // Orden estable para la paginación por OFFSET (ver cierre-extractos).
        .order("org_id", { ascending: true }),
    );
  } catch (error) {
    console.error("[facturar-extractos] lectura de extractos falló:", error);
    return NextResponse.json({ error: "extractos read failed" }, { status: 500 });
  }
  if (extractos.length === 0) return NextResponse.json({ periodo, facturadas: 0, omitidas: 0 });

  // El candado local: cargos ya registrados de este período.
  let yaRegistrados: { org_id: unknown }[];
  try {
    yaRegistrados = await leerTodo<{ org_id: unknown }>(() =>
      supabase
        .schema("bvsala")
        .from("cargos")
        .select("org_id")
        .eq("periodo", periodo)
        .order("org_id", { ascending: true }),
    );
  } catch (errCargos) {
    console.error("[facturar-extractos] lectura de cargos falló:", errCargos);
    return NextResponse.json({ error: "cargos read failed" }, { status: 500 });
  }
  const conCargo = new Set(yaRegistrados.map((c) => String(c.org_id)));

  let facturadas = 0;
  let omitidas = 0;
  const fallos: string[] = [];

  for (const fila of extractos) {
    const e: ExtractoFacturable = {
      org_id: String(fila.org_id),
      periodo: String(fila.periodo),
      es_calibracion: Boolean(fila.es_calibracion),
      cargo_eur: Number(fila.cargo_eur ?? 0),
      ahorro_medido_eur: Number(fila.ahorro_medido_eur ?? 0),
      base_medida_eur: Number(fila.base_medida_eur ?? 0),
      ratio: Number(fila.ratio ?? 0),
    };
    try {
      // El cliente de Stripe: el de la organización (0001). El webhook de la
      // suscripción de asientos lo mantiene; una org sin él no tiene medio de
      // pago y se registra como omitida — el panel y la alerta lo enseñan.
      const { data: org } = await supabase
        .schema("bvsala")
        .from("organizations")
        .select("stripe_customer_id")
        .eq("id", e.org_id)
        .maybeSingle();
      const cliente = (org as { stripe_customer_id?: string | null } | null)?.stripe_customer_id ?? null;

      const decision = decidirCargo(e, cliente, conCargo.has(e.org_id));
      if (decision.accion === "nada") continue;

      if (decision.accion === "omitir") {
        await supabase.schema("bvsala").from("cargos").upsert(
          {
            org_id: e.org_id,
            periodo: e.periodo,
            importe_eur: e.cargo_eur,
            estado: decision.estado,
            detalle: { motivo: decision.estado },
          },
          { onConflict: "org_id,periodo", ignoreDuplicates: true },
        );
        omitidas += 1;
        if (decision.estado === "omitido_sin_cliente") {
          await alertar({
            nivel: "aviso",
            asunto: "Cargo de comisión SIN cliente de Stripe: no se ha facturado",
            detalle: { orgId: e.org_id, periodo: e.periodo, cargoEur: e.cargo_eur },
          });
        }
        continue;
      }

      // 1) Borrador de factura con cobro automático. `pending_invoice_items_behavior:
      //    "exclude"`: SOLO lleva la línea que se le añade abajo — jamás arrastra
      //    items pendientes ajenos a este cargo.
      const factura = await stripe.invoices.create(
        {
          customer: decision.clienteStripe,
          currency: "eur",
          collection_method: "charge_automatically",
          auto_advance: true,
          pending_invoice_items_behavior: "exclude",
          metadata: metadataDeFactura(e),
          description: `BV-SALA savings commission — ${e.periodo}`,
        },
        { idempotencyKey: claveIdempotencia(e.org_id, e.periodo, "factura") },
      );
      // 2) La única línea, generada desde el extracto.
      await stripe.invoiceItems.create(
        {
          customer: decision.clienteStripe,
          invoice: factura.id,
          amount: decision.centimos,
          currency: "eur",
          description: descripcionDeLinea(e),
          metadata: metadataDeFactura(e),
        },
        { idempotencyKey: claveIdempotencia(e.org_id, e.periodo, "linea") },
      );
      // 3) Finalizar: Stripe numera, genera el PDF y cobra (auto_advance).
      const final = await stripe.invoices.finalizeInvoice(factura.id!);

      const { error: errInsert } = await supabase.schema("bvsala").from("cargos").upsert(
        {
          org_id: e.org_id,
          periodo: e.periodo,
          importe_eur: e.cargo_eur,
          estado: "facturado",
          stripe_invoice_id: final.id,
          // La URL alojada y el PDF van al detalle porque el panel los enlaza:
          // el cliente audita su factura desde el historial, sin pedirla a nadie.
          detalle: {
            numero: final.number ?? null,
            centimos: decision.centimos,
            hosted_invoice_url: final.hosted_invoice_url ?? null,
            invoice_pdf: final.invoice_pdf ?? null,
          },
        },
        { onConflict: "org_id,periodo", ignoreDuplicates: true },
      );
      // La factura EXISTE aunque la fila no se pudiera escribir: eso es lo que
      // hay que gritar, porque el candado local quedaría cojo (el de Stripe no).
      if (errInsert) {
        await alertar({
          nivel: "critico",
          asunto: "Factura de comisión emitida pero el cargo NO quedó registrado",
          detalle: { orgId: e.org_id, periodo: e.periodo, invoiceId: final.id, motivo: errInsert.message },
        });
      }
      facturadas += 1;
    } catch (err) {
      fallos.push(e.org_id);
      console.error(`[facturar-extractos] la org ${e.org_id} falló:`, err);
      await alertar({
        nivel: "critico",
        asunto: "La facturación de la comisión está fallando",
        detalle: { orgId: e.org_id, periodo: e.periodo, motivo: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  return NextResponse.json({ periodo, facturadas, omitidas, fallos: fallos.length });
}
