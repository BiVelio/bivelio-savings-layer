import { getTranslations } from "next-intl/server";

import type { StepState } from "../data";
import { CopyButton } from "./CopyButton";

/**
 * EL MISMO COMANDO QUE EL PANEL DE INSTALACIÓN (`INIT` en InstallLicensePanel).
 * Este paso seguía mostrando `pnpm add` cuando el panel ya recomendaba `init`
 * (#355): dos puertas de entrada que decían cosas distintas. `init` detecta la
 * pila e imprime la línea de instalación para el gestor de paquetes de cada uno,
 * así que el `pnpm add` sobra aquí; a mano sigue en el panel de instalación. No
 * se importa de allí para no arrastrar Stripe a la portada del panel: lo fija
 * `instalacion-renderiza.test.ts` en los dos componentes.
 */
const INSTALL_CMD = "npx @bivelio/savings-layer@latest init";

/** The 5-node activation spine — derived, never faked. The current step expands
 *  into a task card; steps beyond it read grey "pending". */
export async function InstrumentationSpine({ steps }: { steps: StepState[] }) {
  const t = await getTranslations("dashboard");
  const current = steps.find((s) => s.status === "current");
  return (
    <section className="app-section">
      <div className="app-sec-head">
        <div>
          <p className="eyebrow">{t("instrumentationSpine.eyebrow")}</p>
          <h2 className="t-section">{t("instrumentationSpine.title")}</h2>
        </div>
      </div>
      <div className="spine">
        {steps.map((s, i) => (
          <div key={s.label} className={`spine-node ${s.status}`}>
            <span className="idx">{s.status === "done" ? "✓" : i + 1}</span>
            <div className="lbl">{s.label}</div>
            <div className="st">
              {s.status === "done"
                ? t("instrumentationSpine.statusDone")
                : s.status === "current"
                  ? t("instrumentationSpine.statusNext")
                  : t("instrumentationSpine.statusPending")}
            </div>
          </div>
        ))}
      </div>
      {current ? (
        <div className="spine-task">
          <p className="t">{t("instrumentationSpine.nextLabel", { label: current.label })}</p>
          {current.id === "SDK installed" ? (
            <div className="code2">
              <span>
                <span className="c">{t("instrumentationSpine.installComment")}</span>
                {"\n"}
                {INSTALL_CMD}
              </span>
              <CopyButton text={INSTALL_CMD} />
            </div>
          ) : (
            <p className="note">
              {/* Por el `id`, no por la etiqueta: la etiqueta va traducida y en 11
                  de los 12 idiomas nunca casaba, así que salía la pista genérica. */}
              {current.id === "License active"
                ? t("instrumentationSpine.hintLicense")
                : current.id === "First report"
                  ? t("instrumentationSpine.hintFirstReport")
                  : t("instrumentationSpine.hintDefault")}
            </p>
          )}
        </div>
      ) : null}
    </section>
  );
}
