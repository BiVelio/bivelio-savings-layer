import { getTranslations } from "next-intl/server";

import { CabeceraDePagina } from "@/app/components/app/CabeceraDePagina";
import { FormatVerifier } from "@/app/components/FormatVerifier";
import { ProofTabs } from "@/app/components/app/ProofTabs";
import { EvidenceBadge } from "@/app/components/ui";
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
      <CabeceraDePagina rotulo={t("verify.eyebrow")} titulo={t("verify.title")} entradilla={t("verify.intro")} />
      {/* El MISMO verificador de la portada, con el tokenizador exacto y
          cargado sin esperar al scroll. El proyector (estimación con
          deslizadores) va debajo, con su etiqueta de estimación. */}
      <section className="pfc-sec prf-sec prb-sec prb-formato" aria-labelledby="vfy-formato">
        <div className="pfc-sec-cab">
          <p className="pfc-rotulo">{t("verify.formatoRotulo")}</p>
          <h2 className="pfc-sec-t" id="vfy-formato">{t("verify.formatoTitulo")}</h2>
          <p className="pfc-sec-sub">{t("verify.formatoSub")}</p>
        </div>
        <FormatVerifier eager />
      </section>
      <section className="pfc-sec prf-sec prb-sec prb-proyector" aria-labelledby="vfy-proyector">
        <div className="pfc-sec-cab">
          <div className="prb-marca">
            <EvidenceBadge tipo="estimacion" label={t("projectorVerifier.notInvoice")} />
          </div>
          <h2 className="pfc-sec-t" id="vfy-proyector">{t("projectorVerifier.projectorTitle")}</h2>
          <p className="pfc-sec-sub">{t("verify.proyectorSub")}</p>
        </div>
        <ProjectorVerifier prices={prices} />
      </section>
    </>
  );
}
