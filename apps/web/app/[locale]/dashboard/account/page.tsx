import { getTranslations } from "next-intl/server";
import { loadDashboard } from "../load";
import { AccountPlanStrip } from "../components/AccountPlanStrip";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("account.metaTitle") };
}

export default async function AccountPage() {
  const t = await getTranslations("dashboard");
  const { user, ctx } = await loadDashboard();
  return (
    <>
      <div className="app-head">
        <p className="ck-eyebrow">{t("account.eyebrow")}</p>
        <h1>{t("account.title")}</h1>
        <p>{t("account.intro")}</p>
      </div>
      <AccountPlanStrip email={user?.email ?? "you@bivelio.com"} ctx={ctx} />
    </>
  );
}
