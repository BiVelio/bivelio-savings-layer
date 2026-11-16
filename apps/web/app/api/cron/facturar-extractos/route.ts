import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type Stripe from "stripe";

import {
  claveIdempotencia,
  decidirCargo,
  descripcionDeLinea,
  ensayoDeCargo,
  medioDePagoParaLaFactura,
  metadataDeFactura,
  type EnsayoDeCargo,
  type ExtractoFacturable,
  type FuentesDeMedioDePago,
  type MedioDePago,
} from "@/lib/billing/facturacion";
import { alertar } from "@/lib/observabilidad/alerta";
import { getStripe } from "@/lib/stripe/client";
import { billingConfigured, catalogoDeComision } from "@/lib/stripe/env";
import { COLUMNAS_SUSCRIPCION_DEL_PERIODO, decidirComisionDelPeriodo, type SuscripcionEnElPeriodo } from "@/lib/billing/plan-de-la-org";
import { createAdminClient } from "@/lib/supabase/admin";
import { leerTodo } from "@/lib/supabase/leer-todo";

/**
 * Facturación de la comisión (día 1, una hora después del cierre — ver
 * apps/web/vercel.json): convierte en factura de Stripe el `cargo_eur` de cada
 * extracto cerrado del período. La factura se GENERA desde el extracto (línea,
 * importe y metadata salen de él); Stripe pone numeración, PDF, impuestos y el
 * cobro automático. EL MEDIO DE PAGO SE PASA EXPLÍCITAMENTE (el de la
 * suscripción de asientos, si no el predeterminado del cliente): una factura
 * suelta no lo hereda de Checkout, y sin él quedaba abierta (ver
 * medioDePagoDeLaOrg y lib/billing/facturacion.ts).
 *
 * IDEMPOTENTE POR DOS CANDADOS: la fila (org, período) de bvsala.cargos —
 * quien ya la tiene no se refactura — y las claves de idempotencia de Stripe,
 * que impiden la doble factura aunque esta tabla y este proceso fallen a la
 * vez. Relanzable a mano con el mismo Bearer y `?periodo=YYYY-MM`.
 *
 * FALLA CERRADO: sin CRON_SECRET o sin Stripe configurado, 501 y no toca nada.
 * Un fallo con UNA org no bloquea a las demás: se alerta y se sigue.
 *
 * SOLO SE FACTURA A QUIEN LLEVÓ UN PLAN CON COMISIÓN en el período del extracto
 * (lib/billing/plan-de-la-org.ts): Pro, Equipo, «Medir», sin suscripción o
 * Enterprise sin contrato con comisión no reciben factura aunque el extracto
 * traiga cargo.
 *
 * ENSAYO EN SECO (`?seco=1`, mismo Bearer): devuelve, por extracto, qué haría
 * (facturar/omitir/nada/exenta/sin_comision, céntimos, cliente y de dónde saldría el cobro)
 * sin crear nada en Stripe ni escribir en cargos. Solo LECTURAS de Stripe, y
 * ninguna alerta. Un `sin_comision` dice además si YA EXISTE un cargo de ese
 * período (`ya_facturado`, `cargo_existente`): es una factura emitida con la
 * regla anterior a quien hoy no la debería, candidata a abono
 * (scripts/auditoria-comision-indebida.mjs).
 *
 * LA RESPUESTA DICE POR QUÉ: `sin_comision` lista, también en real, los cargos
 * sellados que no se facturan y el motivo de la decisión. No hay columna donde
 * guardarlo: queda en la respuesta, en el registro y en la alerta.
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

/**
 * El medio de pago con el que se cobra la factura de comisión: el de la
 * suscripción de asientos (la más reciente con id de Stripe), si no el
 * predeterminado para facturas del cliente. Solo lecturas; cualquier fallo de
 * lectura cuenta como «sin medio» y el llamante lo grita.
 */
async function medioDePagoDeLaOrg(
  supabase: ReturnType<typeof createAdminClient>,
  stripe: Stripe,
  orgId: string,
  clienteStripe: string,
): Promise<MedioDePago> {
  let suscripcion: FuentesDeMedioDePago["suscripcion"] = null;
  const { data: fila } = await supabase
    .schema("bvsala")
    .from("subscriptions")
    .select("stripe_subscription_id, current_period_end")
    .eq("org_id", orgId)
    .not("stripe_subscription_id", "is", null)
    .order("current_period_end", { ascending: false, nullsFirst: false })
    .limit(1)
    .maybeSingle();
  const subId = (fila as { stripe_subscription_id?: string | null } | null)?.stripe_subscription_id ?? null;
  if (subId) {
    try {
      suscripcion = await stripe.subscriptions.retrieve(subId);
    } catch (err) {
      console.error(`[facturar-extractos] suscripción ${subId} ilegible en Stripe:`, err);
    }
  }
  let cliente: FuentesDeMedioDePago["cliente"] = null;
  try {
    const c = await stripe.customers.retrieve(clienteStripe);
    cliente = c.deleted ? null : (c as Stripe.Customer);
  } catch (err) {
    console.error(`[facturar-extractos] cliente ${clienteStripe} ilegible en Stripe:`, err);
  }
  return medioDePagoParaLaFactura({ suscripcion, cliente });
}

