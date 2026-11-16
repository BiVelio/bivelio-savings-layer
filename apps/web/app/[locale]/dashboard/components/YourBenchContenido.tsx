import { getTranslations } from "next-intl/server";

import { ParAB } from "@/app/components/evidencia/ParAB";
import { CodeFrame, Notice, Recibo } from "@/app/components/ui";
import { CUOTA_CORTA_MAXIMA, MIN_PARES, MIN_PARES_POR_ESTRATO } from "@/lib/verificacion/banco-propio";
import type { LecturaDelBancoPropio } from "@/lib/verificacion/lectura";

import { intfmt, money, pct0, pct0Ceil, pctFloor } from "../format";
import type { Rango } from "../rango";
import { YourBenchCounts } from "./YourBenchCounts";
import { YourBenchHeadline } from "./YourBenchHeadline";
import { YourBenchStrata } from "./YourBenchStrata";

/** El ajuste que enciende el muestreo: el mismo que enseña el README. */
const AJUSTE = "verification: { sampleRate: 0.02 },";

/**
 * LO QUE SE VE DE «TU BANCO», estado a estado: no disponible, fallo de
 * lectura, sin datos (muestreo apagado), reuniendo pares, muestra insuficiente
 * por grupos y resultado. Vive aparte de la página para que cada estado se
 * pueda pintar con una lectura dada; las consultas siguen en la página.
 */
export async function YourBenchContenido({ lectura, rango }: { lectura: LecturaDelBancoPropio; rango: Rango }) {
  const t = await getTranslations("dashboard");
  const tu = await getTranslations("ui");
  if (lectura.estado === "no_disponible") {
    return (
      <Notice tono="info" role="status">
        {t("yourBench.notAvailable")}
      </Notice>
    );
  }
  if (lectura.estado === "fallo") {
    return (
      <Notice tono="danger" titulo={t("yourBench.readFailedTitle")}>
        {t("yourBench.readFailed")}
      </Notice>
    );
  }
  const informe = lectura.informe;
  // El par A/B, dibujado: lo que el muestreo hace con cada petición comprobada.
  const par = (
    <ParAB
      className="yb-par"
      peticion={t("proof.diagramRequest")}
      brazoA={t("proof.diagramA")}
      brazoB={t("proof.diagramB")}
      contador={t("proof.diagramMeter")}
    />
  );

  if (informe.estado === "sin_datos") {
    return (
      <div className="card yb-card yb-off yb-split">
        <div className="yb-split-main">
          <p className="yb-state">{t("yourBench.stateOff")}</p>
          <h2 className="yb-h yb-h--lg">{t("yourBench.offTitle")}</h2>
          <p className="yb-p">{t("yourBench.offBody")}</p>
          <CodeFrame
            etiqueta="createSavingsLayer"
            copiar={{ texto: AJUSTE, etiqueta: tu("copy"), etiquetaCopiado: tu("copied") }}
          >
            {AJUSTE}
          </CodeFrame>
          {/* EL COSTE DE LAS COPIAS, antes de encenderlo: cada comprobación es una
              llamada real al proveedor que paga el cliente. */}
          <Notice tono="warn" role="note">
            {t("yourBench.offCost")}
          </Notice>
        </div>
        {par}
      </div>
    );
  }

  // LO QUE COSTÓ EL INSTRUMENTO, como recibo: las copias sin optimizar son
  // llamadas reales al proveedor del cliente. Visible mientras se reúnen pares
  // y con el resultado; una copia sin coste medido no se pinta como cero.
  const coste = (
    <div className="yb-coste app-gap">
      <Recibo
        titulo={t("yourBench.costTitle")}
        filas={[
          { etiqueta: t("yourBench.costCopies"), valor: intfmt(informe.coste.copias) },
          ...(informe.coste.sinCoste > 0
            ? [{ etiqueta: t("yourBench.costUnmeasured"), valor: intfmt(informe.coste.sinCoste), tono: "atenuado" as const }]
            : []),
        ]}
        total={{ etiqueta: t("yourBench.costTotal"), valor: money(informe.coste.usd), tono: "coste" }}
        evidencia={{ tipo: "tus-datos", label: tu("evidence.tusDatos") }}
        procedencia={{ texto: t("yourBench.costBody", { usd: money(informe.coste.usd), pairs: intfmt(informe.coste.copias) }) }}
      />
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
    // Solo anchura de barra: los recuentos van escritos en el título.
    const avance = Math.max(0, Math.min(100, Math.round((informe.paresEnTitular / MIN_PARES) * 100)));
    return (
      <>
        <div className="card yb-card yb-split">
          <div className="yb-split-main">
          {porGrupos ? (
            <>
              <p className="yb-state">{t("yourBench.stateShort")}</p>
              <h2 className="yb-h yb-h--lg">{t("yourBench.collectingGroupsTitle", { n: intfmt(informe.paresEnTitular) })}</h2>
              <p className="yb-p">
                {t("yourBench.collectingGroupsBody", {
                  min: intfmt(MIN_PARES_POR_ESTRATO),
                  gap: pct0Ceil(informe.cuotaCorta),
                  max: pct0(CUOTA_CORTA_MAXIMA),
                })}
              </p>
            </>
          ) : (
            <>
              <p className="yb-state">{t("yourBench.stateCollecting")}</p>
              <h2 className="yb-h yb-h--lg">{t("yourBench.collectingTitle", { n: intfmt(informe.paresEnTitular), min: intfmt(MIN_PARES) })}</h2>
              <div className="yb-meter" aria-hidden>
                <i style={{ width: `${avance}%` }} />
              </div>
              <p className="yb-p">{t("yourBench.collectingBody", { min: intfmt(MIN_PARES) })}</p>
            </>
          )}
          </div>
          {par}
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
      <YourBenchHeadline informe={informe} desde={lectura.desde} hasta={lectura.hasta} />
      <div className="yb-duo yb-duo--coste app-gap">
        <div className="card card-pad yb-card">
          <h2 className="yb-h">{t("yourBench.stressTitle")}</h2>
          <p className="ck-note">{t("yourBench.stressBody", { lower: pctFloor(informe.peorCaso!.fraccion.lower) })}</p>
        </div>
        {coste}
      </div>
      <div className="app-gap">
        <YourBenchStrata informe={informe} />
      </div>
      {noComparados}
      <div className="app-gap">
        <YourBenchCounts informe={informe} />
      </div>
      <div className="yb-duo app-gap">
        <div className="card card-pad yb-card" id="yb-metodo">
          <h2 className="yb-h">{t("yourBench.methodTitle")}</h2>
          <p className="ck-note">{t("yourBench.methodBody", { resamples: intfmt(informe.remuestreos), seed: String(informe.semilla) })}</p>
        </div>
        <div className="card card-pad yb-card">
          <h2 className="yb-h">{t("yourBench.caveatsTitle")}</h2>
          <ul className="yb-lista">
            <li className="ck-note">{t("yourBench.caveats.sample")}</li>
            <li className="ck-note">{t("yourBench.caveats.randomness")}</li>
            <li className="ck-note">{t("yourBench.caveats.outside")}</li>
            <li className="ck-note">{t("yourBench.caveats.streaming")}</li>
          </ul>
        </div>
      </div>
      <p className="app-gap">
        <a className="btn btn-ghost btn-sm" href={`/api/org/verification-pairs?range=${rango}`}>
          {t("yourBench.exportCsv")}
        </a>
      </p>
    </>
  );
}
