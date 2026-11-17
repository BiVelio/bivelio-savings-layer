import { getTranslations } from "next-intl/server";

import { CabeceraDePagina } from "@/app/components/app/CabeceraDePagina";
import { Link } from "@/i18n/navigation";
import { CloudIcon, CodeIcon, TerminalIcon } from "@/app/components/icons";
import { SetupGuide, type SetupGroup } from "@/vendor/affectui/setup-guide";

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
  const estadoDe = (s: StepState) =>
    s.status === "done"
      ? t("instrumentationSpine.statusDone")
      : s.status === "current"
        ? t("instrumentationSpine.statusNext")
        : s.status === "unavailable"
          ? t("instrumentationSpine.statusUnavailable")
          : t("instrumentationSpine.statusPending");
  // LA GUÍA, al lado del contenido y siempre a la vista: con sesión, los cinco
  // hitos MEDIDOS (solo lectura) y, debajo, las tres secciones de la página;
  // sin sesión, solo las secciones. Sin lectura fiable no hay barra ni recuento.
  const secciones: SetupGroup[] = [
    { id: "cloud", title: t("installLicensePanel.cloudTitle"), href: "#cloud", icon: <CloudIcon /> },
    { id: "sdk", title: t("installLicensePanel.sdkTitle"), href: "#sdk", icon: <CodeIcon /> },
    { id: "gateway", title: t("installLicensePanel.gatewayTitle"), href: "#gateway", icon: <TerminalIcon /> },
  ];
  const grupos: SetupGroup[] =
    steps.length > 0
      ? [
          {
            id: "hitos",
            tasks: steps.map((s) => ({
              id: s.id,
              label: s.label,
              status: s.status,
              statusLabel: estadoDe(s),
              href: ANCLA_DEL_HITO[s.id],
            })),
          },
          { ...secciones[0]!, caption: t("install.onThisPage") },
          ...secciones.slice(1),
        ]
      : secciones;
  return (
    <div className="ins-page">
      <CabeceraDePagina rotulo={t("install.eyebrow")} titulo={t("install.title")} entradilla={t("install.intro")} />
      <div className="ins-layout">
        <aside className="ins-rail">
          <SetupGuide
            aria-label={steps.length > 0 ? t("install.trackerTitle") : t("install.onThisPage")}
            title={steps.length > 0 ? t("install.trackerTitle") : t("install.onThisPage")}
            linkAs={Link}
            groups={grupos}
            progress={
              steps.length > 0 && !sinLeer
                ? {
                    done: hechos,
                    total: steps.length,
                    label: t("instrumentationSpine.count", { done: hechos, total: steps.length }),
                    countLabel: t("instrumentationSpine.count", { done: hechos, total: steps.length }),
                  }
                : undefined
            }
            footer={steps.length === 0 ? undefined : sinLeer ? t("instrumentationSpine.unavailableHint") : t("install.trackerNote")}
          />
        </aside>
        <InstallLicensePanel ctx={ctx} />
      </div>
    </div>
  );
}
