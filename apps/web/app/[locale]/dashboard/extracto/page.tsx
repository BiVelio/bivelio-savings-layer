import { getTranslations } from "next-intl/server";

import { AccountTabs } from "@/app/components/app/AccountTabs";
import { CabeceraDePagina } from "@/app/components/app/CabeceraDePagina";

import { extractoEnSombra, periodoDe } from "@/lib/billing/extracto-sombra";
import { diaSiguiente, diasEntre, MAX_FILAS_POR_DESCARGA } from "@/lib/metering/referencias-csv";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { loadDashboard } from "../load";
import { ExtractoVista, type RegimenDelExtracto } from "../components/ExtractoVista";
import { ESTADOS_CON_PLAN, idsSinComision, orgsSinComisionPorPlan, type SuscripcionDeOrg } from "@/lib/billing/plan-de-la-org";
import { preciosSinComision } from "@/lib/stripe/env";

/** Una fila del historial: el extracto cerrado con el estado de su cobro. */
interface PeriodoCerrado {
  periodo: string;
  es_calibracion: boolean;
  es_exento: boolean;
  base_medida_eur: number;
  ahorro_medido_eur: number;
  ratio: number;
  cargo_eur: number;
  cobro: { estado: string; url: string | null; numero: string | null } | null;
  /** Repeticiones medidas por referencia selladas en el período (0029); 0 sin la migración. */
  requests_referencia: number;
}

/**
 * Los períodos cerrados de la organización, con su cobro. Se filtra por
 * `org_id` EXPLÍCITAMENTE: la RLS de miembro devuelve las filas de todas las
 * organizaciones del usuario, y mezclarlas pintaría extractos ajenos.
 */
async function periodosCerrados(orgId: string): Promise<PeriodoCerrado[] | null> {
  const supabase = await createReadOnlyClient();
  const [{ data: extractos, error: e1 }, { data: cargos, error: e2 }, { data: referencias, error: e3 }] = await Promise.all([
    supabase
      .schema("bvsala")
      .from("extractos")
      .select("periodo, es_calibracion, es_exento, base_medida_eur, ahorro_medido_eur, ratio, cargo_eur")
      .eq("org_id", orgId)
      .order("periodo", { ascending: false })
      .limit(24),
    supabase.schema("bvsala").from("cargos").select("periodo, estado, detalle").eq("org_id", orgId),
    // 0029 · aparte y TOLERANTE: sin la migración la columna no existe, y eso no
    // puede tumbar el historial entero — solo deja sin enlace CSV a los períodos.
    supabase
      .schema("bvsala")
      .from("extractos")
      .select("periodo, requests_referencia")
      .eq("org_id", orgId)
      .order("periodo", { ascending: false })
      .limit(24),
  ]);
  if (e1 || e2) return null; // el fallo de lectura se pinta como tal, no como "sin historial"
  if (e3) console.warn("[extracto] historial sin requests_referencia (¿falta la migración 0029?):", e3.message);
  const referenciasPorPeriodo = new Map(
    (e3 ? [] : ((referencias ?? []) as Array<{ periodo: string; requests_referencia: number | string | null }>)).map(
      (r) => [String(r.periodo), Number(r.requests_referencia ?? 0)] as const,
    ),
  );
  const cobroPorPeriodo = new Map(
    (cargos ?? []).map((c) => {
      const detalle = (c.detalle ?? {}) as { hosted_invoice_url?: string | null; numero?: string | null };
      return [String(c.periodo), {
        estado: String(c.estado),
        url: detalle.hosted_invoice_url ?? null,
        numero: detalle.numero ?? null,
      }] as const;
    }),
  );
  return (extractos ?? []).map((x) => ({
    periodo: String(x.periodo),
    es_calibracion: Boolean(x.es_calibracion),
    es_exento: Boolean((x as { es_exento?: boolean }).es_exento),
    base_medida_eur: Number(x.base_medida_eur ?? 0),
    ahorro_medido_eur: Number(x.ahorro_medido_eur ?? 0),
    ratio: Number(x.ratio ?? 0),
    cargo_eur: Number(x.cargo_eur ?? 0),
    cobro: cobroPorPeriodo.get(String(x.periodo)) ?? null,
    requests_referencia: referenciasPorPeriodo.get(String(x.periodo)) ?? 0,
  }));
}

