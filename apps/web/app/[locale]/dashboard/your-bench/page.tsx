import { getTranslations } from "next-intl/server";

import { CabeceraDePagina } from "@/app/components/app/CabeceraDePagina";
import { ProofTabs } from "@/app/components/app/ProofTabs";
import { authConfigured } from "@/lib/supabase/env";
import { createReadOnlyClient } from "@/lib/supabase/server";
import type { InformeDelBancoPropio } from "@/lib/verificacion/banco-propio";
import { leerBancoPropio, type LecturaDelBancoPropio } from "@/lib/verificacion/lectura";
import { RangeSwitch } from "../components/RangeSwitch";
import { YourBenchContenido } from "../components/YourBenchContenido";
import { loadDashboard } from "../load";
import { rangoDesdeParametro } from "../rango";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("yourBench.metaTitle") };
}

/**
 * PRUEBA › TU BANCO. La verificación A/B opcional del SDK sobre el tráfico del
 * propio cliente: cada par medido en los dos lados por su proveedor.
 *
 * INFORMATIVO, JAMÁS FACTURADO: la insignia va en todas las ramas, y nada de
 * esta página se suma al extracto ni a la comisión. El titular es el suelo del
 * intervalo; con pocos pares, o con demasiado tráfico en grupos con pocos
 * pares, no hay intervalo; un fallo de lectura nunca se pinta como un cero.
 */
export default async function YourBenchPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string | string[] }>;
}) {
  const t = await getTranslations("dashboard");
  const rango = rangoDesdeParametro((await searchParams).range);
  const cabecera = (
    <>
      <ProofTabs />
      <CabeceraDePagina
        rotulo={t("yourBench.eyebrow")}
        titulo={t("yourBench.title")}
        entradilla={t("yourBench.intro")}
        aside={
          <div className="prb-rango">
            <RangeSwitch activo={rango} base="/dashboard/your-bench" />
          </div>
        }
      >
        {/* INFORMATIVO, JAMÁS FACTURADO: la franja va en todas las ramas. */}
        <div className="bench-badge yb-badge prb-informativo">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
          <span>
            <b>{t("yourBench.badge")}</b>
          </span>
        </div>
      </CabeceraDePagina>
    </>
  );
  if (!authConfigured) {
    return (
      <>
        {cabecera}
        <p className="note pfc-nota">{t("overview.authNotWired")}</p>
      </>
    );
  }

  const { orgId, orgFallo } = await loadDashboard();
  let lectura: LecturaDelBancoPropio;
  if (orgFallo) lectura = { estado: "fallo" };
  else if (!orgId) lectura = { estado: "ok", desde: "", hasta: "", informe: vacio() };
  else lectura = await leerBancoPropio(await createReadOnlyClient(), orgId, rango);

  return (
    <>
      {cabecera}
      <div className="yb app-gap">
        <YourBenchContenido lectura={lectura} rango={rango} />
      </div>
    </>
  );
}

/** Sin organización no hay nada que leer: el mismo estado que «apagado». */
function vacio(): InformeDelBancoPropio {
  return {
    estado: "sin_datos",
    paresTotales: 0,
    paresLeidos: 0,
    paresEnTitular: 0,
    submuestreado: false,
    elegibles: 0,
    cobertura: 0,
    cuotaCorta: 0,
    tasaLograda: 0,
    remuestreos: 0,
    semilla: 0,
    estratos: [],
    exclusiones: [],
    resultados: [],
    noComparables: { truncadas: 0, incompletas: 0, incumplidas: 0 },
    coste: { usd: 0, copias: 0, sinCoste: 0 },
  };
}
