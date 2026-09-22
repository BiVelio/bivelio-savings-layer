import { getTranslations } from "next-intl/server";

import { PageHead } from "@/app/components/app/PageHead";
import { loadDashboard } from "../load";
import { InstallLicensePanel } from "../components/InstallLicensePanel";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("install.metaTitle") };
}

export default async function InstallPage() {
  const t = await getTranslations("dashboard");
  const { ctx } = await loadDashboard();
  return (
    <>
      <PageHead eyebrow={t("install.eyebrow")} title={t("install.title")} sub={t("install.intro")} />
      <InstallLicensePanel ctx={ctx} />
    </>
  );
}
