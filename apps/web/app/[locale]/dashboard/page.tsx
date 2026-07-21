import { getTranslations } from "next-intl/server";
import { authConfigured } from "@/lib/supabase/env";
import abData from "@/public/data/ab-live.json";
import { activationSteps, type AbArtifact } from "./data";
import { loadDashboard } from "./load";
import { InstrumentationSpine } from "./components/InstrumentationSpine";
import { LiveLedgerTiles } from "./components/LiveLedgerTiles";
import { SavingsTrendChart } from "./components/SavingsTrendChart";
import { TrafficModelMix } from "./components/TrafficModelMix";
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
  const { ctx, usage } = await loadDashboard();
  const steps = await activationSteps(true, ctx, usage);

  return (
    <>
      <div className="app-head">
        <p className="ck-eyebrow">{t("overview.eyebrow")}</p>
        <h1>{t("overview.title")}</h1>
        <p>{t("overview.intro")}</p>
      </div>

      <InstrumentationSpine steps={steps} />

      <section className="ck-sec">
        <div className="ck-head">
          <div>
            <p className="ck-eyebrow">{t("overview.savingsEyebrow")}</p>
            <h2>{t("overview.savingsTitle")}</h2>
          </div>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "14px" }}>
          <VerdictHero usage={usage} />
          <LiveLedgerTiles usage={usage} ab={ab} />
          <div className="cards" style={{ gridTemplateColumns: "1.6fr 1fr" }}>
            <div className="card" style={{ padding: "16px" }}>
              <div className="n" style={{ marginBottom: "10px" }}>{t("overview.savingsTrend")}</div>
              <SavingsTrendChart usage={usage} />
            </div>
            <div className="card" style={{ padding: "16px" }}>
              <div className="n" style={{ marginBottom: "10px" }}>{t("overview.traffic")}</div>
              <TrafficModelMix usage={usage} />
            </div>
          </div>
        </div>
      </section>
    </>
  );
}
