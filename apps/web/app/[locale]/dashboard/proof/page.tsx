import { getTranslations } from "next-intl/server";

import { PageHead } from "@/app/components/app/PageHead";
import { ProofTabs } from "@/app/components/app/ProofTabs";
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
      <ProofTabs />
      <PageHead eyebrow={t("proof.eyebrow")} title={t("proof.title")} sub={t("proof.intro")} />
      <div className="bench">
        <ReferenceModeBadge ab={ab} />
        <NetSavingsCIBand savings={ab.aggregate.savings} mode={ab.mode} />
        <div className="app-gap">
          <ReferenceLedgerCards ab={ab} />
        </div>
        <div className="app-gap">
          <IntegrityQualityChips ab={ab} />
        </div>
        <div className="app-gap">
          <ScenarioTable scenarios={ab.scenarios} />
        </div>
        <div className="app-gap">
          <CacheBreakEven ab={ab} />
        </div>
      </div>
    </>
  );
}