/**
 * Los días del período ya empezados (UTC), para la descarga día a día cuando el
 * mes no cabe en un solo fichero (MAX_FILAS_POR_DESCARGA).
 */
function diasDelPeriodoHastaHoy(periodo: string, hoy: Date): string[] {
  const [y, m] = periodo.split("-").map(Number);
  const finDelMes = new Date(Date.UTC(y!, m!, 1)).toISOString().slice(0, 10);
  const manana = diaSiguiente(hoy.toISOString().slice(0, 10));
  return diasEntre(`${periodo}-01`, manana < finDelMes ? manana : finDelMes);
}

/** La clave i18n del estado del cobro de un período cerrado. */
function claveDeEstado(p: PeriodoCerrado): string {
  if (p.cobro) {
    const porEstado: Record<string, string> = {
      pagado: "estadoPagado",
      facturado: "estadoFacturado",
      fallido: "estadoFallido",
      omitido_sin_cliente: "estadoOmitidoSinCliente",
      omitido_bajo_minimo: "estadoOmitidoBajoMinimo",
    };
    return porEstado[p.cobro.estado] ?? "estadoPendiente";
  }
  if (p.es_calibracion) return "estadoCalibracion";
  // Probadores y cortesías: la comisión se calcula, el cargo es cero, y se dice.
  if (p.es_exento) return "estadoExento";
  if (p.cargo_eur <= 0) return "estadoSinCargo";
  // Cargo sin fila de cobro: el cron del día uno aún no ha pasado (o falló y
  // alertó). "Pendiente" es la verdad — nunca se pinta como pagado ni omitido.
  return "estadoPendiente";
}

/**
 * EL EXTRACTO EN SOMBRA — la pantalla del mes de calibración del plan maestro.
 *
 * Enseña, desde el primer día, el documento exacto que la futura factura
 * variable producirá: base medida, ahorro medido, ratio, rampa, tramos y la
 * comisión resultante — con la etiqueta que corresponda (calibración: 0 €).
 * Nada de esta pantalla cobra: es la sombra. La única fuente de cálculo es
 * `construirExtracto`; aquí solo se pinta.
 */
export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("extracto.metaTitle") };
}

