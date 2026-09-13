import { getTranslations } from "next-intl/server";

import { Link } from "@/i18n/navigation";
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
      <div className="app-head">
        <p className="ck-eyebrow">{t("install.eyebrow")}</p>
        <h1>{t("install.title")}</h1>
        <p>{t("install.intro")}</p>
        {/* El plan de lanzamiento (fase 3.5) lo apuntaba: dentro del panel no había
            ningún enlace a comprar salvo la pestaña Cuenta. Quien llega aquí sin
            plan tiene que poder ir a por él sin adivinar dónde está. */}
        <p>
          <Link href="/dashboard/account">{t("install.irACuenta")}</Link>
        </p>
      </div>
      <InstallLicensePanel ctx={ctx} />
    </>
  );
}
