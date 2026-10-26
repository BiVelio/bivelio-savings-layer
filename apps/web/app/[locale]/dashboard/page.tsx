import { getTranslations } from "next-intl/server";

import { PageHead } from "@/app/components/app/PageHead";
import { authConfigured } from "@/lib/supabase/env";
import { activationSteps, getAsientos, getSesiones } from "./data";
import { cortarPorPeriodo } from "./explorer-datos";
import { loadDashboard } from "./load";
import { RANGO_POR_DEFECTO, rangoDesdeParametro } from "./rango";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { BillingStateBanner } from "./components/BillingStateBanner";
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

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("overview.metaTitle") };
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string | string[] }>;
}) {
  const t = await getTranslations("dashboard");
  if (!authConfigured) {
    return <p className="note">{t("overview.authNotWired")}</p>;
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
  const rango = rangoDesdeParametro((await searchParams).range);
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

  return (
    <>
      <PageHead eyebrow={t("overview.eyebrow")} title={t("overview.title")} sub={t("overview.intro")} />
      <BillingStateBanner ctx={ctx} />
      <GatewayVersionBanner asientos={asientos.rows} />
      <GatewayBrutoBanner asientos={asientos.rows} />
      <SdkReferenciaBanner asientos={asientos.rows} />
      {ctx.medir === "solo-medir" ? <MedirSavingsCard usage={usage} /> : null}

      {readErrors.length > 0 ? (
        <section className="card card-pad" role="alert" aria-labelledby="dashboard-read-errors">
          <h2 className="n card-title" id="dashboard-read-errors">{t("overview.readErrors.title")}</h2>
          <p className="ck-note">{t("overview.readErrors.intro")}</p>
          <ul>
            {readErrors.map((source) => <li key={source}>{t(`overview.readErrors.${source}`)}</li>)}
          </ul>
        </section>
      ) : null}

      <InstrumentationSpine steps={steps} />

      <section className="app-section">
        <div className="app-sec-head">
          <div>
            <p className="eyebrow">{t("overview.savingsEyebrow")}</p>
            <h2 className="t-section">{t("overview.savingsTitle")}</h2>
          </div>
        </div>
        <div className="panel-stack">
          <VerdictHero usage={usage} failed={usageFailed} visibilidad={visibilidad} rango={rango} />
          <PanelEditable
            tarjetas={[
              { id: "ritmo", titulo: t("panel.cards.ritmo"), contenido: <RitmoCard usage={usageCompleto} /> },
              {
                id: "nativo",
                titulo: t("panel.cards.nativo"),
                contenido: <AhorroNativoCard usage={usage} porModelo={porModelo} />,
              },
              {
                id: "oportunidades",
                titulo: t("shadowOpportunities.title"),
                contenido: (
                  <ShadowOpportunitiesCard rows={sombraPorModelo} usage={usage} status={sombraStatus} rango={rango} />
                ),
              },
              { id: "tokens", titulo: t("panel.cards.tokens"), contenido: <TokenTotalsTiles usage={usage} /> },
              { id: "libros", titulo: t("panel.cards.libros"), contenido: <LiveLedgerTiles usage={usage} /> },
              {
                id: "explorador",
                titulo: t("usageExplorer.title"),
                contenido: (
                  <div className="card card-pad">
                    <div className="n card-title">{t("usageExplorer.title")}</div>
                    <UsageExplorer usage={usageCompleto} porModelo={porModeloCompleto} periodoInicial={rango} />
                  </div>
                ),
              },
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
              { id: "maquinas", titulo: t("panel.cards.maquinas"), contenido: <MaquinasCard asientos={asientos.rows} /> },
            ]}
          />
          {/* La sombra se presenta solo como estimación hipotética por modelo;
              nunca entra en el titular medido, el extracto ni la comisión. */}
        </div>
      </section>
    </>
  );
}