/** El período anterior al actual (el que cerró el cron de las 5:00). */
function periodoAnterior(ahora: Date): string {
  return new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!process.env.CRON_SECRET) {
    // FALLO CERRADO, PERO NO SILENCIOSO (2026-09-12).
    await alertar({ nivel: "critico", asunto: "cron facturar-extractos no ha corrido: CRON_SECRET sin definir", detalle: { ruta: "/api/cron/facturar-extractos" } });
    return NextResponse.json({ error: "Cron isn't configured (CRON_SECRET unset)." }, { status: 501 });
  }
  if (!autorizado(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!billingConfigured) return NextResponse.json({ error: "Stripe isn't configured (STRIPE_SECRET_KEY unset)." }, { status: 501 });

  const supabase = createAdminClient();
  const stripe = getStripe();
  const params = new URL(req.url).searchParams;
  const pedido = params.get("periodo");
  const periodo = pedido && /^\d{4}-\d{2}$/.test(pedido) ? pedido : periodoAnterior(new Date());
  const seco = params.get("seco") === "1";

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
    await alertar({
      nivel: "critico",
      asunto: "Facturación de la comisión NO ejecutada: no se pudieron leer los extractos",
      detalle: { periodo, motivo: error instanceof Error ? error.message : String(error) },
    });
    return NextResponse.json({ error: "extractos read failed" }, { status: 500 });
  }
  if (extractos.length === 0) return NextResponse.json({ periodo, seco, facturadas: 0, omitidas: 0 });

  // El candado local: cargos ya registrados de este período.
  let yaRegistrados: { org_id: unknown; estado?: unknown }[];
  try {
    yaRegistrados = await leerTodo<{ org_id: unknown; estado?: unknown }>(() =>
      supabase
        .schema("bvsala")
        .from("cargos")
        .select("org_id, estado")
        .eq("periodo", periodo)
        .order("org_id", { ascending: true }),
    );
  } catch (errCargos) {
    console.error("[facturar-extractos] lectura de cargos falló:", errCargos);
    await alertar({
      nivel: "critico",
      asunto: "Facturación de la comisión NO ejecutada: no se pudo leer el candado de cargos",
      detalle: { periodo, motivo: errCargos instanceof Error ? errCargos.message : String(errCargos) },
    });
    return NextResponse.json({ error: "cargos read failed" }, { status: 500 });
  }
  const conCargo = new Set(yaRegistrados.map((c) => String(c.org_id)));
  const estadoDelCargo = new Map(yaRegistrados.map((c) => [String(c.org_id), c.estado == null ? null : String(c.estado)]));
  /** Cargos sellados que NO se facturan por la decisión del plan, con su porqué. */
  const sinComision: Array<{ org_id: string; cargo_eur: number; motivo: string; revisar: boolean; cargo_existente: string | null }> = [];

  let facturadas = 0;
  let omitidas = 0;
  const fallos: string[] = [];
  const ensayo: EnsayoDeCargo[] = [];

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
        .select("stripe_customer_id, comision_exenta")
        .eq("id", e.org_id)
        .maybeSingle();
      const cliente = (org as { stripe_customer_id?: string | null } | null)?.stripe_customer_id ?? null;
      // SEGUNDA VERJA de la exención (la primera es el cargo 0 del cierre): una
      // cortesía marcada entre el cierre de las 05:00 y esta pasada de las 07:00
      // no se factura. Como la calibración, dos verjas.
      if ((org as { comision_exenta?: boolean } | null)?.comision_exenta) {
        if (seco) ensayo.push(ensayoDeCargo(e, "exenta", undefined));
        else console.warn(`[facturar-extractos] ${e.org_id} ${e.periodo}: organización exenta de comisión, no se factura`);
        continue;
      }
      // SEGUNDA VERJA DEL PLAN (lib/billing/plan-de-la-org.ts, LICENSE-CLOUD
      // §6(b)): solo se factura comisión a quien llevó una suscripción con Price
      // de comisión en ESE período — la misma decisión del cierre, repetida
      // aquí. No es redundante: un extracto sellado con la regla anterior (que
      // cobraba a quien había cancelado Pro) o relanzado a mano con `?periodo=`
      // trae `cargo_eur > 0` y esta verja es lo único que impide facturarlo.
      // Falla CERRADA: sin poder leer el plan no se factura.
      const { data: subs, error: errSubs } = await supabase
        .schema("bvsala")
        .from("subscriptions")
        .select(COLUMNAS_SUSCRIPCION_DEL_PERIODO)
        .eq("org_id", e.org_id);
      if (errSubs) throw new Error(`plan de ${e.org_id} ilegible: ${errSubs.message}`);
      const plan = decidirComisionDelPeriodo((subs ?? []) as SuscripcionEnElPeriodo[], catalogoDeComision(), e.periodo);
      if (!plan.comision) {
        const yaHayCargo = conCargo.has(e.org_id);
        const cargoExistente = estadoDelCargo.get(e.org_id) ?? null;
        sinComision.push({ org_id: e.org_id, cargo_eur: e.cargo_eur, motivo: plan.motivo, revisar: plan.revisar, cargo_existente: yaHayCargo ? cargoExistente : null });
        if (seco) {
          // Si ya hay cargo, el ensayo lo dice JUNTO al `sin_comision`: callarlo
          // escondería una factura ya emitida a quien hoy no la debería.
          ensayo.push(ensayoDeCargo(e, { accion: "sin_comision", motivo: plan.motivo, yaHayCargo, estadoDelCargo: cargoExistente }, undefined));
          continue;
        }
        console.warn(
          `[facturar-extractos] ${e.org_id} ${e.periodo}: cargo sellado de ${e.cargo_eur} € que NO se factura (${plan.motivo})` +
            (yaHayCargo ? ` — ya existe un cargo (${cargoExistente ?? "estado desconocido"})` : ""),
        );
        // Un extracto con cargo que no se convierte en factura no puede quedarse
        // en un warn. `revisar` (Price sin declarar, mes mixto) es crítico: el
        // cargo puede ser legítimo y se relanza al resolverlo. El resto es un
        // extracto sellado con la regla anterior, o un plan que cambió entre el
        // cierre y esta pasada: aviso.
        await alertar({
          nivel: plan.revisar ? "critico" : "aviso",
          asunto: plan.revisar
            ? "Cargo de comisión sellado SIN FACTURAR: el plan de la organización no se puede decidir — resolver y relanzar"
            : "Cargo de comisión sellado que no se factura: la organización no llevó un plan con comisión en el período",
          detalle: {
            orgId: e.org_id,
            periodo: e.periodo,
            cargoEur: e.cargo_eur,
            motivo: plan.motivo,
            ...(plan.revisar ? { precios: plan.precios } : {}),
            cargo_existente: yaHayCargo ? cargoExistente : null,
          },
        });
        continue;
      }

      const decision = decidirCargo(e, cliente, conCargo.has(e.org_id));
      if (seco) {
        const medio = decision.accion === "facturar" ? await medioDePagoDeLaOrg(supabase, stripe, e.org_id, decision.clienteStripe) : undefined;
        ensayo.push(ensayoDeCargo(e, decision, medio));
        continue;
      }
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
          // CRÍTICO (2026-09-13): un cargo con dinero que no se factura y solo
          // deja un aviso en el log es dinero que nadie va a reclamar.
          await alertar({
            nivel: "critico",
            asunto: "Cargo de comisión SIN cliente de Stripe: no se ha facturado",
            detalle: { orgId: e.org_id, periodo: e.periodo, cargoEur: e.cargo_eur },
          });
        }
        continue;
      }

      // 0) El medio de pago, explícito: una factura suelta no hereda el de
      //    Checkout. Sin ninguno se emite igual (el cliente puede pagarla desde el
      //    enlace alojado) pero se GRITA antes, no en la alerta de impago.
      const medio = await medioDePagoDeLaOrg(supabase, stripe, e.org_id, decision.clienteStripe);
      if (!medio) {
        await alertar({
          nivel: "critico",
          asunto: "Factura de comisión SIN medio de pago: quedará abierta y el cobro automático fallará",
          detalle: { orgId: e.org_id, periodo: e.periodo, cliente: decision.clienteStripe, centimos: decision.centimos },
        });
      }
      // 1) Borrador de factura con cobro automático. `pending_invoice_items_behavior:
      //    "exclude"`: SOLO lleva la línea que se le añade abajo — jamás arrastra
      //    items pendientes ajenos a este cargo.
      const factura = await stripe.invoices.create(
        {
          customer: decision.clienteStripe,
          ...(medio ? { default_payment_method: medio.id } : {}),
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
      if (seco) {
        // El ensayo no alerta: el fallo va en su respuesta.
        ensayo.push({ ...ensayoDeCargo(e, { accion: "nada", motivo: "sin_cargo" }, undefined), detalle: `FAILED: ${err instanceof Error ? err.message : String(err)}` });
        continue;
      }
      await alertar({
        nivel: "critico",
        asunto: "La facturación de la comisión está fallando",
        detalle: { orgId: e.org_id, periodo: e.periodo, motivo: err instanceof Error ? err.message : String(err) },
      });
    }
  }

  if (seco) return NextResponse.json({ periodo, seco: true, ensayo, sin_comision: sinComision });
  return NextResponse.json({ periodo, facturadas, omitidas, fallos: fallos.length, sin_comision: sinComision });
}
