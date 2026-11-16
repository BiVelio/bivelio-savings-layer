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
  // EL NOMBRE DEL PLAN, SIN INVENTARLO. El webhook escribe `plan = "pro"` para
  // TODA suscripción viva — Pro, Team y la modalidad anterior con comisión —, y
  // este contexto no trae el precio de la suscripción con el que distinguirlas.
  // Rotular «Pro» a quien compró Team (o conserva la comisión) era afirmar un
  // plan que quizá no es el suyo: se dice «Plan de pago» y el detalle queda en
  // el portal de facturación. «Enterprise» sí es un valor propio, puesto a mano.
  const planLabel = isActive
    ? plan === "enterprise"
      ? "Enterprise"
      : t("accountPlanStrip.paidPlan")
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
  // QUIÉN VE LOS BOTONES QUE MUEVEN DINERO (lib/org/permisos). Con plan activo
  // la acción es el portal (`gestionar_facturacion`); sin plan, la compra
  // (`comprar`). A quien no puede se le dice a quién pedírselo, en su idioma, en
  // vez de un botón que acaba en un 403. Rol desconocido (`null`): se deja como
  // estaba — el servidor es la autoridad y aquí no se adivina.
  const puedeLaAccion = ctx.role == null || puede(ctx.role, isActive ? "gestionar_facturacion" : "comprar");
  const num = (n: number) => n.toLocaleString(locale);
  // `null` (no se pudo medir) y `0` (los días 1 y 2 de cada mes el cero es del
  // calendario) NO se pintan como cero: van como «—» con su porqué al lado.
  const hayUso = seatsUsados != null && seatsUsados > 0;
  const proporcion =
    hayUso && ctx.seats != null && ctx.seats > 0 ? Math.min(100, Math.round((seatsUsados / ctx.seats) * 100)) : null;
  return (
    <div className="cards plan acct">
      <section className="card acct-main" aria-labelledby="acct-plan-titulo">
        <header className="acct-head">
          <div className="acct-head-txt">
            <p className="acct-k">{t("accountPlanStrip.plan")}</p>
            <h2 id="acct-plan-titulo" className="acct-plan-name">{planLabel}</h2>
          </div>
          <p className="acct-status" data-tone={estado.tono}>
            <span className="acct-dot" aria-hidden />
            <span className="sr-only">{t("accountPlanStrip.statusLabel")}: </span>
            {estado.texto}
          </p>
        </header>

        {/* CONTRATADOS vs EN USO, con la unidad al lado de la cifra: un asiento
            es una máquina o una identidad de servicio, nunca una persona. */}
        {isActive ? (
          <div className="acct-seats">
            <div className="acct-seats-head">
              <h3 className="acct-h">{t("accountPlanStrip.seatsTitle")}</h3>
              <span className="acct-unit">{t("accountPlanStrip.seatUnit")}</span>
            </div>
            <dl className="acct-stats">
              <div className="acct-stat">
                <dt>{t("accountPlanStrip.seatsContracted")}</dt>
                <dd className="acct-fig">{ctx.seats != null ? num(ctx.seats) : "—"}</dd>
              </div>
              <div className="acct-stat">
                <dt>{t("accountPlanStrip.seatsUsed")}</dt>
                <dd className="acct-fig">{hayUso ? num(seatsUsados) : "—"}</dd>
                {hayUso ? null : (
                  <dd className="acct-stat-note">
                    {seatsUsados == null
                      ? t("accountPlanStrip.seatsUnknown")
                      : t("accountPlanStrip.seatsNotYet", { dias: DIAS_ACTIVOS_PARA_CONTAR_ASIENTO })}
                  </dd>
                )}
              </div>
            </dl>
            {proporcion != null ? (
              <div className="acct-meter" data-over={aviso === "exceso" || aviso === "rotado" ? "" : undefined} aria-hidden>
                <i style={{ width: `${proporcion}%` }} />
              </div>
            ) : null}
          </div>
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
        ) : !puedeLaAccion ? (
          <Notice tono="info" role="note">
            {t("accountPlanStrip.roleNote")}
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
        <p className="acct-k">{t("accountPlanStrip.signedInAs")}</p>
        <p className="acct-email">{email}</p>
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
              <dd>{nombreDelRol}</dd>
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
