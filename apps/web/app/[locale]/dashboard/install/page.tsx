import { getTranslations } from "next-intl/server";
import abData from "@/public/data/ab-live.json";
import { type AbArtifact } from "../data";
import { loadDashboard } from "../load";
import { InstallLicensePanel } from "../components/InstallLicensePanel";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("install.metaTitle") };
}

const ab = abData as unknown as AbArtifact;

export default async function InstallPage() {
  const t = await getTranslations("dashboard");
  const { ctx } = await loadDashboard();
  return (
    <>
      <div className="app-head">
        <p className="ck-eyebrow">{t("install.eyebrow")}</p>
        <h1>{t("install.title")}</h1>
        <p>{t("install.intro")}</p>
      </div>
      <InstallLicensePanel ab={ab} ctx={ctx} />
    </>
  );
}
