import { getTranslations } from "next-intl/server";
import abData from "@/public/data/ab-live.json";
import { type AbArtifact } from "../data";
import { CacheBreakEven } from "../components/CacheBreakEven";
import { IntegrityQualityChips } from "../components/IntegrityQualityChips";
import { NetSavingsCIBand } from "../components/NetSavingsCIBand";
import { ReferenceLedgerCards } from "../components/ReferenceLedgerCards";
import { ReferenceModeBadge } from "../components/ReferenceModeBadge";
import { ScenarioTable } from "../components/ScenarioTable";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("proof.metaTitle") };
}

const ab = abData as unknown as AbArtifact;

export default async function ProofPage() {
  const t = await getTranslations("dashboard");
  return (
    <>
      <div className="app-head">
        <p className="ck-eyebrow">{t("proof.eyebrow")}</p>
        <h1>{t("proof.title")}</h1>
        <p>{t("proof.intro")}</p>
      </div>
      <div className="bench">
        <ReferenceModeBadge ab={ab} />
        <NetSavingsCIBand savings={ab.aggregate.savings} mode={ab.mode} />
        <div style={{ marginTop: "16px" }}>
          <ReferenceLedgerCards ab={ab} />
        </div>
        <div style={{ marginTop: "16px" }}>
          <IntegrityQualityChips ab={ab} />
        </div>
        <div style={{ marginTop: "16px" }}>
          <ScenarioTable scenarios={ab.scenarios} />
        </div>
        <div style={{ marginTop: "16px" }}>
          <CacheBreakEven ab={ab} />
        </div>
      </div>
    </>
  );
}
