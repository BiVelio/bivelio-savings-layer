import { getTranslations } from "next-intl/server";

import { PageHead } from "@/app/components/app/PageHead";
import { Link } from "@/i18n/navigation";
import { ProgressTracker } from "@/vendor/affectui/progress-tracker-clean";

import { activationSteps, type StepState } from "../data";
import { loadDashboard } from "../load";
import { InstallLicensePanel } from "../components/InstallLicensePanel";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("install.metaTitle") };
}

/**
 * Dónde está, EN ESTA PÁGINA, la instrucción de cada hito. Los hitos y su
 * estado los decide `activationSteps`; aquí solo se dice a dónde lleva
 * pulsarlos. Pulsar abre la instrucción: no marca nada como hecho.
 */
const ANCLA_DEL_HITO: Record<string, string> = {
  "Account created": "/dashboard/account",
  "License active": "#cloud",
  "SDK or gateway installed": "#sdk",
  "First real request": "#gateway",
  "Report ready": "/dashboard",
};

export default async function InstallPage() {
  const t = await getTranslations("dashboard");
  const { user, ctx, usage, usageFailed, visibilidad, orgFallo } = await loadDashboard();
  // Los cinco hitos reales, con la misma lectura que la espina del Resumen.
  // Sin sesión no hay hitos que enseñar: no se inventa un progreso.
  const steps: StepState[] = user
    ? await activationSteps(true, ctx, usage, {
        usageFailed: usageFailed || orgFallo,
        usageHidden: visibilidad === "oculto",
      })
    : [];
  const sinLeer = steps.some((s) => s.status === "unavailable");
  const hechos = steps.filter((s) => s.status === "done").length;
  return (
    <div className="ins-page">
      <PageHead eyebrow={t("install.eyebrow")} title={t("install.title")} sub={t("install.intro")} />
      {steps.length > 0 ? (
        <div className="ins-progress">
          <ProgressTracker
            layout="steps"
            headingAs="h2"
            linkAs={Link}
            title={t("install.trackerTitle")}
            countLabel={
              sinLeer
                ? t("instrumentationSpine.statusUnavailable")
                : t("instrumentationSpine.count", { done: hechos, total: steps.length })
            }
            done={sinLeer ? 0 : hechos}
            total={steps.length}
            steps={steps.map((s) => ({
              id: s.id,
              label: s.label,
              status: s.status,
              statusLabel:
                s.status === "done"
                  ? t("instrumentationSpine.statusDone")
                  : s.status === "current"
                    ? t("instrumentationSpine.statusNext")
                    : s.status === "unavailable"
                      ? t("instrumentationSpine.statusUnavailable")
                      : t("instrumentationSpine.statusPending"),
              href: ANCLA_DEL_HITO[s.id],
            }))}
            footer={sinLeer ? t("instrumentationSpine.unavailableHint") : t("install.trackerNote")}
          />
        </div>
      ) : null}
      <InstallLicensePanel ctx={ctx} />
    </div>
  );
}
