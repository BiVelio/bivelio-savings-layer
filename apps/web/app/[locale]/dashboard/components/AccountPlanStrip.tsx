import { getLocale, getTranslations } from "next-intl/server";

import type { OrgContext } from "../data";
import { BillingButtons } from "./BillingButtons";
import { tarifasDeLosPlanes } from "@/lib/stripe/pricing";
import { terminosDeLosPlanes } from "@/lib/legal/precios-publicados";
import { avisoDeAsientos, DIAS_ACTIVOS_PARA_CONTAR_ASIENTO } from "@/lib/billing/asientos";
import type { AjusteDeAsientosVisible } from "@/lib/billing/asientos-usados";
import { formatearPrecio } from "@/lib/format/precio";
import { puede } from "@/lib/org/permisos";
import { Notice } from "@/app/components/ui";
import { Link } from "@/i18n/navigation";
import { Avatar } from "@/vendor/affectui/avatar";
import { Badge, type BadgeTone } from "@/vendor/affectui/badge-clean";
import { UsageMeter, type UsageMeterRow } from "@/vendor/affectui/usage-meter";

/** Real account/plan — reads organizations.plan (best-effort), never hardcoded.
 *  Degrades honestly when the schema can't resolve org/seats. */
export async function AccountPlanStrip({
  email,
  ctx,
  /**
   * Asientos USADOS este mes. `null` = no se ha podido medir (que no es cero).
   * Antes solo se pintaban los PAGADOS, así que ni el cliente podía ver que se
   * estaba pasando ni nosotros enseñárselo — y el dato lo calcula
   * `billable_seats` desde el primer día.
   */
  asientos = { usados: null, rotacionEsteMes: false },
  // Acaba de pagar y la activación está en curso: se ocultan los botones de
  // compra. Reofrecérselos en ese momento es la vía directa al doble cobro, y la
  // guardia del servidor no lo frena mientras la suscripción está `incomplete`.
  ocultarCompra = false,
  codigo = null,
}: {
  email: string;
  ctx: OrgContext;
  asientos?: { usados: number | null; rotacionEsteMes: boolean; ajusteMesPasado?: AjusteDeAsientosVisible | null };
  ocultarCompra?: boolean;
  /** Código de promoción que se pre-aplica al pagar (enlace de los probadores). */
  codigo?: string | null;
}) {
  const t = await getTranslations("dashboard");
  // El precio se formatea en SERVIDOR y baja como cadena a los botones, que son de
  // cliente. Formatear en los dos lados reabriría el error de hidratación #418: la
  // ICU de Node y la del navegador no siempre coinciden en detalles invisibles.
  const locale = await getLocale();
  // Lo que se VENDE es Pro y Equipo (2026-09-29); la modalidad con comisión está
  // cerrada a clientes nuevos. Las cifras, de sus Prices (o del respaldo).
  const tarifas = await tarifasDeLosPlanes();
  const planes = terminosDeLosPlanes(locale, tarifas);
  const incluidos = tarifas.equipo.monthly.asientosIncluidos;
  const plan = ctx.org?.plan;
  const isActive = plan === "pro" || plan === "enterprise";
  const seatsUsados = asientos.usados;
  const aviso = avisoDeAsientos({
    planActivo: isActive,
    usados: seatsUsados,
    pagados: ctx.seats,
    rotacionEsteMes: asientos.rotacionEsteMes,
  });
  const planLabel = isActive
    ? plan.charAt(0).toUpperCase() + plan.slice(1)
    : ctx.medir === "solo-medir"
      ? t("measurePlan.planLabel")
      : t("accountPlanStrip.noActivePlan");
  // EL ESTADO REAL, CON PALABRAS. `past_due` mapea a plan «pro»: sin esto la
  // tarjeta diría «Pro» a secas mientras corre la gracia. Solo se nombran los
  // estados que la suscripción trae de verdad; cualquier otro no se inventa.
  const estadoSub = ctx.subscription?.status;
  const estado: { texto: string; tono: "ok" | "warn" | "danger" | "neutro" } = ocultarCompra
    ? { texto: t("accountPlanStrip.statusPending"), tono: "warn" }
    : estadoSub === "past_due"
      ? { texto: t("accountPlanStrip.statusPastDue"), tono: "danger" }
      : estadoSub === "incomplete"
        ? { texto: t("accountPlanStrip.statusIncomplete"), tono: "warn" }
        : isActive
          ? { texto: t("accountPlanStrip.statusActive"), tono: "ok" }
          : { texto: t("accountPlanStrip.statusNone"), tono: "neutro" };
  const nombreDelRol =
    ctx.role === "owner"
      ? t("equipo.rolOwner")
      : ctx.role === "admin"
        ? t("equipo.rolAdmin")
        : ctx.role === "billing"
          ? t("equipo.rolBilling")
          : ctx.role === "member"
            ? t("equipo.rolMember")
            : null;
  const num = (n: number) => n.toLocaleString(locale);
  // `null` (no se pudo medir) y `0` (los días 1 y 2 de cada mes el cero es del
  // calendario) NO se pintan como cero: van como «—» con su porqué al lado.
  const hayUso = seatsUsados != null && seatsUsados > 0;
  const proporcion =
    hayUso && ctx.seats != null && ctx.seats > 0 ? Math.min(100, Math.round((seatsUsados / ctx.seats) * 100)) : null;
  // EL MEDIDOR (Usage Meter de affectUI, reducido a asientos). Todo sale de dos
  // lecturas reales: contratados (`ctx.seats`) y en uso (`billable_seats`). Lo
  // único que se calcula es su resta. Sin lectura no hay barra ni porcentaje.
  const porEncima = aviso === "exceso" || aviso === "rotado";
  const exceso = hayUso && ctx.seats != null && seatsUsados > ctx.seats ? seatsUsados - ctx.seats : 0;
  const libres = hayUso && ctx.seats != null && seatsUsados <= ctx.seats ? ctx.seats - seatsUsados : null;
  const filasDelMedidor: UsageMeterRow[] = [
    { label: t("accountPlanStrip.seatsContracted"), value: ctx.seats != null ? num(ctx.seats) : "—", swatch: "plain" },
    ...(hayUso ? [{ label: t("accountPlanStrip.seatsUsed"), value: num(seatsUsados), swatch: "used" as const }] : []),
    ...(exceso > 0
      ? [{ label: t("accountPlanStrip.seatsExtra"), value: num(exceso), swatch: "over" as const }]
      : libres != null
        ? [{ label: t("accountPlanStrip.seatsFree"), value: num(libres), swatch: "free" as const }]
        : []),
  ];
  const tonoDelEstado: Record<typeof estado.tono, BadgeTone> = { ok: "success", warn: "warning", danger: "danger", neutro: "neutral" };
  return (
    <div className="cards plan acct">
      <section className="card acct-main" aria-labelledby="acct-plan-titulo">
        <header className="acct-head">
          <div className="acct-head-txt">
            <p className="acct-k">{t("accountPlanStrip.plan")}</p>
            <h2 id="acct-plan-titulo" className="acct-plan-name">{planLabel}</h2>
          </div>
          <p className="acct-status" data-tone={estado.tono}>
            <span className="sr-only">{t("accountPlanStrip.statusLabel")}: </span>
            <Badge size="lg" tone={tonoDelEstado[estado.tono]} dot live={ocultarCompra}>
              {estado.texto}
            </Badge>
          </p>
        </header>

        {/* CONTRATADOS vs EN USO, con la unidad al lado de la cifra: un asiento
            es una máquina o una identidad de servicio, nunca una persona. */}
        {isActive ? (
          <UsageMeter
            className="acct-seats"
            title={t("accountPlanStrip.seatsTitle")}
            unit={t("accountPlanStrip.seatUnit")}
            figure={hayUso ? num(seatsUsados) : undefined}
            figureLabel={t("accountPlanStrip.seatsUsed")}
            missing={
              seatsUsados == null
                ? t("accountPlanStrip.seatsUnknown")
                : t("accountPlanStrip.seatsNotYet", { dias: DIAS_ACTIVOS_PARA_CONTAR_ASIENTO })
            }
            share={
              proporcion != null && ctx.seats != null && hayUso
                ? (seatsUsados / ctx.seats).toLocaleString(locale, { style: "percent", maximumFractionDigits: 0 })
                : undefined
            }
            state={porEncima ? "over" : "ok"}
            used={proporcion != null && hayUso ? seatsUsados : null}
            limit={ctx.seats}
            meterLabel={
              hayUso && ctx.seats != null
                ? `${t("accountPlanStrip.seatsUsed")}: ${num(seatsUsados)} · ${t("accountPlanStrip.seatsContracted")}: ${num(ctx.seats)}`
                : undefined
            }
            rows={filasDelMedidor}
          />
        ) : null}

        {/* USADOS vs PAGADOS. `seatsUsados != null` se repite aunque
            `avisoDeAsientos` ya lo garantice: el compilador no puede seguir esa
            garantía a través de la variable. */}
        {aviso === "exceso" && seatsUsados != null && ctx.seats != null ? (
          <Notice tono="warn" titulo={t("accountPlanStrip.overTitle")}>
            {t("accountPlanStrip.seatsOver", { used: seatsUsados, paid: ctx.seats })}
          </Notice>
        ) : aviso === "rotado" && seatsUsados != null ? (
          /* Rotó la clave este mes: el recuento está inflado porque el seat_id
             sale de un HMAC con esa clave. Se explica en vez de pedirle dinero. */
          <Notice tono="info" role="note">
            {t("accountPlanStrip.seatsRotated", { used: seatsUsados })}
          </Notice>
        ) : null}
        {/* EL MES CERRADO: lo que se usó frente a lo pagado y lo que eso añade
            (cron cobrar-asientos, 0034). Solo si se cobró o está por cobrarse:
            un ensayo en seco o una revisión humana no se enseñan como un cargo. */}
        {asientos.ajusteMesPasado ? (
          <Notice tono="info" role="note" titulo={t("accountPlanStrip.lastMonthTitle")}>
            {t("accountPlanStrip.seatsLastMonth", {
              period: asientos.ajusteMesPasado.periodo,
              used: asientos.ajusteMesPasado.usados,
              paid: asientos.ajusteMesPasado.pagados,
              extra: asientos.ajusteMesPasado.exceso,
              amount: formatearPrecio(locale, { amount: asientos.ajusteMesPasado.importeCentimos, currency: "eur" }),
            })}
          </Notice>
        ) : null}

        {/* LA ACCIÓN, SEGÚN EL CONTEXTO. Con la activación pendiente NO hay
            botones de compra: es la regla contra el doble cobro, y se dice. */}
        {ocultarCompra ? (
          <Notice tono="warn" role="status" titulo={t("accountPlanStrip.pendingTitle")}>
            {t("accountPlanStrip.pendingBody")}
          </Notice>
        ) : (
          <BillingButtons
            codigo={codigo}
            isActive={isActive}
            precios={{
              pro: { monthly: planes.pro.mensual, yearly: planes.pro.anual },
              equipo: {
                monthly: planes.equipo.mensual,
                yearly: planes.equipo.anual,
                incluidos,
                extraMonthly: planes.equipo.extraMensual,
              },
            }}
          />
        )}

        {/* EL IMPUESTO VA APARTE, Y HAY QUE DECIRLO. Los precios son `exclusive`:
            anunciar un importe a secas sin esta línea es enseñar uno que no es
            el que se cobra. */}
        <p className="ck-note acct-tax">{t("accountPlanStrip.taxNote")}</p>
        <details className="acct-more">
          <summary>{t("accountPlanStrip.howBilledTitle")}</summary>
          <p>
            {t("accountPlanStrip.planBody", {
              monthly: planes.pro.mensual,
              yearly: planes.pro.anual,
              teamMonthly: planes.equipo.mensual,
              included: incluidos,
            })}
          </p>
        </details>
      </section>

      <aside className="card acct-side" aria-label={t("account.eyebrow")}>
        <div className="acct-id">
          <Avatar size={40} name={email.split("@")[0]?.replace(/[._+-]+/g, " ")} seed={email} />
          <div className="acct-id-txt">
            <p className="acct-k">{t("accountPlanStrip.signedInAs")}</p>
            <p className="acct-email">{email}</p>
          </div>
        </div>
        <dl className="acct-facts">
          {ctx.org ? (
            <div>
              <dt>{t("accountPlanStrip.orgLabel")}</dt>
              <dd>{ctx.org.name}</dd>
            </div>
          ) : null}
          {nombreDelRol ? (
            <div>
              <dt>{t("accountPlanStrip.roleLabel")}</dt>
              <dd>
                <Badge size="md" tone={ctx.role === "owner" ? "info" : "neutral"}>
                  {nombreDelRol}
                </Badge>
              </dd>
            </div>
          ) : null}
        </dl>
        {ctx.org ? null : <p className="acct-side-note">{t("accountPlanStrip.personalNote")}</p>}
        {/* MIEMBROS ≠ ASIENTOS: las personas se gestionan en Equipo, aparte de lo
            que se paga. El enlace solo para quien puede abrir esa página. */}
        <p className="acct-side-note">
          {t("accountPlanStrip.membersNote")}
          {puede(ctx.role, "gestionar_miembros") ? (
            <>
              {" "}
              <Link href="/dashboard/team">{t("accountPlanStrip.membersLink")}</Link>
            </>
          ) : null}
        </p>
      </aside>
    </div>
  );
}
