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

/** The 5-node activation spine — derived, never faked. */
export async function InstrumentationSpine({ steps }: { steps: StepState[] }) {
  const t = await getTranslations("dashboard");
  const current = steps.find((s) => s.status === "current");
  const hasUnavailable = steps.some((s) => s.status === "unavailable");
  const accountCta = current?.id === "Account created" || current?.id === "License active";
  const installCta = current?.id === "First real request";
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
          <div key={s.id} className={`spine-node ${s.status}`}>
            <span className="idx">{s.status === "done" ? "✓" : i + 1}</span>
            <div className="lbl">{s.label}</div>
            <div className="st">
              {s.status === "done"
                ? t("instrumentationSpine.statusDone")
                : s.status === "current"
                  ? t("instrumentationSpine.statusNext")
                  : s.status === "unavailable"
                    ? t("instrumentationSpine.statusUnavailable")
                    : t("instrumentationSpine.statusPending")}
            </div>
          </div>
        ))}
      </div>
      {current ? (
        <div className="spine-task">
          <p className="t">{t("instrumentationSpine.nextLabel", { label: current.label })}</p>
          {current.id === "SDK or gateway installed" ? (
            <>
              <div className="code2">
                <span>
                  <span className="c">{t("instrumentationSpine.installComment")}</span>
                  <span style={{ display: "block" }}>{INSTALL_CMD}</span>
                </span>
                <CopyButton text={INSTALL_CMD} />
              </div>
              <p className="note">{t("instrumentationSpine.hintInstall")}</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <a className="btn" href="/dashboard/install#sdk">{t("instrumentationSpine.linkSdk")}</a>
                <a className="btn" href="/dashboard/install#gateway">{t("instrumentationSpine.linkGateway")}</a>
              </div>
            </>
          ) : (
            <>
              <p className="note">
                {current.id === "License active"
                  ? t("instrumentationSpine.hintLicense")
                  : current.id === "First real request"
                    ? t("instrumentationSpine.hintFirstRequest")
                    : current.id === "Report ready"
                      ? t("instrumentationSpine.hintReport")
                      : t("instrumentationSpine.hintDefault")}
              </p>
              {accountCta ? <a className="btn" href="/dashboard/account">{t("instrumentationSpine.linkAccount")}</a> : null}
              {installCta ? <a className="btn" href="/dashboard/install">{t("instrumentationSpine.linkInstall")}</a> : null}
            </>
          )}
        </div>
      ) : hasUnavailable ? (
        <p className="note" role="status">{t("instrumentationSpine.unavailableHint")}</p>
      ) : null}
    </section>
  );
}
