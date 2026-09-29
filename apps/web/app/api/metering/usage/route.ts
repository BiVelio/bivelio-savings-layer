import { createHash } from "node:crypto";
import { after, NextResponse } from "next/server";

import {
  degradarReferencias,
  leerInterruptorReferenciaComoEstimado,
  parseUsageRecords,
  UsageValidationError,
} from "@/lib/metering/usage";
import { admiteReferencia, CABECERA_VERSION, sellarVersion, versionDeclarada } from "@/lib/metering/version";
import { decideEntitlement } from "@/lib/metering/entitlement";
import {
  aplicarTopeDeAsientos,
  diaUtc,
  huecoDeVolumen,
  inicioDeMes,
  LIMITES_MEDIR,
  neutralizarParaMedir,
  URL_DE_PAGO_MEDIR,
} from "@/lib/license/medir";
import { alertar } from "@/lib/observabilidad/alerta";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * SDK usage ingest. Authenticated by a service-account Bearer key (bvk_…): we hash
 * it, look it up in service_accounts, and DERIVE the org server-side — the body's
 * orgId (if any) is never trusted. Records pass the counts-only content backstop,
 * then an atomic RPC folds them into seat_activity + usage_daily. Fail-closed (401)
 * with no matching key.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function bearer(authorization: string | null): string | null {
  if (!authorization || !authorization.startsWith("Bearer ")) return null;
  const t = authorization.slice(7).trim();
  return t.length > 0 ? t : null;
}

