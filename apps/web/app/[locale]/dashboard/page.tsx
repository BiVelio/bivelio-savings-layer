import { getTranslations } from "next-intl/server";

import { PageHead } from "@/app/components/app/PageHead";
import { Notice } from "@/app/components/ui";
import { authConfigured } from "@/lib/supabase/env";
import { activationSteps, getAsientos, getSesiones } from "./data";
import { cortarPorPeriodo } from "./explorer-datos";
import { loadDashboard } from "./load";
import { RANGO_POR_DEFECTO, rangoDesdeParametro } from "./rango";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { BillingStateBanner } from "./components/BillingStateBanner";
import { PlanElegidoNotice, planElegidoDe, sobraElPlanElegido } from "./components/PlanElegidoNotice";
import { GatewayVersionBanner } from "./components/GatewayVersionBanner";
import { GatewayBrutoBanner } from "./components/GatewayBrutoBanner";
import { SdkReferenciaBanner } from "./components/SdkReferenciaBanner";
import { InstrumentationSpine } from "./components/InstrumentationSpine";
import { AhorroNativoCard } from "./components/AhorroNativoCard";
import { LiveLedgerTiles } from "./components/LiveLedgerTiles";
import { RitmoCard } from "./components/RitmoCard";
import { TokenTotalsTiles } from "./components/TokenTotalsTiles";
import { UsageExplorer } from "./components/UsageExplorer";
import { TrafficModelMix } from "./components/TrafficModelMix";
import { MaquinasCard } from "./components/MaquinasCard";
import { PanelEditable } from "./components/PanelEditable";
import { SesionesCard } from "./components/SesionesCard";
import { VerdictHero } from "./components/VerdictHero";
import { MedirSavingsCard } from "./components/MedirSavingsCard";
import { ShadowOpportunitiesCard } from "./components/ShadowOpportunitiesCard";
import { ResumenKpis } from "./components/ResumenKpis";
import { DesgloseModelos } from "./components/DesgloseModelos";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("overview.metaTitle") };
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string | string[]; plan?: string | string[] }>;
}) {
  const t = await getTranslations("dashboard");
  if (!authConfigured) {
    return (
      <>
        <PageHead eyebrow={t("overview.eyebrow")} title={t("overview.title")} />
        <Notice tono="warn">{t("overview.authNotWired")}</Notice>
      </>
    );
  }
  const {
    ctx,
    usage: usageCompleto,
    usageFailed,
    porModelo: porModeloCompleto,
    porModeloFailed,
    sombraPorModelo: sombraCompleta,
    sombraStatus,
    visibilidad,
    orgId,
    orgFallo,
  } = await loadDashboard();
  const { range: rangoPedido, plan: planPedido } = await searchParams;
  const rango = rangoDesdeParametro(rangoPedido);
  // El plan elegido en la portada llega aquí por `?plan=`; el selector vive en
  // Cuenta. Con un plan ya activo, o con una suscripción viva o en curso (un
  // adeudo SEPA sin liquidar), no hay nada que confirmar.
  const planElegido = planElegidoDe(planPedido);
  const yaConPlan = sobraElPlanElegido(ctx);
  const usage = rango === RANGO_POR_DEFECTO ? usageCompleto : cortarPorPeriodo(usageCompleto, rango);
  const porModelo = rango === RANGO_POR_DEFECTO ? porModeloCompleto : cortarPorPeriodo(porModeloCompleto, rango);
  const sombraPorModelo = rango === RANGO_POR_DEFECTO ? sombraCompleta : cortarPorPeriodo(sombraCompleta, rango);
  const steps = await activationSteps(true, ctx, usageCompleto, {
    usageFailed: usageFailed || orgFallo,
    usageHidden: visibilidad === "oculto",
  });
  const lector = orgId ? await createReadOnlyClient() : null;
  const [sesiones, asientos] = lector && orgId
    ? await Promise.all([getSesiones(lector, orgId), getAsientos(lector, orgId)])
    : [{ rows: [], failed: false }, { rows: [], failed: false }];
  const readErrors = [
    orgFallo ? "org" : null,
    usageFailed ? "usage" : null,
    porModeloFailed ? "models" : null,
    sesiones.failed ? "sessions" : null,
    asientos.failed ? "seats" : null,
  ].filter((x): x is string => x !== null);

  // LO QUE DECIDE LA COMPOSICIÓN (guía §9), sin calcular nada nuevo:
  //  · `integrado` distingue «aún no hay nada conectado» de «conectado, pero
  //    sin tráfico en este periodo». Sale del hito que ya acredita la
  //    instalación; si ese hito no se pudo evaluar, no se afirma ninguna.
  //  · `hayUso`: hay filas que leer en el rango. Sin ellas no se pintan las
  //    tres cifras — tres rayas no informan, y el titular ya dice qué pasa.
  //  · `completo`: los cinco hitos hechos. Entonces la puesta en marcha deja
  //    de ocupar la página y el siguiente paso es abrir la evidencia.
  const hitoInstalacion = steps.find((s) => s.id === "SDK or gateway installed")?.status;
  const integrado = hitoInstalacion === "done" ? true : hitoInstalacion === "unavailable" || hitoInstalacion === undefined ? undefined : false;
  const hayUso = usage.length > 0 && !usageFailed && visibilidad !== "oculto";
  const completo = steps.length > 0 && steps.every((s) => s.status === "done");

  return (
    <div className="ov">
      <PageHead eyebrow={t("overview.eyebrow")} title={t("overview.title")} sub={t("overview.intro")} />

      {/* 1 · Lo que exige atención: cobro y servicio primero, solo si hay algo. */}
      <div className="ov-attention">
        <BillingStateBanner ctx={ctx} />
        {planElegido && !yaConPlan ? <PlanElegidoNotice plan={planElegido} role={ctx.role} /> : null}
        <GatewayVersionBanner asientos={asientos.rows} />
        <GatewayBrutoBanner asientos={asientos.rows} />
        <SdkReferenciaBanner asientos={asientos.rows} />
        {readErrors.length > 0 ? (
          <section className="notice ov-errors" data-tone="danger" role="alert" aria-labelledby="dashboard-read-errors">
            <div className="notice-body">
              <h2 className="notice-title" id="dashboard-read-errors">{t("overview.readErrors.title")}</h2>
              <p>{t("overview.readErrors.intro")}</p>
              <ul className="ov-errors-list">
                {readErrors.map((source) => <li key={source}>{t(`overview.readErrors.${source}`)}</li>)}
              </ul>
            </div>
          </section>
        ) : null}
      </div>

      {/* 2 · El resultado, con su periodo y su siguiente acción. */}
      <section className="app-section ov-result">
        <div className="app-sec-head">
          <div>
            <p className="eyebrow">{t("overview.savingsEyebrow")}</p>
            <h2 className="t-section">{t("overview.savingsTitle")}</h2>
          </div>
        </div>
        <div className="panel-stack">
          <VerdictHero usage={usage} failed={usageFailed} visibilidad={visibilidad} rango={rango} integrado={integrado} />
          {ctx.medir === "solo-medir" ? <MedirSavingsCard usage={usage} /> : null}
          {hayUso ? <ResumenKpis usage={usage} rango={rango} steps={steps} /> : null}
        </div>
      </section>

      {completo ? null : <InstrumentationSpine steps={steps} />}

      {/* 3 · Uso, oportunidades y distribución: el panel que se ordena. */}
      <section className="app-section">
        <div className="app-sec-head">
          <div>
            <p className="eyebrow">{t("overview.panelEyebrow")}</p>
            <h2 className="t-section">{t("overview.panelTitle")}</h2>
          </div>
        </div>
        <PanelEditable
          tarjetas={[
            {
              id: "explorador",
              titulo: t("usageExplorer.title"),
              contenido: (
                <div className="ov-explore">
                  <div className="card card-pad" data-tour="explorer">
                    <div className="n card-title">{t("usageExplorer.title")}</div>
                    <UsageExplorer usage={usageCompleto} porModelo={porModeloCompleto} periodoInicial={rango} />
                  </div>
                  <DesgloseModelos
                    porModelo={porModelo}
                    porModeloCompleto={porModeloCompleto}
                    usage={usage}
                    rango={rango}
                    fallo={porModeloFailed}
                  />
                </div>
              ),
            },
            {
              id: "oportunidades",
              titulo: t("shadowOpportunities.title"),
              contenido: (
                <ShadowOpportunitiesCard rows={sombraPorModelo} usage={usage} status={sombraStatus} rango={rango} />
              ),
            },
            { id: "ritmo", titulo: t("panel.cards.ritmo"), contenido: <RitmoCard usage={usageCompleto} /> },
            {
              id: "nativo",
              titulo: t("panel.cards.nativo"),
              contenido: <AhorroNativoCard usage={usage} porModelo={porModelo} />,
            },
            { id: "tokens", titulo: t("panel.cards.tokens"), contenido: <TokenTotalsTiles usage={usage} /> },
            { id: "libros", titulo: t("panel.cards.libros"), contenido: <LiveLedgerTiles usage={usage} /> },
            {
              id: "trafico",
              titulo: t("panel.cards.trafico"),
              contenido: (
                <div className="card card-pad">
                  <div className="n card-title">{t("overview.traffic")}</div>
                  <TrafficModelMix usage={usage} />
                </div>
              ),
            },
            { id: "sesiones", titulo: t("panel.cards.sesiones"), contenido: <SesionesCard sesiones={sesiones.rows} /> },
            {
              id: "maquinas",
              titulo: t("panel.cards.maquinas"),
              contenido: <MaquinasCard asientos={asientos.rows} fallo={asientos.failed} />,
              // El raíl enlaza a `#maquinas`: con la tarjeta oculta, el ancla
              // sigue existiendo y ofrece volver a mostrarla.
              ancla: {
                id: "maquinas",
                titulo: t("maquinas.hiddenTitle"),
                texto: t("maquinas.hiddenBody"),
                accion: t("maquinas.show"),
              },
            },
          ]}
        />
        {/* La sombra se presenta solo como estimación hipotética por modelo;
            nunca entra en el titular medido, el extracto ni la comisión. */}
      </section>
    </div>
  );
}
