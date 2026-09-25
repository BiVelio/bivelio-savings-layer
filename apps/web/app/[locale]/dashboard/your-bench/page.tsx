import { getTranslations } from "next-intl/server";

import { PageHead } from "@/app/components/app/PageHead";
import { ProofTabs } from "@/app/components/app/ProofTabs";
import { authConfigured } from "@/lib/supabase/env";
import { createReadOnlyClient } from "@/lib/supabase/server";
import {
  CUOTA_CORTA_MAXIMA,
  MIN_PARES,
  MIN_PARES_POR_ESTRATO,
  type InformeDelBancoPropio,
} from "@/lib/verificacion/banco-propio";
import { leerBancoPropio, type LecturaDelBancoPropio } from "@/lib/verificacion/lectura";
import { CopyButton } from "../components/CopyButton";
import { RangeSwitch } from "../components/RangeSwitch";
import { YourBenchCounts } from "../components/YourBenchCounts";
import { YourBenchHeadline } from "../components/YourBenchHeadline";
import { YourBenchStrata } from "../components/YourBenchStrata";
import { intfmt, money, pct0, pct0Ceil, pctFloor } from "../format";
import { loadDashboard } from "../load";
import { rangoDesdeParametro, type Rango } from "../rango";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "dashboard" });
  return { title: t("yourBench.metaTitle") };
}

/** El ajuste que enciende el muestreo: el mismo que enseña el README. */
const AJUSTE = "verification: { sampleRate: 0.02 },";

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
      <PageHead
        eyebrow={t("yourBench.eyebrow")}
        title={t("yourBench.title")}
        sub={t("yourBench.intro")}
        aside={<RangeSwitch activo={rango} base="/dashboard/your-bench" />}
      />
      <div className="bench-badge">
        <span>
          <b>{t("yourBench.badge")}</b>
        </span>
      </div>
    </>
  );
  if (!authConfigured) {
    return (
      <>
        {cabecera}
        <p className="note">{t("overview.authNotWired")}</p>
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
      <div className="bench app-gap">
        <Contenido lectura={lectura} rango={rango} />
      </div>
    </>
  );
}

async function Contenido({ lectura, rango }: { lectura: LecturaDelBancoPropio; rango: Rango }) {
  const t = await getTranslations("dashboard");
  if (lectura.estado === "no_disponible") return <p className="app-note">{t("yourBench.notAvailable")}</p>;
  if (lectura.estado === "fallo") {
    return (
      <p className="app-note warn" role="alert">
        {t("yourBench.readFailed")}
      </p>
    );
  }
  const informe = lectura.informe;

  if (informe.estado === "sin_datos") {
    return (
      <div className="card card-pad">
        <div className="card-title">{t("yourBench.offTitle")}</div>
        <p className="ck-note">{t("yourBench.offBody")}</p>
        <div className="code2">
          <span>{AJUSTE}</span>
          <CopyButton text={AJUSTE} />
        </div>
        <p className="ck-note">{t("yourBench.offCost")}</p>
      </div>
    );
  }

  const coste = (
    <div className="card card-pad app-gap">
      <div className="card-title">{t("yourBench.costTitle")}</div>
      <p className="ck-note">{t("yourBench.costBody", { usd: money(informe.coste.usd), pairs: intfmt(informe.coste.copias) })}</p>
      {informe.coste.sinCoste > 0 ? <p className="ck-note">{t("yourBench.costUnknown", { n: intfmt(informe.coste.sinCoste) })}</p> : null}
    </div>
  );
  // Los pares que no entran en ninguna cifra (la copia no terminó como se le
  // exige a la petición servida), contados a la vista en los dos estados.
  const nc = informe.noComparables;
  const noComparados =
    nc.truncadas + nc.incompletas + nc.incumplidas > 0 ? (
      <p className="ck-note app-gap">
        {t("yourBench.naiveQuality", {
          truncated: intfmt(nc.truncadas),
          incomplete: intfmt(nc.incompletas),
          missed: intfmt(nc.incumplidas),
        })}
      </p>
    ) : null;

  if (informe.estado === "reuniendo") {
    const porGrupos = informe.falta === "grupos";
    return (
      <>
        <div className="card card-pad">
          {porGrupos ? (
            <>
              <div className="card-title">{t("yourBench.collectingGroupsTitle", { n: intfmt(informe.paresEnTitular) })}</div>
              <p className="ck-note">
                {t("yourBench.collectingGroupsBody", {
                  min: intfmt(MIN_PARES_POR_ESTRATO),
                  gap: pct0Ceil(informe.cuotaCorta),
                  max: pct0(CUOTA_CORTA_MAXIMA),
                })}
              </p>
            </>
          ) : (
            <>
              <div className="card-title">{t("yourBench.collectingTitle", { n: intfmt(informe.paresEnTitular), min: intfmt(MIN_PARES) })}</div>
              <p className="ck-note">{t("yourBench.collectingBody", { min: intfmt(MIN_PARES) })}</p>
            </>
          )}
        </div>
        {coste}
        {informe.estratos.some((e) => e.elegibles > 0 || e.pares > 0) ? (
          <div className="app-gap">
            <YourBenchStrata informe={informe} />
          </div>
        ) : null}
        {noComparados}
        <div className="app-gap">
          <YourBenchCounts informe={informe} />
        </div>
      </>
    );
  }

  return (
    <>
      <YourBenchHeadline informe={informe} />
      <div className="card card-pad app-gap">
        <div className="card-title">{t("yourBench.stressTitle")}</div>
        <p className="ck-note">{t("yourBench.stressBody", { lower: pctFloor(informe.peorCaso!.fraccion.lower) })}</p>
      </div>
      {coste}
      <div className="app-gap">
        <YourBenchStrata informe={informe} />
      </div>
      {noComparados}
      <div className="app-gap">
        <YourBenchCounts informe={informe} />
      </div>
      <div className="card card-pad app-gap">
        <div className="card-title">{t("yourBench.methodTitle")}</div>
        <p className="ck-note">{t("yourBench.methodBody", { resamples: intfmt(informe.remuestreos), seed: String(informe.semilla) })}</p>
      </div>
      <div className="card card-pad app-gap">
        <div className="card-title">{t("yourBench.caveatsTitle")}</div>
        <ul>
          <li className="ck-note">{t("yourBench.caveats.sample")}</li>
          <li className="ck-note">{t("yourBench.caveats.randomness")}</li>
          <li className="ck-note">{t("yourBench.caveats.outside")}</li>
          <li className="ck-note">{t("yourBench.caveats.streaming")}</li>
        </ul>
      </div>
      <p className="app-gap">
        <a className="btn btn-ghost btn-sm" href={`/api/org/verification-pairs?range=${rango}`}>
          {t("yourBench.exportCsv")}
        </a>
      </p>
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