export default async function ExtractoPage() {
  const t = await getTranslations("dashboard");
  const { ctx, usage, usageFailed, orgId } = await loadDashboard();

  const periodo = periodoDe(new Date());
  // La marca de exención (0028) llega también a la sombra: sin esto la cabecera
  // diría «cargo 12 €» y la tabla de abajo «exento de comisión».
  let esExento = false;
  // QUÉ RÉGIMEN SE LE ENSEÑA, solo con lo que estas mismas consultas ya traen
  // (ninguna consulta nueva): la marca de exención, y si alguna suscripción con
  // plan lleva o no comisión. Lo que no se puede saber se dice como tal.
  let exentaPorMarca = false;
  let exentaPorPlan = false;
  let suscripcionesConPlan: number | null = null;
  // Una lectura que FALLA no es «no hay suscripción» ni «no hay exención»: es
  // no saber. Antes el error se tiraba y la página afirmaba un régimen.
  let lecturaFallida = false;
  if (orgId) {
    const supabase = await createReadOnlyClient();
    const { data: org, error: errOrg } = await supabase.schema("bvsala").from("organizations").select("comision_exenta").eq("id", orgId).maybeSingle();
    if (errOrg) lecturaFallida = true;
    esExento = Boolean((org as { comision_exenta?: boolean } | null)?.comision_exenta);
    exentaPorMarca = esExento;
    // Pro y Equipo no llevan comisión (lib/billing/planes.ts): su extracto en
    // sombra la enseña como la de una cuenta exenta — lo que habría costado en
    // la modalidad con comisión, sin cargo. Misma regla que el cierre.
    const precios = preciosSinComision();
    if (!esExento && idsSinComision(precios).length > 0) {
      const { data: subs, error: errSubs } = await supabase
        .schema("bvsala")
        .from("subscriptions")
        .select("org_id, price_id, status")
        .eq("org_id", orgId)
        .in("status", [...ESTADOS_CON_PLAN]);
      if (errSubs) lecturaFallida = true;
      esExento = orgsSinComisionPorPlan((subs ?? []) as SuscripcionDeOrg[], precios).has(orgId);
      exentaPorPlan = esExento;
      suscripcionesConPlan = (subs ?? []).length;
    }
  }
  // «legado»: hay suscripción con plan y ninguna es de cuota fija. «indeterminado»:
  // hay suscripción pero este despliegue no sabe qué precios son de cuota fija
  // (la consulta de arriba no llegó a hacerse). Elegir bien el régimen en ese
  // caso es trabajo de billing; aquí se pinta un aviso neutro, nunca una suposición.
  // También es «indeterminado»:
  //  · cuando falló la lectura de la exención o la de las suscripciones;
  //  · cuando las dos lecturas se contradicen — el contexto ve una suscripción
  //    con plan y la consulta de aquí no devuelve ninguna.
  // «ninguno» NO es «no se te cobra», y TAMPOCO «se te cobra comisión según las
  // condiciones publicadas»: LICENSE-CLOUD §6(b) solo da comisión al plan que el
  // precio publicado lista con ella. La vista no afirma ni lo uno ni lo otro:
  // pinta el aviso neutro (lo que se cobra es lo que figura en las facturas).
  // «medir»: sin plan vivo, pero con la licencia gratuita Measure (`ctx.medir`,
  // ver ../medir.ts). Modo sombra: ahorro ESTIMADO, que nunca se factura ni
  // entra en comisión alguna (LICENSE-CLOUD §1).
  const conSuscripcion = ctx.subscription != null && ESTADOS_CON_PLAN.includes(ctx.subscription.status);
  const regimenBase: "fija" | "exenta" | "legado" | "ninguno" | "indeterminado" = lecturaFallida
    ? "indeterminado"
    : exentaPorMarca
      ? "exenta"
      : exentaPorPlan
        ? "fija"
        : suscripcionesConPlan === null
          ? conSuscripcion
            ? "indeterminado"
            : "ninguno"
          : suscripcionesConPlan > 0
            ? "legado"
            : conSuscripcion
              ? "indeterminado"
              : "ninguno";
  const regimen: RegimenDelExtracto = regimenBase === "ninguno" && ctx.medir === "solo-medir" ? "medir" : regimenBase;
  const e = extractoEnSombra("panel", usage, periodo, esExento);
  const cerrados = orgId ? await periodosCerrados(orgId) : [];

  return (
    <>
      <AccountTabs role={ctx.role} />
      <CabeceraDePagina rotulo={t("extracto.eyebrow")} titulo={t("extracto.title")} entradilla={t("extracto.intro")} />
      <ExtractoVista
        e={e}
        periodo={periodo}
        regimen={regimen}
        usageFailed={usageFailed}
        cerrados={cerrados === null ? null : cerrados.map((p) => ({ ...p, claveDeEstado: claveDeEstado(p) }))}
        // Un mes con más filas de las que caben en una descarga se baja por
        // días (la ruta respondería 413 al mes entero).
        diasDeDescarga={
          e.referencia && e.referencia.requests > MAX_FILAS_POR_DESCARGA ? diasDelPeriodoHastaHoy(periodo, new Date()) : null
        }
      />
    </>
  );
}
