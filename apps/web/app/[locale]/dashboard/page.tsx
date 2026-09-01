import { getTranslations } from "next-intl/server";
import { authConfigured } from "@/lib/supabase/env";
import abData from "@/public/data/ab-live.json";
import { activationSteps, getSesiones, type AbArtifact } from "./data";
import { loadDashboard } from "./load";
import { createReadOnlyClient } from "@/lib/supabase/server";
import { BillingStateBanner } from "./components/BillingStateBanner";
import { InstrumentationSpine } from "./components/InstrumentationSpine";
import { LiveLedgerTiles } from "./components/LiveLedgerTiles";
import { TokenTotalsTiles } from "./components/TokenTotalsTiles";
import { SavingsTrendChart } from "./components/SavingsTrendChart";
import { TrafficModelMix } from "./components/TrafficModelMix";
import { SesionesCard } from "./components/SesionesCard";
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
  const { ctx, usage, usageFailed, visibilidad, orgId } = await loadDashboard();
  const steps = await activationSteps(true, ctx, usage);
  // Coste por sesión (0019): lectura aparte y tolerante — sin tabla (migración
  // por detrás del deploy) o sin filas, la tarjeta no existe y el panel sigue.
  const sesiones = orgId ? (await getSesiones(await createReadOnlyClient(), orgId)).rows : [];

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
          {/* Los TOTALES antes que la atribución por libro: "cuántos tokens he
              gastado" es la pregunta que se hace primero, y los cuatro libros de
              abajo la responden por partes que NO se pueden sumar entre sí. */}
          <TokenTotalsTiles usage={usage} />
          <LiveLedgerTiles usage={usage} ab={ab} />
          <div className="cards wide">
            <div className="card" style={{ padding: "16px" }}>
              <div className="n" style={{ marginBottom: "10px" }}>{t("overview.savingsTrend")}</div>
              <SavingsTrendChart usage={usage} />
            </div>
            <div className="card" style={{ padding: "16px" }}>
              <div className="n" style={{ marginBottom: "10px" }}>{t("overview.traffic")}</div>
              <TrafficModelMix usage={usage} />
            </div>
          </div>
          <SesionesCard sesiones={sesiones} />
        </div>
      </section>
    </>
  );
}
