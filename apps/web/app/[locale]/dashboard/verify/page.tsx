import { getTranslations } from "next-intl/server";

import { PageHead } from "@/app/components/app/PageHead";
import { ProofTabs } from "@/app/components/app/ProofTabs";
import abData from "@/public/data/ab-live.json";
import { type AbArtifact } from "../data";
import { ProjectorVerifier } from "../components/ProjectorVerifier";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("verify.metaTitle") };
}

const ab = abData as unknown as AbArtifact;
const mini = (ab.pricing.table["gpt-4o-mini"] ?? {}) as { inputPer1k?: number; outputPer1k?: number };
const prices = { inPer1k: mini.inputPer1k ?? 0.00015, outPer1k: mini.outputPer1k ?? 0.0006 };

export default async function VerifyPage() {
  const t = await getTranslations("dashboard");
  return (
    <>
      <ProofTabs />
      <PageHead eyebrow={t("verify.eyebrow")} title={t("verify.title")} sub={t("verify.intro")} />
      <ProjectorVerifier prices={prices} />
    </>
  );
}
