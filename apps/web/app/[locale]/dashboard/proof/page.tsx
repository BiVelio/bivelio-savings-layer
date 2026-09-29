import { getLocale, getTranslations } from "next-intl/server";

import { PageHead } from "@/app/components/app/PageHead";
import { ProofTabs } from "@/app/components/app/ProofTabs";
import { TarjetaMedidoEnVivo, filasDelBancoEnVivo } from "@/app/components/MedidoEnVivo";
import { Link } from "@/i18n/navigation";
import abData from "@/public/data/ab-live.json";
import { escenariosConPiezaDelBanco } from "@/lib/bench/sdk-instalado";
import { BANCO_EN_VIVO } from "@/lib/portada/banco-en-vivo";
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

/**
 * LA PRUEBA, CON EL MISMO CRITERIO QUE LA PORTADA (2026-09-29).
 *
 * Hasta hoy esta página abría con la tirada sintética del 12-09 y su «≥ 10 %».
 * Ahora enseña tres cosas, por separado y en este orden:
 *   1. el banco público en vivo: la cifra CONDICIONADA (con repeticiones,
 *      sin ellas ≈ 0, y Claude con la caché del proveedor aparte), con su
 *      intervalo y su informe enlazado — las mismas filas que la portada;
 *   2. lo del cliente: su dinero, medido con el contador de su proveedor, que
 *      vive en su Resumen;
 *   3. la tirada sintética, etiquetada como tal y sin cifra de titular
 *      (NetSavingsCIBand no pinta nada sin `sdk.asShipped: true`): explica
 *      cómo funciona cada palanca, no promete nada.
 */
export default async function ProofPage() {
  const t = await getTranslations("dashboard");
  const tl = await getTranslations("landing");
  const locale = await getLocale();
  return (
    <>
      <ProofTabs />
      <PageHead eyebrow={t("proof.eyebrow")} title={t("proof.title")} sub={t("proof.intro")} />
      <TarjetaMedidoEnVivo
        className="hero-prueba medido-prueba"
        titulo={tl("enVivo.titulo", { fecha: BANCO_EN_VIVO.fecha })}
        filas={filasDelBancoEnVivo(tl, locale)}
        pie={tl.rich("enVivo.pie", { bench: (c) => <Link href="/benchmarks">{c}</Link> })}
      />
      <p className="app-gap">{t.rich("proof.tuDinero", { overview: (c) => <Link href="/dashboard">{c}</Link> })}</p>
      <h2 className="app-gap">{t("proof.sinteticaTitulo")}</h2>
      <div className="bench">
        <ReferenceModeBadge ab={ab} />
        <NetSavingsCIBand ab={ab} />
        <div className="app-gap">
          <ReferenceLedgerCards ab={ab} />
        </div>
        <div className="app-gap">
          <IntegrityQualityChips ab={ab} />
        </div>
        <div className="app-gap">
          <ScenarioTable scenarios={ab.scenarios} piezaDelBanco={[...escenariosConPiezaDelBanco(ab)]} />
        </div>
        <div className="app-gap">
          <CacheBreakEven ab={ab} />
        </div>
      </div>
    </>
  );
}