export async function POST(req: Request): Promise<NextResponse> {
  const token = bearer(req.headers.get("authorization"));
  if (!token) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const keyHash = createHash("sha256").update(token).digest("hex");

  const supabase = createAdminClient();

  const { data: sa, error: saErr } = await supabase
    .from("service_accounts")
    .select("org_id")
    .eq("key_hash", keyHash)
    .maybeSingle();
  if (saErr) {
    console.error("[metering/usage] service-account lookup failed:", saErr);
    return NextResponse.json({ error: "metering store unavailable" }, { status: 503 });
  }
  if (!sa) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const orgId = sa.org_id as string;

  // ── Candado de entitlement (servidor). El SDK del cliente es parcheable; esto
  // no. Una org sin licencia válida ni suscripción que la cubra deja de poder
  // ingerir uso (402), así que pierde panel y facturación: la revocada, la
  // caducada pasada la gracia y también la que NUNCA tuvo licencia (no hay free
  // tier; ver `decideEntitlement`). La lógica refleja la del SDK para que no se
  // contradigan.
  //
  // Fail-OPEN ante error de BD: el trabajo primario de este endpoint es no
  // PERDER datos de facturación, así que un fallo transitorio de la consulta de
  // entitlement no debe descartar el uso de un cliente que paga. La revocación
  // la refuerzan también el gate del SDK y el poller; una ventana breve durante
  // una caída de BD es aceptable, tirar el uso legítimo no.
  // TODAS las suscripciones de la org, no solo la más nueva. Con `limit(1)` una
  // fila NO vigente más reciente hacía sombra a la vigente más antigua y el
  // ingest devolvía 402 a un cliente que paga. Ver `hasActiveSubscription`.
  const [{ data: licenses, error: licErr }, { data: subs, error: subErr }] = await Promise.all([
    supabase.from("licenses").select("revoked, expires_at, grace_days, plan").eq("org_id", orgId),
    supabase.from("subscriptions").select("status, current_period_end").eq("org_id", orgId),
  ]);
  // ¿Solo licencia Medir (gratuita, en sombra)? Entonces su uso entra para el
  // panel, con topes y NEUTRALIZADO: jamás comisión ni referencia cobrable.
  let soloMedir = false;
  if (licErr || subErr) {
    console.error("[metering/usage] entitlement lookup failed (fail-open):", licErr ?? subErr);
  } else {
    const decision = decideEntitlement(licenses ?? [], subs ?? [], Date.now());
    soloMedir = decision.reason === "measure-license";
    if (decision.blocked) {
      return NextResponse.json(
        {
          error: "subscription required",
          reason: decision.reason,
          detail:
            "This organization has no active BiVelio license or subscription. Subscribe or renew at https://savings.bivelio.com/dashboard/account",
        },
        { status: 402 },
      );
    }
  }

  let records;
  try {
    records = parseUsageRecords(await req.json(), orgId);
  } catch (err) {
    if (err instanceof UsageValidationError) return NextResponse.json({ error: err.message }, { status: 400 });
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (records.length === 0) return NextResponse.json({ ingested: 0 }, { status: 202 });

  // ── LICENCIA MEDIR · topes y neutralización (antes de TODO lo demás) ────────
  let rechazadosPorAsiento = 0;
  if (soloMedir) {
    const ahora = Date.now();
    // Tope de ASIENTOS por mes natural. Fail-open ante error de lectura: el tope
    // es anti-abuso, no un candado de cobro (Medir no cobra nada).
    const { data: asientos, error: asErr } = await supabase
      .from("seat_activity")
      .select("seat_id")
      .eq("org_id", orgId)
      .gte("day", inicioDeMes(ahora));
    if (asErr) {
      console.error("[metering/usage] measure: seat lookup failed (fail-open):", asErr);
    } else {
      const delMes = new Set(((asientos ?? []) as { seat_id?: string }[]).map((a) => String(a.seat_id ?? "")));
      const tope = aplicarTopeDeAsientos(records, delMes);
      rechazadosPorAsiento = tope.rechazados.length;
      if (tope.admitidos.length === 0) {
        return NextResponse.json(
          {
            error: "measure plan seat limit",
            reason: "measure-seat-limit",
            detail:
              `The free Measure plan measures up to ${LIMITES_MEDIR.asientos} seats per month and this one is over the limit. ` +
              `Your layer keeps working unchanged; to measure every seat and turn the levers on, upgrade at ${URL_DE_PAGO_MEDIR}`,
          },
          { status: 402 },
        );
      }
      records = tope.admitidos;
    }
    // Tope de VOLUMEN diario (peticiones medidas, UTC). Los registros sombra
    // acompañan a una petición ya contada y no cuentan.
    const { data: hoy, error: hoyErr } = await supabase
      .from("usage_daily")
      .select("requests")
      .eq("org_id", orgId)
      .eq("day", diaUtc(ahora))
      .maybeSingle();
    if (hoyErr) {
      console.error("[metering/usage] measure: volume lookup failed (fail-open):", hoyErr);
    } else {
      const hueco = huecoDeVolumen(Number((hoy as { requests?: number } | null)?.requests ?? 0));
      if (hueco === 0) {
        return NextResponse.json(
          {
            error: "measure plan daily limit",
            reason: "measure-volume-limit",
            detail:
              `The free Measure plan measures up to ${LIMITES_MEDIR.peticionesDiarias} requests per day and today is full. ` +
              `Your layer keeps working unchanged; to measure all your traffic, upgrade at ${URL_DE_PAGO_MEDIR}`,
          },
          { status: 429 },
        );
      }
      const medidos = records.filter((r) => r["basis"] !== "shadow");
      if (medidos.length > hueco) {
        const fuera = new Set(medidos.slice(hueco).map((r) => r.requestId));
        records = records.filter((r) => !fuera.has(r.requestId) && !fuera.has(r.requestId.replace(/:shadow$/, "")));
      }
    }
    const n = neutralizarParaMedir(records);
    if (n.neutralizados > 0 || n.referencias > 0) {
      // Con el SDK honrado nunca pasa: en sombra no hay palanca que ahorre. Si
      // pasa, alguien corre palancas con una licencia gratuita.
      console.warn("[metering/usage] measure: ahorro neutralizado en una org Medir", { org: orgId, ...n });
    }
  }

  // 0029 · EL INTERRUPTOR DE SERVIDOR del carril medido por referencia. Con
  // BVSALA_INGEST_REFERENCE_AS_ESTIMATED=1 (variable de Vercel + redespliegue del
  // mismo commit, sin código ni npm) todo registro "reference" entra como
  // "estimated": sigue contando en los totales, pero deja de acumularse en
  // reference_* y de escribir reference_hits. Se aplica sobre los registros YA
  // validados y antes de sellar la versión y de la RPC. Es el hermano de
  // COMISIONAR_REFERENCIA (lib/billing/tarifa.ts), que decide si lo acumulado
  // entra en la base; este corta la acumulación misma.
  //
  // Falla hacia ENCENDIDO: `1`/`true`/`yes`/`on` lo encienden, y un valor que no
  // se reconoce también (con aviso) — quien lo pone durante un incidente quiere
  // cortar, y un `true` que no cortara seguiría acumulando sin que nadie lo viera.
  const interruptor = leerInterruptorReferenciaComoEstimado(process.env.BVSALA_INGEST_REFERENCE_AS_ESTIMATED);
  if (!interruptor.reconocido) {
    console.warn(
      "[metering/usage] BVSALA_INGEST_REFERENCE_AS_ESTIMATED con un valor no reconocido: se trata como ENCENDIDO (usa 1 o 0)",
    );
  }
  if (interruptor.activo) {
    const n = degradarReferencias(records);
    if (n > 0) {
      console.warn("[metering/usage] interruptor BVSALA_INGEST_REFERENCE_AS_ESTIMATED: reference→estimated", { n });
    }
  }

  // La versión del proceso (0024) viene en CABECERA, no en el cuerpo, y se sella
  // SIEMPRE sobre los registros ya validados — nunca sobre el JSON crudo, para
  // que la lista blanca ya haya rechazado cualquier `clientVersion` del cliente.
  // Una cabecera rara es «sin declarar» (null), jamás un 400; una RPC anterior a
  // 0024 ignora la clave porque lee por nombre. Se sella también en los registros
  // sombra: inocuo, la RPC sale de ese carril antes del upsert de seat_activity.
  const version = versionDeclarada(req.headers.get(CABECERA_VERSION));

  // LA VERJA DE LA REGLA. El cierre sella REGLA_REFERENCIA.version para el
  // extracto entero, y la regla con la que el SDK valoró cada repetición no viaja
  // en el registro. La etiqueta v0.4.23 se cortó con la regla v1; si se publica,
  // sus referencias no pueden entrar bajo el sello «reference-v2». Y de la 0.4.24
  // a la 0.4.31 el SDK podía repetir una negativa como referencia (la que el
  // modelo escribe como texto, hasta la 0.4.30: #384; el `content_filter: OTHER`
  // de Gemini, las que #384 no veía y los temas sensibles, hasta la 0.4.31:
  // #393, #401, #402). Un proceso que no
  // declara versión, que declara una anterior a VERSION_MINIMA_REFERENCIA, o
  // que es el gateway (no pasa por el pipeline que aplica la regla v2), entra
  // como "estimated": sigue en los totales, fuera de reference_* y de la base.
  // Por construcción, sin depender de qué se publique ni en qué orden.
  if (!admiteReferencia(version)) {
    const n = degradarReferencias(records);
    if (n > 0) {
      console.warn("[metering/usage] referencias de un proceso anterior a la regla vigente: reference→estimated", {
        n,
        version,
      });
    }
  }

  sellarVersion(records, version);

  const { data, error } = await supabase.rpc("ingest_usage_batch", { p_org: orgId, records });
  if (error) {
    // SE PIERDEN DATOS DE FACTURACION. `usage_daily` es de donde salen las cifras
    // del panel y `billable_seats`, que decide los asientos cobrables — y aqui no
    // hay cola ni reintento: el SDK reencola solo los 5xx, pero un fallo
    // sostenido del RPC (un CHECK, un deadlock, saturacion) abre un agujero en el
    // historico que crece cada minuto y no se recupera. Mientras tanto, todos los
    // paneles degradan a "0 peticiones vistas".
    console.error("[metering/usage] ingest RPC failed:", error);
    await alertar({
      nivel: "critico",
      asunto: "El ingest de uso esta fallando: se estan perdiendo datos de facturacion",
      detalle: { org: orgId, registros: records.length, motivo: error.message ?? String(error) },
    });
    return NextResponse.json({ error: "ingest failed" }, { status: 500 });
  }

  // Best-effort liveness stamp, off the hot path: run it AFTER the response is sent so
  // billing-critical ingest latency never waits on this extra write to a hot row.
  after(async () => {
    const { error: stampErr } = await supabase
      .from("service_accounts")
      .update({ last_used_at: new Date().toISOString() })
      .eq("key_hash", keyHash);
    if (stampErr) console.error("[metering/usage] last_used_at stamp failed:", stampErr);
  });

  return NextResponse.json(
    { ingested: data ?? records.length, ...(rechazadosPorAsiento > 0 ? { rejectedOverSeatLimit: rechazadosPorAsiento } : {}) },
    { status: 202 },
  );
}
