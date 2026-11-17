import { getLocale, getTranslations } from "next-intl/server";

import { CabeceraDePagina } from "@/app/components/app/CabeceraDePagina";
import { ProofTabs } from "@/app/components/app/ProofTabs";
import { ParAB } from "@/app/components/evidencia/ParAB";
import { EvidenceBadge } from "@/app/components/ui";
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
  const tu = await getTranslations("ui");
  const locale = await getLocale();
  return (
    <>
      <ProofTabs />
      <CabeceraDePagina rotulo={t("proof.eyebrow")} titulo={t("proof.title")} entradilla={t("proof.intro")} />

      {/* 1 · BANCO PÚBLICO: un ensayo de referencia, no datos de la organización. */}
      <section className="pfc-sec prf-sec prb-sec" aria-labelledby="prf-publico">
        <div className="pfc-sec-cab">
          <div className="prb-marca">
            <EvidenceBadge tipo="benchmark" label={tu("evidence.benchmark")} />
          </div>
          <h2 className="pfc-sec-t" id="prf-publico">{t("proof.publicoTitulo")}</h2>
          <p className="pfc-sec-sub">{t("proof.publicoSub")}</p>
        </div>
        <TarjetaMedidoEnVivo
          className="hero-prueba medido-prueba prb-banco"
          titulo={tl("enVivo.titulo", { fecha: BANCO_EN_VIVO.fecha })}
          filas={filasDelBancoEnVivo(tl, locale, { sinRepeticiones: true })}
          pie={tl.rich("enVivo.pie", { bench: (c) => <Link href="/benchmarks">{c}</Link> })}
        />
      </section>

      {/* 2 · TUS DATOS: el dinero del cliente vive en su Resumen y en su banco. */}
      <section className="pfc-sec prf-sec prb-sec" aria-labelledby="prf-propio">
        <div className="pfc-sec-cab">
          <div className="prb-marca">
            <EvidenceBadge tipo="tus-datos" label={tu("evidence.tusDatos")} />
          </div>
          <h2 className="pfc-sec-t" id="prf-propio">{t("proof.propioTitulo")}</h2>
        </div>
        <div className="card prf-propio prb-propio">
          <div className="prf-propio-txt">
            <p className="prf-propio-t">{t.rich("proof.tuDinero", { overview: (c) => <Link href="/dashboard">{c}</Link> })}</p>
            <Link className="btn btn-ghost btn-sm prb-boton" href="/dashboard/your-bench">
              {t("proof.propioBanco")}
              <Flecha />
            </Link>
          </div>
          {/* Cómo es ese A/B, dibujado: la misma petición por dos brazos y un
              solo contador, el de tu proveedor. No dice nada del resultado. */}
          <ParAB
            className="prf-par"
            peticion={t("proof.diagramRequest")}
            brazoA={t("proof.diagramA")}
            brazoB={t("proof.diagramB")}
            contador={t("proof.diagramMeter")}
          />
        </div>
      </section>

      {/* 3 · DEMOSTRACIÓN TÉCNICA: la batería sintética, siempre rotulada. */}
      <section className="pfc-sec prf-sec prb-sec" aria-labelledby="prf-tecnica">
        <div className="pfc-sec-cab">
          <div className="prb-marca">
            <EvidenceBadge tipo="sintetico" label={tu("evidence.sintetico")} />
          </div>
          <h2 className="pfc-sec-t" id="prf-tecnica">
            <TituloConMatiz texto={t("proof.sinteticaTitulo")} />
          </h2>
          <p className="pfc-sec-sub">{t("proof.tecnicaSub")}</p>
        </div>
        <div className="bench prb-tirada">
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
      </section>
    </>
  );
}

/**
 * «Tirada sintética · cómo funciona cada palanca»: lo que sigue al « · » va en
 * serif cursiva, como el título de sección de la Firma de campaña. Sin el
 * separador (un idioma que no lo use), el título va tal cual.
 */
function TituloConMatiz({ texto }: { texto: string }) {
  const corte = texto.indexOf(" · ");
  if (corte < 0) return <>{texto}</>;
  return (
    <>
      {texto.slice(0, corte + 3)}
      <em>{texto.slice(corte + 3)}</em>
    </>
  );
}

function Flecha() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}
