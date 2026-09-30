import { createHash, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import type Stripe from "stripe";

import { periodoAnterior } from "@/lib/billing/cierre";
import {
  claveIdempotenciaAsientos,
  comportamientoHaciaDelante,
  decidirAjuste,
  descripcionDelAjuste,
  esEstadoFinal,
  esItemDelAjuste,
  metadataDelAjuste,
  modoDeCobro,
  planYPeriodoDelPrecio,
  tarifaDelPlan,
  type AjusteParaStripe,
  type DecisionDeAjuste,
  type EstadoDeAjuste,
  type PreciosPorPeriodo,
} from "@/lib/billing/cobro-asientos";
import { ESTADOS_CON_PLAN } from "@/lib/billing/plan-de-la-org";
import { tarifaDeEquipoDesdeTramos, type PeriodoDePago, type PlanDePago } from "@/lib/billing/planes";
import { alertar } from "@/lib/observabilidad/alerta";
import { getStripe } from "@/lib/stripe/client";
import {
  billingConfigured,
  STRIPE_PRICE_ID_MONTHLY,
  STRIPE_PRICE_ID_PRO_MONTHLY,
  STRIPE_PRICE_ID_PRO_YEARLY,
  STRIPE_PRICE_ID_TEAM_MONTHLY,
  STRIPE_PRICE_ID_TEAM_YEARLY,
  STRIPE_PRICE_ID_YEARLY,
} from "@/lib/stripe/env";
import { PRECIO_RESPALDO } from "@/lib/stripe/pricing";
import { createAdminClient } from "@/lib/supabase/admin";
import { esTablaInexistente, type ErrorDePostgrest } from "@/lib/supabase/esquema-pendiente";
import { leerTodo } from "@/lib/supabase/leer-todo";

/**
 * EL COBRO DE LOS ASIENTOS USADOS DE MÁS (día 1, 07:30 UTC — ver
 * apps/web/vercel.json). Para cada organización con suscripción viva: compara
 * los asientos USADOS en el mes cerrado (`billable_seats`) con los PAGADOS (la
 * `quantity`), y cobra el exceso con un invoice item de Stripe al precio real
 * de su plan. La decisión es pura (lib/billing/cobro-asientos.ts); aquí solo se
 * ejecuta.
 *
 * POR QUÉ UN CRON APARTE y no dentro de facturar-extractos: aquella ruta es la
 * de la COMISIÓN, con su tabla (cargos), sus verjas y sus facturas sueltas con
 * `pending_invoice_items_behavior: "exclude"` — que, justamente, garantiza que
 * no se trague un item de asientos pendiente—. Mezclarlas obligaba a tocar el
 * cobro de la comisión, y un fallo de una tumbaría la otra. Va a las 07:30,
 * después del cierre (05:00) y de la comisión (07:00): no depende de ninguno,
 * pero así las alertas del día 1 llegan en orden.
 *
 * NUNCA DOS VECES: la fila (org, período) de bvsala.ajustes_asientos (0034) se
 * escribe `pendiente` ANTES de crear nada en Stripe; un `cobrado` no se vuelve
 * a tocar. El reintento de un `pendiente`/`fallido` usa LAS CIFRAS DE LA FILA,
 * busca primero en Stripe un item con su metadata (por si el primer intento
 * cobró y murió antes de apuntarlo) y usa la misma clave de idempotencia.
 *
 * PRIMER CICLO EN SECO: `BVSALA_COBRO_ASIENTOS` = `seco` (por defecto) calcula,
 * registra filas `seco` y devuelve el informe sin tocar Stripe; `vivo` cobra.
 * `?seco=1` fuerza el ensayo aunque la variable diga `vivo`. `?periodo=YYYY-MM`
 * relanza un mes concreto (idempotente).
 *
 * FALLA CERRADO: sin CRON_SECRET, 501 con alerta; en `vivo` sin Stripe, 501;
 * sin la tabla de 0034, 503 con alerta. Un fallo con UNA org no para a las demás.
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

type Admin = ReturnType<typeof createAdminClient>;

interface FilaSuscripcion {
  org_id: string;
  status: string;
  seats: number | null;
  price_id: string | null;
  stripe_subscription_id: string | null;
  stripe_item_id: string | null;
  stripe_customer_id: string | null;
}

interface FilaAjuste {
  org_id: string;
  periodo: string;
  plan: PlanDePago;
  periodo_pago: PeriodoDePago | null;
  stripe_subscription_id: string | null;
  usados: number;
  pagados: number;
  exceso: number;
  importe_eur: number | string;
  estado: EstadoDeAjuste;
  stripe_invoice_item_id: string | null;
  motivo: string;
}

/** Una línea del informe (lo que se revisa el día 1 antes de pasar a `vivo`). */
interface LineaDelInforme {
  org_id: string;
  plan: PlanDePago | null;
  periodo_pago: PeriodoDePago | null;
  usados: number | null;
  pagados: number | null;
  exceso: number;
  importe_eur: number;
  /** Lo que se hizo (o se haría, en seco). */
  resultado: "nada" | "ya_registrado" | "cobraria" | EstadoDeAjuste;
  motivo: string;
}

const COLUMNAS_AJUSTE =
  "org_id, periodo, plan, periodo_pago, stripe_subscription_id, usados, pagados, exceso, importe_eur, estado, stripe_invoice_item_id, motivo";

function preciosPorPeriodo(): PreciosPorPeriodo {
  return {
    pro: { monthly: STRIPE_PRICE_ID_PRO_MONTHLY, yearly: STRIPE_PRICE_ID_PRO_YEARLY },
    equipo: { monthly: STRIPE_PRICE_ID_TEAM_MONTHLY, yearly: STRIPE_PRICE_ID_TEAM_YEARLY },
    comision: { monthly: STRIPE_PRICE_ID_MONTHLY, yearly: STRIPE_PRICE_ID_YEARLY },
  };
}

const RESPALDO_COMISION = { monthly: PRECIO_RESPALDO.monthly, yearly: PRECIO_RESPALDO.yearly };

function motivoDeError(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object" && "message" in err) return String((err as { message: unknown }).message);
  return String(err);
}

export async function GET(req: Request): Promise<NextResponse> {
  if (!process.env.CRON_SECRET) {
    await alertar({ nivel: "critico", asunto: "cron cobrar-asientos no ha corrido: CRON_SECRET sin definir", detalle: { ruta: "/api/cron/cobrar-asientos" } });
    return NextResponse.json({ error: "Cron isn't configured (CRON_SECRET unset)." }, { status: 501 });
  }
  if (!autorizado(req)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const params = new URL(req.url).searchParams;
  const pedido = params.get("periodo");
  const periodo = pedido && /^\d{4}-\d{2}$/.test(pedido) ? pedido : periodoAnterior(new Date());
  const modo = modoDeCobro(process.env.BVSALA_COBRO_ASIENTOS, params.get("seco") === "1");
  if (modo === "vivo" && !billingConfigured) {
    return NextResponse.json({ error: "Stripe isn't configured (STRIPE_SECRET_KEY unset)." }, { status: 501 });
  }
  const desde = `${periodo}-01`;
  const [y, m] = periodo.split("-").map(Number);
  const hasta = new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 10);

  const supabase = createAdminClient();
  const bv = () => supabase.schema("bvsala");

  // 1) El candado: los ajustes ya registrados de este período. Sin la tabla
  //    (0034 sin aplicar) no se cobra NADA: sin candado no hay «una sola vez».
  let registrados: FilaAjuste[];
  try {
    registrados = await leerTodo<FilaAjuste>(() =>
      bv().from("ajustes_asientos").select(COLUMNAS_AJUSTE).eq("periodo", periodo).order("org_id", { ascending: true }),
    );
  } catch (error) {
    const faltaTabla = esTablaInexistente(error as ErrorDePostgrest);
    await alertar({
      nivel: "critico",
      asunto: faltaTabla
        ? "Cobro de asientos NO ejecutado: falta aplicar la migración 0034 (ajustes_asientos)"
        : "Cobro de asientos NO ejecutado: no se pudo leer ajustes_asientos",
      detalle: { periodo, motivo: motivoDeError(error) },
    });
    return NextResponse.json({ error: "ajustes_asientos unavailable", periodo }, { status: 503 });
  }
  const porOrg = new Map(registrados.map((r) => [String(r.org_id), r]));

  // 2) Las suscripciones vivas, agrupadas por organización.
  let subs: FilaSuscripcion[];
  try {
    subs = await leerTodo<FilaSuscripcion>(() =>
      bv()
        .from("subscriptions")
        .select("org_id, status, seats, price_id, stripe_subscription_id, stripe_item_id, stripe_customer_id")
        .in("status", [...ESTADOS_CON_PLAN])
        .order("org_id", { ascending: true }),
    );
  } catch (error) {
    await alertar({ nivel: "critico", asunto: "Cobro de asientos NO ejecutado: no se pudieron leer las suscripciones", detalle: { periodo, motivo: motivoDeError(error) } });
    return NextResponse.json({ error: "subscriptions read failed", periodo }, { status: 500 });
  }
  const subsPorOrg = new Map<string, FilaSuscripcion[]>();
  for (const s of subs) subsPorOrg.set(String(s.org_id), [...(subsPorOrg.get(String(s.org_id)) ?? []), s]);

  const precios = preciosPorPeriodo();
  const stripe = modo === "vivo" ? getStripe() : null;
  const informe: LineaDelInforme[] = [];
  const revision: Array<{ orgId: string; motivo: string }> = [];
  const fallos: string[] = [];
  let cobrados = 0;

  // Las orgs con suscripción viva y, además, las que tienen un ajuste a medias
  // de este período (su suscripción pudo cancelarse después de apuntarlo).
  const orgs = new Set<string>([...subsPorOrg.keys(), ...[...porOrg.values()].filter((r) => !esEstadoFinal(r.estado) && r.estado !== "seco").map((r) => String(r.org_id))]);

  for (const orgId of [...orgs].sort()) {
    const previa = porOrg.get(orgId) ?? null;
    try {
      // ── Ya decidido: no se toca. ─────────────────────────────────────────
      if (previa && esEstadoFinal(previa.estado)) {
        informe.push(lineaDeFila(previa, "ya_registrado"));
        continue;
      }
      // ── A medias (pendiente/fallido): se reintenta CON LAS CIFRAS DE LA FILA. ─
      if (previa && (previa.estado === "pendiente" || previa.estado === "fallido")) {
        if (modo === "seco") {
          informe.push(lineaDeFila(previa, previa.estado));
          continue;
        }
        const sub = elegirSuscripcion(subsPorOrg.get(orgId) ?? [], previa.stripe_subscription_id);
        const resultado = await cobrar(supabase, stripe!, ajusteDeFila(previa), sub, previa.stripe_subscription_id, true);
        if (resultado === "cobrado") cobrados += 1;
        else fallos.push(orgId);
        informe.push(lineaDeFila(previa, resultado));
        continue;
      }

      // ── Nuevo (o ensayo previo en seco): se calcula. ───────────────────────
      const lista = subsPorOrg.get(orgId) ?? [];
      const sub = lista[0]!;
      const plan = planYPeriodoDelPrecio(sub.price_id, precios);
      const pagados = Math.max(0, Number(sub.seats ?? 0));

      const { data: usadosCrudo, error: errSeats } = await supabase.rpc("billable_seats", { p_org: orgId, p_month: desde });
      if (errSeats) throw new Error(`billable_seats: ${errSeats.message}`);
      const usados = Math.max(0, Number(usadosCrudo ?? 0));

      const uso = await leerTodo<{ requests: number | null }>(() =>
        bv().from("usage_daily").select("requests").eq("org_id", orgId).gte("day", desde).lt("day", hasta).order("day", { ascending: true }),
      );
      const requests = uso.reduce((n, r) => n + Number(r.requests ?? 0), 0);

      const { data: revocadas, error: errRot } = await bv()
        .from("billing_audit")
        .select("id")
        .eq("org_id", orgId)
        .eq("kind", "service_account_revoked")
        .gte("at", `${desde}T00:00:00Z`)
        .lt("at", `${hasta}T00:00:00Z`)
        .limit(1);
      // Ante la duda, se ASUME rotación (asientos-usados.ts): el peor error aquí
      // es cobrar un recuento inflado.
      const rotacionEnElMes = errRot ? true : (revocadas ?? []).length > 0;

      const decision = decidirAjuste({
        usados,
        pagados,
        requests,
        status: sub.status,
        plan,
        rotacionEnElMes,
        variasSuscripciones: lista.length > 1,
        respaldoComision: RESPALDO_COMISION,
      });
      if (decision.accion === "nada") {
        informe.push({ org_id: orgId, plan: plan?.plan ?? null, periodo_pago: plan?.periodoPago ?? null, usados, pagados, exceso: 0, importe_eur: 0, resultado: "nada", motivo: decision.motivo });
        continue;
      }

      const base = {
        org_id: orgId,
        periodo,
        plan: plan?.plan ?? "comision",
        periodo_pago: plan?.periodoPago ?? null,
        stripe_subscription_id: sub.stripe_subscription_id,
        usados,
        pagados,
        exceso: decision.exceso,
        importe_eur: decision.centimos / 100,
      };

      if (decision.accion === "registrar" && decision.estado === "revision_humana") {
        revision.push({ orgId, motivo: decision.motivo });
      }

      // ── SECO: se apunta el ensayo y NO se toca Stripe. ────────────────────
      if (modo === "seco") {
        const { error } = await bv()
          .from("ajustes_asientos")
          .upsert({ ...base, estado: "seco", motivo: motivoDelEnsayo(decision) }, { onConflict: "org_id,periodo" });
        if (error) throw new Error(`ajustes_asientos (seco): ${error.message}`);
        informe.push(lineaDeBase(base, decision.accion === "cobrar" ? "cobraria" : decision.estado, decision.motivo));
        continue;
      }

      // ── VIVO: lo que no se cobra se apunta con su causa, y se acabó. ──────
      if (decision.accion === "registrar") {
        await fijar(supabase, previa, { ...base, estado: decision.estado, motivo: decision.motivo });
        informe.push(lineaDeBase(base, decision.estado, decision.motivo));
        continue;
      }

      // ── VIVO, a cobrar: antes de escribir en Stripe, LEER Stripe. ─────────
      // La suscripción tiene que seguir activa, con la cantidad y el price que
      // dice el espejo, y el Price tiene que costar lo que dicen las constantes:
      // si algo no cuadra, se cobra a mano o no se cobra, nunca a ciegas.
      const verificacion = await verificarEnStripe(stripe!, sub, plan!, pagados);
      if (verificacion) {
        if (verificacion.estado === "revision_humana") revision.push({ orgId, motivo: verificacion.motivo });
        await fijar(supabase, previa, { ...base, estado: verificacion.estado, motivo: verificacion.motivo });
        informe.push(lineaDeBase(base, verificacion.estado, verificacion.motivo));
        continue;
      }

      // El candado ANTES del cobro. Si otra ejecución ganó la carrera, `fijar`
      // lanza y esta org se salta: la otra la está cobrando.
      await fijar(supabase, previa, { ...base, estado: "pendiente", motivo: "" });
      const ajuste: AjusteParaStripe = {
        orgId,
        periodo,
        plan: plan!.plan,
        periodoPago: plan!.periodoPago,
        usados,
        pagados,
        exceso: decision.exceso,
        centimos: decision.centimos,
      };
      const resultado = await cobrar(supabase, stripe!, ajuste, sub, sub.stripe_subscription_id, false);
      if (resultado === "cobrado") cobrados += 1;
      else fallos.push(orgId);
      informe.push(lineaDeBase(base, resultado, decision.motivo));
    } catch (err) {
      fallos.push(orgId);
      console.error(`[cobrar-asientos] la org ${orgId} falló:`, err);
      await alertar({
        nivel: "critico",
        asunto: "El cobro de asientos está fallando",
        detalle: { orgId, periodo, modo, motivo: motivoDeError(err) },
      });
    }
  }

  // La revisión humana, por el mismo canal que los invariantes: una alerta
  // crítica (llega por correo) con la lista, no una por org.
  if (revision.length > 0) {
    await alertar({
      nivel: "critico",
      asunto: `${revision.length} organización(es) con asientos para REVISIÓN HUMANA: el recuento no es fiable y no se ha cobrado`,
      detalle: { periodo, modo, orgs: revision.slice(0, 20), deMas: Math.max(0, revision.length - 20) },
    });
  }

  return NextResponse.json({
    periodo,
    modo,
    cobrados,
    revision: revision.length,
    fallos: fallos.length,
    informe,
  });
}

// ─────────────────────────────────────────────────────────────────────────────

function elegirSuscripcion(lista: FilaSuscripcion[], subId: string | null): FilaSuscripcion | null {
  return lista.find((s) => s.stripe_subscription_id === subId) ?? null;
}

function ajusteDeFila(f: FilaAjuste): AjusteParaStripe {
  return {
    orgId: String(f.org_id),
    periodo: String(f.periodo),
    plan: f.plan,
    periodoPago: f.periodo_pago ?? "monthly",
    usados: Number(f.usados),
    pagados: Number(f.pagados),
    exceso: Number(f.exceso),
    centimos: Math.round(Number(f.importe_eur) * 100),
  };
}

function lineaDeFila(f: FilaAjuste, resultado: LineaDelInforme["resultado"]): LineaDelInforme {
  return {
    org_id: String(f.org_id),
    plan: f.plan,
    periodo_pago: f.periodo_pago,
    usados: Number(f.usados),
    pagados: Number(f.pagados),
    exceso: Number(f.exceso),
    importe_eur: Number(f.importe_eur),
    resultado,
    motivo: f.motivo ?? "",
  };
}

function lineaDeBase(
  b: { org_id: string; plan: PlanDePago; periodo_pago: PeriodoDePago | null; usados: number; pagados: number; exceso: number; importe_eur: number },
  resultado: LineaDelInforme["resultado"],
  motivo: string,
): LineaDelInforme {
  return { org_id: b.org_id, plan: b.plan, periodo_pago: b.periodo_pago, usados: b.usados, pagados: b.pagados, exceso: b.exceso, importe_eur: b.importe_eur, resultado, motivo };
}

function motivoDelEnsayo(d: Exclude<DecisionDeAjuste, { accion: "nada" }>): string {
  return d.accion === "cobrar" ? `would charge: ${d.motivo}` : `would record ${d.estado}: ${d.motivo}`;
}

/**
 * Escribe la fila del ajuste: INSERT si no había ninguna; si había un ensayo
 * `seco`, lo sustituye SOLO si sigue siendo `seco` (compare-and-set). Si otra
 * ejecución se adelantó, lanza — y esta org no se cobra en esta pasada.
 */
async function fijar(supabase: Admin, previa: FilaAjuste | null, fila: Record<string, unknown>): Promise<void> {
  const tabla = () => supabase.schema("bvsala").from("ajustes_asientos");
  if (!previa) {
    const { error } = await tabla().insert(fila);
    if (error) throw new Error(`ajustes_asientos insert (${(error as ErrorDePostgrest).code ?? "?"}): ${error.message}`);
    return;
  }
  const { data, error } = await tabla()
    .update(fila)
    .eq("org_id", fila.org_id as string)
    .eq("periodo", fila.periodo as string)
    .eq("estado", "seco")
    .select("org_id");
  if (error) throw new Error(`ajustes_asientos update: ${error.message}`);
  if (((data ?? []) as unknown[]).length === 0) throw new Error("ajustes_asientos: another run took this adjustment");
}

/**
 * La lectura previa en Stripe (solo lecturas). Devuelve `null` si todo cuadra,
 * o el estado con el que se apunta la org si no.
 */
async function verificarEnStripe(
  stripe: Stripe,
  sub: FilaSuscripcion,
  plan: { plan: PlanDePago; periodoPago: PeriodoDePago },
  pagados: number,
): Promise<{ estado: "revision_humana" | "omitido_no_activa"; motivo: string } | null> {
  if (!sub.stripe_subscription_id || !sub.stripe_customer_id) {
    return { estado: "revision_humana", motivo: "subscription without Stripe ids in the mirror" };
  }
  const real = await stripe.subscriptions.retrieve(sub.stripe_subscription_id, { expand: ["items.data.price.tiers"] });
  if (real.status !== "active") return { estado: "omitido_no_activa", motivo: `subscription ${real.status} in Stripe` };
  const items = real.items?.data ?? [];
  if (items.length !== 1) return { estado: "revision_humana", motivo: `subscription has ${items.length} items` };
  const item = items[0]!;
  if (sub.stripe_item_id && item.id !== sub.stripe_item_id) return { estado: "revision_humana", motivo: "subscription item differs from the mirror" };
  if (item.price?.id !== sub.price_id) return { estado: "revision_humana", motivo: "price differs from the mirror" };
  if ((item.quantity ?? 0) !== pagados) {
    return { estado: "revision_humana", motivo: `paid seats differ: mirror ${pagados}, Stripe ${item.quantity ?? 0}` };
  }
  // El Price cuesta lo que dicen las constantes (Pro/Equipo) o el respaldo (comisión).
  const esperada = tarifaDelPlan(plan.plan, plan.periodoPago, RESPALDO_COMISION);
  const precio = item.price;
  const leida =
    precio.billing_scheme === "tiered"
      ? tarifaDeEquipoDesdeTramos(precio.tiers ?? null, precio.currency)
      : typeof precio.unit_amount === "number"
        ? { fijaCentimos: 0, asientosIncluidos: 0, asientoCentimos: precio.unit_amount, currency: precio.currency }
        : null;
  if (
    !leida ||
    leida.currency !== esperada.currency ||
    leida.fijaCentimos !== esperada.fijaCentimos ||
    leida.asientosIncluidos !== esperada.asientosIncluidos ||
    leida.asientoCentimos !== esperada.asientoCentimos
  ) {
    return { estado: "revision_humana", motivo: "Stripe price does not match the published plan price" };
  }
  return null;
}

/**
 * EL COBRO: el invoice item del importe exacto en la suscripción y, hacia
 * delante, lo que diga `comportamientoHaciaDelante`. Siempre deja la fila en
 * `cobrado` o `fallido` (nunca la deja `pendiente` salvo que la propia escritura
 * de la fila falle, y eso se grita).
 */
async function cobrar(
  supabase: Admin,
  stripe: Stripe,
  a: AjusteParaStripe,
  sub: FilaSuscripcion | null,
  subId: string | null,
  esReintento: boolean,
): Promise<"cobrado" | "fallido"> {
  const tabla = () => supabase.schema("bvsala").from("ajustes_asientos");
  const marcar = async (cambios: Record<string, unknown>): Promise<void> => {
    const { error } = await tabla().update(cambios).eq("org_id", a.orgId).eq("periodo", a.periodo).in("estado", ["pendiente", "fallido"]);
    if (error) {
      await alertar({
        nivel: "critico",
        asunto: "Ajuste de asientos: Stripe respondió pero la fila NO quedó registrada",
        detalle: { orgId: a.orgId, periodo: a.periodo, cambios, motivo: error.message },
      });
    }
  };

  let itemId: string;
  try {
    const cliente = sub?.stripe_customer_id ?? null;
    if (!cliente || !subId) throw new Error("no Stripe customer/subscription for this adjustment");
    // Tercer candado, para el reintento: si el primer intento creó el item y
    // murió antes de apuntarlo (y ya caducó la idempotencia de Stripe, 24 h),
    // el item está ahí con su metadata. Se adopta en vez de crear otro.
    let existente: string | null = null;
    if (esReintento) {
      const lista = await stripe.invoiceItems.list({ customer: cliente, limit: 100 });
      existente = lista.data.find((it) => esItemDelAjuste(it.metadata, a.orgId, a.periodo))?.id ?? null;
    }
    if (existente) {
      itemId = existente;
    } else {
      const item = await stripe.invoiceItems.create(
        {
          customer: cliente,
          subscription: subId,
          amount: a.centimos,
          currency: "eur",
          description: descripcionDelAjuste(a),
          metadata: metadataDelAjuste(a),
        },
        { idempotencyKey: claveIdempotenciaAsientos(a.orgId, a.periodo, "item") },
      );
      itemId = item.id;
    }
  } catch (err) {
    await marcar({ estado: "fallido", motivo: `stripe: ${motivoDeError(err)}` });
    await alertar({
      nivel: "critico",
      asunto: "Cobro de asientos FALLIDO en Stripe: se reintenta en la próxima pasada sin duplicar",
      detalle: { orgId: a.orgId, periodo: a.periodo, centimos: a.centimos, motivo: motivoDeError(err) },
    });
    return "fallido";
  }

  // El item EXISTE: el ajuste está cobrado (irá en la factura). Lo que venga
  // detrás es hacia delante; si falla, se avisa, pero no se descobra.
  const detalle: Record<string, unknown> = { centimos: a.centimos };
  const haciaDelante = comportamientoHaciaDelante(a.periodoPago);
  try {
    if (haciaDelante.facturarYa) {
      const factura = await stripe.invoices.create(
        {
          customer: sub!.stripe_customer_id!,
          subscription: subId!,
          collection_method: "charge_automatically",
          auto_advance: true,
          pending_invoice_items_behavior: "include",
          metadata: metadataDelAjuste(a),
          description: `BV-SALA seats used above your subscription — ${a.periodo}`,
        },
        { idempotencyKey: claveIdempotenciaAsientos(a.orgId, a.periodo, "factura") },
      );
      detalle.factura = factura.id ?? null;
      if (factura.id && factura.status === "draft") await stripe.invoices.finalizeInvoice(factura.id);
    }
    if (haciaDelante.subirCantidad && sub?.stripe_item_id) {
      const item = await stripe.subscriptionItems.retrieve(sub.stripe_item_id);
      // Solo hacia ARRIBA: si el cliente ya subió (o un intento anterior lo hizo), no se toca.
      if ((item.quantity ?? 0) < a.usados) {
        await stripe.subscriptionItems.update(
          sub.stripe_item_id,
          { quantity: a.usados, proration_behavior: "none" },
          { idempotencyKey: claveIdempotenciaAsientos(a.orgId, a.periodo, "cantidad") },
        );
        detalle.cantidad = a.usados;
      }
    }
  } catch (err) {
    detalle.hacia_delante = `failed: ${motivoDeError(err)}`;
    await alertar({
      nivel: "aviso",
      asunto: "Ajuste de asientos cobrado, pero la suscripción no se actualizó hacia delante",
      detalle: { orgId: a.orgId, periodo: a.periodo, motivo: motivoDeError(err) },
    });
  }

  await marcar({ estado: "cobrado", stripe_invoice_item_id: itemId, motivo: "", detalle });
  return "cobrado";
}
