import { getTranslations } from "next-intl/server";
import { authConfigured } from "@/lib/supabase/env";
import abData from "@/public/data/ab-live.json";
import { activationSteps, getAsientos, getSesiones, type AbArtifact } from "./data";
import { loadDashboard } from "./load";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { BillingStateBanner } from "./components/BillingStateBanner";
import { GatewayVersionBanner } from "./components/GatewayVersionBanner";
import { InstrumentationSpine } from "./components/InstrumentationSpine";
import { LiveLedgerTiles } from "./components/LiveLedgerTiles";
import { RitmoCard } from "./components/RitmoCard";
import { TokenTotalsTiles } from "./components/TokenTotalsTiles";
import { UsageExplorer } from "./components/UsageExplorer";
import { TrafficModelMix } from "./components/TrafficModelMix";
import { MaquinasCard } from "./components/MaquinasCard";
import { SesionesCard } from "./components/SesionesCard";
import { SombraElisionCard } from "./components/SombraElisionCard";
import { VerdictHero } from "./components/VerdictHero";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("overview.metaTitle") };
}

const ab = abData as unknown as AbArtifact;

export default async function OverviewPage() {
  const t = await getTranslations("dashboard");
  if (!authConfigured) {
    return <p className="ck-note">{t("overview.authNotWired")}</p>;
  }
  const { ctx, usage, usageFailed, porModelo, visibilidad, orgId } = await loadDashboard();
  const steps = await activationSteps(true, ctx, usage);
  // Coste por sesión (0019) y máquinas (0024): lecturas aparte y tolerantes —
  // sin tabla o sin columnas (migración por detrás del deploy) o sin filas, la
  // tarjeta no existe y el panel sigue. Un solo cliente de solo lectura para las dos.
  const lector = orgId ? await createReadOnlyClient() : null;
  const [sesiones, asientos] = lector && orgId
    ? await Promise.all([getSesiones(lector, orgId).then((r) => r.rows), getAsientos(lector, orgId).then((r) => r.rows)])
    : [[], []];

  return (
    <>
      <div className="app-head">
        <p className="ck-eyebrow">{t("overview.eyebrow")}</p>
        <h1>{t("overview.title")}</h1>
        <p>{t("overview.intro")}</p>
      </div>

      {/* Lo primero de la primera pantalla: si el cobro va mal, se entera aquí
          y no cuando el SDK se le pare. */}
      <BillingStateBanner ctx={ctx} />
      {/* Y justo detrás, si alguna máquina con gateway lleva una semana sin un
          euro MEDIDO: decide el dinero por asiento, la versión solo explica. */}
      <GatewayVersionBanner asientos={asientos} />

      <InstrumentationSpine steps={steps} />

      <section className="ck-sec">
        <div className="ck-head">
          <div>
            <p className="ck-eyebrow">{t("overview.savingsEyebrow")}</p>
            <h2>{t("overview.savingsTitle")}</h2>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <VerdictHero usage={usage} failed={usageFailed} visibilidad={visibilidad} />
          {/* Justo detrás del titular: a qué velocidad va y dónde acaba el mes.
              La pregunta que sigue a "cuánto llevo ahorrado" es siempre "¿y a
              este paso?" — y hasta ahora el panel no la contestaba. */}
          <RitmoCard usage={usage} />
          {/* Los TOTALES antes que la atribución por libro: "cuántos tokens he
              gastado" es la pregunta que se hace primero, y los cuatro libros de
              abajo la responden por partes que NO se pueden sumar entre sí. */}
          <TokenTotalsTiles usage={usage} />
          <LiveLedgerTiles usage={usage} ab={ab} />
          {/* El explorador configurable (por día · periodo · modelo) a lo ancho:
              necesita sitio para los controles y las barras. */}
          <div className="card" style={{ padding: "16px" }}>
            <div className="n" style={{ marginBottom: "10px" }}>{t("usageExplorer.title")}</div>
            <UsageExplorer usage={usage} porModelo={porModelo} />
          </div>
          <div className="card" style={{ padding: "16px" }}>
            <div className="n" style={{ marginBottom: "10px" }}>{t("overview.traffic")}</div>
            <TrafficModelMix usage={usage} />
          </div>
          <SesionesCard sesiones={sesiones} />
          <MaquinasCard asientos={asientos} />
          {/* La sombra al final y en tarjeta PROPIA: hipotética por doctrina,
              jamás mezclada con el titular ni con los libros medidos. */}
          <SombraElisionCard usage={usage} />
        </div>
      </section>
    </>
  );
}
